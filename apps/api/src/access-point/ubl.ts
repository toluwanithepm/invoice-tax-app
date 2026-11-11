import type { ClearanceRequest, Party } from './access-point';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const TYPE_CODES = { invoice: '380', credit_note: '381', debit_note: '383' } as const;
const TAX_CATEGORY: Record<string, string> = { standard: 'S', zero: 'Z', exempt: 'E' };
const money = (n: number) => `currencyID="NGN">${n.toFixed(2)}`;

function party(tag: string, p: Party | null) {
  if (!p) return '';
  return `  <cac:${tag}><cac:Party>
    <cac:PartyName><cbc:Name>${esc(p.name)}</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>${esc(p.tin)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PostalAddress><cbc:StreetName>${esc(p.address)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>NG</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
  </cac:Party></cac:${tag}>`;
}

/** UBL 2.1 document for MBS clearance (E3-3). Signing is done by the APP in Phase 4 (keys in its HSM). */
export function buildUbl(r: Omit<ClearanceRequest, 'ublXml' | 'idempotencyKey' | 'sandbox'>): string {
  const t = r.totals;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>${esc(r.number)}</cbc:ID>
  <cbc:IssueDate>${esc(r.issueDate)}</cbc:IssueDate>
${r.dueDate ? `  <cbc:DueDate>${esc(r.dueDate)}</cbc:DueDate>\n` : ''}  <cbc:InvoiceTypeCode>${TYPE_CODES[r.docType]}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>NGN</cbc:DocumentCurrencyCode>
${r.original ? `  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(r.original.irn)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>\n` : ''}${party('AccountingSupplierParty', r.seller)}
${party('AccountingCustomerParty', r.buyer)}
  <cac:TaxTotal><cbc:TaxAmount ${money(t.vatTotal)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount ${money(t.subtotal)}</cbc:LineExtensionAmount>
    <cbc:AllowanceTotalAmount ${money(t.discountTotal)}</cbc:AllowanceTotalAmount>
    <cbc:TaxExclusiveAmount ${money(t.subtotal - t.discountTotal)}</cbc:TaxExclusiveAmount>
    <cbc:PayableAmount ${money(t.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${r.lines
  .map(
    (l, i) => `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity>${l.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount ${money(l.net)}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>${esc(l.description)}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>${TAX_CATEGORY[l.vatTreatment] ?? ''}</cbc:ID><cbc:Percent>${(l.vatRate * 100).toFixed(1)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount ${money(l.unitPrice)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`,
  )
  .join('\n')}
</Invoice>`;
}
