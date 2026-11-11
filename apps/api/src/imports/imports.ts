import { Body, Controller, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { customerSchema, IMPORT_FIELDS, IMPORT_KINDS, IMPORT_MAX_ROWS, importCommitSchema, productSchema } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { RateLimit, RequirePermission } from '../common/decorators';
import { badRequest, notFound } from '../common/errors';
import { ZodPipe } from '../common/zod';
import { requireUserId, requireWorkspaceId } from '../common/request-context';

type Kind = (typeof IMPORT_KINDS)[number];
const MAX_BYTES = 5 * 1024 * 1024;

const ALIASES: Record<string, string[]> = {
  name: ['name', 'customername', 'customer', 'company', 'businessname', 'productname', 'product', 'item', 'itemname'],
  kind: ['kind', 'type', 'customertype', 'category'],
  tin: ['tin', 'taxid', 'taxidentificationnumber', 'taxnumber'],
  email: ['email', 'emailaddress'],
  phone: ['phone', 'phonenumber', 'mobile', 'telephone'],
  address: ['address', 'streetaddress', 'location'],
  description: ['description', 'details'],
  unitPrice: ['unitprice', 'price', 'rate', 'amount', 'sellingprice'],
  vatTreatment: ['vat', 'vattreatment', 'vattype', 'taxtype', 'vatstatus'],
  sku: ['sku', 'code', 'itemcode', 'productcode'],
};
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function suggestMapping(kind: Kind, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of IMPORT_FIELDS[kind]) {
    const hit = headers.find((h) => (ALIASES[field] ?? [field.toLowerCase()]).includes(key(h)));
    if (hit) out[field] = hit;
  }
  return out;
}

export function normaliseVat(v: string): string {
  const s = key(v);
  if (['standard', 's', '75', 'vatable', 'yes', 'std'].includes(s)) return 'standard';
  if (['zero', 'zerorated', 'z', '0', 'nil'].includes(s)) return 'zero';
  if (['exempt', 'e', 'none', 'no', 'exempted'].includes(s)) return 'exempt';
  return v;
}

/** Parses CSV or XLSX (checked by content, not just extension) into a header row and data rows. */
export async function parseSheet(file: Express.Multer.File): Promise<{ headers: string[]; rows: string[][] }> {
  const b = file.buffer;
  const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  let table: string[][];
  if (isZip) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(b as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('That workbook has no sheets.');
    table = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as unknown[]).slice(1).map(cellText);
      table.push(values);
    });
  } else {
    if (b.subarray(0, 4096).includes(0)) throw badRequest('Upload a CSV or Excel (.xlsx) file.');
    table = parseCsv(b, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true }) as string[][];
  }
  const [headerRow, ...rows] = table;
  if (!headerRow || headerRow.every((h) => !h)) throw badRequest('The first row must contain column names.');
  if (rows.length === 0) throw badRequest('The file has no data rows.');
  if (rows.length > IMPORT_MAX_ROWS) throw badRequest(`Files can have at most ${IMPORT_MAX_ROWS.toLocaleString()} rows. Split it and try again.`);
  return { headers: headerRow.map((h) => String(h ?? '').trim()), rows: rows.map((r) => r.map((c) => String(c ?? '').trim())) };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { result?: unknown; text?: string; richText?: { text: string }[] };
    if (o.result !== undefined) return cellText(o.result);
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.text) return o.text;
  }
  return String(v);
}

export interface RowError {
  row: number;
  field: string | null;
  message: string;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async upload(kind: Kind, file: Express.Multer.File | undefined) {
    if (!file) throw badRequest('Choose a CSV or Excel file to upload.');
    if (file.size > MAX_BYTES) throw badRequest('Files must be smaller than 5 MB.');
    const { headers, rows } = await parseSheet(file);
    const job = await this.prisma.scoped().importJob.create({
      data: {
        workspaceId: requireWorkspaceId(),
        kind,
        fileName: file.originalname.slice(0, 200),
        headers,
        rows: rows as unknown as Prisma.InputJsonValue,
        createdBy: requireUserId(),
      },
    });
    return {
      id: job.id,
      kind,
      fileName: job.fileName,
      headers,
      rowCount: rows.length,
      preview: rows.slice(0, 5),
      fields: IMPORT_FIELDS[kind],
      suggestedMapping: suggestMapping(kind, headers),
    };
  }

