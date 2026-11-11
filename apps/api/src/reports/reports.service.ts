import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  addDays,
  DOC_TYPE_LABELS,
  lagosToday,
  monthBounds,
  monthLabel,
  STATUS_LABELS,
  toKobo,
  fromKobo,
  vatReturnDueDate,
  type DocType,
  type InvoiceStatus,
  type VatDeclarationInput,
} from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { badRequest, conflict, notFound } from '../common/errors';
import { isoDay, num } from '../common/zod';
import { requireUserId, requireWorkspaceId } from '../common/request-context';

type Treatment = 'standard' | 'zero' | 'exempt';
const TREATMENTS: Treatment[] = ['standard', 'zero', 'exempt'];

/** Money is summed in kobo so report, Excel and PDF totals are identical (E7-2). */
class Sum {
  private k = 0;
  add(v: unknown, sign = 1) {
    this.k += sign * toKobo(num(v));
    return this;
  }
  get value() {
    return fromKobo(this.k);
  }
}

export interface Reconciliation {
  month: string;
  monthLabel: string;
  dueDate: string;
  workspace: { legalName: string; tin: string };
  invoices: { count: number; net: number; vat: number };
  debitNotes: { count: number; net: number; vat: number };
  creditNotes: { count: number; net: number; vat: number };
  b2c: { days: number; net: number; vat: number; gross: number; enabled: boolean };
  byTreatment: { treatment: Treatment; net: number; vat: number }[];
  outputVat: number;
  declared: { vat: number; note: string | null; updatedAt: string } | null;
  difference: number | null;
  documents: {
    id: string;
    number: string | null;
    docType: string;
    issueDate: string;
    customer: string | null;
    customerTin: string | null;
    irn: string | null;
    net: number;
    vat: number;
    total: number;
  }[];
  b2cDays: { date: string; status: string; net: number; vat: number; gross: number; rows: number }[];
  exceptions: {
    unclearedDocuments: { id: string; number: string | null; docType: string; status: string; statusLabel: string; customer: string | null; vat: number }[];
    unclearedVat: number;
    b2cMissingDays: { date: string; status: string }[];
  };
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** E7-1: output VAT for a month from cleared invoices, notes and accepted B2C reports, vs the filed figure. */
  async reconciliation(month: string): Promise<Reconciliation> {
    const db = this.prisma.scoped();
    const workspaceId = requireWorkspaceId();
    const { start, end } = monthBounds(month);
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const [docs, reports, declaration, b2cByTreatment] = await Promise.all([
      db.invoice.findMany({
        where: { issueDate: { gte: new Date(start), lte: new Date(end) } },
        include: { lines: true, customer: true },
        orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
      }),
      db.b2cReport.findMany({ where: { salesDate: { gte: new Date(start), lte: new Date(end) } }, orderBy: { salesDate: 'asc' } }),
      db.vatDeclaration.findUnique({ where: { workspaceId_month: { workspaceId, month } } }),
      db.b2cSale.groupBy({
        by: ['vatTreatment'],
        where: { report: { status: 'accepted', salesDate: { gte: new Date(start), lte: new Date(end) } } },
        _sum: { net: true, vat: true },
      }),
    ]);

    const buckets = {
      invoice: { count: 0, net: new Sum(), vat: new Sum() },
      debit_note: { count: 0, net: new Sum(), vat: new Sum() },
      credit_note: { count: 0, net: new Sum(), vat: new Sum() },
    };
    const treat = Object.fromEntries(TREATMENTS.map((t) => [t, { net: new Sum(), vat: new Sum() }])) as Record<Treatment, { net: Sum; vat: Sum }>;
    const outputVat = new Sum();
    const unclearedVat = new Sum();
    const documents: Reconciliation['documents'] = [];
    const uncleared: Reconciliation['exceptions']['unclearedDocuments'] = [];

    for (const d of docs) {
      const customer = (d.buyerSnapshot as { name?: string } | null)?.name ?? d.customer?.name ?? null;
      if (d.status !== 'cleared') {
        uncleared.push({
          id: d.id,
          number: d.number,
          docType: d.docType,
          status: d.status,
          statusLabel: STATUS_LABELS[d.status as InvoiceStatus] ?? d.status,
          customer,
          vat: num(d.vatTotal),
        });
        unclearedVat.add(d.vatTotal, d.docType === 'credit_note' ? -1 : 1);
        continue;
      }
      const sign = d.docType === 'credit_note' ? -1 : 1;
      const b = buckets[d.docType as keyof typeof buckets];
      const net = toKobo(num(d.subtotal)) - toKobo(num(d.discountTotal));
      b.count++;
      b.net.add(fromKobo(net));
      b.vat.add(d.vatTotal);
      outputVat.add(d.vatTotal, sign);
      for (const l of d.lines) {
        const t = treat[l.vatTreatment as Treatment];
        if (t) {
          t.net.add(l.net, sign);
          t.vat.add(l.vat, sign);
        }
      }
      documents.push({
        id: d.id,
        number: d.number,
        docType: d.docType,
        issueDate: isoDay(d.issueDate)!,
        customer,
        customerTin: (d.buyerSnapshot as { tin?: string } | null)?.tin ?? d.customer?.tin ?? null,
        irn: d.irn,
        net: sign * fromKobo(net),
        vat: sign * num(d.vatTotal),
        total: sign * num(d.total),
      });
    }

    const b2c = { days: 0, net: new Sum(), vat: new Sum(), gross: new Sum() };
    for (const r of reports.filter((r) => r.status === 'accepted')) {
      b2c.days++;
      b2c.net.add(r.netTotal);
      b2c.vat.add(r.vatTotal);
      b2c.gross.add(r.grossTotal);
      outputVat.add(r.vatTotal);
    }
    for (const g of b2cByTreatment) {
      const t = treat[g.vatTreatment as Treatment];
      if (t) {
        t.net.add(g._sum.net);
        t.vat.add(g._sum.vat);
      }
    }

    // B2C days that should have been reported (only up to yesterday, and only once B2C is on).
    const missing: Reconciliation['exceptions']['b2cMissingDays'] = [];
    if (ws.b2cEnabled) {
      const yesterday = addDays(lagosToday(), -1);
      const firstDay = [start, isoDay(ws.createdAt)!].sort().pop()!;
      const byDate = new Map(reports.map((r) => [isoDay(r.salesDate)!, r.status]));
      for (let d = firstDay; d <= end && d <= yesterday; d = addDays(d, 1)) {
        const s = byDate.get(d);
        if (s !== 'accepted') missing.push({ date: d, status: s ?? 'missing' });
      }
    }

    const declared = declaration
      ? { vat: num(declaration.declaredVat), note: declaration.note, updatedAt: declaration.updatedAt.toISOString() }
      : null;
    return {
      month,
      monthLabel: monthLabel(month),
      dueDate: vatReturnDueDate(month),
      workspace: { legalName: ws.legalName, tin: ws.tin },
      invoices: { count: buckets.invoice.count, net: buckets.invoice.net.value, vat: buckets.invoice.vat.value },
      debitNotes: { count: buckets.debit_note.count, net: buckets.debit_note.net.value, vat: buckets.debit_note.vat.value },
      creditNotes: { count: buckets.credit_note.count, net: buckets.credit_note.net.value, vat: buckets.credit_note.vat.value },
      b2c: { days: b2c.days, net: b2c.net.value, vat: b2c.vat.value, gross: b2c.gross.value, enabled: ws.b2cEnabled },
      byTreatment: TREATMENTS.map((t) => ({ treatment: t, net: treat[t].net.value, vat: treat[t].vat.value })),
      outputVat: outputVat.value,
      declared,
      difference: declared ? fromKobo(toKobo(declared.vat) - toKobo(outputVat.value)) : null,
      documents,
      b2cDays: reports.map((r) => ({
        date: isoDay(r.salesDate)!,
        status: r.status,
        net: num(r.netTotal),
        vat: num(r.vatTotal),
        gross: num(r.grossTotal),
        rows: r.rowCount,
      })),
      exceptions: { unclearedDocuments: uncleared, unclearedVat: unclearedVat.value, b2cMissingDays: missing },
    };
  }

