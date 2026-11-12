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
      where: { status: { in: ['success', 'failed'] } },
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
      failureReason: p.status === 'failed' ? (p.failureReason ?? 'Payment did not go through') : null,
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
      throw new AppError(502, 'PAYMENT_GATEWAY_ERROR', "We couldn't reach the payment provider. You haven't been charged. Try again in a few minutes.");
    }
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
  async settle(reference: string, known?: PaymentResult): Promise<Payment | null> {
    const db = this.prisma.scoped();
    const p = await db.payment.findUnique({ where: { reference } });
    if (!p) return null;
    if (p.status !== 'pending') return p;
    const r = known ?? (await this.provider.verify(reference));
    if (r.status === 'pending') return p;

    if (r.status !== 'success' || r.amountKobo !== p.amount || r.currency !== 'NGN') {
      const reason =
        r.status === 'success' ? 'Amount did not match' : (r.message ?? 'Payment did not go through');
      if (r.status === 'success')
        this.log.error(
          { reference, expected: p.amount, got: r.amountKobo, currency: r.currency },
          'Payment amount mismatch',
        );
      await db.payment.updateMany({
        where: { id: p.id, status: 'pending' },
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
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: p.workspaceId } });
      // Renewals continue from the end of the paid period; new plans and upgrades start now.
      const start = p.kind === 'renewal' && ws.currentPeriodEnd ? ws.currentPeriodEnd : paidAt;
      const end = periodEnd(start, p.interval as BillingInterval);
      const moved = await tx.payment.updateMany({
        where: { id: p.id, status: 'pending' },
        data: {
          status: 'success',
          channel: r.channel,
          paidAt,
          periodStart: start,
          periodEnd: end,
          receiptNumber: receiptNumber(p, paidAt),
        },
      });
      if (!moved.count) return null;
      const card = r.authorization?.reusable ? r.authorization : null;
      await tx.workspace.update({
        where: { id: ws.id },
        data: {
          plan: p.plan,
          billingInterval: p.interval,
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

    await this.jobs.enqueue(
      RENEW_JOB,
      { periodEnd: applied.end.toISOString(), attempt: 0 },
      {
        runAt: applied.end,
        workspaceId: p.workspaceId,
        dedupeKey: `renew:${p.workspaceId}:${applied.end.toISOString()}:0`,
      },
    );
    await this.audit.record({
      entity: 'payment',
      entityId: reference,
      action: 'billing.payment_succeeded',
      detail: {
        plan: p.plan,
        interval: p.interval,
        amount: p.amount,
        kind: p.kind,
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
      const email = ws.billingEmail ?? (await this.payerEmail(ws));
      const reference = newReference();
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
      const result = await this.provider.chargeAuthorization({
        email,
        amountKobo: amount,
        reference,
        authorizationCode: decrypt(ws.cardAuthEnc),
      });
      const settled = await this.settle(reference, result);
      renewed = settled?.status === 'success';
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
