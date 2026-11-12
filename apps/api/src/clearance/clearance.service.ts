import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type Workspace } from '@prisma/client';
import { can, explainNrsError, nextRetryDelayMs, RETRY_WINDOW_MS, type PlainError } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { NotificationsService } from '../platform/notifications.service';
import { JobsService } from '../jobs/jobs.service';
import {
  ACCESS_POINT,
  ProviderUnavailableError,
  type AccessPointProvider,
  type ClearanceRequest,
  type ClearanceResult,
  type Party,
} from '../access-point/access-point';
import { buildUbl } from '../access-point/ubl';
import { conflict, forbidden, unprocessable } from '../common/errors';
import { sha256 } from '../common/crypto';
import { isoDay, num } from '../common/zod';
import { ctx, requireUserId, requireWorkspaceId } from '../common/request-context';
import { env } from '../config/env';
import { InvoicesService } from '../invoices/invoices.service';
import { invoiceDto, type InvoiceWithRelations } from '../invoices/invoice.mapper';
import { sellerParty } from '../workspaces/workspaces.service';
import { BillingService } from '../billing/billing.service';
import { validateForSubmission } from './validation';

export const RETRY_JOB = 'clearance.retry';
const PROVIDER_TIMEOUT_MS = 10_000;
const NUMBER_PREFIX = { credit_note: 'CN', debit_note: 'DN' } as const;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new ProviderUnavailableError('The tax authority took too long to respond.')),
      ms,
    );
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * Status machine: draft → [pending_approval] → submitting → cleared | rejected | queued → … → failed.
 * The conditional status update in `submit` is the concurrency lock: two clicks never submit twice.
 */
@Injectable()
export class ClearanceService implements OnModuleInit {
  private readonly log = new Logger('Clearance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
    private readonly notify: NotificationsService,
    private readonly jobs: JobsService,
    private readonly billing: BillingService,
    @Inject(ACCESS_POINT) private readonly accessPoint: AccessPointProvider,
  ) {}

  onModuleInit() {
    this.jobs.register(RETRY_JOB, (payload: { invoiceId: string }) => this.retry(payload.invoiceId));
  }

  private workspace(): Promise<Workspace> {
    return this.prisma.scoped().workspace.findUniqueOrThrow({ where: { id: requireWorkspaceId() } });
  }

  /** E3-2: run the pre-submission check without submitting. */
  async validate(id: string): Promise<{ ok: boolean; errors: PlainError[] }> {
    const inv = await this.invoices.getRaw(id);
    const errors = validateForSubmission(inv, await this.workspace(), inv.customer ?? null, {
      remainingCreditable: inv.originalInvoiceId
        ? await this.invoices.remainingCreditable(inv.originalInvoiceId, inv.id)
        : undefined,
    });
    return { ok: errors.length === 0, errors };
  }

  /** E9-3: at or above the workspace's threshold, a second person must approve before it goes to NRS. */
  private overThreshold(ws: Workspace, inv: InvoiceWithRelations) {
    return ws.approvalThreshold !== null && num(inv.total) >= num(ws.approvalThreshold);
  }

  /** The person who sent an over-threshold invoice for approval can't also approve it. */
  private assertNotSelfApproval(ws: Workspace, inv: InvoiceWithRelations) {
    if (this.overThreshold(ws, inv) && inv.submittedBy && inv.submittedBy === requireUserId()) {
      throw forbidden(
        `Invoices of ₦${num(ws.approvalThreshold).toLocaleString('en-NG')} or more need a second person to approve them. Ask another owner or approver.`,
        'SECOND_APPROVER_REQUIRED',
      );
    }
  }

  /** Clerks may only send invoices for approval; without an approval rule that applies, they can't submit. */
  async submitChecked(id: string) {
    if (!can(ctx().role, 'invoices.submit')) {
      const ws = await this.workspace();
      const inv = await this.invoices.getRaw(id);
      if (!ws.approvalRequired && !this.overThreshold(ws, inv)) {
        throw forbidden(
          'Your role can prepare invoices but not submit them. Ask an owner, admin or approver to submit it.',
          'SUBMIT_NOT_ALLOWED',
        );
      }
    }
    return this.submit(id);
  }