  async declare(month: string, input: VatDeclarationInput) {
    const workspaceId = requireWorkspaceId();
    await this.prisma.scoped().vatDeclaration.upsert({
      where: { workspaceId_month: { workspaceId, month } },
      create: { workspaceId, month, declaredVat: input.declaredVat, note: input.note, declaredBy: requireUserId() },
      update: { declaredVat: input.declaredVat, note: input.note, declaredBy: requireUserId() },
    });
    await this.audit.record({ entity: 'vat_return', entityId: month, action: 'vat.declared', detail: { declaredVat: input.declaredVat } });
    return this.reconciliation(month);
  }

  // ── E7-2: exports built from the same Reconciliation object ─────────

  async toXlsx(r: Reconciliation): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'E-Invoice';
    const money = '#,##0.00;[Red]-#,##0.00';

    const s = wb.addWorksheet('Summary');
    s.columns = [{ width: 42 }, { width: 10 }, { width: 18 }, { width: 18 }];
    s.addRow([`VAT reconciliation — ${r.monthLabel}`]).font = { bold: true, size: 14 };
    s.addRow([`${r.workspace.legalName} · TIN ${r.workspace.tin} · Return due ${r.dueDate}`]);
    s.addRow([]);
    s.addRow(['Source', 'Count', 'Net (NGN)', 'VAT (NGN)']).font = { bold: true };
    s.addRow(['Cleared invoices', r.invoices.count, r.invoices.net, r.invoices.vat]);
    s.addRow(['Cleared debit notes', r.debitNotes.count, r.debitNotes.net, r.debitNotes.vat]);
    s.addRow(['Cleared credit notes (deducted)', r.creditNotes.count, -r.creditNotes.net, -r.creditNotes.vat]);
    s.addRow(['B2C daily reports (accepted days)', r.b2c.days, r.b2c.net, r.b2c.vat]);
    const total = s.addRow(['Output VAT', null, null, r.outputVat]);
    total.font = { bold: true };
    total.getCell(1).name = 'OutputVatLabel';
    total.getCell(4).name = 'OutputVat';
    s.addRow(['Declared on VAT return', null, null, r.declared?.vat ?? null]);
    s.addRow(['Difference (declared − output VAT)', null, null, r.difference]);
    s.addRow([]);
    s.addRow(['By VAT treatment', null, 'Net (NGN)', 'VAT (NGN)']).font = { bold: true };
    for (const t of r.byTreatment) s.addRow([t.treatment, null, t.net, t.vat]);
    s.getColumn(3).numFmt = money;
    s.getColumn(4).numFmt = money;

