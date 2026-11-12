export const DOC_TYPES = ['invoice', 'credit_note', 'debit_note'] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
};

/**
 * Status machine (E3-3, E3-7):
 * draft → pending_approval → submitting → cleared | rejected
 *                         ↘ queued (NRS/APP unavailable) → submitting … → failed (after 72h)
 * rejected → draft (on edit) → … ; cleared is terminal (NFR-11).
 */
export const INVOICE_STATUSES = [
  'draft',
  'pending_approval',
  'submitting',
  'queued',
  'cleared',
  'rejected',
  'failed',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Plain-language status names: say what is happening, not the system state. */
export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Needs approval',
  submitting: 'Sending to NRS',
  queued: 'Waiting for NRS',
  cleared: 'Approved by NRS',
  rejected: 'Needs fixing',
  failed: "Couldn't send",
};

const TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['pending_approval', 'submitting'],
  pending_approval: ['submitting', 'draft'],
  submitting: ['cleared', 'rejected', 'queued'],
  queued: ['submitting', 'failed'],
  rejected: ['draft', 'submitting'],
  failed: ['submitting', 'draft'],
  cleared: [],
};

export const canTransition = (from: InvoiceStatus, to: InvoiceStatus) => TRANSITIONS[from].includes(to);
export const isEditable = (s: InvoiceStatus) => s === 'draft' || s === 'rejected' || s === 'failed';

/** E3-7 / NFR-4: retry backoff — 30s, 1m, 2m … capped at 30 min, for up to 72 hours. */
export const RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;
export function nextRetryDelayMs(attempt: number): number {
  const base = 30_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 30 * 60 * 1000);
}
