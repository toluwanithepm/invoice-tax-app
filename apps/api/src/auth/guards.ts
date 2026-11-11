import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ALLOW_PENDING_2FA_KEY, PUBLIC_KEY, SKIP_CSRF_KEY } from '../common/decorators';
import { forbidden, unauthorized } from '../common/errors';
import { safeEqual } from '../common/crypto';
import { setCtx } from '../common/request-context';
import { webOrigins } from '../config/env';
import { SessionService, csrfCookieName, sessionCookieName } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests:
 *  1. Origin (or Referer) must be one of WEB_ORIGIN on every state-changing request.
 *  2. When a session cookie is present, X-CSRF-Token must equal the csrf cookie (double submit).
 * SameSite=Lax cookies are a third layer.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [context.getHandler(), context.getClass()])) return true;

    const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
    if (!origin || !webOrigins().includes(origin)) throw forbidden('This request came from an unexpected site.', 'BAD_ORIGIN');

    if (req.cookies?.[sessionCookieName()]) {
      const cookie = req.cookies?.[csrfCookieName()];
      const header = req.headers['x-csrf-token'];
      if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) {
        throw forbidden('Your session check failed. Refresh the page and try again.', 'CSRF');
      }
    }
    return true;
  }
}

function refererOrigin(referer: string | undefined) {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/** Resolves the session cookie into the request context. Every route needs a session unless @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest<Request>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets);
    const session = await this.sessions.resolve(req.cookies?.[sessionCookieName()]);

    if (session) {
      setCtx({
        userId: session.userId,
        userName: session.user.name ?? session.user.email ?? session.user.phone,
        sessionId: session.id,
        mfaVerified: session.mfaVerified,
      });
      (req as any).session = session;
    }
    if (isPublic) return true;
    if (!session) throw unauthorized();

    const pendingOk = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_2FA_KEY, targets);
    if (session.user.totpEnabledAt && !session.mfaVerified && !pendingOk) {
      throw unauthorized('Enter the code from your authenticator app to continue.', 'MFA_REQUIRED');
    }
    return true;
  }
}
