import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma, type Job } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runWithContext } from '../common/request-context';
import { env } from '../config/env';

export type JobHandler = (payload: any, job: Job) => Promise<void>;
const STUCK_AFTER_MS = 5 * 60 * 1000;
const MAX_JOB_ATTEMPTS = 8;

/**
 * Postgres-backed job queue (NFR-4). Works on serverless: nothing runs between requests, so
 * `drain()` is triggered every minute by Supabase pg_cron/pg_net or Vercel Cron hitting
 * /internal/jobs/run. Locally an in-process interval calls the same drain.
 * Jobs are claimed with FOR UPDATE SKIP LOCKED, so concurrent drains never double-process.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly maintenance: (() => Promise<void>)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(private readonly prisma: PrismaService) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }
  registerMaintenance(fn: () => Promise<void>) {
    this.maintenance.push(fn);
  }

  async enqueue(type: string, payload: Record<string, unknown>, opts: { runAt?: Date; workspaceId?: string | null; dedupeKey?: string } = {}) {
    try {
      return await this.prisma.job.create({
        data: {
          type,
          payload: payload as Prisma.InputJsonValue,
          runAt: opts.runAt ?? new Date(),
          workspaceId: opts.workspaceId ?? null,
          dedupeKey: opts.dedupeKey ?? null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null; // already queued
      throw e;
    }
  }

  async drain(limit = 25): Promise<{ processed: number; failed: number }> {
    if (this.draining) return { processed: 0, failed: 0 };
    this.draining = true;
    let processed = 0;
    let failed = 0;
    try {
      const jobs = await this.prisma.$queryRaw<Job[]>`
        UPDATE app.jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM app.jobs
          WHERE (status = 'pending' AND run_at <= now())
             OR (status = 'running' AND locked_at < now() - make_interval(secs => ${STUCK_AFTER_MS / 1000}))
          ORDER BY run_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
        RETURNING id, type, workspace_id AS "workspaceId", payload, attempts, run_at AS "runAt"`;
      for (const job of jobs) {
        const handler = this.handlers.get(job.type);
        try {
          if (!handler) throw new Error(`No handler for job type ${job.type}`);
          await runWithContext({ requestId: `job:${job.id}`, workspaceId: job.workspaceId, userId: null }, () =>
            handler(job.payload, job),
          );
          await this.prisma.job.update({ where: { id: job.id }, data: { status: 'done', lockedAt: null } });
          processed++;
        } catch (err) {
          failed++;
          const dead = job.attempts >= MAX_JOB_ATTEMPTS;
          this.log.warn({ err, jobId: job.id, type: job.type }, dead ? 'Job failed permanently' : 'Job failed; will retry');
          await this.prisma.job.update({
            where: { id: job.id },
            data: {
              status: dead ? 'dead' : 'pending',
              lockedAt: null,
              lastError: String((err as Error)?.message ?? err).slice(0, 1000),
              runAt: new Date(Date.now() + Math.min(60_000 * 2 ** job.attempts, 3_600_000)),
            },
          });
        }
      }
      for (const fn of this.maintenance) {
        await fn().catch((err) => this.log.warn({ err }, 'Maintenance task failed'));
      }
    } finally {
      this.draining = false;
    }
    return { processed, failed };
  }

  onApplicationBootstrap() {
    if (env().JOBS_INPROCESS && env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.drain().catch((err) => this.log.error({ err }, 'Drain failed')), 5_000);
      this.timer.unref();
      this.log.log('In-process job drain running every 5s');
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
