/**
 * Plain-English explanations of every term the product uses. One source of truth for the
 * inline tooltips (<Term>, <InfoTip>) and the Help centre, so the wording is always the same.
 */
export interface GlossaryEntry {
  term: string;
  short: string; // one or two sentences, shown in tooltips
  long?: string; // extra detail for the Help centre
}

export const GLOSSARY = {
  nrs: {
    term: 'NRS',
    short: 'The Nigeria Revenue Service — the government agency that collects tax (formerly FIRS).',
  },
  mbs: {
    term: 'MBS',
    short: "NRS's Merchant Buyer Solution: the national system that checks and approves every business invoice before it counts for tax.",
    long: 'From 2026 Nigerian businesses must send invoices through MBS. We connect you to it for you — there is nothing to install.',
  },
  clearance: {
    term: 'Clearance',
    short: 'When NRS checks an invoice and approves it. A cleared invoice gets an IRN and QR code and can no longer be changed.',
  },
  irn: {
    term: 'IRN',
    short: "Invoice Reference Number — NRS's unique stamp on a cleared invoice. Your buyer needs it to claim back the VAT they paid.",
  },
  qr: {
    term: 'QR stamp',
    short: 'A code printed on every cleared invoice. Anyone can scan it to confirm NRS approved the invoice.',
  },
  tin: {
    term: 'TIN',
    short: 'Tax Identification Number — e.g. 12345678-0001. Every business has one; it is on your TIN certificate.',
  },
  vatStandard: {
    term: 'Standard VAT (7.5%)',
    short: 'Most goods and services. 7.5% VAT is added on top of the price.',
  },
  vatZero: {
    term: 'Zero-rated (0%)',
    short: 'VAT applies at 0% — e.g. exports and some basic food items. You still report the sale.',
  },
  vatExempt: {
    term: 'Exempt',
    short: 'Outside VAT altogether — e.g. medical and pharmaceutical items, school fees. No VAT is charged.',
  },
  vatTreatment: {
    term: 'VAT treatment',
    short: 'Whether an item carries standard 7.5% VAT, is zero-rated (0%), or is exempt. Set it once per product and we do the maths.',
  },
  outputVat: {
    term: 'Output VAT',
    short: 'The VAT you charged your customers in a month. This is what you pay NRS on your monthly VAT return.',
  },
  vatReturn: {
    term: 'VAT return',
    short: 'Your monthly statement of VAT to NRS, due by the 21st of the following month.',
  },
  creditNote: {
    term: 'Credit note',
    short: 'Reduces a cleared invoice — for returns, refunds or a discount agreed after invoicing. Cleared invoices are never edited.',
  },
  debitNote: {
    term: 'Debit note',
    short: 'Adds to a cleared invoice when you under-billed — e.g. a forgotten delivery charge.',
  },
  b2b: {
    term: 'B2B',
    short: 'Business to business: you sell to another company. Their TIN is required on the invoice.',
  },
  b2g: {
    term: 'B2G',
    short: 'Business to government: you sell to a ministry or agency. Their TIN is required on the invoice.',
  },
  b2c: {
    term: 'Retail (B2C) sales',
    short: 'Sales to ordinary consumers, e.g. at a shop till. Instead of one invoice per sale, you report each day’s total to NRS within 24 hours.',
  },
  sandbox: {
    term: 'Sandbox test',
    short: 'A practice invoice sent to NRS’s test system to prove your connection works. It is not a real invoice.',
  },
  approval: {
    term: 'Approval',
    short: 'When switched on, invoices prepared by clerks or accountants wait for an owner or approver before going to NRS.',
  },
  approvalLimit: {
    term: 'Approval amount',
    short: 'Invoices at or above this total need a second person (another owner or approver) to approve them before they go to NRS. Business and Pro plans.',
  },
  firmCode: {
    term: 'Firm code',
    short: 'An 8-character code from your accounting firm. Entering it lets them work on your invoices and VAT. You can remove access any time.',
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;
