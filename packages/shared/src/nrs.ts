/**
 * NRS / MBS rules and plain-language error catalogue (E3-2, E3-5, NFR-15).
 * Users never see a raw code; they see `message` beside `field`.
 */
export const TIN_PATTERN = /^\d{8}-\d{4}$/;
export const TIN_HINT = 'A Tax ID looks like 12345678-0001 (8 digits, a dash, 4 digits).';
export const normaliseTin = (tin: string | null | undefined) => (tin ?? '').trim().replace(/\s+/g, '');
export const isValidTin = (tin: string | null | undefined) => TIN_PATTERN.test(normaliseTin(tin));

export interface PlainError {
  code: string;
  field: string | null;
  message: string;
}

export const NRS_ERRORS: Record<string, Omit<PlainError, 'code'>> = {
  'NRS-E101': { field: 'seller.tin', message: 'Your business Tax ID is missing or not verified. Verify it in Settings.' },
  'NRS-E102': { field: 'customerId', message: 'Choose a customer for this invoice.' },
  'NRS-E103': { field: 'customer.tin', message: "The customer's Tax ID is missing or in the wrong format. B2B and B2G invoices need it." },
  'NRS-E104': { field: 'lines', message: 'Add at least one line item.' },
  'NRS-E105': { field: 'lines.vatTreatment', message: 'Each line needs a VAT treatment: standard, zero-rated or exempt.' },
  'NRS-E106': { field: 'totals', message: "The totals don't add up. Save the invoice again to recalculate them." },
  'NRS-E107': { field: 'issueDate', message: 'The issue date cannot be in the future.' },
  'NRS-E108': { field: 'originalInvoiceId', message: 'A credit or debit note must point to a cleared invoice.' },
  'NRS-E109': { field: 'lines.quantity', message: 'Quantities and prices must be more than zero.' },
  'NRS-E110': { field: 'lines', message: 'This credit note is larger than what is left on the original invoice.' },
  'NRS-E111': { field: 'lines.description', message: 'Every line needs a description.' },
  'NRS-E112': { field: 'seller.mbs', message: 'Your business is not connected to the tax authority yet. Finish setup in Settings → MBS connection.' },
  'NRS-E113': { field: 'receiptNo', message: 'Two sales on the same day have the same receipt number.' },
  'NRS-E201': { field: null, message: 'The tax authority rejected the digital signature. Contact support.' },
  'NRS-E999': { field: null, message: "The tax authority couldn't process this invoice. Try again; if it keeps failing, contact support." },
};

export function explainNrsError(code: string): PlainError {
  const known = NRS_ERRORS[code] ?? NRS_ERRORS['NRS-E999']!;
  return { code, ...known };
}

/** E1-5: taxpayer band and e-invoicing go-live date from declared annual turnover (Naira). */
export function taxBand(turnover: number | null | undefined): { band: string; goLive: string } | null {
  if (turnover === null || turnover === undefined || Number.isNaN(Number(turnover))) return null;
  const t = Number(turnover);
  if (t < 1_000_000_000) return { band: 'Small (under ₦1bn)', goLive: '2027-07-01' };
  if (t <= 5_000_000_000) return { band: 'Medium (₦1bn–₦5bn)', goLive: '2027-01-01' };
  return { band: 'Large (over ₦5bn)', goLive: '2025-11-01' };
}
