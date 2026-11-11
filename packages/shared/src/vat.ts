/**
 * VAT and invoice totals. All arithmetic is done in integer kobo to avoid floating-point drift,
 * so the same inputs give identical totals in the browser and on the server (E3-1, E7-2).
 */
export const VAT_TREATMENTS = ['standard', 'zero', 'exempt'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

/** Rates in basis points. Standard rate is 7.5% under the Nigerian VAT Act. */
export const VAT_RATE_BPS: Record<VatTreatment, number> = { standard: 750, zero: 0, exempt: 0 };

export const VAT_LABELS: Record<VatTreatment, string> = {
  standard: 'Standard (7.5%)',
  zero: 'Zero-rated (0%)',
  exempt: 'Exempt',
};

export interface LineInput {
  description: string;
  quantity: number;
  unitPrice: number; // Naira
  discount?: number; // Naira, absolute amount off this line
  vatTreatment: VatTreatment;
}

export interface LineResult extends LineInput {
  discount: number;
  vatRate: number; // e.g. 0.075
  gross: number;
  net: number;
  vat: number;
}

export interface Totals {
  lines: LineResult[];
  subtotal: number;
  discountTotal: number;
  netTotal: number;
  vatTotal: number;
  total: number;
}

export const toKobo = (naira: number | string): number => Math.round(Number(naira) * 100);
export const fromKobo = (kobo: number): number => kobo / 100;

/** Round half away from zero. */
const roundHalf = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

export function computeLine(line: LineInput): LineResult {
  const rate = VAT_RATE_BPS[line.vatTreatment];
  if (rate === undefined) throw new Error('Choose a VAT treatment for every line.');
  const grossK = roundHalf(Number(line.quantity) * toKobo(line.unitPrice));
  const discountK = Math.min(toKobo(line.discount ?? 0), grossK);
  const netK = grossK - discountK;
  const vatK = roundHalf((netK * rate) / 10_000);
  return {
    ...line,
    discount: fromKobo(discountK),
    vatRate: rate / 10_000,
    gross: fromKobo(grossK),
    net: fromKobo(netK),
    vat: fromKobo(vatK),
  };
}

export function computeTotals(lines: LineInput[]): Totals {
  const results = lines.map(computeLine);
  const sum = (f: (l: LineResult) => number) => results.reduce((s, l) => s + toKobo(f(l)), 0);
  const subtotalK = sum((l) => l.gross);
  const discountK = sum((l) => l.discount);
  const vatK = sum((l) => l.vat);
  const netK = subtotalK - discountK;
  return {
    lines: results,
    subtotal: fromKobo(subtotalK),
    discountTotal: fromKobo(discountK),
    netTotal: fromKobo(netK),
    vatTotal: fromKobo(vatK),
    total: fromKobo(netK + vatK),
  };
}

export const formatNaira = (n: number | string) =>
  '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
