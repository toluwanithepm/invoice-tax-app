import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type B2cReport } from '@prisma/client';
import {
  addDays,
  B2C_ALERT_LEAD_MS,
  B2C_FIELDS,
  b2cAutoSubmitAt,
  b2cDeadline,
  b2cSaleSchema,
  explainNrsError,
  IMPORT_MAX_ROWS,
  lagosToday,
  splitGross,
  type B2cSaleInput,
} from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { NotificationsService } from '../platform/notifications.service';
import { JobsService } from '../jobs/jobs.service';
import { ACCESS_POINT, ProviderUnavailableError, type AccessPointProvider } from '../access-point/access-point';
import { parseSheet, type RowError } from '../imports/imports';
import { badRequest, conflict, notFound } from '../common/errors';
import { sha256 } from '../common/crypto';
import { isoDay, num } from '../common/zod';
import { requireUserId, requireWorkspaceId, runWithContext } from '../common/request-context';

export const B2C_SUBMIT_JOB = 'b2c.submit';
export const B2C_CHECK_JOB = 'b2c.check';
const RETRY_MS = 10 * 60 * 1000;
const RETRY_FOR_MS = 72 * 60 * 60 * 1000;

const ALIASES: Record<string, string[]> = {
  date: ['date', 'salesdate', 'saledate', 'transactiondate', 'day'],
  receiptNo: ['receiptno', 'receipt', 'receiptnumber', 'transactionid', 'invoiceno', 'ref', 'reference'],
  description: ['description', 'item', 'items', 'details'],
  amount: ['amount', 'total', 'gross', 'amountpaid', 'totalamount', 'value'],
  vatTreatment: ['vat', 'vattreatment', 'tax', 'taxtype', 'vattype'],
  buyerName: ['buyername', 'customer', 'customername', 'buyer'],
  buyerPhone: ['buyerphone', 'phone', 'customerphone', 'mobile'],
};
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const VAT_WORDS: Record<string, string> = {
  standard: 'standard', s: 'standard', '75': 'standard', vatable: 'standard', yes: 'standard',
  zero: 'zero', zerorated: 'zero', z: 'zero', '0': 'zero',
  exempt: 'exempt', e: 'exempt', no: 'exempt', none: 'exempt',
};

/** Accepts YYYY-MM-DD, DD/MM/YYYY and DD-MM-YYYY (Nigerian POS exports use day-first dates). */
export function normaliseDate(v: string): string {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return s;
}

export function reportDto(r: B2cReport) {
  return {
    id: r.id,
    date: isoDay(r.salesDate)!,
    status: r.status,
    noSales: r.noSales,
    rows: r.rowCount,
    net: num(r.netTotal),
    vat: num(r.vatTotal),
    gross: num(r.grossTotal),
    deadlineAt: r.deadlineAt.toISOString(),
    reportRef: r.reportRef,
    attempts: r.attempts,
    errors: (r.lastErrors as unknown[]) ?? [],
    submittedAt: r.submittedAt?.toISOString() ?? null,
    acceptedAt: r.acceptedAt?.toISOString() ?? null,
  };
}

/**
 * E5: retail sales are reported to NRS once a day. Uploads are grouped by sales date into a
 * daily report; each report is submitted automatically shortly after the day closes and
 * must be accepted within 24 hours. A daily check alerts the business 6 hours before the
 * deadline if a day is missing or failed.
 */
