import { describe, expect, it } from 'vitest';
import {
  can,
  canTransition,
  computeTotals,
  customerSchema,
  explainNrsError,
  nextRetryDelayMs,
  phoneSchema,
  taxBand,
} from '../src';

describe('computeTotals', () => {
  it('applies 7.5% VAT to standard lines only, after discount', () => {
    const t = computeTotals([
      { description: 'Rice 50kg', quantity: 10, unitPrice: 45000, discount: 5000, vatTreatment: 'standard' },
      { description: 'Export freight', quantity: 1, unitPrice: 100000, vatTreatment: 'zero' },
      { description: 'Medical supplies', quantity: 2, unitPrice: 2500, vatTreatment: 'exempt' },
    ]);
    expect(t.subtotal).toBe(555000);
    expect(t.discountTotal).toBe(5000);
    expect(t.netTotal).toBe(550000);
    expect(t.vatTotal).toBe(33375); // 445000 × 7.5%
    expect(t.total).toBe(583375);
  });

  it('avoids floating-point drift', () => {
    const t = computeTotals([{ description: 'x', quantity: 3, unitPrice: 0.1, vatTreatment: 'standard' }]);
    expect(t.subtotal).toBe(0.3);
    expect(t.vatTotal).toBe(0.02);
    expect(t.total).toBe(0.32);
  });

  it('never lets a discount exceed the line value', () => {
    const t = computeTotals([{ description: 'x', quantity: 1, unitPrice: 100, discount: 500, vatTreatment: 'standard' }]);
    expect(t.netTotal).toBe(0);
    expect(t.total).toBe(0);
  });
});

describe('roles', () => {
  it('lets clerks create but not submit', () => {
    expect(can('clerk', 'invoices.edit')).toBe(true);
    expect(can('clerk', 'invoices.submit')).toBe(false);
  });
  it('denies unknown roles', () => {
    expect(can(undefined, 'workspace.view')).toBe(false);
  });
});

describe('status machine', () => {
  it('keeps cleared invoices terminal', () => {
    expect(canTransition('cleared', 'draft')).toBe(false);
    expect(canTransition('submitting', 'cleared')).toBe(true);
  });
  it('backs off and caps retries', () => {
    expect(nextRetryDelayMs(1)).toBe(30_000);
    expect(nextRetryDelayMs(3)).toBe(120_000);
    expect(nextRetryDelayMs(50)).toBe(30 * 60_000);
  });
});

describe('validation and messages', () => {
  it('normalises Nigerian phone numbers', () => {
    expect(phoneSchema.parse('0803 123 4567')).toBe('+2348031234567');
    expect(phoneSchema.safeParse('12345').success).toBe(false);
  });
  it('requires a well-formed customer TIN', () => {
    expect(customerSchema.safeParse({ name: 'Buyer Ltd', tin: '1234' }).success).toBe(false);
    expect(customerSchema.parse({ name: 'Buyer Ltd', tin: ' 12345678-0001 ' }).tin).toBe('12345678-0001');
  });
  it('maps NRS codes to plain language and falls back safely', () => {
    expect(explainNrsError('NRS-E103').field).toBe('customer.tin');
    expect(explainNrsError('WHATEVER').message).toMatch(/couldn't process/);
  });
  it('bands taxpayers by turnover', () => {
    expect(taxBand(800_000_000)?.goLive).toBe('2027-07-01');
    expect(taxBand(3_000_000_000)?.goLive).toBe('2027-01-01');
    expect(taxBand(null)).toBeNull();
  });
});
