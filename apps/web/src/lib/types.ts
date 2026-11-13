import type { InvoiceStatus, Role, VatTreatment } from '@einv/shared';

export interface Me {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  twoFactorEnabled: boolean;
  mfaVerified: boolean;
  workspaces: { id: string; name: string; role: Role; mbsStatus: MbsStatus; viaFirmId: string | null }[];
  firms: { id: string; name: string; role: 'admin' | 'accountant' }[];
}

export type MbsStatus = 'not_connected' | 'sandbox' | 'sandbox_passed' | 'live';

export interface Workspace {
  id: string;
  legalName: string;
  tradingName: string | null;
  tin: string;
  tinVerified: boolean;
  registryName: string | null;
  nameMismatch: boolean;
  address: string | null;
  email: string | null;
  phone: string | null;
  turnover: number | null;
  taxBand: { band: string; goLive: string } | null;
  hasLogo: boolean;
  brandColor: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountLast4: string | null;
  bankAccountName: string | null;
  invoiceTerms: string | null;
  invoicePrefix: string;
  mbsStatus: MbsStatus;
  mbsTestIrn: string | null;
  approvalRequired: boolean;
  approvalThreshold: number | null;
  require2fa: boolean;
  b2cEnabled: boolean;
  plan: string;
  trialEndsAt: string | null;
  planStatus: PlanStatus;
}

export interface Customer {
  id: string;
  name: string;
  kind: 'B2B' | 'B2G';
  tin: string;
  registryName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  unitPrice: number;
  vatTreatment: VatTreatment;
}

export interface PlainError {
  code?: string;
  field: string | null;
  message: string;
}

export interface InvoiceSummary {
  id: string;
  docType: 'invoice' | 'credit_note' | 'debit_note';
  number: string | null;
  status: InvoiceStatus;
  statusLabel: string;
  customerName: string | null;
  issueDate: string;
  dueDate: string | null;
  total: number;
  vatTotal: number;
  irn: string | null;
  clearedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface InvoiceLine {
  id?: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  vatTreatment: VatTreatment;
  vatRate?: number;
  net?: number;
  vat?: number;
}

export interface Invoice extends InvoiceSummary {
  editable: boolean;
  customerId: string | null;
  customer: Customer | null;
  buyer: { name: string; tin: string; address: string | null; email?: string | null } | null;
  originalInvoice: { id: string; number: string; irn: string; total: number } | null;
  adjustments: InvoiceSummary[];
  reason: string | null;
  notes: string | null;
  subtotal: number;
  discountTotal: number;
  netTotal: number;
  lines: InvoiceLine[];
  qrPayload: string | null;
  errors: PlainError[];
  attempts: number;
  submittedBy: string | null;
  nextAttemptAt: string | null;
  history: { attempt: number; outcome: string; at: string; durationMs: number }[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AuditEvent {
  id: string;
  actorName: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

// ── Billing (E10) ────────────────────────────────────────────────────
export type PlanStatus = 'trialing' | 'trial_ended' | 'active' | 'past_due' | 'lapsed';
export interface BillingSummary {
  plan: 'trial' | 'starter' | 'business' | 'pro';
  planName: string;
  interval: 'monthly' | 'yearly' | null;
  status: PlanStatus;
  statusLabel: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  autoRenew: boolean;
  billingEmail: string | null;
  nextPlan: 'starter' | 'business' | 'pro' | null;
  nextInterval: 'monthly' | 'yearly' | null;
  card: { last4: string; brand: string | null; expiry: string | null } | null;
  usage: { used: number; limit: number | null; share: number | null; since: string; warn: boolean };
  canSend: boolean;
  block: { code: string; message: string } | null;
  checkoutAvailable: boolean;
  testMode: boolean;
}
export interface PaymentRow {
  id: string;
  reference: string;
  kind: 'checkout' | 'renewal';
  plan: string;
  planName: string;
  interval: string;
  amount: number;
  credit: number;
  status: 'success' | 'failed' | 'refund_pending' | 'refunded' | 'refund_failed';
  channel: string | null;
  failureReason: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  receiptNumber: string | null;
  createdAt: string;
}
export interface IrnCheck {
  valid: boolean;
  irn: string | null;
  reason?: 'not_found' | 'not_an_irn';
  sellerTin?: string | null;
  sellerName?: string | null;
  total?: number | null;
  issueDate?: string | null;
}
