import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { isValidTin, lagosToday } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccessPointProvider,
  B2cReportRequest,
  B2cReportResult,
  ClearanceRequest,
  ClearanceResult,
  ProviderUnavailableError,
  TaxIdRecord,
  TaxIdRegistry,
} from './access-point';

/** Rules MBS applies on receipt. Our pre-submission check (clearance/validation.ts) mirrors them. */
export function mbsRules(r: ClearanceRequest): string[] {
  const errs = new Set<string>();
  if (!r.seller.tin || !isValidTin(r.seller.tin) || !r.seller.tinVerified) errs.add('NRS-E101');
  if (!r.buyer) errs.add('NRS-E102');
  else if (r.buyer.kind !== 'B2C' && !isValidTin(r.buyer.tin)) errs.add('NRS-E103');
  if (r.lines.length === 0) errs.add('NRS-E104');
  if (r.lines.some((l) => !['standard', 'zero', 'exempt'].includes(l.vatTreatment))) errs.add('NRS-E105');
  if (r.lines.some((l) => !(l.quantity > 0) || !(l.unitPrice > 0))) errs.add('NRS-E109');
  const kobo = (n: number) => Math.round(n * 100);
  const net = r.lines.reduce((s, l) => s + kobo(l.net), 0);
  const vat = r.lines.reduce((s, l) => s + kobo(l.vat), 0);
  if (net + vat !== kobo(r.totals.total) || vat !== kobo(r.totals.vatTotal)) errs.add('NRS-E106');
  if (r.issueDate > new Date().toISOString().slice(0, 10)) errs.add('NRS-E107');
  if (r.docType !== 'invoice' && !r.original?.irn) errs.add('NRS-E108');
  return [...errs];
}

/** Rules MBS applies to a daily B2C batch. */
export function b2cRules(r: B2cReportRequest): string[] {
  const errs = new Set<string>();
  if (!isValidTin(r.sellerTin)) errs.add('NRS-E101');
  if (r.salesDate > lagosToday()) errs.add('NRS-E107');
  if (!r.noSales && r.rows.length === 0) errs.add('NRS-E104');
  const k = (n: number) => Math.round(n * 100);
  if (r.rows.some((x) => k(x.net) + k(x.vat) !== k(x.gross))) errs.add('NRS-E106');
  const sum = (f: (x: B2cReportRequest['rows'][number]) => number) => r.rows.reduce((s, x) => s + k(f(x)), 0);
  if (sum((x) => x.gross) !== k(r.totals.gross) || sum((x) => x.vat) !== k(r.totals.vat)) errs.add('NRS-E106');
  if (new Set(r.rows.map((x) => x.receiptNo)).size !== r.rows.length) errs.add('NRS-E113');
  return [...errs];
}

/**
 * Sandbox stand-in for NRS MBS. Issues IRNs in the published shape
 * (<invoice no>-<service id>-<YYYYMMDD>), signs a QR payload, rejects with NRS-style codes,
 * stays idempotent, and can simulate an outage to exercise the retry queue.
 */
@Injectable()
export class MockAccessPoint implements AccessPointProvider {
  static outage = false;
  /** Test/dev hook: make the next clearance calls reject with these NRS codes. */
  static forceErrors: string[] | null = null;
  constructor(private readonly prisma: PrismaService) {}

  private serviceId(tin: string) {
    return createHash('sha256').update(tin).digest('hex').slice(0, 8).toUpperCase();
  }

  async connectTaxpayer(tin: string) {
    this.checkUp();
    return { ok: true as const, reference: `APP-${this.serviceId(tin)}` };
  }