  /** E3-3: one-click submit. Returns the invoice in its new state. */
  async submit(id: string) {
    const inv = await this.invoices.getRaw(id);
    if (['submitting', 'queued', 'cleared'].includes(inv.status)) return invoiceDto(inv); // idempotent re-click

    const ws = await this.workspace();
    const { errors } = await this.validate(id);
    if (errors.length) throw unprocessable('Fix these before submitting.', errors, 'PRE_SUBMISSION_FAILED');

    const role = ctx().role;
    const needsApproval =
      inv.status !== 'pending_approval' &&
      ((ws.approvalRequired && !can(role, 'invoices.approve')) || this.overThreshold(ws, inv));
    if (needsApproval) {
      const moved = await this.prisma.scoped().invoice.updateMany({
        where: { id, status: { in: ['draft', 'rejected', 'failed'] } },
        data: { status: 'pending_approval', submittedBy: requireUserId() },
      });
      if (!moved.count)
        throw conflict('This invoice changed while you were working on it. Refresh and try again.', 'STALE');
      await this.audit.record({
        entity: 'invoice',
        entityId: id,
        action: 'invoice.approval_requested',
        detail: this.overThreshold(ws, inv)
          ? { reason: 'over_threshold', threshold: num(ws.approvalThreshold) }
          : undefined,
      });
      await this.notifyApprovers(ws, inv);
      return invoiceDto(await this.invoices.getRaw(id));
    }
    if (inv.status === 'pending_approval' && !can(role, 'invoices.approve')) {
      throw forbidden('This invoice is waiting for an approver.', 'AWAITING_APPROVAL');
    }
    if (inv.status === 'pending_approval') this.assertNotSelfApproval(ws, inv);
    return this.startClearance(inv, ws, inv.status === 'pending_approval');
  }

  /** E6-3/E9-3 groundwork: an approver releases a pending invoice for clearance. */
  async approve(id: string) {
    const inv = await this.invoices.getRaw(id);
    if (inv.status !== 'pending_approval')
      throw conflict('This invoice is not waiting for approval.', 'NOT_PENDING');
    const ws = await this.workspace();
    this.assertNotSelfApproval(ws, inv);
    const { errors } = await this.validate(id);
    if (errors.length) throw unprocessable('Fix these before approving.', errors, 'PRE_SUBMISSION_FAILED');
    return this.startClearance(inv, ws, true);
  }

  async rejectApproval(id: string, reason: string) {
    const moved = await this.prisma.scoped().invoice.updateMany({
      where: { id, status: 'pending_approval' },
      data: {
        status: 'draft',
        lastErrors: [{ code: 'APP-APPROVAL', field: null, message: `Sent back by approver: ${reason}` }],
      },
    });
    if (!moved.count) throw conflict('This invoice is not waiting for approval.', 'NOT_PENDING');
    await this.audit.record({
      entity: 'invoice',
      entityId: id,
      action: 'invoice.approval_declined',
      detail: { reason },
    });
    return this.invoices.get(id);
  }

  private async startClearance(inv: InvoiceWithRelations, ws: Workspace, approved: boolean) {
    const userId = requireUserId();
    await this.billing.assertCanSend(ws); // E10: trial or plan limit; drafts and approvals are never blocked
    const number = inv.number ?? (await this.nextNumber(ws, inv.docType));
    const customer = inv.customer!;
    const buyer: Party = {
      name: customer.name,
      tin: customer.tin,
      address: customer.address,
      email: customer.email,
      phone: customer.phone,
      kind: customer.kind as Party['kind'],
    };
    const seller = {
      ...sellerParty(ws),
      tradingName: ws.tradingName,
      bankName: ws.bankName,
      bankAccountName: ws.bankAccountName,
      bankAccountLast4: ws.bankAccountLast4,
      bankAccountEnc: ws.bankAccountEnc ? ws.bankAccountEnc : null,
      invoiceTerms: ws.invoiceTerms,
    };
    const moved = await this.prisma.scoped().invoice.updateMany({
      where: { id: inv.id, status: { in: ['draft', 'rejected', 'failed', 'pending_approval'] } },
      data: {
        status: 'submitting',
        number,
        buyerSnapshot: buyer as unknown as Prisma.InputJsonValue,
        sellerSnapshot: seller as unknown as Prisma.InputJsonValue,
        submittedBy: approved ? (inv.submittedBy ?? userId) : userId,
        approvedBy: approved ? userId : null,
        firstAttemptAt: new Date(),
        attempts: 0,
        lastErrors: Prisma.DbNull,
      },
    });
    if (!moved.count) throw conflict('This invoice is already being submitted.', 'STALE');
    await this.audit.record({
      entity: 'invoice',
      entityId: inv.id,
      action: approved ? 'invoice.approved_and_submitted' : 'invoice.submitted',
      detail: { number, total: num(inv.total) },
    });
    await this.attempt(inv.id);
    return invoiceDto(await this.invoices.getRaw(inv.id));
  }