    const d = wb.addWorksheet('Documents');
    d.columns = [
      { header: 'Number', width: 14 },
      { header: 'Type', width: 12 },
      { header: 'Issue date', width: 12 },
      { header: 'Customer', width: 32 },
      { header: 'Customer TIN', width: 16 },
      { header: 'IRN', width: 34 },
      { header: 'Net (NGN)', width: 16, style: { numFmt: money } },
      { header: 'VAT (NGN)', width: 16, style: { numFmt: money } },
      { header: 'Total (NGN)', width: 16, style: { numFmt: money } },
    ];
    d.getRow(1).font = { bold: true };
    for (const x of r.documents) {
      d.addRow([x.number, DOC_TYPE_LABELS[x.docType as DocType], x.issueDate, x.customer, x.customerTin, x.irn, x.net, x.vat, x.total]);
    }

    const b = wb.addWorksheet('B2C');
    b.columns = [
      { header: 'Sales date', width: 12 },
      { header: 'Status', width: 12 },
      { header: 'Receipts', width: 10 },
      { header: 'Net (NGN)', width: 16, style: { numFmt: money } },
      { header: 'VAT (NGN)', width: 16, style: { numFmt: money } },
      { header: 'Gross (NGN)', width: 16, style: { numFmt: money } },
    ];
    b.getRow(1).font = { bold: true };
    for (const x of r.b2cDays) b.addRow([x.date, x.status, x.rows, x.net, x.vat, x.gross]);