  async clear(r: ClearanceRequest): Promise<ClearanceResult> {
    this.checkUp();
    const prior = await this.prisma.mockMbsDocument.findUnique({ where: { idempotencyKey: r.idempotencyKey } });
    if (prior) return { status: 'cleared', irn: prior.irn, qrPayload: this.qr(prior.irn, r), duplicate: true };

    const errors = MockAccessPoint.forceErrors ?? mbsRules(r);
    if (errors.length) return { status: 'rejected', errors };

    const base = `${r.number.replace(/[^A-Za-z0-9]/g, '')}-${this.serviceId(r.seller.tin!)}-${r.issueDate.replace(/-/g, '')}`;
    // Sandbox IRNs are marked and made unique so repeated test invoices never collide with live ones.
    const irn = r.sandbox ? `SBX-${base}-${r.idempotencyKey.slice(-6).toUpperCase()}` : base;
    await this.prisma.mockMbsDocument.create({
      data: {
        irn,
        idempotencyKey: r.idempotencyKey,
        sellerTin: r.seller.tin!,
        buyerTin: r.buyer?.tin ?? null,
        docType: r.docType,
        total: r.totals.total,
        issueDate: r.issueDate,
        sandbox: r.sandbox,
      },
    });
    return { status: 'cleared', irn, qrPayload: this.qr(irn, r) };
  }

  async reportB2C(r: B2cReportRequest): Promise<B2cReportResult> {
    this.checkUp();
    const prior = await this.prisma.mockMbsDocument.findUnique({ where: { idempotencyKey: r.idempotencyKey } });
    if (prior) return { status: 'accepted', reference: prior.irn, duplicate: true };
    const errors = MockAccessPoint.forceErrors ?? b2cRules(r);
    if (errors.length) return { status: 'rejected', errors };
    const reference = `B2C-${this.serviceId(r.sellerTin)}-${r.salesDate.replace(/-/g, '')}-${r.idempotencyKey.slice(-6).toUpperCase()}`;
    await this.prisma.mockMbsDocument.create({
      data: {
        irn: reference,
        idempotencyKey: r.idempotencyKey,
        sellerTin: r.sellerTin,
        buyerTin: null,
        docType: 'b2c_daily',
        total: r.totals.gross,
        issueDate: r.salesDate,
        sandbox: false,
      },
    });
    return { status: 'accepted', reference };
  }

  async lookupIrn(irn: string) {
    this.checkUp();
    const d = await this.prisma.mockMbsDocument.findUnique({ where: { irn: irn.trim() } });
    if (!d || d.sandbox) return { valid: false };
    return { valid: true, sellerTin: d.sellerTin, total: Number(d.total), issueDate: d.issueDate };
  }

  /** QR content: IRN + key facts + a signature the buyer's verifier can check against MBS. */
  private qr(irn: string, r: ClearanceRequest) {
    const body = { irn, seller_tin: r.seller.tin, buyer_tin: r.buyer?.tin ?? null, total: r.totals.total, issue_date: r.issueDate };
    const sig = createHmac('sha256', 'mock-mbs').update(JSON.stringify(body)).digest('base64url').slice(0, 22);
    return Buffer.from(JSON.stringify({ ...body, sig })).toString('base64url');
  }

  private checkUp() {
    if (MockAccessPoint.outage) throw new ProviderUnavailableError();
  }
}

const MOCK_REGISTRY: Record<string, { legalName: string; address: string }> = {
  '12345678-0001': { legalName: 'Amaka Distribution Ltd', address: '14 Creek Road, Apapa, Lagos' },
  '23456789-0001': { legalName: 'Lekki Retail Buyers Ltd', address: '1 Alfred Rewane Road, Ikoyi, Lagos' },
  '34567890-0001': { legalName: 'Federal Ministry of Works', address: 'Mabushi, Abuja' },
  '45678901-0001': { legalName: 'Kano Agro Supplies Ltd', address: '22 Murtala Mohammed Way, Kano' },
};

/**
 * Mock NRS Tax ID registry (E1-2, E2-1). Seeded TINs return a registered name (to demo the
 * mismatch warning); any other well-formed TIN is treated as registered with no name on file.
 * TINs starting 00000000 are treated as not registered.
 */
@Injectable()
export class MockTaxIdRegistry implements TaxIdRegistry {
  async lookup(tin: string): Promise<TaxIdRecord> {
    if (!isValidTin(tin) || tin.startsWith('00000000')) return { tin, found: false };
    const rec = MOCK_REGISTRY[tin];
    return rec ? { tin, found: true, ...rec } : { tin, found: true };
  }
}
