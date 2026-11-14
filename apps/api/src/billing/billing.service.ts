import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Payment, Workspace } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import {
  GRACE_DAYS,
  MIN_CHARGE_KOBO,
  PLANS,
  PLAN_STATUS_LABELS,
  TRIAL_INVOICE_LIMIT,
  USAGE_WARN_AT,
  formatKobo,
  isPlanId,
  isUpgrade,
  lagosMonthStart,
  periodEnd,
  planState,
  priceKobo,
  prorationCredit,
  sendBlock,
  type BillingInterval,
  type CheckoutInput,
  type PlanId,
} from '@einv/shared';
import { AppError, badRequest, conflict, notFound } from '../common/errors';
import { decrypt, encrypt, uuidv7 } from '../common/crypto';
import { ctx, requireWorkspaceId, runWithContext } from '../common/request-context';
import { env, isProd } from '../config/env';
import { JobsService } from '../jobs/jobs.service';
import { AuditService } from '../platform/audit.service';
import { NotificationsService } from '../platform/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER, type PaymentProvider, type PaymentResult } from './payment-provider';

export const RENEW_JOB = 'billing.renew';
export const RECONCILE_JOB = 'billing.reconcile';
/** Pending payments are re-checked with the gateway after this long. */
const SWEEP_MIN_AGE_SEC = 5 * 60;
/** Unpaid checkouts are closed after this long. */
const ABANDON_AFTER_MS = 48 * 3_600_000;
/** The daily reconciliation looks back this far, so late webhooks and transfers are caught. */
const RECONCILE_LOOKBACK_MS = 3 * 86_400_000;
/** Deterministic per workspace, period and attempt, so the gateway refuses a repeated charge. */
const renewalPrefix = (workspaceId: string, periodEnd: Date) =>
  `einv-rn-${workspaceId.replace(/-/g, '')}-${periodEnd.getTime()}`; // full milliseconds: periods never share a prefix
const DAY = 86_400_000;

const newReference = () => `einv-${randomBytes(12).toString('hex')}`;
const receiptNumber = (p: Payment, paidAt: Date) =>
  `RCT-${paidAt.getUTCFullYear()}${String(paidAt.getUTCMonth() + 1).padStart(2, '0')}-${p.id.replace(/-/g, '').slice(-8).toUpperCase()}`;
const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });

export interface Usage {
  used: number;
  limit: number | null;
  /** 0–1, or null when unlimited. */
  share: number | null;
  since: string;
  warn: boolean;
}

/**
 * E10 subscriptions. Plan status is derived from dates (see `planState`), so a trial ending or a
 * plan lapsing never depends on a job running. Payments are confirmed with the gateway, never
 * from a webhook body.
 */
@Injectable()
export class BillingService implements OnModuleInit {
  private readonly log = new Logger('Billing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit() {
    this.jobs.register(RENEW_JOB, (p: { periodEnd: string; attempt: number }) =>
      this.renew(p.periodEnd, p.attempt ?? 0),
    );
    this.jobs.register(RECONCILE_JOB, async () => {
      await this.reconcile();
    });
    // Runs on every jobs drain (each minute in production); throttled here.
    let lastSweep = 0;
    this.jobs.registerMaintenance(async () => {
      if (Date.now() - lastSweep >= 5 * 60_000) {
        lastSweep = Date.now();
        await this.sweep();
      }
      // Once a day (Lagos date), deduplicated in the job table so many instances queue it once.
      const day = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
      await this.jobs.enqueue(RECONCILE_JOB, { day }, { dedupeKey: `reconcile:${day}` });
    });
  }

  private workspace() {
    return this.prisma.scoped().workspace.findUniqueOrThrow({ where: { id: requireWorkspaceId() } });
  }

  // ── Usage and enforcement (E10-1, E10-3) ──────────────────────────────

  async usage(ws: Workspace, now = new Date()): Promise<Usage> {
    const trial = !isPlanId(ws.plan);
    const since = trial ? ws.createdAt : lagosMonthStart(now);
    // In-flight submissions count, so several quick clicks can't overshoot the limit.
    const used = await this.prisma.scoped().invoice.count({
      where: {
        docType: 'invoice',
        OR: [{ status: 'cleared', clearedAt: { gte: since } }, { status: { in: ['submitting', 'queued'] } }],
      },
    });
    const limit = trial ? TRIAL_INVOICE_LIMIT : PLANS[ws.plan as PlanId].invoiceLimit;
    const share = limit ? Math.min(1, used / limit) : null;
    return { used, limit, share, since: since.toISOString(), warn: share !== null && share >= USAGE_WARN_AT };
  }

