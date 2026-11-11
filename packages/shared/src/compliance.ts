/** Compliance calendar helpers. Nigeria is UTC+1 all year (no daylight saving). */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** Today's date in Lagos as YYYY-MM-DD. */
export function lagosToday(now = new Date()): string {
  return new Date(now.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * E5-1: a day's retail sales must reach NRS within 24 hours of the day closing,
 * i.e. by 23:59:59 Lagos time on the following day.
 */
export function b2cDeadline(salesDate: string): Date {
  return new Date(new Date(addDays(salesDate, 2) + 'T00:00:00Z').getTime() - LAGOS_OFFSET_MS - 1000);
}

/** When the daily report is submitted automatically: 00:30 Lagos time the next morning. */
export function b2cAutoSubmitAt(salesDate: string): Date {
  return new Date(new Date(addDays(salesDate, 1) + 'T00:30:00Z').getTime() - LAGOS_OFFSET_MS);
}

/** E5-3: alert at least 6 hours before the deadline. */
export const B2C_ALERT_LEAD_MS = 6 * 60 * 60 * 1000;

/** Monthly VAT return due date: the 21st of the following month. */
export function vatReturnDueDate(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return `${next}-21`;
}

export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

export const monthLabel = (month: string) =>
  new Date(month + '-01T00:00:00Z').toLocaleDateString('en-NG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
