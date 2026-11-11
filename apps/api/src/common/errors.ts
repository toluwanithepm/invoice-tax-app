import { HttpStatus } from '@nestjs/common';

export interface FieldError {
  field: string | null;
  message: string;
  code?: string;
}

/**
 * Application error rendered as RFC 9457 problem+json. `detail` and each `errors[].message`
 * are plain-English and safe to show to users (NFR-15).
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail: string,
    public readonly errors: FieldError[] = [],
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
  }
}

export const badRequest = (detail: string, errors: FieldError[] = [], code = 'BAD_REQUEST') =>
  new AppError(HttpStatus.BAD_REQUEST, code, detail, errors);
export const unauthorized = (detail = 'Please sign in again.', code = 'UNAUTHENTICATED') =>
  new AppError(HttpStatus.UNAUTHORIZED, code, detail);
export const forbidden = (detail = "You don't have permission to do that.", code = 'FORBIDDEN') =>
  new AppError(HttpStatus.FORBIDDEN, code, detail);
export const notFound = (what = 'That record') => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (detail: string, code = 'CONFLICT', extra: Record<string, unknown> = {}) =>
  new AppError(HttpStatus.CONFLICT, code, detail, [], extra);
export const unprocessable = (detail: string, errors: FieldError[], code = 'VALIDATION_FAILED') =>
  new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, detail, errors);
export const tooMany = (detail = 'Too many attempts. Wait a few minutes and try again.') =>
  new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', detail);