  /** Called before anything is sent to NRS. Drafts, approvals and reading are never blocked. */
  async assertCanSend(ws: Workspace) {
    const { status } = planState(ws);
    const u = await this.usage(ws);
    const block = sendBlock(status, u.used, u.limit, !isPlanId(ws.plan));
    if (block) throw new AppError(402, block.code, block.message, [], { billingUrl: `/w/${ws.id}/billing` });
  }

  /** Plan rules that unlock features (E9-3 approval threshold). The trial has everything. */
  static allowsApprovalRules(ws: Pick<Workspace, 'plan'>) {
    return !isPlanId(ws.plan) || PLANS[ws.plan].approvalRules;
  }

  // ── Summary ───────────────────────────────────────────────────────────

  async summary() {
    const ws = await this.workspace();
    const { status, graceEndsAt } = planState(ws);
    const usage = await this.usage(ws);
    const block = sendBlock(status, usage.used, usage.limit, !isPlanId(ws.plan));
    return {
      plan: ws.plan,
      planName: isPlanId(ws.plan) ? PLANS[ws.plan].name : 'Free trial',
      interval: ws.billingInterval,
      status,
      statusLabel: PLAN_STATUS_LABELS[status],
      trialEndsAt: ws.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: ws.currentPeriodEnd?.toISOString() ?? null,
      graceEndsAt: graceEndsAt?.toISOString() ?? null,
      autoRenew: ws.autoRenew,
      billingEmail: ws.billingEmail,
      nextPlan: ws.nextPlan,
      nextInterval: ws.nextInterval,
      card: ws.cardLast4 ? { last4: ws.cardLast4, brand: ws.cardBrand, expiry: ws.cardExpiry } : null,
      usage,
      canSend: !block,
      block,
      checkoutAvailable: !(isProd() && this.provider.mode === 'mock'),
      testMode: this.provider.mode === 'mock' || env().PAYSTACK_SECRET_KEY?.startsWith('sk_test_') === true,
    };
  }