@Injectable()
export class B2cService implements OnModuleInit {
  private readonly log = new Logger('B2C');
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotificationsService,
    private readonly jobs: JobsService,
    @Inject(ACCESS_POINT) private readonly accessPoint: AccessPointProvider,
  ) {}

  onModuleInit() {
    this.jobs.register(B2C_SUBMIT_JOB, (p: { reportId: string }) => this.attempt(p.reportId));
    this.jobs.register(B2C_CHECK_JOB, (p: { date: string }, job) => this.dailyCheck(job.workspaceId!, p.date));
  }

  // ── Status ──────────────────────────────────────────────────────────

  async days(count: number) {
    const db = this.prisma.scoped();
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: requireWorkspaceId() } });
    const today = lagosToday();
    const from = addDays(today, -(count - 1));
    const reports = await db.b2cReport.findMany({ where: { salesDate: { gte: new Date(from) } }, orderBy: { salesDate: 'desc' } });
    const byDate = new Map(reports.map((r) => [isoDay(r.salesDate)!, r]));
    const started = isoDay(ws.createdAt)!;
    const days = [];
    for (let d = today; d >= from; d = addDays(d, -1)) {
      const r = byDate.get(d);
      if (r) days.push({ ...reportDto(r), date: d });
      else if (d >= started || d === today)
        days.push({ id: null, date: d, status: d === today ? 'open' : 'missing', noSales: false, rows: 0, net: 0, vat: 0, gross: 0, deadlineAt: b2cDeadline(d).toISOString(), reportRef: null, attempts: 0, errors: [], submittedAt: null, acceptedAt: null });
    }
    return { enabled: ws.b2cEnabled, today, days };
  }

  async setEnabled(enabled: boolean) {
    const workspaceId = requireWorkspaceId();
    await this.prisma.scoped().workspace.update({ where: { id: workspaceId }, data: { b2cEnabled: enabled } });
    if (enabled) {
      // Start the daily deadline-check chain from yesterday (or today on a brand-new workspace).
      await this.scheduleCheck(workspaceId, addDays(lagosToday(), -1));
    }
    await this.audit.record({ entity: 'workspace', entityId: workspaceId, action: enabled ? 'b2c.enabled' : 'b2c.disabled' });
    return this.days(14);
  }

  async rows(date: string) {
    const r = await this.prisma.scoped().b2cReport.findUnique({
      where: { workspaceId_salesDate: { workspaceId: requireWorkspaceId(), salesDate: new Date(date) } },
      include: { sales: { orderBy: { receiptNo: 'asc' }, take: 1000 } },
    });
    if (!r) throw notFound('A report for that day');
    return {
      report: reportDto(r),
      sales: r.sales.map((s) => ({
        receiptNo: s.receiptNo,
        description: s.description,
        gross: num(s.grossAmount),
        net: num(s.net),
        vat: num(s.vat),
        vatTreatment: s.vatTreatment,
        buyerName: s.buyerName,
        buyerPhone: s.buyerPhone,
      })),
    };
  }

  // ── E5-2: upload from POS ───────────────────────────────────────────

  async upload(file: Express.Multer.File | undefined) {
    if (!file) throw badRequest('Choose a CSV or Excel file to upload.');
    const { headers, rows } = await parseSheet(file);
    const job = await this.prisma.scoped().importJob.create({
      data: {
        workspaceId: requireWorkspaceId(),
        kind: 'b2c',
        fileName: file.originalname.slice(0, 200),
        headers,
        rows: rows as unknown as Prisma.InputJsonValue,
        createdBy: requireUserId(),
      },
    });
    const suggestedMapping: Record<string, string> = {};
    for (const f of B2C_FIELDS) {
      const hit = headers.find((h) => (ALIASES[f] ?? []).includes(key(h)));
      if (hit) suggestedMapping[f] = hit;
    }
    return { id: job.id, fileName: job.fileName, headers, rowCount: rows.length, preview: rows.slice(0, 5), fields: B2C_FIELDS, suggestedMapping };
  }

  async commit(importId: string, mapping: Record<string, string>, dryRun: boolean) {
    const db = this.prisma.scoped();
    const workspaceId = requireWorkspaceId();
    const job = await db.importJob.findUnique({ where: { id: importId } });
    if (!job || job.kind !== 'b2c') throw notFound('That upload');
    if (job.status === 'completed') throw badRequest('This file has already been imported.');
    for (const f of ['date', 'receiptNo', 'amount']) {
      if (!mapping[f] || !job.headers.includes(mapping[f]!)) throw badRequest(`Map a column to "${f}" before importing.`);
    }
    const rows = job.rows as string[][];
    if (rows.length > IMPORT_MAX_ROWS) throw badRequest(`Files can have at most ${IMPORT_MAX_ROWS} rows.`);
    const idx = Object.fromEntries(Object.entries(mapping).map(([f, h]) => [f, job.headers.indexOf(h)]));
    const today = lagosToday();

    const errors: RowError[] = [];
    const valid: (B2cSaleInput & { row: number })[] = [];
    rows.forEach((r, i) => {
      const rowNo = i + 2;
      const obj: Record<string, unknown> = {};
      for (const [f, col] of Object.entries(idx)) if (col >= 0 && r[col] !== '' && r[col] !== undefined) obj[f] = r[col];
      if (typeof obj.date === 'string') obj.date = normaliseDate(obj.date);
      if (typeof obj.amount === 'string') obj.amount = obj.amount.replace(/[₦,\s]/g, '');
      if (typeof obj.vatTreatment === 'string') obj.vatTreatment = VAT_WORDS[key(obj.vatTreatment)] ?? obj.vatTreatment;
      const p = b2cSaleSchema.safeParse(obj);
      if (!p.success) {
        for (const iss of p.error.issues) errors.push({ row: rowNo, field: iss.path.join('.') || null, message: iss.message });
        return;
      }
      if (p.data.date > today) return void errors.push({ row: rowNo, field: 'date', message: 'The sale date is in the future.' });
      valid.push({ ...p.data, row: rowNo });
    });

    // Group by day; check duplicates in the file and against what's already stored for that day.
    const dates = [...new Set(valid.map((v) => v.date))].sort();
    const existing = await db.b2cReport.findMany({
      where: { salesDate: { in: dates.map((d) => new Date(d)) } },
      include: { sales: { select: { receiptNo: true } } },
    });
    const existingByDate = new Map(existing.map((r) => [isoDay(r.salesDate)!, r]));
    const seen = new Map<string, number>();
    const accepted: typeof valid = [];
    for (const v of valid) {
      const rep = existingByDate.get(v.date);
      const k = `${v.date}|${v.receiptNo}`;
      if (rep && (rep.status === 'accepted' || rep.status === 'submitting')) {
        errors.push({ row: v.row, field: 'date', message: `${v.date} has already been reported to NRS.` });
      } else if (rep?.sales.some((s) => s.receiptNo === v.receiptNo)) {
        errors.push({ row: v.row, field: 'receiptNo', message: `Receipt ${v.receiptNo} is already in the ${v.date} report.` });
      } else if (seen.has(k)) {
        errors.push({ row: v.row, field: 'receiptNo', message: `Same receipt number and date as row ${seen.get(k)}.` });
      } else {
        seen.set(k, v.row);
        accepted.push(v);
      }
    }

    const perDay = dates
      .map((d) => {
        const items = accepted.filter((a) => a.date === d);
        const kobo = items.reduce(
          (acc, a) => {
            const s = splitGross(a.amount, a.vatTreatment);
            return { gross: acc.gross + Math.round(s.gross * 100), vat: acc.vat + Math.round(s.vat * 100) };
          },
          { gross: 0, vat: 0 },
        );
        return { date: d, rows: items.length, gross: kobo.gross / 100, vat: kobo.vat / 100 };
      })
      .filter((d) => d.rows > 0);
    const result = { total: rows.length, valid: accepted.length, invalid: rows.length - accepted.length, errors: errors.slice(0, 1000), days: perDay, dryRun };
    if (dryRun) return result;

    for (const day of perDay) {
      const items = accepted.filter((a) => a.date === day.date);
      const report = await this.prisma.scopedTx(async (tx) => {
        const rep = await tx.b2cReport.upsert({
          where: { workspaceId_salesDate: { workspaceId, salesDate: new Date(day.date) } },
          create: { workspaceId, salesDate: new Date(day.date), deadlineAt: b2cDeadline(day.date) },
          update: { status: 'pending', noSales: false, lastErrors: Prisma.DbNull },
        });
        await tx.b2cSale.createMany({
          data: items.map((a) => {
            const s = splitGross(a.amount, a.vatTreatment);
            return {
              workspaceId,
              reportId: rep.id,
              receiptNo: a.receiptNo,
              description: a.description,
              grossAmount: s.gross,
              vatTreatment: a.vatTreatment,
              net: s.net,
              vat: s.vat,
              buyerName: a.buyerName,
              buyerPhone: a.buyerPhone,
            };
          }),
        });
        return this.recalculate(tx, rep.id);
      });
      const runAt = new Date(Math.max(Date.now(), b2cAutoSubmitAt(day.date).getTime()));
      await this.jobs.enqueue(B2C_SUBMIT_JOB, { reportId: report.id }, { runAt, workspaceId, dedupeKey: `b2c-submit:${report.id}:${report.updatedAt.getTime()}` });
    }
    await db.importJob.update({ where: { id: importId }, data: { status: 'completed', rows: [], result: result as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ entity: 'b2c', entityId: importId, action: 'b2c.uploaded', detail: { rows: accepted.length, days: perDay.map((d) => d.date) } });
    return result;
  }

  private async recalculate(tx: Prisma.TransactionClient, reportId: string) {
    const agg = await tx.b2cSale.aggregate({ where: { reportId }, _sum: { grossAmount: true, net: true, vat: true }, _count: { _all: true } });
    return tx.b2cReport.update({
      where: { id: reportId },
      data: {
        rowCount: agg._count._all,
        grossTotal: agg._sum.grossAmount ?? 0,
        netTotal: agg._sum.net ?? 0,
        vatTotal: agg._sum.vat ?? 0,
      },
    });
  }

  // ── Submission ──────────────────────────────────────────────────────

  private async reportFor(date: string) {
    return this.prisma.scoped().b2cReport.findUnique({
      where: { workspaceId_salesDate: { workspaceId: requireWorkspaceId(), salesDate: new Date(date) } },
    });
  }

  /** "Submit now" from the UI. Only for a finished day (today is still open). */
  async submitDay(date: string) {
    if (date >= lagosToday()) throw badRequest("Today's sales can be reported once the day is over.", [], 'DAY_NOT_CLOSED');
    const r = await this.reportFor(date);
    if (!r) throw notFound('A report for that day');
    if (r.status === 'accepted') return reportDto(r);
    await this.attempt(r.id);
    return reportDto((await this.reportFor(date))!);
  }

  /** E5-3 companion: a day with no retail sales is reported as an empty batch so it isn't flagged missing. */
  async noSales(date: string) {
    if (date >= lagosToday()) throw badRequest('You can confirm no sales once the day is over.', [], 'DAY_NOT_CLOSED');
    const workspaceId = requireWorkspaceId();
    const existing = await this.reportFor(date);
    if (existing && existing.rowCount > 0) throw conflict('This day already has sales. Delete them first if they were uploaded by mistake.', 'HAS_SALES');
    if (existing?.status === 'accepted') return reportDto(existing);
    const r = await this.prisma.scoped().b2cReport.upsert({
      where: { workspaceId_salesDate: { workspaceId, salesDate: new Date(date) } },
      create: { workspaceId, salesDate: new Date(date), deadlineAt: b2cDeadline(date), noSales: true },
      update: { noSales: true, status: 'pending' },
    });
    await this.audit.record({ entity: 'b2c', entityId: r.id, action: 'b2c.no_sales', detail: { date } });
    await this.attempt(r.id);
    return reportDto((await this.reportFor(date))!);
  }

  /** Remove a day's uploaded sales before they are reported (e.g. wrong file). */
  async deleteDay(date: string) {
    const r = await this.reportFor(date);
    if (!r) throw notFound('A report for that day');
    if (r.status === 'accepted' || r.status === 'submitting') throw conflict('This day has already been sent to NRS and cannot be deleted.', 'ALREADY_REPORTED');
    await this.prisma.scoped().b2cReport.delete({ where: { id: r.id } });
    await this.audit.record({ entity: 'b2c', entityId: r.id, action: 'b2c.day_deleted', detail: { date, rows: r.rowCount } });
  }

  /** One attempt to report a day. Runs from the UI or as a job (workspace context set by JobsService). */
  async attempt(reportId: string) {
    const db = this.prisma.scoped();
    const claimed = await db.b2cReport.updateMany({
      where: { id: reportId, status: { in: ['pending', 'rejected', 'failed'] } },
      data: { status: 'submitting', attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    const r = await db.b2cReport.findUniqueOrThrow({ where: { id: reportId }, include: { sales: true } });
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: r.workspaceId } });
    const date = isoDay(r.salesDate)!;
    const rows = r.sales.map((s) => ({ receiptNo: s.receiptNo, vatTreatment: s.vatTreatment, gross: num(s.grossAmount), net: num(s.net), vat: num(s.vat) }));
    const content = JSON.stringify({ date, noSales: r.noSales, rows: rows.map((x) => [x.receiptNo, x.gross, x.vatTreatment]) });
    try {
      const res = await this.accessPoint.reportB2C({
        idempotencyKey: `${r.id}:${sha256(content).slice(0, 24)}`,
        sellerTin: ws.tin,
        salesDate: date,
        noSales: r.noSales,
        rows,
        totals: { gross: num(r.grossTotal), net: num(r.netTotal), vat: num(r.vatTotal) },
      });
      if (res.status === 'accepted') {
        await db.b2cReport.update({
          where: { id: r.id },
          data: { status: 'accepted', reportRef: res.reference, submittedAt: new Date(), acceptedAt: new Date(), lastErrors: Prisma.DbNull },
        });
        await this.audit.record({ entity: 'b2c', entityId: r.id, action: 'b2c.accepted', detail: { date, reference: res.reference, rows: rows.length } });
      } else {
        await db.b2cReport.update({
          where: { id: r.id },
          data: { status: 'rejected', submittedAt: new Date(), lastErrors: res.errors.map(explainNrsError) as unknown as Prisma.InputJsonValue },
        });
        await this.audit.record({ entity: 'b2c', entityId: r.id, action: 'b2c.rejected', detail: { date, codes: res.errors } });
      }
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) this.log.error({ err, reportId }, 'Unexpected provider error; will retry');
      const giveUp = Date.now() - r.deadlineAt.getTime() > RETRY_FOR_MS;
      await db.b2cReport.update({
        where: { id: r.id },
        data: {
          status: giveUp ? 'failed' : 'pending',
          lastErrors: [{ code: 'APP-UNAVAILABLE', field: null, message: "NRS isn't responding. We'll keep retrying automatically." }],
        },
      });
      if (!giveUp) {
        await this.jobs.enqueue(B2C_SUBMIT_JOB, { reportId: r.id }, { runAt: new Date(Date.now() + RETRY_MS), workspaceId: r.workspaceId, dedupeKey: `b2c-submit:${r.id}:retry:${r.attempts + 1}` });
      }
    }
  }

  // ── E5-3: daily deadline check and alerts ──────────────────────────

  private async scheduleCheck(workspaceId: string, date: string) {
    const at = new Date(Math.max(Date.now(), b2cDeadline(date).getTime() - B2C_ALERT_LEAD_MS));
    await this.jobs.enqueue(B2C_CHECK_JOB, { date }, { runAt: at, workspaceId, dedupeKey: `b2c-check:${workspaceId}:${date}` });
  }

  /** Runs 6 hours before a day's deadline. Submits anything waiting, alerts if the day still isn't accepted, then schedules tomorrow. */
  async dailyCheck(workspaceId: string, date: string) {
    return runWithContext({ requestId: `b2c-check:${date}`, workspaceId, userId: null }, async () => {
      const db = this.prisma.scoped();
      const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
      if (!ws?.b2cEnabled) return; // chain stops when B2C is switched off
      let r = await this.reportFor(date);
      if (r && r.status === 'pending' && (r.rowCount > 0 || r.noSales)) {
        await this.attempt(r.id);
        r = await this.reportFor(date);
      }
      if (r?.status !== 'accepted') await this.alert(ws.id, ws.legalName, date, r?.status ?? 'missing');
      await this.scheduleCheck(workspaceId, addDays(date, 1));
    });
  }

  private async alert(workspaceId: string, name: string, date: string, status: string) {
    const deadline = b2cDeadline(date).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    const what = status === 'missing' ? 'has not been uploaded' : status === 'rejected' ? 'was rejected by NRS' : `is ${status}`;
    const body = `${name}: your retail sales report for ${date} ${what}. It must reach NRS by ${deadline}. Upload your sales or confirm there were no sales.`;
    const members = await this.prisma.scoped().membership.findMany({ where: { workspaceId, role: { in: ['owner', 'admin', 'accountant'] } } });
    const users = await this.prisma.user.findMany({ where: { id: { in: members.map((m) => m.userId) } } });
    for (const u of users) {
      // FRD asks for email + WhatsApp; WhatsApp Business API arrives in Phase 4, so SMS stands in for it.
      if (u.email) await this.notify.send({ workspaceId, channel: 'email', recipient: u.email, subject: `Retail sales report for ${date} needs attention`, body });
      if (u.phone) await this.notify.send({ workspaceId, channel: 'sms', recipient: u.phone, body });
    }
    await this.audit.record({ entity: 'b2c', entityId: null, action: 'b2c.deadline_alert', detail: { date, status }, workspaceId });
  }
}
