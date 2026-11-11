import type { Customer, Workspace } from '@prisma/client';
import { explainNrsError, isValidTin, type PlainError } from '@einv/shared';
import { num } from '../common/zod';
import type { InvoiceWithRelations } from '../invoices/invoice.mapper';

/**
 * E3-2: pre-submission check of every mandatory MBS field, so invoices aren't rejected.
 * Mirrors the rules in access-point/mock-access-point.ts#mbsRules and adds app-level checks.
 * Every message is plain language with the field to fix (NFR-15).
 */
export function validateForSubmission(
  inv: InvoiceWithRelations,
  ws: Workspace,
  customer: Customer | null,
  opts: { remainingCreditable?: number } = {},
): PlainError[] {
  const errs: PlainError[] = [];
  const add = (code: string, field?: string, message?: string) => {
    const e = explainNrsError(code);
    errs.push({ ...e, field: field ?? e.field, message: message ?? e.message });
  };

  if (!ws.tinVerifiedAt || !isValidTin(ws.tin)) add('NRS-E101');
  if (ws.mbsStatus !== 'live') add('NRS-E112');
  if (!customer) add('NRS-E102');
  else if (!isValidTin(customer.tin)) add('NRS-E103');

  if (inv.lines.length === 0) add('NRS-E104');
  inv.lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.description.trim()) add('NRS-E111', `lines.${i}.description`, `Line ${n} needs a description.`);
    if (!(num(l.quantity) > 0) || !(num(l.unitPrice) > 0)) {
      add('NRS-E109', `lines.${i}.quantity`, `Line ${n}: quantity and price must be more than zero.`);
    }
    if (!['standard', 'zero', 'exempt'].includes(l.vatTreatment)) add('NRS-E105', `lines.${i}.vatTreatment`);
  });

  const today = new Date().toISOString().slice(0, 10);
  if (inv.issueDate.toISOString().slice(0, 10) > today) add('NRS-E107');
  if (inv.dueDate && inv.dueDate < inv.issueDate) {
    errs.push({ code: 'APP-DUE', field: 'dueDate', message: 'The due date must be on or after the issue date.' });
  }

  if (inv.docType !== 'invoice') {
    if (!inv.originalInvoice || inv.originalInvoice.status !== 'cleared' || !inv.originalInvoice.irn) add('NRS-E108');
    if (inv.docType === 'credit_note' && opts.remainingCreditable !== undefined && num(inv.total) > opts.remainingCreditable + 0.001) {
      add('NRS-E110');
    }
  }
  return errs;
}
