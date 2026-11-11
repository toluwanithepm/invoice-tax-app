/**
 * Integration seam to NRS MBS through an Access Point Provider (APP).
 * Phase 1 ships MockAccessPoint; a real APP adapter implements the same interface (Phase 4).
 */
export const ACCESS_POINT = Symbol('ACCESS_POINT');
export const TAX_ID_REGISTRY = Symbol('TAX_ID_REGISTRY');

export interface Party {
  name: string;
  tin: string | null;
  address: string | null;
  email?: string | null;
  phone?: string | null;
  kind?: 'B2B' | 'B2G' | 'B2C';
}

export interface ClearanceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  vatTreatment: string;
  vatRate: number;
  net: number;
  vat: number;
}

export interface ClearanceRequest {
  idempotencyKey: string;
  sandbox: boolean;
  docType: 'invoice' | 'credit_note' | 'debit_note';
  number: string;
  issueDate: string; // YYYY-MM-DD
  dueDate: string | null;
  seller: Party & { tinVerified: boolean };
  buyer: Party | null;
  original: { irn: string; number: string } | null;
  lines: ClearanceLine[];
  totals: { subtotal: number; discountTotal: number; vatTotal: number; total: number };
  ublXml: string;
}

export type ClearanceResult =
  | { status: 'cleared'; irn: string; qrPayload: string; duplicate?: boolean }
  | { status: 'rejected'; errors: string[] };

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  constructor(message = 'The tax authority service is not reachable right now.') {
    super(message);
  }
}

export interface AccessPointProvider {
  /** Registers the taxpayer with MBS through the APP (E1-3). */
  connectTaxpayer(tin: string): Promise<{ ok: true; reference: string }>;
  /** Submits a document for clearance. Must be idempotent on idempotencyKey (NFR-4). Throws ProviderUnavailableError. */
  clear(req: ClearanceRequest): Promise<ClearanceResult>;
  /** E5-1: daily batch of retail (B2C) sales. Idempotent on idempotencyKey. Throws ProviderUnavailableError. */
  reportB2C(req: B2cReportRequest): Promise<B2cReportResult>;
  /** E8-1 (Phase 3): IRN lookup. */
  lookupIrn(irn: string): Promise<{ valid: boolean; sellerTin?: string; total?: number; issueDate?: string }>;
}

export interface TaxIdRecord {
  tin: string;
  found: boolean;
  legalName?: string;
  address?: string;
}
export interface TaxIdRegistry {
  lookup(tin: string): Promise<TaxIdRecord>;
}

export interface B2cReportRequest {
  idempotencyKey: string;
  sellerTin: string;
  salesDate: string; // YYYY-MM-DD
  noSales: boolean;
  rows: { receiptNo: string; vatTreatment: string; gross: number; net: number; vat: number }[];
  totals: { gross: number; net: number; vat: number };
}
export type B2cReportResult = { status: 'accepted'; reference: string; duplicate?: boolean } | { status: 'rejected'; errors: string[] };
