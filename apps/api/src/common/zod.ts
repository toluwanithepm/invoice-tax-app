import { PipeTransform } from '@nestjs/common';
import type { ZodSchema, ZodError } from 'zod';
import { badRequest, FieldError } from './errors';

export const zodErrors = (err: ZodError): FieldError[] =>
  err.issues.map((i) => ({ field: i.path.join('.') || null, message: i.message }));

/** Validates a body/query against a shared zod schema. Usage: @Body(new ZodPipe(schema)). */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw badRequest('Some details need fixing.', zodErrors(r.error), 'VALIDATION_FAILED');
    return r.data;
  }
}

/** Prisma Decimal / string / number → number (2dp money is exact within JS safe range). */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
