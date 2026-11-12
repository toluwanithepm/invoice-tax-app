import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  ACCESS_POINT,
  TAX_ID_REGISTRY,
  type AccessPointProvider,
  type TaxIdRegistry,
} from '../access-point/access-point';
import { ProviderUnavailableError } from '../access-point/access-point';
import { Public, RateLimit } from '../common/decorators';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod';

/** An IRN, or the text inside an invoice's QR code (base64url JSON carrying `irn`). */
export function extractIrn(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9-]{6,80}$/.test(s) && s.includes('-')) return s;
  try {
    const decoded = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as { irn?: unknown };
    if (typeof decoded.irn === 'string' && /^[A-Za-z0-9-]{6,80}$/.test(decoded.irn)) return decoded.irn;
  } catch {
    /* not a QR payload */
  }
  return null;
}

/**
 * E8-1: anyone holding an invoice (a buyer claiming input VAT, an auditor) can check it was
 * approved by NRS. Answers come from MBS, never from this app's own records.
 */
@Controller('v1/public/irn')
@Public()
export class IrnCheckController {
  constructor(
    @Inject(ACCESS_POINT) private readonly accessPoint: AccessPointProvider,
    @Inject(TAX_ID_REGISTRY) private readonly registry: TaxIdRegistry,
  ) {}

  @Get()
  @RateLimit({ name: 'irn-check', limit: 30, windowSec: 600, by: 'ip' })
  async check(
    @Query(new ZodPipe(z.object({ q: z.string().min(1).max(2000) }))) query: { q: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const irn = extractIrn(query.q);
    if (!irn) return { valid: false, irn: null, reason: 'not_an_irn' as const };
    let found;
    try {
      found = await this.accessPoint.lookupIrn(irn);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        throw new AppError(
          503,
          'NRS_UNAVAILABLE',
          "NRS can't be reached right now. Try again in a few minutes.",
        );
      }
      throw err;
    }
    if (!found.valid) return { valid: false, irn, reason: 'not_found' as const };
    const seller = found.sellerTin ? await this.registry.lookup(found.sellerTin).catch(() => null) : null;
    return {
      valid: true,
      irn,
      sellerTin: found.sellerTin ?? null,
      sellerName: seller?.legalName ?? null,
      total: found.total ?? null,
      issueDate: found.issueDate ?? null,
    };
  }
}
