import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { RATE_LIMIT_KEY, RateLimitRule } from '../common/decorators';
import { tooMany } from '../common/errors';
import { ctx } from '../common/request-context';

/**
 * Fixed-window rate limiter stored in Postgres, so limits hold across serverless instances
 * (an in-memory limiter would reset per Vercel function instance).
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly prisma: PrismaService) {}

  async hit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; count: number }> {
    const windowMs = windowSec * 1000;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO rate_limit_buckets (key, window_start, count) VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1
      RETURNING count`;
    const count = Number(rows[0]?.count ?? 0);
    return { allowed: count <= limit, count };
  }

  async enforce(key: string, limit: number, windowSec: number) {
    const r = await this.hit(key, limit, windowSec);
    if (!r.allowed) throw tooMany();
  }

  /** Housekeeping, called by the jobs drain. */
  async purgeOlderThan(hours = 24) {
    await this.prisma.$executeRaw`DELETE FROM rate_limit_buckets WHERE window_start < now() - make_interval(hours => ${hours})`;
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rule) return true;
    const c = ctx();
    const who = rule.by === 'user' && c.userId ? `u:${c.userId}` : `ip:${c.ip ?? 'unknown'}`;
    await this.limiter.enforce(`${rule.name}:${who}`, rule.limit, rule.windowSec);
    return true;
  }
}
