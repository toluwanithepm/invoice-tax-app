import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public, SkipCsrf } from '../common/decorators';
import { unauthorized } from '../common/errors';
import { safeEqual } from '../common/crypto';
import { ZodPipe } from '../common/zod';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { MockAccessPoint } from '../access-point/mock-access-point';
import { devInbox } from '../platform/notifications.service';
import { JobsService } from './jobs.service';

/**
 * Job drain trigger. Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET`;
 * Supabase pg_cron + pg_net can POST with the same header.
 */
@Controller('internal/jobs')
@Public()
@SkipCsrf()
export class InternalJobsController {
  constructor(private readonly jobs: JobsService) {}

  private check(auth: string | undefined) {
    const expected = `Bearer ${env().CRON_SECRET}`;
    if (!auth || !safeEqual(auth, expected)) throw unauthorized('Not allowed.', 'BAD_CRON_SECRET');
  }

  @Get('run')
  runGet(@Headers('authorization') auth?: string) {
    this.check(auth);
    return this.jobs.drain();
  }

  @Post('run')
  @HttpCode(200)
  runPost(@Headers('authorization') auth?: string) {
    this.check(auth);
    return this.jobs.drain();
  }
}

@Controller('v1/health')
@Public()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    const started = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', db: 'ok', dbLatencyMs: Date.now() - started, time: new Date().toISOString() };
  }
}

/** Development-only helpers. Every route 404s outside development. */
@Controller('v1/dev')
export class DevController {
  private guard() {
    if (env().NODE_ENV !== 'development') throw new NotFoundException();
  }

  @Post('mock-mbs/outage')
  @HttpCode(200)
  outage(@Body(new ZodPipe(z.object({ on: z.boolean() }))) body: { on: boolean }) {
    this.guard();
    MockAccessPoint.outage = body.on;
    return { outage: MockAccessPoint.outage };
  }

  @Get('inbox')
  inbox() {
    this.guard();
    return devInbox.slice(-20);
  }
}
