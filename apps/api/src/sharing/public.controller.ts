import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public, RateLimit } from '../common/decorators';
import { SharingService } from './sharing.service';

/** Public, token-scoped, read-only access to one cleared invoice (E3-6). */
@Controller('v1/public/invoices')
@Public()
export class PublicInvoicesController {
  constructor(private readonly sharing: SharingService) {}

  @Get(':token')
  @RateLimit({ name: 'public-invoice', limit: 120, windowSec: 600, by: 'ip' })
  view(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'private, no-store');
    return this.sharing.publicView(token);
  }

  @Get(':token/pdf')
  @RateLimit({ name: 'public-pdf', limit: 60, windowSec: 600, by: 'ip' })
  async pdf(@Param('token') token: string, @Res() res: Response) {
    const { buf, fileName } = await this.sharing.publicPdf(token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '')}"`);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  }

  @Get(':token/logo')
  @RateLimit({ name: 'public-logo', limit: 120, windowSec: 600, by: 'ip' })
  async logo(@Param('token') token: string, @Res() res: Response) {
    const { data, mime } = await this.sharing.publicLogo(token);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(mime).send(data);
  }
}