  /** Validates every row; on dryRun nothing is written. Valid rows are imported, invalid rows are listed. */
  async commit(id: string, mapping: Record<string, string>, dryRun: boolean) {
    const db = this.prisma.scoped();
    const job = await db.importJob.findUnique({ where: { id } });
    if (!job) throw notFound('That import');
    if (job.status === 'completed') throw badRequest('This file has already been imported.');
    const kind = job.kind as Kind;
    const rows = job.rows as string[][];
    const idx = Object.fromEntries(Object.entries(mapping).map(([field, header]) => [field, job.headers.indexOf(header)]));
    if (idx.name === undefined || idx.name < 0) throw badRequest('Map a column to "name" before importing.');

    const errors: RowError[] = [];
    const valid: Record<string, unknown>[] = [];
    const seenTins = new Map<string, number>();
    const existingTins =
      kind === 'customers'
        ? new Set((await db.customer.findMany({ where: { archivedAt: null }, select: { tin: true } })).map((c) => c.tin))
        : new Set<string>();

    rows.forEach((r, i) => {
      const rowNo = i + 2; // spreadsheet row number (header is row 1)
      const obj: Record<string, unknown> = {};
      for (const [field, col] of Object.entries(idx)) if (col >= 0 && r[col] !== '') obj[field] = r[col];
      if (kind === 'products' && typeof obj.vatTreatment === 'string') obj.vatTreatment = normaliseVat(obj.vatTreatment);
      if (kind === 'products' && typeof obj.unitPrice === 'string') obj.unitPrice = obj.unitPrice.replace(/[₦,\s]/g, '');
      if (kind === 'customers' && typeof obj.kind === 'string') obj.kind = /gov|b2g|ministry|agency/i.test(obj.kind) ? 'B2G' : 'B2B';
      const parsed = (kind === 'customers' ? customerSchema : productSchema).safeParse(obj);
      if (!parsed.success) {
        for (const iss of parsed.error.issues) errors.push({ row: rowNo, field: iss.path.join('.') || null, message: iss.message });
        return;
      }
      if (kind === 'customers') {
        const tin = (parsed.data as { tin: string }).tin;
        if (existingTins.has(tin)) return void errors.push({ row: rowNo, field: 'tin', message: 'A customer with this Tax ID already exists.' });
        if (seenTins.has(tin)) return void errors.push({ row: rowNo, field: 'tin', message: `Same Tax ID as row ${seenTins.get(tin)}.` });
        seenTins.set(tin, rowNo);
      }
      valid.push(parsed.data as Record<string, unknown>);
    });

    const result = { total: rows.length, valid: valid.length, invalid: rows.length - valid.length, errors: errors.slice(0, 1000), dryRun };
    if (dryRun) return result;

    const workspaceId = requireWorkspaceId();
    await this.prisma.scopedTx(async (tx) => {
      if (kind === 'customers') {
        await tx.customer.createMany({ data: valid.map((v) => ({ ...(v as any), workspaceId })) });
      } else {
        await tx.product.createMany({ data: valid.map((v) => ({ ...(v as any), workspaceId })) });
      }
      await tx.importJob.update({
        where: { id },
        data: { status: 'completed', result: result as unknown as Prisma.InputJsonValue, rows: [] },
      });
      await this.audit.record({ entity: 'import', entityId: id, action: `import.${kind}`, detail: { imported: valid.length, skipped: result.invalid } }, tx);
    });
    return result;
  }
}

@Controller('v1/workspaces/:workspaceId/imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post(':kind')
  @RequirePermission('records.edit')
  @RateLimit({ name: 'import', limit: 30, windowSec: 3600, by: 'user' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  upload(@Param('kind', new ZodPipe(z.enum(IMPORT_KINDS))) kind: Kind, @UploadedFile() file?: Express.Multer.File) {
    return this.imports.upload(kind, file);
  }

  @Post(':id/commit')
  @HttpCode(200)
  @RequirePermission('records.edit')
  commit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(importCommitSchema)) body: { mapping: Record<string, string> },
    @Query('dryRun') dryRun?: string,
  ) {
    return this.imports.commit(id, body.mapping, dryRun === 'true');
  }
}

/** Downloadable templates so users start from the right columns. */
@Controller('v1/import-templates')
export class ImportTemplatesController {
  @Get(':kind')
  template(@Param('kind', new ZodPipe(z.enum(IMPORT_KINDS))) kind: Kind) {
    const sample =
      kind === 'customers'
        ? 'name,kind,tin,email,phone,address\nLekki Retail Buyers Ltd,B2B,23456789-0001,ap@lekkiretail.ng,08031234567,"1 Alfred Rewane Road, Ikoyi"\n'
        : 'name,description,unitPrice,vatTreatment,sku\nRice 50kg,Parboiled rice,45000,standard,RICE50\n';
    return { fileName: `${kind}-template.csv`, csv: sample };
  }
}
