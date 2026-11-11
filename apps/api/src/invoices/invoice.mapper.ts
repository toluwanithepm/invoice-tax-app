import type { ClearanceAttempt, Customer, Invoice, InvoiceLine } from '@prisma/client';
import { STATUS_LABELS, isEditable, type InvoiceStatus } from '@einv/shared';
import { isoDay, num } from '../common/zod';
import { customerDto } from '../customers/customers.service';

export type InvoiceWithRelations = Invoice & {
  lines: InvoiceLine[];
  customer?: Customer | null;
  originalInvoice?: Invoice | null;
  adjustments?: Invoice[];
  attemptsLog?: ClearanceAttempt[];
};

export const lineDto = (l: InvoiceLine) => ({
  id: l.id,
  productId: l.productId,
  description: l.description,
  quantity: num(l.quantity),
  unitPrice: num(l.unitPrice),
  discount: num(l.discount),
  vatTreatment: l.vatTreatment,
  vatRate: num(l.vatRate),
  net: num(l.net),
  vat: num(l.vat),
});

export const invoiceSummaryDto = (i: Invoice & { customer?: Customer | null }) => ({
  id: i.id,
  docType: i.docType,
  number: i.number,
  status: i.status,
  statusLabel: STATUS_LABELS[i.status as InvoiceStatus] ?? i.status,
  customerName: (i.buyerSnapshot as { name?: string } | null)?.name ?? i.customer?.name ?? null,
  issueDate: isoDay(i.issueDate),
  dueDate: isoDay(i.dueDate),
  total: num(i.total),
  vatTotal: num(i.vatTotal),
  irn: i.irn,
  clearedAt: i.clearedAt?.toISOString() ?? null,
  createdAt: i.createdAt.toISOString(),
});

export function invoiceDto(i: InvoiceWithRelations) {
  return {
    ...invoiceSummaryDto(i),
    editable: isEditable(i.status as InvoiceStatus),
    customerId: i.customerId,
    customer: i.customer ? customerDto(i.customer) : null,
    buyer: i.buyerSnapshot,
    seller: i.sellerSnapshot ? { ...(i.sellerSnapshot as object), bankAccountEnc: undefined } : null,
    originalInvoice: i.originalInvoice
      ? { id: i.originalInvoice.id, number: i.originalInvoice.number, irn: i.originalInvoice.irn, total: num(i.originalInvoice.total) }
      : null,
    adjustments: (i.adjustments ?? []).map((a) => invoiceSummaryDto(a)),
    reason: i.reason,
    notes: i.notes,
    subtotal: num(i.subtotal),
    discountTotal: num(i.discountTotal),
    netTotal: num(i.subtotal) - num(i.discountTotal),
    lines: [...i.lines].sort((a, b) => a.position - b.position).map(lineDto),
    qrPayload: i.qrPayload,
    errors: (i.lastErrors as unknown[]) ?? [],
    attempts: i.attempts,
    nextAttemptAt: i.nextAttemptAt?.toISOString() ?? null,
    history: (i.attemptsLog ?? [])
      .sort((a, b) => a.attempt - b.attempt)
      .map((a) => ({ attempt: a.attempt, outcome: a.outcome, at: a.createdAt.toISOString(), durationMs: a.durationMs })),
  };
}
