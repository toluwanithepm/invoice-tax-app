import { Inject, Injectable } from '@nestjs/common';
import type { Workspace } from '@prisma/client';
import { TRIAL_DAYS, planState, taxBand, type WorkspaceCreate, type WorkspaceUpdate } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import {
  ACCESS_POINT,
  TAX_ID_REGISTRY,
  type AccessPointProvider,
  type TaxIdRegistry,
} from '../access-point/access-point';
import { buildUbl } from '../access-point/ubl';
import { badRequest, forbidden, notFound } from '../common/errors';
import { decrypt, encrypt, uuidv7 } from '../common/crypto';
import { num, numOrNull } from '../common/zod';
import { ctx, requireUserId, requireWorkspaceId, setCtx } from '../common/request-context';
import { BillingService } from '../billing/billing.service';

const sameName = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

export function workspaceDto(w: Workspace, opts: { revealBank?: boolean } = {}) {
  const band = taxBand(numOrNull(w.turnover));
  return {
    id: w.id,
    legalName: w.legalName,
    tradingName: w.tradingName,
    tin: w.tin,
    tinVerified: !!w.tinVerifiedAt,
    registryName: w.registryName,
    nameMismatch: !!w.registryName && !sameName(w.registryName, w.legalName),
    address: w.address,
    email: w.email,
    phone: w.phone,
    turnover: numOrNull(w.turnover),
    taxBand: band,
    hasLogo: !!w.logo,
    brandColor: w.brandColor,
    bankName: w.bankName,
    bankAccountNumber: opts.revealBank && w.bankAccountEnc ? decrypt(w.bankAccountEnc) : null,
    bankAccountLast4: w.bankAccountLast4,
    bankAccountName: w.bankAccountName,
    invoiceTerms: w.invoiceTerms,
    invoicePrefix: w.invoicePrefix,
    mbsStatus: w.mbsStatus,
    mbsTestIrn: w.mbsTestIrn,
    approvalRequired: w.approvalRequired,
    approvalThreshold: numOrNull(w.approvalThreshold),
    require2fa: w.require2fa,
    b2cEnabled: w.b2cEnabled,
    plan: w.plan,
    trialEndsAt: w.trialEndsAt?.toISOString() ?? null,
    planStatus: planState(w).status,
    createdAt: w.createdAt.toISOString(),
  };
}

