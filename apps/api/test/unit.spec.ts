import { decrypt, encrypt, uuidv7 } from '../src/common/crypto';
import { buildUbl } from '../src/access-point/ubl';
import { mbsRules } from '../src/access-point/mock-access-point';
import type { ClearanceRequest } from '../src/access-point/access-point';
import { normaliseVat, parseSheet, suggestMapping } from '../src/imports/imports';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../src/auth/totp';

const base = (): ClearanceRequest => ({
  idempotencyKey: 'k',
  sandbox: false,
  docType: 'invoice',
  number: 'INV-000001',
  issueDate: '2026-01-15',
  dueDate: null,
  seller: { name: 'Seller & Sons <Ltd>', tin: '12345678-0001', tinVerified: true, address: 'Lagos' },
  buyer: { name: 'Buyer', tin: '23456789-0001', address: 'Abuja', kind: 'B2B' },
  original: null,
  lines: [{ description: 'Item', quantity: 2, unitPrice: 500, discount: 0, vatTreatment: 'standard', vatRate: 0.075, net: 1000, vat: 75 }],
  totals: { subtotal: 1000, discountTotal: 0, vatTotal: 75, total: 1075 },
  ublXml: '',
});

describe('crypto', () => {
  it('round-trips AES-256-GCM and detects tampering', () => {
    const c = encrypt('0123456789');
    expect(c.startsWith('v1.')).toBe(true);
    expect(decrypt(c)).toBe('0123456789');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
  it('makes time-ordered UUIDv7s', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) <= b.slice(0, 13)).toBe(true);
  });
});

describe('UBL builder', () => {
  it('escapes XML and sets the type code', () => {
    const xml = buildUbl(base());
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
    expect(xml).toContain('Seller &amp; Sons &lt;Ltd&gt;');
    expect(xml).toContain('<cbc:PayableAmount currencyID="NGN">1075.00</cbc:PayableAmount>');
    const cn = buildUbl({ ...base(), docType: 'credit_note', original: { irn: 'IRN-1', number: 'INV-1' } });
    expect(cn).toContain('<cbc:InvoiceTypeCode>381</cbc:InvoiceTypeCode>');
    expect(cn).toContain('<cbc:ID>IRN-1</cbc:ID>');
  });
});

describe('MBS rules (mock)', () => {
  it('accepts a valid document', () => expect(mbsRules(base())).toEqual([]));
  it('rejects bad buyer TIN, wrong totals and orphan credit notes', () => {
    const r = base();
    r.buyer!.tin = '123';
    r.totals.total = 1;
    expect(mbsRules(r)).toEqual(expect.arrayContaining(['NRS-E103', 'NRS-E106']));
    expect(mbsRules({ ...base(), docType: 'credit_note' })).toContain('NRS-E108');
  });
});

describe('import parsing', () => {
  it('parses CSV with BOM and maps aliased headers', async () => {
    const buf = Buffer.from('﻿Customer Name,Tax ID,E-mail\nA Ltd,12345678-0001,a@a.ng\n');
    const { headers, rows } = await parseSheet({ buffer: buf } as Express.Multer.File);
    expect(headers).toEqual(['Customer Name', 'Tax ID', 'E-mail']);
    expect(rows).toEqual([['A Ltd', '12345678-0001', 'a@a.ng']]);
    expect(suggestMapping('customers', headers)).toEqual({ name: 'Customer Name', tin: 'Tax ID', email: 'E-mail' });
  });
  it('rejects binary files that are not xlsx', async () => {
    await expect(parseSheet({ buffer: Buffer.from([0, 1, 2, 3, 0]) } as Express.Multer.File)).rejects.toThrow();
  });
  it('normalises VAT wording', () => {
    expect(normaliseVat('7.5%')).toBe('standard');
    expect(normaliseVat('Zero-rated')).toBe('zero');
    expect(normaliseVat('Exempt')).toBe('exempt');
  });
});

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC test vectors (last 6 digits)', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpAt(secret, 1_111_111_109_000)).toBe('081804');
    expect(totpAt(secret, 2_000_000_000_000)).toBe('279037');
  });
  it('allows one step of clock drift and nothing more', () => {
    const t = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, t - 30_000), t)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, t - 90_000), t)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', t)).toBe(false);
  });
  it('round-trips base32', () => {
    const b = Buffer.from([0, 1, 2, 250, 255]);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
});
