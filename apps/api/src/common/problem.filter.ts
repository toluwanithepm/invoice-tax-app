import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { AppError, FieldError } from './errors';
import { ctx } from './request-context';

/** Renders every error as RFC 9457 problem+json with plain-language text (NFR-15). Internals never leak. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const p = this.toProblem(exception);
    if (p.status >= 500) this.log.error({ err: exception, path: req.path }, 'Unhandled error');
    res
      .status(p.status)
      .type('application/problem+json')
      .json({
        type: `https://errors.einvoice.ng/${p.code.toLowerCase()}`,
        title: p.title,
        status: p.status,
        code: p.code,
        detail: p.detail,
        errors: p.errors,
        ...p.extra,
        requestId: ctx().requestId,
      });
  }

  private toProblem(e: unknown): {
    status: number;
    code: string;
    title: string;
    detail: string;
    errors: FieldError[];
    extra: Record<string, unknown>;
  } {
    const base = { errors: [] as FieldError[], extra: {} };
    if (e instanceof AppError) {
      return { status: e.status, code: e.code, title: HttpStatus[e.status] ?? 'Error', detail: e.detail, errors: e.errors, extra: e.extra };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const detail =
        status === 404 ? 'That page or record was not found.' : status === 413 ? 'That file is too large.' : e.message;
      return { ...base, status, code: HttpStatus[status] ?? 'HTTP_ERROR', title: HttpStatus[status] ?? 'Error', detail };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002')
        return { ...base, status: 409, code: 'DUPLICATE', title: 'Conflict', detail: 'A record with these details already exists.' };
      if (e.code === 'P2025')
        return { ...base, status: 404, code: 'NOT_FOUND', title: 'Not Found', detail: 'That record was not found.' };
    }
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('IMMUTABLE:')) {
      return {
        ...base,
        status: 409,
        code: 'IMMUTABLE',
        title: 'Conflict',
        detail: "This invoice has been cleared and can't be changed. Raise a credit or debit note instead.",
      };
    }
    if (msg.includes('row-level security')) {
      return { ...base, status: 404, code: 'NOT_FOUND', title: 'Not Found', detail: 'That record was not found.' };
    }
    return {
      ...base,
      status: 500,
      code: 'INTERNAL',
      title: 'Internal Server Error',
      detail: 'Something went wrong on our side. Try again; if it keeps happening, contact support.',
    };
  }
}