/** Seller party as it is sent to MBS and frozen on each submitted invoice. */
export function sellerParty(w: Workspace) {
  return {
    name: w.legalName,
    tin: w.tin,
    tinVerified: !!w.tinVerifiedAt,
    address: w.address,
    email: w.email,
    phone: w.phone,
  };
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(TAX_ID_REGISTRY) private readonly registry: TaxIdRegistry,
    @Inject(ACCESS_POINT) private readonly accessPoint: AccessPointProvider,
  ) {}

  /** E1-2: create the business and verify its Tax ID in one step, pre-filling from the registry. */
  async create(input: WorkspaceCreate) {
    const userId = requireUserId();
    const id = uuidv7();
    const record = await this.registry.lookup(input.tin);
    const ws = await this.prisma.scopedTx(
      async (tx) => {
        const w = await tx.workspace.create({
          data: {
            id,
            legalName: input.legalName,
            tin: input.tin,
            turnover: input.turnover ?? null,
            tinVerifiedAt: record.found ? new Date() : null,
            registryName: record.legalName ?? null,
            address: record.address ?? null,
            trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
          },
        });
        await tx.membership.create({ data: { workspaceId: id, userId, role: 'owner' } });
        return w;
      },
      { workspaceId: id, userId },
    );
    setCtx({ workspaceId: id, role: 'owner' });
    await this.audit.record({
      entity: 'workspace',
      entityId: id,
      action: 'workspace.created',
      detail: { tinVerified: record.found },
    });
    return workspaceDto(ws);
  }

  async get(opts: { revealBank?: boolean } = {}) {
    const w = await this.prisma.scoped().workspace.findUnique({ where: { id: requireWorkspaceId() } });
    if (!w) throw notFound('That workspace');
    return workspaceDto(w, opts);
  }

  async raw() {
    const w = await this.prisma.scoped().workspace.findUnique({ where: { id: requireWorkspaceId() } });
    if (!w) throw notFound('That workspace');
    return w;
  }

  async update(input: WorkspaceUpdate) {
    const id = requireWorkspaceId();
    if (input.approvalThreshold != null) {
      const current = await this.raw();
      if (!BillingService.allowsApprovalRules(current)) {
        throw forbidden(
          'Approval for large invoices is part of the Business and Pro plans. Upgrade to turn it on.',
          'PLAN_FEATURE',
        );
      }
    }
    const { bankAccountNumber, legalName, ...rest } = input;
    const data: Record<string, unknown> = { ...rest };
    if (legalName !== undefined) data.legalName = legalName;
    if (bankAccountNumber !== undefined) {
      data.bankAccountEnc = bankAccountNumber ? encrypt(bankAccountNumber) : null;
      data.bankAccountLast4 = bankAccountNumber ? bankAccountNumber.slice(-4) : null;
    }
    const w = await this.prisma.scoped().workspace.update({ where: { id }, data });
    await this.audit.record({
      entity: 'workspace',
      entityId: id,
      action: 'workspace.updated',
      detail: {
        fields: Object.keys(input).map((k) => (k === 'bankAccountNumber' ? 'bankAccountNumber(masked)' : k)),
      },
    });
    return workspaceDto(w);
  }

  /** E1-2: re-check the Tax ID against NRS; reports a name mismatch clearly. */
  async verifyTin() {
    const w = await this.raw();
    const record = await this.registry.lookup(w.tin);
    const updated = await this.prisma.scoped().workspace.update({
      where: { id: w.id },
      data: {
        tinVerifiedAt: record.found ? (w.tinVerifiedAt ?? new Date()) : null,
        registryName: record.legalName ?? null,
        address: w.address ?? record.address ?? null,
      },
    });
    await this.audit.record({
      entity: 'workspace',
      entityId: w.id,
      action: 'workspace.tin_verified',
      detail: { found: record.found },
    });
    return {
      found: record.found,
      registryName: record.legalName ?? null,
      registryAddress: record.address ?? null,
      workspace: workspaceDto(updated),
      message: record.found
        ? record.legalName && !sameName(record.legalName, w.legalName)
          ? `NRS has this Tax ID registered to "${record.legalName}". Use that name so your invoices aren't rejected.`
          : 'Tax ID verified with NRS.'
        : "We couldn't find this Tax ID with NRS. Check the number on your TIN certificate.",
    };
  }

  async setLogo(file: Express.Multer.File | undefined) {
    if (!file)
      throw badRequest('Choose a PNG or JPEG image.', [
        { field: 'logo', message: 'Choose a PNG or JPEG image.' },
      ]);
    const b = file.buffer;
    const isPng = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const isJpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (!isPng && !isJpeg)
      throw badRequest('The logo must be a PNG or JPEG image.', [
        { field: 'logo', message: 'Use a PNG or JPEG image.' },
      ]);
    if (b.length > 300 * 1024)
      throw badRequest('The logo must be smaller than 300 KB.', [
        { field: 'logo', message: 'Use an image under 300 KB.' },
      ]);
    await this.prisma.scoped().workspace.update({
      where: { id: requireWorkspaceId() },
      data: { logo: b, logoMime: isPng ? 'image/png' : 'image/jpeg' },
    });
    await this.audit.record({
      entity: 'workspace',
      entityId: requireWorkspaceId(),
      action: 'workspace.logo_updated',
    });
    return { ok: true };
  }

  async getLogo() {
    const w = await this.prisma.scoped().workspace.findUnique({
      where: { id: requireWorkspaceId() },
      select: { logo: true, logoMime: true },
    });
    if (!w?.logo) throw notFound('A logo');
    return { data: Buffer.from(w.logo), mime: w.logoMime ?? 'image/png' };
  }

  // ── E1-3: MBS connection wizard ────────────────────────────────────

  async mbsConnect() {
    const w = await this.raw();
    if (!w.tinVerifiedAt)
      throw badRequest('Verify your Tax ID before connecting to MBS.', [], 'TIN_NOT_VERIFIED');
    const r = await this.accessPoint.connectTaxpayer(w.tin);
    const updated = await this.prisma.scoped().workspace.update({
      where: { id: w.id },
      data: { mbsStatus: w.mbsStatus === 'not_connected' ? 'sandbox' : w.mbsStatus },
    });
    await this.audit.record({
      entity: 'workspace',
      entityId: w.id,
      action: 'mbs.connected',
      detail: { reference: r.reference },
    });
    return workspaceDto(updated);
  }

  /** Clears a sample invoice in the sandbox to prove the connection end-to-end. */
  async mbsTest() {
    const w = await this.raw();
    if (w.mbsStatus === 'not_connected') throw badRequest('Connect to MBS first.', [], 'MBS_NOT_CONNECTED');
    const today = new Date().toISOString().slice(0, 10);
    const base = {
      docType: 'invoice' as const,
      number: 'TEST-0001',
      issueDate: today,
      dueDate: null,
      seller: sellerParty(w),
      buyer: { name: 'MBS Sandbox Buyer', tin: '23456789-0001', address: 'Sandbox', kind: 'B2B' as const },
      original: null,
      lines: [
        {
          description: 'Sandbox test item',
          quantity: 1,
          unitPrice: 1000,
          discount: 0,
          vatTreatment: 'standard',
          vatRate: 0.075,
          net: 1000,
          vat: 75,
        },
      ],
      totals: { subtotal: 1000, discountTotal: 0, vatTotal: 75, total: 1075 },
    };
    const result = await this.accessPoint.clear({
      ...base,
      idempotencyKey: `sbx-${uuidv7()}`,
      sandbox: true,
      ublXml: buildUbl(base),
    });
    if (result.status !== 'cleared') {
      return { passed: false, errors: result.errors, workspace: workspaceDto(w) };
    }
    const updated = await this.prisma.scoped().workspace.update({
      where: { id: w.id },
      data: { mbsStatus: w.mbsStatus === 'live' ? 'live' : 'sandbox_passed', mbsTestIrn: result.irn },
    });
    await this.audit.record({
      entity: 'workspace',
      entityId: w.id,
      action: 'mbs.sandbox_test_passed',
      detail: { irn: result.irn },
    });
    return { passed: true, irn: result.irn, workspace: workspaceDto(updated) };
  }

  async mbsGoLive() {
    const w = await this.raw();
    if (w.mbsStatus !== 'sandbox_passed' && w.mbsStatus !== 'live') {
      throw badRequest('Clear a test invoice in the sandbox before going live.', [], 'SANDBOX_NOT_PASSED');
    }
    const updated = await this.prisma.scoped().workspace.update({
      where: { id: w.id },
      data: { mbsStatus: 'live', mbsLiveAt: w.mbsLiveAt ?? new Date() },
    });
    await this.audit.record({ entity: 'workspace', entityId: w.id, action: 'mbs.live' });
    return workspaceDto(updated);
  }

  /** Dashboard data (E1-5 deadline card + invoice status counts + onboarding checklist). */
  async summary() {
    const w = await this.raw();
    const db = this.prisma.scoped();
    const monthStart = new Date(new Date().toISOString().slice(0, 8) + '01T00:00:00Z');
    const [byStatus, clearedThisMonth, customers, products] = await Promise.all([
      db.invoice.groupBy({ by: ['status'], _count: { _all: true } }),
      db.invoice.aggregate({
        where: { status: 'cleared', clearedAt: { gte: monthStart } },
        _sum: { total: true, vatTotal: true },
        _count: { _all: true },
      }),
      db.customer.count({ where: { archivedAt: null } }),
      db.product.count({ where: { archivedAt: null } }),
    ]);
    const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    return {
      workspace: workspaceDto(w),
      counts,
      thisMonth: {
        clearedCount: clearedThisMonth._count._all,
        clearedTotal: num(clearedThisMonth._sum.total),
        outputVat: num(clearedThisMonth._sum.vatTotal),
      },
      checklist: {
        tinVerified: !!w.tinVerifiedAt,
        branding: !!w.bankAccountEnc,
        mbsLive: w.mbsStatus === 'live',
        hasCustomer: customers > 0,
        hasProduct: products > 0,
        firstInvoiceCleared: (counts.cleared ?? 0) > 0,
      },
      role: ctx().role,
    };
  }
}