  async payments() {
    const rows = await this.prisma.scoped().payment.findMany({
      where: { status: { in: ['success', 'failed', 'refund_pending', 'refunded', 'refund_failed'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((p) => ({
      id: p.id,
      reference: p.reference,
      kind: p.kind,
      plan: p.plan,
      planName: isPlanId(p.plan) ? PLANS[p.plan].name : p.plan,
      interval: p.interval,
      amount: p.amount,
      credit: p.credit,
      status: p.status,
      channel: p.channel,
      failureReason:
        p.status === 'failed'
          ? (p.failureReason ?? 'Payment did not go through')
          : p.status.startsWith('refund')
            ? 'Duplicate payment, refunded'
            : null,
      periodStart: p.periodStart?.toISOString() ?? null,
      periodEnd: p.periodEnd?.toISOString() ?? null,
      paidAt: p.paidAt?.toISOString() ?? null,
      receiptNumber: p.receiptNumber,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  // ── Checkout (E10-2) ──────────────────────────────────────────────────

  /**
   * Starts paying for a plan. Upgrades take effect now with credit for the unused days;
   * downgrades and interval changes to something cheaper wait until the current period ends.
   */
  async checkout(input: CheckoutInput) {
    if (isProd() && this.provider.mode === 'mock') {
      throw new AppError(
        503,
        'CHECKOUT_UNAVAILABLE',
        'Online payment is not switched on yet. Contact support to activate your plan.',
      );
    }
    const ws = await this.workspace();
    const { status } = planState(ws);
    const target = { plan: input.plan, interval: input.interval };
    const list = priceKobo(target.plan, target.interval);
    let credit = 0;

    if (status === 'active' && isPlanId(ws.plan) && ws.billingInterval && ws.currentPeriodEnd) {
      const current = { plan: ws.plan, interval: ws.billingInterval as BillingInterval };
      if (current.plan === target.plan && current.interval === target.interval) {
        throw conflict(
          `You are already on ${PLANS[target.plan].name} (${target.interval}).`,
          'ALREADY_ON_PLAN',
        );
      }
      if (!isUpgrade(current, target)) {
        await this.prisma.scoped().workspace.update({
          where: { id: ws.id },
          data: { nextPlan: target.plan, nextInterval: target.interval },
        });
        await this.audit.record({
          entity: 'workspace',
          entityId: ws.id,
          action: 'billing.change_scheduled',
          detail: target,
        });
        return { scheduled: true as const, effectiveAt: ws.currentPeriodEnd.toISOString() };
      }
      credit = Math.min(list, prorationCredit({ ...current, periodEnd: ws.currentPeriodEnd }, new Date()));
    }

    // A second tab or a retry reuses the checkout already open for the same plan, so the business
    // can't end up paying twice. If that checkout was in fact paid, apply it instead.
    const open = await this.prisma.scoped().payment.findFirst({
      where: {
        kind: 'checkout',
        status: 'pending',
        plan: target.plan,
        interval: target.interval,
        authorizationUrl: { not: null },
        createdAt: { gt: new Date(Date.now() - 30 * 60_000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      const now = await this.settle(open.reference);
      if (now?.status === 'success') {
        return {
          scheduled: false as const,
          alreadyPaid: true as const,
          reference: open.reference,
          amount: open.amount,
        };
      }
      if (now?.status === 'pending' && open.authorizationUrl) {
        return {
          scheduled: false as const,
          authorizationUrl: open.authorizationUrl,
          reference: open.reference,
          amount: open.amount,
        };
      }
    }

    const email = await this.payerEmail(ws);
    const amount = Math.max(MIN_CHARGE_KOBO, list - credit);
    const reference = newReference();
    await this.prisma.scoped().payment.create({
      data: {
        id: uuidv7(),
        workspaceId: ws.id,
        reference,
        kind: 'checkout',
        plan: target.plan,
        interval: target.interval,
        amount,
        listPrice: list,
        credit: list - amount < 0 ? 0 : list - amount,
        createdBy: ctx().userId ?? null,
      },
    });
    if (!ws.billingEmail)
      await this.prisma.scoped().workspace.update({ where: { id: ws.id }, data: { billingEmail: email } });
    let authorizationUrl: string;
    try {
      ({ authorizationUrl } = await this.provider.initialize({
        email,
        amountKobo: amount,
        reference,
        callbackUrl: `${env().PUBLIC_APP_URL}/w/${ws.id}/billing`,
        metadata: { workspace_id: ws.id, plan: target.plan, interval: target.interval },
      }));
    } catch (err) {
      const message = (err as Error).message ?? '';
      this.log.warn({ err, reference }, 'Payment gateway refused checkout');
      await this.prisma.scoped().payment.updateMany({
        where: { reference, status: 'pending' },
        data: { status: 'abandoned', failureReason: message.slice(0, 300) },
      });
      if (/email/i.test(message)) {
        throw badRequest(
          `The payment provider didn't accept ${email} as an email address. Change the billing email on this page and try again.`,
          [{ field: 'billingEmail', message: 'Use a working email address.' }],
          'BILLING_EMAIL_REJECTED',
        );
      }
      throw new AppError(
        502,
        'PAYMENT_GATEWAY_ERROR',
        "We couldn't reach the payment provider. You haven't been charged. Try again in a few minutes.",
      );
    }
    await this.prisma.scoped().payment.updateMany({ where: { reference }, data: { authorizationUrl } });
    await this.audit.record({
      entity: 'payment',
      entityId: reference,
      action: 'billing.checkout_started',
      detail: { ...target, amount, credit: list - amount },
    });
    return { scheduled: false as const, authorizationUrl, reference, amount };
  }

  async cancelScheduledChange() {
    const ws = await this.workspace();
    await this.prisma
      .scoped()
      .workspace.update({ where: { id: ws.id }, data: { nextPlan: null, nextInterval: null } });
    await this.audit.record({ entity: 'workspace', entityId: ws.id, action: 'billing.change_cancelled' });
    return this.summary();
  }

  async updateSettings(input: { autoRenew?: boolean; billingEmail?: string }) {
    const ws = await this.workspace();
    await this.prisma.scoped().workspace.update({ where: { id: ws.id }, data: input });
    if (input.autoRenew !== undefined) {
      await this.audit.record({
        entity: 'workspace',
        entityId: ws.id,
        action: input.autoRenew ? 'billing.auto_renew_on' : 'billing.auto_renew_off',
      });
    }
    if (input.billingEmail !== undefined) {
      await this.audit.record({ entity: 'workspace', entityId: ws.id, action: 'billing.email_changed' });
    }
    return this.summary();
  }

  /** The payer returns from the gateway: confirm with the gateway and apply. */
  async confirm(reference: string) {
    const p = await this.prisma.scoped().payment.findUnique({ where: { reference } });
    if (!p) throw notFound('That payment');
    const result = await this.settle(reference);
    return { status: result?.status ?? p.status, summary: await this.summary() };
  }

  /** Webhook path: no session, so find the workspace first and run in its context. */
  async settleFromWebhook(reference: string) {
    const rows = await this.prisma.$queryRaw<
      { ws: string | null }[]
    >`SELECT app.resolve_payment(${reference}) AS ws`;
    const workspaceId = rows[0]?.ws;
    if (!workspaceId) return; // not ours (or a test event)
    await runWithContext({ requestId: `webhook:${reference}`, workspaceId, userId: null }, () =>
      this.settle(reference),
    );
  }

  /**
   * Applies a payment once. Safe to call from the return page, the webhook and renewals at the
   * same time: only the call that moves the row out of `pending` changes the plan.
   */
  async settle(
    reference: string,
    known?: PaymentResult,
    opts: { reopen?: boolean } = {},
  ): Promise<Payment | null> {
    const db = this.prisma.scoped();
    let p = await db.payment.findUnique({ where: { reference } });
    if (!p) return null;
    const reopenable = opts.reopen && (p.status === 'failed' || p.status === 'abandoned');
    if (p.status !== 'pending' && !reopenable) return p;
    const r = known ?? (await this.provider.verify(reference));
    if (r.status === 'pending') return p;
    if (reopenable) {
      // The gateway is the source of truth: a transfer can clear after we closed the checkout.
      if (r.status !== 'success') return p;
      await db.payment.updateMany({
        where: { id: p.id, status: p.status },
        data: { status: 'pending', failureReason: null },
      });
      await this.audit.record({
        entity: 'payment',
        entityId: reference,
        action: 'billing.payment_reopened',
        detail: { was: p.status },
      });
      p = (await db.payment.findUnique({ where: { reference } }))!;
    }
    const payment = p;

    if (r.status !== 'success' || r.amountKobo !== payment.amount || r.currency !== 'NGN') {
      const reason =
        r.status === 'success' ? 'Amount did not match' : (r.message ?? 'Payment did not go through');
      if (r.status === 'success')
        this.log.error(
          { reference, expected: payment.amount, got: r.amountKobo, currency: r.currency },
          'Payment amount mismatch',
        );
      await db.payment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: {
          status: r.status === 'abandoned' ? 'abandoned' : 'failed',
          failureReason: reason,
          channel: r.channel,
        },
      });
      await this.audit.record({
        entity: 'payment',
        entityId: reference,
        action: 'billing.payment_failed',
        detail: { reason },
      });
      return db.payment.findUnique({ where: { reference } });
    }

    const paidAt = r.paidAt ?? new Date();
    const applied = await this.prisma.scopedTx(async (tx) => {
      // One settlement at a time per workspace, so two different payments can't both start a period.
      await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${payment.workspaceId}))) AS l`;
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: payment.workspaceId } });
      // Another payment already settled after this one started: this one is a duplicate.
      const dup = await tx.payment.findFirst({
        where: { id: { not: payment.id }, status: 'success', paidAt: { gte: payment.createdAt } },
        orderBy: { paidAt: 'asc' },
      });
      if (dup) {
        const claimed = await tx.payment.updateMany({
          where: { id: payment.id, status: 'pending' },
          data: {
            status: 'refund_pending',
            channel: r.channel,
            paidAt,
            failureReason: `Duplicate of ${dup.reference}`,
          },
        });
        return claimed.count ? { duplicate: dup.reference, ws } : null;
      }
      // Renewals continue from the end of the paid period; new plans and upgrades start now.
      const start = payment.kind === 'renewal' && ws.currentPeriodEnd ? ws.currentPeriodEnd : paidAt;
      const end = periodEnd(start, payment.interval as BillingInterval);
      const moved = await tx.payment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: {
          status: 'success',
          channel: r.channel,
          paidAt,
          periodStart: start,
          periodEnd: end,
          receiptNumber: receiptNumber(payment, paidAt),
        },
      });
      if (!moved.count) return null;
      const card = r.authorization?.reusable ? r.authorization : null;
      await tx.workspace.update({
        where: { id: ws.id },
        data: {
          plan: payment.plan,
          billingInterval: payment.interval,
          currentPeriodEnd: end,
          nextPlan: null,
          nextInterval: null,
          ...(card
            ? {
                cardAuthEnc: encrypt(card.code),
                cardLast4: card.last4,
                cardBrand: card.brand,
                cardExpiry: card.expiry,
              }
            : {}),
        },
      });
      return { ws, end };
    });
    if (!applied) return db.payment.findUnique({ where: { reference } });
    if ('duplicate' in applied) {
      await this.audit.record({
        entity: 'payment',
        entityId: reference,
        action: 'billing.duplicate_detected',
        detail: { duplicateOf: applied.duplicate, amount: payment.amount },
      });
      return this.completeRefund(reference, applied.ws);
    }

    await this.jobs.enqueue(
      RENEW_JOB,
      { periodEnd: applied.end.toISOString(), attempt: 0 },
      {
        runAt: applied.end,
        workspaceId: payment.workspaceId,
        dedupeKey: `renew:${payment.workspaceId}:${applied.end.toISOString()}:0`,
      },
    );
    await this.audit.record({
      entity: 'payment',
      entityId: reference,
      action: 'billing.payment_succeeded',
      detail: {
        plan: payment.plan,
        interval: payment.interval,
        amount: payment.amount,
        kind: payment.kind,
        periodEnd: applied.end.toISOString(),
      },
    });
    const settled = (await db.payment.findUnique({ where: { reference } }))!;
    await this.sendReceipt(applied.ws, settled).catch((err) =>
      this.log.warn({ err }, 'Receipt email failed'),
    );
    return settled;
  }

  // ── Renewals (E10-2: retried for 7 days, then sending pauses) ─────────

  async renew(periodEndIso: string, attempt: number) {
    const ws = await this.workspace();
    if (!isPlanId(ws.plan) || !ws.currentPeriodEnd || ws.currentPeriodEnd.toISOString() !== periodEndIso)
      return; // already renewed or changed
    const now = new Date();
    const graceEnd = new Date(ws.currentPeriodEnd.getTime() + GRACE_DAYS * DAY);
    if (now >= graceEnd) {
      await this.audit.record({ entity: 'workspace', entityId: ws.id, action: 'billing.lapsed' });
      await this.notifyOwners(
        ws,
        'Your E-Invoice plan is paused',
        `We couldn't collect payment for ${ws.legalName}, so sending invoices to NRS is paused. Your drafts and approved invoices are safe. Pay here to continue: ${env().PUBLIC_APP_URL}/w/${ws.id}/billing`,
      );
      return;
    }

    const plan = (isPlanId(ws.nextPlan) ? ws.nextPlan : ws.plan) as PlanId;
    const interval = (ws.nextInterval ?? ws.billingInterval ?? 'monthly') as BillingInterval;
    const amount = priceKobo(plan, interval);
    let renewed = false;

    if (ws.autoRenew && ws.cardAuthEnc) {
      // Before charging, find out what happened to every earlier attempt for this period. A charge
      // that timed out may have gone through; it must never be repeated.
      const prefix = renewalPrefix(ws.id, ws.currentPeriodEnd);
      const earlier = await this.prisma
        .scoped()
        .payment.findMany({ where: { kind: 'renewal', reference: { startsWith: `${prefix}-` } } });
      for (const e of earlier.filter((x) => x.status === 'pending')) {
        const s = await this.settle(e.reference);
        if (s?.status === 'success') return;
        if (s?.status === 'pending') {
          // Still unknown at the gateway: look again in an hour rather than risk a second charge.
          const hour = Math.floor(Date.now() / 3_600_000);
          await this.jobs.enqueue(
            RENEW_JOB,
            { periodEnd: periodEndIso, attempt },
            {
              runAt: new Date(Date.now() + 3_600_000),
              workspaceId: ws.id,
              dedupeKey: `renew:${ws.id}:${periodEndIso}:${attempt}:check:${hour}`,
            },
          );
          return;
        }
      }
      if (earlier.some((x) => x.status === 'success')) return;
      const reference = `${prefix}-${attempt}`;
      const already = earlier.find((x) => x.reference === reference);
      const email = ws.billingEmail ?? (await this.payerEmail(ws));
      if (!already)
        await this.prisma.scoped().payment.create({
          data: {
            id: uuidv7(),
            workspaceId: ws.id,
            reference,
            kind: 'renewal',
            plan,
            interval,
            amount,
            listPrice: amount,
          },
        });
      const result = already
        ? null // this attempt already ran (the job was retried); its result is recorded
        : await this.provider.chargeAuthorization({
            email,
            amountKobo: amount,
            reference,
            authorizationCode: decrypt(ws.cardAuthEnc),
          });
      const settled = result ? await this.settle(reference, result) : already;
      renewed = settled?.status === 'success';
      if (settled?.status === 'pending') {
        // Outcome unknown (timeout): the next run checks it with the gateway before doing anything else.
        await this.jobs.enqueue(
          RENEW_JOB,
          { periodEnd: periodEndIso, attempt },
          {
            runAt: new Date(Date.now() + 3_600_000),
            workspaceId: ws.id,
            dedupeKey: `renew:${ws.id}:${periodEndIso}:${attempt}:unknown`,
          },
        );
        return;
      }
      if (!renewed && (attempt === 0 || attempt === GRACE_DAYS - 1)) {
        await this.notifyOwners(
          ws,
          'Your E-Invoice payment did not go through',
          `We couldn't charge your card ending ${ws.cardLast4 ?? ''} for ${PLANS[plan].name} (${formatKobo(amount)}). We'll try again daily until ${fmtDate(graceEnd)}; sending keeps working until then. Pay or update your card here: ${env().PUBLIC_APP_URL}/w/${ws.id}/billing`,
        );
      }
    } else if (attempt === 0) {
      await this.notifyOwners(
        ws,
        'Your E-Invoice plan is due for renewal',
        `Your ${PLANS[plan].name} plan for ${ws.legalName} is due (${formatKobo(amount)}). Pay by ${fmtDate(graceEnd)} to keep sending invoices to NRS: ${env().PUBLIC_APP_URL}/w/${ws.id}/billing`,
      );
    }

    if (!renewed) {
      const next = Math.min(now.getTime() + DAY, graceEnd.getTime());
      await this.jobs.enqueue(
        RENEW_JOB,
        { periodEnd: periodEndIso, attempt: attempt + 1 },
        {
          runAt: new Date(next),
          workspaceId: ws.id,
          dedupeKey: `renew:${ws.id}:${periodEndIso}:${attempt + 1}`,
        },
      );
    }
  }

  // ── Duplicate payments ────────────────────────────────────────────────

  /** Refunds a payment marked `refund_pending` (a duplicate). Safe to retry. */
  async completeRefund(reference: string, ws?: Workspace): Promise<Payment | null> {
    const db = this.prisma.scoped();
    const p = await db.payment.findUnique({ where: { reference } });
    if (!p || p.status !== 'refund_pending') return p;
    const workspace = ws ?? (await this.workspace());
    const rf = await this.provider.refund(reference);
    await db.payment.updateMany({
      where: { id: p.id, status: 'refund_pending' },
      data: rf.ok
        ? { status: 'refunded' }
        : {
            status: 'refund_failed',
            failureReason: `${p.failureReason ?? ''}; refund failed: ${rf.message ?? ''}`.slice(0, 300),
          },
    });
    if (rf.ok) {
      await this.audit.record({
        entity: 'payment',
        entityId: reference,
        action: 'billing.duplicate_refunded',
        detail: { amount: p.amount },
      });
      await this.notifyOwners(
        workspace,
        'We refunded a duplicate payment',
        `We received a second payment of ${formatKobo(p.amount)} for ${workspace.legalName} for a period that was already paid, so we have refunded it in full. Banks usually return the money within 5-10 working days. Reference: ${reference}.`,
      ).catch((err) => this.log.warn({ err }, 'Refund email failed'));
    } else {
      await this.flag(reference, p.workspaceId, 'refund_failed', { amount: p.amount, message: rf.message });
    }
    return db.payment.findUnique({ where: { reference } });
  }

  // ── Scheduled checks ──────────────────────────────────────────────────

  /**
   * Every 5 minutes: asks the gateway about payments still pending (missed webhooks, transfers
   * that cleared after the tab closed, renewals that timed out) and retries unfinished refunds.
   * Checkouts with no payment after 48 hours are closed.
   */
  async sweep(): Promise<{ checked: number; settled: number; abandoned: number }> {
    const rows = await this.prisma.$queryRaw<
      { reference: string; workspace_id: string; created_at: Date; status: string }[]
    >`
      SELECT * FROM app.stale_pending_payments(${SWEEP_MIN_AGE_SEC}::int, 100::int)`;
    let settled = 0;
    let abandoned = 0;
    for (const row of rows) {
      await runWithContext(
        { requestId: `sweep:${row.reference}`, workspaceId: row.workspace_id, userId: null },
        async () => {
          try {
            if (row.status === 'refund_pending') {
              await this.completeRefund(row.reference);
              return;
            }
            const s = await this.settle(row.reference);
            if (s?.status === 'success') settled++;
            if (
              s?.status === 'pending' &&
              Date.now() - new Date(row.created_at).getTime() > ABANDON_AFTER_MS
            ) {
              await this.prisma.scoped().payment.updateMany({
                where: { reference: row.reference, status: 'pending', kind: 'checkout' },
                data: { status: 'abandoned', failureReason: 'No payment received within 48 hours' },
              });
              abandoned++;
            }
          } catch (err) {
            this.log.warn({ err, reference: row.reference }, 'Sweep could not check a payment');
          }
        },
      );
    }
    return { checked: rows.length, settled, abandoned };
  }

  /**
   * Daily: compares the gateway's successful payments (last 3 days) with ours, both ways.
   * Fixes what it can (payments the gateway took but we never recorded) and flags the rest for a
   * person: unknown references, amount mismatches, and payments we recorded that the gateway no
   * longer shows as successful. Also re-queues any renewal job that went missing.
   */
  async reconcile(
    now = new Date(),
  ): Promise<{ gateway: number; fixed: number; discrepancies: number; renewalsQueued: number }> {
    const from = new Date(now.getTime() - RECONCILE_LOOKBACK_MS);
    const gateway = (await this.provider.listSuccessful(from, now)).filter((t) =>
      t.reference.startsWith('einv-'),
    );
    const refs = gateway.map((t) => t.reference);
    const ours = refs.length
      ? await this.prisma.$queryRaw<
          { reference: string; workspace_id: string; status: string; amount: number }[]
        >`
          SELECT * FROM app.payments_by_reference(${refs}::text[])`
      : [];
    const byRef = new Map(ours.map((o) => [o.reference, o]));
    // Already-reported problems, loaded once so each new finding costs a single write.
    const known = new Set(
      (
        await this.prisma.$queryRaw<{ reference: string; kind: string }[]>`
          SELECT reference, kind FROM app.open_payment_discrepancies(now() - interval '400 days')`
      ).map((k) => `${k.reference}|${k.kind}`),
    );
    const flag = async (
      reference: string,
      workspaceId: string | null,
      kind: string,
      detail: Record<string, unknown>,
    ) => {
      if (known.has(`${reference}|${kind}`)) return false;
      known.add(`${reference}|${kind}`);
      return this.flag(reference, workspaceId, kind, detail, true);
    };
    let fixed = 0;
    let discrepancies = 0;

    for (const t of gateway) {
      const o = byRef.get(t.reference);
      if (!o) {
        if (await flag(t.reference, null, 'unknown_reference', { amount: t.amountKobo, paidAt: t.paidAt }))
          discrepancies++;
        continue;
      }
      if (o.amount !== t.amountKobo || t.currency !== 'NGN') {
        if (
          await flag(t.reference, o.workspace_id, 'amount_mismatch', {
            ours: o.amount,
            gateway: t.amountKobo,
            currency: t.currency,
          })
        )
          discrepancies++;
        continue;
      }
      if (o.status === 'pending' || o.status === 'failed' || o.status === 'abandoned') {
        const s = await runWithContext(
          { requestId: `reconcile:${t.reference}`, workspaceId: o.workspace_id, userId: null },
          () => this.settle(t.reference, undefined, { reopen: true }),
        );
        if (s && (s.status === 'success' || s.status === 'refunded' || s.status === 'refund_pending'))
          fixed++;
        else if (await flag(t.reference, o.workspace_id, 'not_applied', { status: s?.status ?? o.status }))
          discrepancies++;
      }
    }

    // The other direction: payments we recorded as paid that the gateway doesn't list as successful.
    // Leave a 15-minute margin for gateway indexing.
    const gatewayRefs = new Set(refs);
    const settled = await this.prisma.$queryRaw<
      { reference: string; workspace_id: string; amount: number }[]
    >`
      SELECT * FROM app.settled_payments_between(${from}, ${new Date(now.getTime() - 15 * 60_000)})`;
    for (const s of settled) {
      if (
        !gatewayRefs.has(s.reference) &&
        (await flag(s.reference, s.workspace_id, 'missing_at_gateway', { amount: s.amount }))
      )
        discrepancies++;
    }

    // Renewal safety net: every paid plan past its period end has a renewal job.
    const due = await this.prisma.$queryRaw<{ workspace_id: string; current_period_end: Date }[]>`
      SELECT * FROM app.paid_workspaces_past_period_end(500::int)`;
    let renewalsQueued = 0;
    for (const w of due) {
      const end = new Date(w.current_period_end).toISOString();
      const job = await this.jobs.enqueue(
        RENEW_JOB,
        { periodEnd: end, attempt: 0 },
        { workspaceId: w.workspace_id, dedupeKey: `renew:${w.workspace_id}:${end}:0` },
      );
      if (job) renewalsQueued++;
    }

    const summary = { gateway: gateway.length, fixed, discrepancies, renewalsQueued };
    this.log.log(summary, 'Payment reconciliation finished');
    if (discrepancies > 0 && env().OPS_ALERT_EMAIL) {
      await this.notifications.send({
        channel: 'email',
        recipient: env().OPS_ALERT_EMAIL!,
        subject: `Payment reconciliation: ${discrepancies} item(s) need checking`,
        body: `The daily payment check found ${discrepancies} new discrepancy(ies) and fixed ${fixed}. See app.payment_discrepancies (unresolved rows) for details.`,
      });
    }
    return summary;
  }

  /** Records a discrepancy once per reference and kind. Returns true if it was new. */
  private async flag(
    reference: string,
    workspaceId: string | null,
    kind: string,
    detail: Record<string, unknown>,
    checked = false,
  ): Promise<boolean> {
    if (!checked) {
      const before = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM app.open_payment_discrepancies(now() - interval '400 days') WHERE reference = ${reference} AND kind = ${kind}`;
      if (Number(before[0]?.n ?? 0) > 0) return false;
    }
    await this.prisma
      .$executeRaw`SELECT app.record_payment_discrepancy(${reference}, ${workspaceId}::uuid, ${kind}, ${JSON.stringify(detail)}::jsonb)`;
    this.log.error({ reference, workspaceId, kind, detail }, 'Payment discrepancy');
    return true;
  }

  // ── Receipts ──────────────────────────────────────────────────────────

  async receiptPdf(paymentId: string) {
    const p = await this.prisma.scoped().payment.findUnique({ where: { id: paymentId } });
    if (!p || p.status !== 'success') throw notFound('That receipt');
    const ws = await this.workspace();
    return { filename: `${p.receiptNumber}.pdf`, pdf: await renderReceipt(ws, p) };
  }

  private async sendReceipt(ws: Workspace, p: Payment) {
    const to = ws.billingEmail ?? (await this.payerEmail(ws).catch(() => null));
    if (!to) return;
    await this.notifications.send({
      channel: 'email',
      recipient: to,
      workspaceId: ws.id,
      subject: `Receipt ${p.receiptNumber} — E-Invoice ${PLANS[p.plan as PlanId]?.name ?? p.plan}`,
      body: [
        `Thank you. We received ${formatKobo(p.amount)} for ${ws.legalName}.`,
        `Plan: ${PLANS[p.plan as PlanId]?.name ?? p.plan} (${p.interval})`,
        `Covers: ${fmtDate(p.periodStart!)} to ${fmtDate(p.periodEnd!)}`,
        `Receipt number: ${p.receiptNumber}`,
        `Download the PDF receipt: ${env().PUBLIC_APP_URL}/w/${ws.id}/billing`,
      ].join('\n'),
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** The business's billing email first (e.g. accounts@), then the person paying, then the business email. */
  private async payerEmail(ws: Workspace): Promise<string> {
    if (ws.billingEmail) return ws.billingEmail;
    const userId = ctx().userId;
    if (userId) {
      const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (u?.email) return u.email;
    }
    if (ws.billingEmail) return ws.billingEmail;
    if (ws.email) return ws.email;
    throw badRequest(
      'Add a business email in Settings first. The payment provider sends receipts to it.',
      [],
      'BILLING_EMAIL_REQUIRED',
    );
  }

  private async notifyOwners(ws: Workspace, subject: string, body: string) {
    const members = await this.prisma
      .scoped()
      .membership.findMany({ where: { workspaceId: ws.id, role: { in: ['owner', 'admin'] } } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) }, email: { not: null } },
      select: { email: true },
    });
    const to = new Set([...users.map((u) => u.email!), ...(ws.billingEmail ? [ws.billingEmail] : [])]);
    for (const recipient of to)
      await this.notifications.send({ channel: 'email', recipient, subject, body, workspaceId: ws.id });
  }
}

/** A4 receipt. Built-in PDF fonts have no ₦ glyph, so amounts use the ISO code. */
function renderReceipt(ws: Workspace, p: Payment): Promise<Buffer> {
  const ngn = (kobo: number) =>
    'NGN ' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Receipt ${p.receiptNumber}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font('Helvetica-Bold').fontSize(20).text('Receipt');
  doc
    .moveDown(0.3)
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#4b5262')
    .text(`E-Invoice subscription · ${p.receiptNumber}`);
  doc.moveDown(1.5).fillColor('#0b0f17').fontSize(11);
  const row = (label: string, value: string) => {
    const y = doc.y;
    doc.font('Helvetica').fillColor('#4b5262').text(label, 56, y, { width: 160 });
    doc.font('Helvetica').fillColor('#0b0f17').text(value, 220, y, { width: 320 });
    doc.moveDown(0.6);
  };
  row('Billed to', ws.legalName);
  row('Tax ID (TIN)', ws.tin);
  if (ws.address) row('Address', ws.address);
  row('Date paid', fmtDate(p.paidAt!));
  row('Plan', `${PLANS[p.plan as PlanId]?.name ?? p.plan} (${p.interval})`);
  row('Period', `${fmtDate(p.periodStart!)} to ${fmtDate(p.periodEnd!)}`);
  row('Payment method', p.channel ? p.channel.replace('_', ' ') : '—');
  row('Payment reference', p.reference);
  doc.moveDown(0.8);
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#e8e9ec').stroke();
  doc.moveDown(0.8);
  if (p.credit > 0) {
    row('Plan price', ngn(p.listPrice));
    row('Credit for unused days', `- ${ngn(p.credit)}`);
  }
  const y = doc.y;
  doc.font('Helvetica-Bold').fillColor('#0b0f17').text('Amount paid', 56, y, { width: 160 });
  doc.text(ngn(p.amount), 220, y, { width: 320 });
  doc
    .moveDown(3)
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#6b7280')
    .text('This receipt confirms payment for an E-Invoice subscription. It is not a tax invoice.');
  doc.end();
  return done;
}
