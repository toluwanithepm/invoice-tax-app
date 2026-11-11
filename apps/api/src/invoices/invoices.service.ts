import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  computeTotals,
  isEditable,
  type AdjustmentNoteInput,
  type DocType,
  type InvoiceDraft,
  type InvoiceLineInput,
  type InvoiceStatus,
} from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { badRequest, conflict, notFound } from '../common/errors';
import { num } from '../common/zod';
import { requireUserId, requireWorkspaceId } from '../common/request-context';
import { invoiceDto, invoiceSummaryDto } from './invoice.mapper';

const FULL_INCLUDE = {
  lines: true,
  customer: true,
  originalInvoice: true,
  adjustments: { orderBy: { createdAt: 'asc' } },
  attemptsLog: true,
} satisfies Prisma.InvoiceInclude;

/** Lines with server-side totals (the client's numbers are never trusted). */
export function priceLines(lines: InvoiceLineInput[], workspaceId: string) {
  const t = computeTotals(lines);
  return {
    totals: { subtotal: t.subtotal, discountTotal: t.discountTotal, vatTotal: t.vatTotal, total: t.total },
    rows: t.lines.map((l, i) => ({
      workspaceId,
      position: i,
      productId: lines[i]!.productId ?? null,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount,
      vatTreatment: l.vatTreatment,
      vatRate: l.vatRate,
      net: l.net,
      vat: l.vat,
    })),
  };
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: { status?: string; q?: string; docType?: string; customerId?: string; cursor?: string; limit: number }) {
    const statuses = q.status?.split(',').filter(Boolean);
    const rows = await this.prisma.scoped().invoice.findMany({
      where: {
        ...(statuses?.length ? { status: { in: statuses } } : {}),
        ...(q.docType ? { docType: q.docType } : {}),
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.q
          ? {
              OR: [
                { number: { contains: q.q, mode: 'insensitive' } },
                { irn: { contains: q.q, mode: 'insensitive' } },
                { customer: { name: { contains: q.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: { customer: true },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit);
    return { items: items.map(invoiceSummaryDto), nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  async getRaw(id: string) {
    const inv = await this.prisma.scoped().invoice.findUnique({ where: { id }, include: FULL_INCLUDE });
    if (!inv) throw notFound('That invoice');
    return inv;
  }

  async get(id: string) {
    return invoiceDto(await this.getRaw(id));
  }

  private async assertCustomer(customerId: string | null | undefined) {
    if (!customerId) return;
    const c = await this.prisma.scoped().customer.findUnique({ where: { id: customerId } });
    if (!c) throw badRequest('That customer was not found.', [{ field: 'customerId', message: 'Choose a customer from your list.' }]);
  }

  /** E3-1: create a draft. Totals are always recomputed here. */
  async createDraft(input: InvoiceDraft) {
    await this.assertCustomer(input.customerId);
    const workspaceId = requireWorkspaceId();
    const { totals, rows } = priceLines(input.lines, workspaceId);
    const inv = await this.prisma.scoped().invoice.create({
      data: {
        workspaceId,
        docType: 'invoice',
        customerId: input.customerId ?? null,
        issueDate: new Date(input.issueDate),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        notes: input.notes,
        ...totals,
        createdBy: requireUserId(),
        lines: { create: rows },
      },
      include: FULL_INCLUDE,
    });
    await this.audit.record({ entity: 'invoice', entityId: inv.id, action: 'invoice.created', detail: { total: totals.total } });
    return invoiceDto(inv);
  }

  /** Autosave target. Editing a rejected invoice puts it back to draft; history is kept in clearance attempts (E3-5). */
  async updateDraft(id: string, input: InvoiceDraft) {
    const existing = await this.getRaw(id);
    if (!isEditable(existing.status as InvoiceStatus)) {
      throw conflict(
        existing.status === 'cleared'
          ? "This invoice has been cleared and can't be changed. Raise a credit or debit note instead."
          : 'This invoice is with the tax authority and can’t be edited right now.',
        'NOT_EDITABLE',
      );
    }
    if (existing.docType === 'invoice') await this.assertCustomer(input.customerId);
    const workspaceId = requireWorkspaceId();
    const { totals, rows } = priceLines(input.lines, workspaceId);
    if (existing.docType === 'credit_note') await this.assertCreditWithinRemaining(existing.originalInvoiceId!, totals.total, id);
    const inv = await this.prisma.scopedTx(async (tx) => {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      return tx.invoice.update({
        where: { id },
        data: {
          ...(existing.docType === 'invoice' ? { customerId: input.customerId ?? null } : {}),
          issueDate: new Date(input.issueDate),
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          notes: input.notes,
          ...totals,
          status: 'draft',
          lastErrors: Prisma.DbNull,
          lines: { create: rows },
        },
        include: FULL_INCLUDE,
      });
    });
    await this.audit.record({ entity: 'invoice', entityId: id, action: 'invoice.updated', detail: { total: totals.total } });
    return invoiceDto(inv);
  }

  async deleteDraft(id: string) {
    const existing = await this.getRaw(id);
    if (existing.status !== 'draft' || existing.number) {
      throw conflict('Only drafts that were never submitted can be deleted.', 'NOT_DELETABLE');
    }
    await this.prisma.scoped().invoice.delete({ where: { id } });
    await this.audit.record({ entity: 'invoice', entityId: id, action: 'invoice.deleted' });
  }

  /** What is left to credit on a cleared invoice: total + cleared debit notes − credit notes (cleared or in progress). */
  async remainingCreditable(originalId: string, excludeId?: string) {
    const original = await this.prisma.scoped().invoice.findUnique({ where: { id: originalId }, include: { adjustments: true } });
    if (!original) throw notFound('The original invoice');
    let remaining = num(original.total);
    for (const a of original.adjustments) {
      if (a.id === excludeId) continue;
      if (a.docType === 'debit_note' && a.status === 'cleared') remaining += num(a.total);
      if (a.docType === 'credit_note' && a.status !== 'rejected' && a.status !== 'failed') remaining -= num(a.total);
    }
    return Math.round(remaining * 100) / 100;
  }

  private async assertCreditWithinRemaining(originalId: string, total: number, excludeId?: string) {
    const remaining = await this.remainingCreditable(originalId, excludeId);
    if (total > remaining + 0.001) {
      throw badRequest(`This credit note is larger than what is left on the original invoice (₦${remaining.toLocaleString('en-NG')}).`, [
        { field: 'lines', message: 'Reduce the amounts on this credit note.', code: 'NRS-E110' },
      ], 'CREDIT_EXCEEDS_REMAINING');
    }
  }

  /** E4-1 / E4-2: raise a credit or debit note against a cleared invoice's IRN. */
  async createAdjustment(originalId: string, docType: Exclude<DocType, 'invoice'>, input: AdjustmentNoteInput) {
    const original = await this.getRaw(originalId);
    if (original.docType !== 'invoice') throw badRequest('Notes can only be raised against an invoice.');
    if (original.status !== 'cleared' || !original.irn) {
      throw badRequest('A credit or debit note must point to a cleared invoice.', [], 'ORIGINAL_NOT_CLEARED');
    }
    const workspaceId = requireWorkspaceId();
    const { totals, rows } = priceLines(input.lines, workspaceId);
    if (docType === 'credit_note') await this.assertCreditWithinRemaining(originalId, totals.total);
    const note = await this.prisma.scoped().invoice.create({
      data: {
        workspaceId,
        docType,
        customerId: original.customerId,
        originalInvoiceId: originalId,
        reason: input.reason,
        issueDate: new Date(input.issueDate),
        ...totals,
        createdBy: requireUserId(),
        lines: { create: rows },
      },
      include: FULL_INCLUDE,
    });
    await this.audit.record({
      entity: 'invoice',
      entityId: note.id,
      action: `${docType}.created`,
      detail: { originalInvoiceId: originalId, originalIrn: original.irn, total: totals.total },
    });
    return invoiceDto(note);
  }

  /** Lines of the original, pre-filled for a full credit note. */
  async creditTemplate(originalId: string) {
    const original = await this.getRaw(originalId);
    return {
      remaining: await this.remainingCreditable(originalId),
      lines: invoiceDto(original).lines.map(({ id: _id, net: _n, vat: _v, vatRate: _r, ...l }) => l),
    };
  }
}
