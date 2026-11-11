import { Injectable } from '@nestjs/common';
import type { Response, Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { randomToken, sha256 } from '../common/crypto';
import { isProd } from '../config/env';

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // NFR-7: 30 minutes idle
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

export const sessionCookieName = () => (isProd() ? '__Host-sid' : 'sid');
export const csrfCookieName = () => (isProd() ? '__Host-csrf' : 'csrf');

/**
 * Opaque server-side sessions. The cookie holds a 256-bit random token; only its SHA-256 is stored,
 * so a database leak does not yield usable sessions.
 */
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, mfaVerified: boolean, req: Request, res: Response) {
    const token = randomToken();
    const now = Date.now();
    const session = await this.prisma.session.create({
      data: {
        tokenHash: sha256(token),
        userId,
        mfaVerified,
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
        expiresAt: new Date(now + ABSOLUTE_TIMEOUT_MS),
      },
    });
    this.setCookies(res, token);
    return session;
  }

  /** Replace the token (after 2FA or a privilege change) so a stolen pre-auth token is useless. */
  async rotate(sessionId: string, patch: { mfaVerified?: boolean }, res: Response) {
    const token = randomToken();
    await this.prisma.session.update({ where: { id: sessionId }, data: { tokenHash: sha256(token), ...patch } });
    this.setCookies(res, token);
  }

  async resolve(token: string | undefined) {
    if (!token || token.length > 100) return null;
    const session = await this.prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!session || session.revokedAt) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return null;
    }
    if (now - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    return session;
  }

  revoke(sessionId: string) {
    return this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }

  revokeAll(userId: string) {
    return this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  setCookies(res: Response, token: string) {
    const secure = isProd();
    res.cookie(sessionCookieName(), token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: ABSOLUTE_TIMEOUT_MS,
    });
    // Double-submit CSRF token: readable by the web app, echoed in the X-CSRF-Token header.
    res.cookie(csrfCookieName(), randomToken(18), { httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge: ABSOLUTE_TIMEOUT_MS });
  }

  clearCookies(res: Response) {
    res.clearCookie(sessionCookieName(), { path: '/' });
    res.clearCookie(csrfCookieName(), { path: '/' });
  }
}
