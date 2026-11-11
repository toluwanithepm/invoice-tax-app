/** Request schemas shared by the API (validation pipe) and the web app (react-hook-form). */
import { z } from 'zod';
import { VAT_TREATMENTS } from './vat';
import { ROLES } from './roles';
import { TIN_HINT, TIN_PATTERN, normaliseTin } from './nrs';

const trimmed = (max = 200) => z.string().trim().max(max);
const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');
const money = z.coerce.number({ error: 'Enter an amount.' }).min(0, 'Amount cannot be negative.').max(1e12);
const tin = z
  .string()
  .transform(normaliseTin)
  .refine((v) => TIN_PATTERN.test(v), TIN_HINT);

/** Nigerian phone numbers in E.164 (+234…) or local (080…) form. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .transform((v) => (v.startsWith('0') ? '+234' + v.slice(1) : v))
  .refine((v) => /^\+234[789][01]\d{8}$/.test(v), 'Enter a Nigerian mobile number, e.g. 0803 123 4567.');
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);

// ── Auth (E1-1, NFR-7) ───────────────────────────────────────────────
export const otpRequestSchema = z.object({
  channel: z.enum(['email', 'sms']),
  identifier: z.string().trim().min(3).max(254),
  purpose: z.enum(['login', 'signup']).default('login'),
  name: trimmed(120).optional(),
  consent: z.boolean().optional(),
});
export type OtpRequest = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});
export type OtpVerify = z.infer<typeof otpVerifySchema>;

export const totpCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^(\d{6}|[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/, 'Enter the 6-digit code from your authenticator app, or a recovery code.'),
});

// ── Workspace (E1-2 … E1-5) ──────────────────────────────────────────
export const workspaceCreateSchema = z.object({
  legalName: trimmed(200).min(2, 'Enter the registered business name.'),
  tin,
  turnover: money.optional().nullable(),
});
export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

export const workspaceUpdateSchema = z.object({
  legalName: trimmed(200).min(2).optional(),
  tradingName: optionalText(200),
  address: optionalText(400),
  email: emailSchema.optional().nullable(),
  phone: phoneSchema.optional().nullable(),
  turnover: money.optional().nullable(),
  bankName: optionalText(120),
  bankAccountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'A NUBAN account number has 10 digits.')
    .optional()
    .nullable(),
  bankAccountName: optionalText(200),
  invoiceTerms: optionalText(2000),
  invoicePrefix: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,6}$/, 'Use 2–6 capital letters or digits.')
    .optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .nullable(),
  approvalRequired: z.boolean().optional(),
  require2fa: z.boolean().optional(),
});
export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;

export const memberInviteSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES),
});
export const memberRoleSchema = z.object({ role: z.enum(ROLES) });

// ── Customers & products (E2-1, E2-2) ─────────────────────────────────
export const CUSTOMER_KINDS = ['B2B', 'B2G'] as const;
export const customerSchema = z.object({
  name: trimmed(200).min(2, 'Enter the customer name.'),
  kind: z.enum(CUSTOMER_KINDS).default('B2B'),
  tin,
  email: emailSchema.optional().nullable().or(z.literal('').transform(() => null)),
  phone: phoneSchema.optional().nullable().or(z.literal('').transform(() => null)),
  address: optionalText(400),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export const productSchema = z.object({
  name: trimmed(200).min(1, 'Enter a name.'),
  description: optionalText(500),
  unitPrice: money,
  vatTreatment: z.enum(VAT_TREATMENTS, { error: 'Choose a VAT treatment.' }),
  sku: optionalText(64),
});
export type ProductInput = z.infer<typeof productSchema>;

// ── Invoices (E3-1, E4) ───────────────────────────────────────────────
export const invoiceLineSchema = z.object({
  productId: z.string().uuid().optional().nullable(),
  description: trimmed(500),
  quantity: z.coerce.number().min(0).max(1e9),
  unitPrice: money,
  discount: money.default(0),
  vatTreatment: z.enum(VAT_TREATMENTS),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;

/** Drafts may be incomplete; completeness is checked by pre-submission validation (E3-2). */
export const invoiceDraftSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  issueDate: isoDate,
  dueDate: isoDate.optional().nullable(),
  notes: optionalText(2000),
  lines: z.array(invoiceLineSchema).max(500),
});
export type InvoiceDraft = z.infer<typeof invoiceDraftSchema>;

export const adjustmentNoteSchema = z.object({
  reason: trimmed(500).min(3, 'Say why this note is being raised.'),
  issueDate: isoDate,
  lines: z.array(invoiceLineSchema).min(1, 'Add at least one line.').max(500),
});
export type AdjustmentNoteInput = z.infer<typeof adjustmentNoteSchema>;

export const shareSchema = z.object({
  channel: z.enum(['link', 'email', 'whatsapp']),
  recipient: z.string().trim().max(254).optional(),
});

export const listQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  status: z.string().optional(),
});

// ── Import (E2-3) ─────────────────────────────────────────────────────
export const IMPORT_KINDS = ['customers', 'products'] as const;
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_FIELDS = {
  customers: ['name', 'kind', 'tin', 'email', 'phone', 'address'],
  products: ['name', 'description', 'unitPrice', 'vatTreatment', 'sku'],
} as const;
export const importCommitSchema = z.object({
  mapping: z.record(z.string(), z.string()),
});

// ── Reconciliation & reports (E7) ─────────────────────────────────────
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM.');
export const vatDeclarationSchema = z.object({
  declaredVat: money,
  note: optionalText(500),
});
export type VatDeclarationInput = z.infer<typeof vatDeclarationSchema>;
export const markPaidSchema = z.object({ paid: z.boolean(), paidOn: isoDate.optional() });

// ── B2C reporting (E5) ────────────────────────────────────────────────
export const B2C_FIELDS = ['date', 'receiptNo', 'description', 'amount', 'vatTreatment', 'buyerName', 'buyerPhone'] as const;
export const B2C_REQUIRED_FIELDS = ['date', 'receiptNo', 'amount'] as const;
/** One retail sale from a POS export. Buyer details are optional (decision: not required for B2C). */
export const b2cSaleSchema = z.object({
  date: isoDate,
  receiptNo: trimmed(64).min(1, 'Every sale needs a receipt number.'),
  description: optionalText(200),
  amount: z.coerce.number({ error: 'Enter the amount paid.' }).positive('The amount must be more than zero.').max(1e10),
  vatTreatment: z.enum(VAT_TREATMENTS, { error: 'VAT must be standard, zero-rated or exempt.' }).default('standard'),
  buyerName: optionalText(120),
  buyerPhone: optionalText(20),
});
export type B2cSaleInput = z.infer<typeof b2cSaleSchema>;

// ── Accounting firms (E6) ─────────────────────────────────────────────
export const FIRM_ROLES = ['admin', 'accountant'] as const;
export const firmCreateSchema = z.object({ name: trimmed(200).min(2, 'Enter the firm name.') });
export const firmInviteSchema = z.object({ email: emailSchema, role: z.enum(FIRM_ROLES).default('accountant') });
export const firmClientCreateSchema = workspaceCreateSchema.extend({
  ownerEmail: emailSchema.optional().nullable().or(z.literal('').transform(() => null)),
});
export type FirmClientCreate = z.infer<typeof firmClientCreateSchema>;
export const firmConnectSchema = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/, 'A firm code has 8 letters or digits.') });