  private async nextNumber(ws: Workspace, docType: string) {
    const field =
      docType === 'credit_note' ? 'seqCredit' : docType === 'debit_note' ? 'seqDebit' : 'seqInvoice';
    const updated = await this.prisma.scoped().workspace.update({
      where: { id: ws.id },
      data: { [field]: { increment: 1 } },
      select: { seqInvoice: true, seqCredit: true, seqDebit: true },
    });
    const n = updated[field as keyof typeof updated];
    const prefix =
      docType === 'invoice' ? ws.invoicePrefix : NUMBER_PREFIX[docType as keyof typeof NUMBER_PREFIX];
    return `${prefix}-${String(n).padStart(6, '0')}`;
  }

  /** Builds the MBS request from the frozen snapshots, so retries send exactly the same document. */
  private buildRequest(inv: InvoiceWithRelations): ClearanceRequest {
    const seller = inv.sellerSnapshot as unknown as ClearanceRequest['seller'];
    const lines = [...inv.lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        description: l.description,
        quantity: num(l.quantity),
        unitPrice: num(l.unitPrice),
        discount: num(l.discount),
        vatTreatment: l.vatTreatment,
        vatRate: num(l.vatRate),
        net: num(l.net),
        vat: num(l.vat),
      }));
    const base = {
      docType: inv.docType as ClearanceRequest['docType'],
      number: inv.number!,
      issueDate: isoDay(inv.issueDate)!,
      dueDate: isoDay(inv.dueDate),
      seller: {
        name: seller.name,
        tin: seller.tin,
        tinVerified: seller.tinVerified,
        address: seller.address,
      },
      buyer: inv.buyerSnapshot as unknown as Party,
      original: inv.originalInvoice?.irn
        ? { irn: inv.originalInvoice.irn, number: inv.originalInvoice.number! }
        : null,
      lines,
      totals: {
        subtotal: num(inv.subtotal),
        discountTotal: num(inv.discountTotal),
        vatTotal: num(inv.vatTotal),
        total: num(inv.total),
      },
    };
    const ublXml = buildUbl(base);
    // Same document ⇒ same key ⇒ MBS returns the same IRN on retry (NFR-4: no duplicate IRNs).
    return { ...base, ublXml, sandbox: false, idempotencyKey: `${inv.id}:${sha256(ublXml).slice(0, 32)}` };
  }

  /** One attempt against MBS. Records the outcome and schedules a retry if MBS/APP is unavailable. */
  async attempt(id: string) {
    const inv = await this.invoices.getRaw(id);
    if (inv.status !== 'submitting' && inv.status !== 'queued') return;
    const req = this.buildRequest(inv);
    const attemptNo = inv.attempts + 1;
    const started = Date.now();
    let result: ClearanceResult | null = null;
    let unavailable: Error | null = null;
    try {
      result = await withTimeout(this.accessPoint.clear(req), PROVIDER_TIMEOUT_MS);
    } catch (err) {
      unavailable = err as Error;
      if (!(err instanceof ProviderUnavailableError))
        this.log.error({ err, invoiceId: id }, 'Unexpected provider error; treating as unavailable');
    }
    const durationMs = Date.now() - started;
    const db = this.prisma.scoped();
    await db.clearanceAttempt.create({
      data: {
        workspaceId: inv.workspaceId,
        invoiceId: id,
        attempt: attemptNo,
        outcome: result?.status ?? 'unavailable',
        requestHash: sha256(req.ublXml),
        response: (result ?? { error: unavailable?.message }) as unknown as Prisma.InputJsonValue,
        durationMs,
      },
    });

    if (result?.status === 'cleared') {
      await db.invoice.update({
        where: { id },
        data: {
          status: 'cleared',
          irn: result.irn,
          qrPayload: result.qrPayload,
          clearedAt: new Date(),
          idempotencyKey: req.idempotencyKey,
          attempts: attemptNo,
          nextAttemptAt: null,
          lastErrors: Prisma.DbNull,
        },
      });
      await this.audit.record({
        entity: 'invoice',
        entityId: id,
        action: 'invoice.cleared',
        detail: { irn: result.irn, attempt: attemptNo, durationMs },
      });
      return;
    }

    if (result?.status === 'rejected') {
      const errors = result.errors.map(explainNrsError);
      await db.invoice.update({
        where: { id },
        data: {
          status: 'rejected',
          attempts: attemptNo,
          nextAttemptAt: null,
          lastErrors: errors as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.record({
        entity: 'invoice',
        entityId: id,
        action: 'invoice.rejected',
        detail: { codes: result.errors },
      });
      return;
    }

    // Unavailable: queue with backoff for up to 72 hours (E3-7, NFR-4).
    const started0 = inv.firstAttemptAt?.getTime() ?? Date.now();
    if (Date.now() - started0 > RETRY_WINDOW_MS) {
      await db.invoice.update({
        where: { id },
        data: {
          status: 'failed',
          attempts: attemptNo,
          nextAttemptAt: null,
          lastErrors: [
            {
              code: 'APP-UNAVAILABLE',
              field: null,
              message: 'The tax authority was unreachable for 72 hours. Submit again to retry.',
            },
          ],
        },
      });
      await this.audit.record({
        entity: 'invoice',
        entityId: id,
        action: 'invoice.failed',
        detail: { attempts: attemptNo },
      });
      await this.notifyFailure(inv);
      return;
    }
    const nextAt = new Date(Date.now() + nextRetryDelayMs(attemptNo));
    await db.invoice.update({
      where: { id },
      data: { status: 'queued', attempts: attemptNo, nextAttemptAt: nextAt },
    });
    await this.jobs.enqueue(
      RETRY_JOB,
      { invoiceId: id },
      { runAt: nextAt, workspaceId: inv.workspaceId, dedupeKey: `clear:${id}:${attemptNo}` },
    );
    if (attemptNo === 1) {
      await this.audit.record({
        entity: 'invoice',
        entityId: id,
        action: 'invoice.queued',
        detail: { reason: unavailable?.message, nextAttemptAt: nextAt },
      });
    }
  }

  /** Job handler: runs in the invoice's workspace context (set by JobsService). */
  async retry(invoiceId: string) {
    await this.attempt(invoiceId);
  }

  private async notifyApprovers(ws: Workspace, inv: InvoiceWithRelations) {
    const approvers = await this.prisma.scoped().membership.findMany({
      where: { workspaceId: ws.id, role: { in: ['owner', 'approver'] }, userId: { not: requireUserId() } },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: approvers.map((a) => a.userId) } } });
    const why = this.overThreshold(ws, inv)
      ? ` It is above your ₦${num(ws.approvalThreshold).toLocaleString('en-NG')} approval limit.`
      : '';
    const body = `${ctx().userName ?? 'A colleague'} sent an invoice for ₦${num(inv.total).toLocaleString('en-NG')} to ${inv.customer?.name ?? 'a customer'} for approval.${why} Review and approve it here: ${env().PUBLIC_APP_URL}/w/${ws.id}/invoices/${inv.id}`;
    // E9-3: approvers hear by email and WhatsApp.
    for (const u of users) {
      if (u.email)
        await this.notify.send({
          workspaceId: ws.id,
          channel: 'email',
          recipient: u.email,
          subject: 'An invoice is waiting for your approval',
          body,
        });
      if (u.phone)
        await this.notify.send({ workspaceId: ws.id, channel: 'whatsapp', recipient: u.phone, body });
    }
  }

  private async notifyFailure(inv: InvoiceWithRelations) {
    const owners = await this.prisma
      .scoped()
      .membership.findMany({ where: { workspaceId: inv.workspaceId, role: { in: ['owner', 'admin'] } } });
    const ids = [...owners.map((o) => o.userId), inv.createdBy];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids }, email: { not: null } } });
    for (const u of users) {
      await this.notify.send({
        workspaceId: inv.workspaceId,
        channel: 'email',
        recipient: u.email!,
        subject: `Invoice ${inv.number} could not be cleared`,
        body: `We tried for 72 hours but the tax authority was unreachable. Open invoice ${inv.number} and submit it again.`,
      });
    }
  }
}