    const e = wb.addWorksheet('Exceptions');
    e.columns = [{ header: 'Item', width: 30 }, { header: 'Status', width: 22 }, { header: 'Customer / date', width: 30 }, { header: 'VAT (NGN)', width: 16, style: { numFmt: money } }];
    e.getRow(1).font = { bold: true };
    for (const x of r.exceptions.unclearedDocuments) e.addRow([`${DOC_TYPE_LABELS[x.docType as DocType]} ${x.number ?? '(draft)'}`, x.statusLabel, x.customer, x.vat]);
    for (const x of r.exceptions.b2cMissingDays) e.addRow(['B2C daily report', x.status === 'missing' ? 'Not reported' : x.status, x.date, null]);

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async toPdf(r: Reconciliation): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `VAT reconciliation ${r.month}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const m = (n: number | null) => (n === null ? '—' : 'NGN ' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const L = 48;
    const R = doc.page.width - 48;
    const row = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(label, L, y, { width: 300 });
      doc.text(value, R - 180, y, { width: 180, align: 'right' });
      doc.moveDown(0.3);
    };

    doc.font('Helvetica-Bold').fontSize(16).text(`VAT reconciliation — ${r.monthLabel}`);
    doc.font('Helvetica').fontSize(10).fillColor('#444').text(`${r.workspace.legalName} · TIN ${r.workspace.tin} · Return due ${r.dueDate}`);
    doc.fillColor('#111').moveDown();
    row(`Cleared invoices (${r.invoices.count})`, m(r.invoices.vat));
    row(`Cleared debit notes (${r.debitNotes.count})`, m(r.debitNotes.vat));
    row(`Cleared credit notes (${r.creditNotes.count}), deducted`, m(-r.creditNotes.vat));
    row(`B2C daily reports (${r.b2c.days} days)`, m(r.b2c.vat));
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#ddd').stroke().moveDown(0.3);
    row('Output VAT', m(r.outputVat), true);
    row('Declared on VAT return', m(r.declared?.vat ?? null));
    row('Difference', m(r.difference), true);
    doc.moveDown();
    doc.font('Helvetica-Bold').text('By VAT treatment').moveDown(0.3);
    for (const t of r.byTreatment) row(`${t.treatment} — net ${m(t.net)}`, m(t.vat));

    if (r.exceptions.unclearedDocuments.length || r.exceptions.b2cMissingDays.length) {
      doc.moveDown().font('Helvetica-Bold').text('Not included (exceptions)').moveDown(0.3);
      for (const x of r.exceptions.unclearedDocuments) row(`${DOC_TYPE_LABELS[x.docType as DocType]} ${x.number ?? '(draft)'} — ${x.statusLabel}`, m(x.vat));
      for (const x of r.exceptions.b2cMissingDays) row(`B2C ${x.date} — ${x.status === 'missing' ? 'not reported' : x.status}`, '—');
    }

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12).text('Cleared documents').moveDown(0.5);
    for (const x of r.documents) {
      row(`${x.number} · ${x.issueDate} · ${x.customer ?? ''}`, `${m(x.net)} + ${m(x.vat)}`);
    }
    doc.end();
    return done;
  }

  // ── E7-3: SME dashboard ─────────────────────────────────────────────

  async dashboard(q: { months: number; customerId?: string }) {
    const db = this.prisma.scoped();
    const today = lagosToday();
    const thisMonth = today.slice(0, 7);
    const months: string[] = [];
    for (let i = q.months - 1; i >= 0; i--) {
      const d = new Date(thisMonth + '-01T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const from = new Date(months[0] + '-01');
    const cleared = await db.invoice.findMany({
      where: { status: 'cleared', issueDate: { gte: from }, ...(q.customerId ? { customerId: q.customerId } : {}) },
      select: { docType: true, issueDate: true, subtotal: true, discountTotal: true, vatTotal: true, total: true },
    });
    const b2c = q.customerId
      ? []
      : await db.b2cReport.findMany({ where: { status: 'accepted', salesDate: { gte: from } }, select: { salesDate: true, netTotal: true, vatTotal: true } });
    const series = new Map(months.map((m) => [m, { month: m, sales: new Sum(), vat: new Sum() }]));
    for (const c of cleared) {
      const s = series.get(isoDay(c.issueDate)!.slice(0, 7));
      if (!s) continue;
      const sign = c.docType === 'credit_note' ? -1 : 1;
      s.sales.add(fromKobo(toKobo(num(c.subtotal)) - toKobo(num(c.discountTotal))), sign);
      s.vat.add(c.vatTotal, sign);
    }
    for (const r of b2c) {
      const s = series.get(isoDay(r.salesDate)!.slice(0, 7));
      if (s) {
        s.sales.add(r.netTotal);
        s.vat.add(r.vatTotal);
      }
    }

    // Outstanding = cleared, unpaid invoices adjusted by their cleared notes.
    const unpaid = await db.invoice.findMany({
      where: { docType: 'invoice', status: 'cleared', paidAt: null, ...(q.customerId ? { customerId: q.customerId } : {}) },
      include: { adjustments: { where: { status: 'cleared' } }, customer: true },
      orderBy: { dueDate: 'asc' },
    });
    let outstanding = new Sum();
    let overdue = new Sum();
    const items = unpaid.map((i) => {
      const owed = new Sum().add(i.total);
      for (const a of i.adjustments) owed.add(a.total, a.docType === 'credit_note' ? -1 : 1);
      const due = isoDay(i.dueDate);
      const isOverdue = !!due && due < today;
      outstanding = outstanding.add(owed.value);
      if (isOverdue) overdue = overdue.add(owed.value);
      return {
        id: i.id,
        number: i.number,
        customer: (i.buyerSnapshot as { name?: string } | null)?.name ?? i.customer?.name ?? null,
        issueDate: isoDay(i.issueDate),
        dueDate: due,
        owed: owed.value,
        overdue: isOverdue,
      };
    });

    const current = series.get(thisMonth)!;
    return {
      months: [...series.values()].map((s) => ({ month: s.month, sales: s.sales.value, vat: s.vat.value })),
      thisMonth: { month: thisMonth, sales: current.sales.value, vatOwed: current.vat.value, dueDate: vatReturnDueDate(thisMonth) },
      outstanding: { total: outstanding.value, overdue: overdue.value, count: items.length, items: items.filter((i) => i.owed > 0).slice(0, 50) },
    };
  }

  /** Record that a cleared invoice was paid (or undo it). The only change allowed after clearance. */
  async setPaid(invoiceId: string, paid: boolean, paidOn?: string) {
    const db = this.prisma.scoped();
    const inv = await db.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw notFound('That invoice');
    if (inv.docType !== 'invoice' || inv.status !== 'cleared') throw conflict('Only cleared invoices can be marked as paid.', 'NOT_CLEARED');
    if (paidOn && paidOn > lagosToday()) throw badRequest('The payment date cannot be in the future.', [{ field: 'paidOn', message: 'Use today or an earlier date.' }]);
    await db.invoice.update({ where: { id: invoiceId }, data: { paidAt: paid ? new Date(paidOn ?? new Date().toISOString()) : null } });
    await this.audit.record({ entity: 'invoice', entityId: invoiceId, action: paid ? 'invoice.marked_paid' : 'invoice.marked_unpaid', detail: { paidOn } });
    return { paid, paidAt: paid ? (paidOn ?? new Date().toISOString().slice(0, 10)) : null };
  }
}
