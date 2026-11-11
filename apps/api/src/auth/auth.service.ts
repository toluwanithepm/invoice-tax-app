import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as QRCode from 'qrcode';
import { emailSchema, phoneSchema, type OtpRequest, type OtpVerify } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from '../platform/rate-limit';
import { NotificationsService } from '../platform/notifications.service';
import { AuditService } from '../platform/audit.service';
import { badRequest, notFound } from '../common/errors';
import { decrypt, encrypt, hmac, randomDigits, randomToken, safeEqual, sha256, uuidv7 } from '../common/crypto';
import { ctx, setCtx } from '../common/request-context';
import { env } from '../config/env';
import { SessionService } from './session.service';
import { generateTotpSecret, totpUri, verifyTotp } from './totp';

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
export const PRIVACY_NOTICE_VERSION = '2026-11';
const ISSUER = 'E-Invoice';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimitService,
    private readonly notify: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private normalise(channel: 'email' | 'sms', identifier: string) {
    const r = channel === 'email' ? emailSchema.safeParse(identifier) : phoneSchema.safeParse(identifier);
    if (!r.success) throw badRequest(r.error.issues[0]!.message, [{ field: 'identifier', message: r.error.issues[0]!.message }]);
    return r.data;
  }

  /** E1-1: send a one-time code. The response is identical for new and existing accounts (no enumeration). */
  async requestOtp(input: OtpRequest) {
    const identifier = this.normalise(input.channel, input.identifier);
    await this.limiter.enforce(`otp:id:${sha256(identifier)}`, 5, 15 * 60);
    await this.limiter.enforce(`otp:ip:${ctx().ip ?? 'unknown'}`, 30, 15 * 60);

    const id = uuidv7();
    const code = randomDigits(6);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await this.prisma.otpChallenge.create({
      data: {
        id,
        channel: input.channel,
        identifier,
        codeHash: hmac(`${id}:${code}`),
        name: input.name ?? null,
        consent: input.consent === true,
        expiresAt,
        ip: ctx().ip ?? null,
      },
    });
    await this.notify.send({
      channel: input.channel,
      recipient: identifier,
      subject: `Your ${ISSUER} sign-in code`,
      body: `Your ${ISSUER} code is ${code}. It expires in 5 minutes. Never share it with anyone.`,
      sensitive: true,
    });
    return {
      challengeId: id,
      expiresAt: expiresAt.toISOString(),
      ...(env().OTP_DEV_ECHO && env().NODE_ENV !== 'production' ? { devCode: code } : {}),
    };
  }

  async verifyOtp(input: OtpVerify, req: Request, res: Response) {
    const ch = await this.prisma.otpChallenge.findUnique({ where: { id: input.challengeId } });
    const expired = 'This code has expired. Ask for a new one.';
    if (!ch || ch.consumedAt || ch.expiresAt.getTime() < Date.now() || ch.attempts >= OTP_MAX_ATTEMPTS) {
      throw badRequest(expired, [{ field: 'code', message: expired }], 'OTP_EXPIRED');
    }
    if (!safeEqual(hmac(`${ch.id}:${input.code}`), ch.codeHash)) {
      const updated = await this.prisma.otpChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
      const left = OTP_MAX_ATTEMPTS - updated.attempts;
      const msg = left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : expired;
      throw badRequest(msg, [{ field: 'code', message: msg }], 'OTP_INVALID');
    }
    // Single use, even under concurrent requests.
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: ch.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw badRequest(expired, [{ field: 'code', message: expired }], 'OTP_EXPIRED');

    const where = ch.channel === 'email' ? { email: ch.identifier } : { phone: ch.identifier };
    let user = await this.prisma.user.findUnique({ where });
    let isNew = false;
    if (!user) {
      if (!ch.consent) {
        throw badRequest('Please accept the privacy notice to create your account.', [
          { field: 'consent', message: 'Accept the privacy notice to continue.' },
        ], 'CONSENT_REQUIRED');
      }
      user = await this.prisma.user.create({
        data: {
          ...where,
          name: ch.name,
          consents: { create: { purpose: 'privacy_notice', version: PRIVACY_NOTICE_VERSION, granted: true, ip: ctx().ip ?? null } },
        },
      });
      isNew = true;
    }
    const mfaRequired = !!user.totpEnabledAt;
    await this.sessions.create(user.id, !mfaRequired, req, res);
    setCtx({ userId: user.id, userName: user.name ?? ch.identifier });
    await this.audit.record({ entity: 'user', entityId: user.id, action: isNew ? 'auth.signup' : 'auth.login', workspaceId: null });
    return { userId: user.id, isNew, mfaRequired };
  }

  // ── TOTP two-step verification ─────────────────────────────────────

  async setupTotp(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw badRequest('Two-step verification is already on.', [], 'TOTP_ALREADY_ON');
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: encrypt(secret) } });
    const uri = totpUri(secret, user.email ?? user.phone ?? 'account', ISSUER);
    return { otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }), secret };
  }

  async enableTotp(userId: string, code: string, res: Response) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecretEnc) throw badRequest('Start two-step setup first.', [], 'TOTP_NOT_SETUP');
    if (!this.checkTotp(user.totpSecretEnc, code)) throw this.badCode();
    const recovery = Array.from({ length: 8 }, () => {
      const t = randomToken(6).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8).toUpperCase();
      return `${t.slice(0, 4)}-${t.slice(4, 8)}`;
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabledAt: new Date(), recoveryCodes: recovery.map(sha256) },
    });
    await this.sessions.rotate(ctx().sessionId!, { mfaVerified: true }, res);
    await this.audit.record({ entity: 'user', entityId: userId, action: 'auth.2fa_enabled', workspaceId: null });
    return { recoveryCodes: recovery };
  }

  async verifyTotp(userId: string, code: string, res: Response) {
    await this.limiter.enforce(`totp:${userId}`, 10, 15 * 60);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt || !user.totpSecretEnc) throw badRequest('Two-step verification is not on.', [], 'TOTP_OFF');
    let ok = this.checkTotp(user.totpSecretEnc, code);
    if (!ok && code.includes('-')) {
      const h = sha256(code.toUpperCase());
      if (user.recoveryCodes.includes(h)) {
        ok = true;
        await this.prisma.user.update({ where: { id: userId }, data: { recoveryCodes: user.recoveryCodes.filter((c) => c !== h) } });
        await this.audit.record({ entity: 'user', entityId: userId, action: 'auth.recovery_code_used', workspaceId: null });
      }
    }
    if (!ok) throw this.badCode();
    await this.sessions.rotate(ctx().sessionId!, { mfaVerified: true }, res);
    return { ok: true };
  }

  async disableTotp(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecretEnc || !this.checkTotp(user.totpSecretEnc, code)) throw this.badCode();
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabledAt: null, totpSecretEnc: null, recoveryCodes: [] },
    });
    await this.audit.record({ entity: 'user', entityId: userId, action: 'auth.2fa_disabled', workspaceId: null });
    return { ok: true };
  }

  private checkTotp(secretEnc: string, code: string) {
    if (!/^\d{6}$/.test(code)) return false;
    try {
      return verifyTotp(decrypt(secretEnc), code);
    } catch {
      return false;
    }
  }
  private badCode() {
    const m = "That code isn't right. Check your authenticator app and try again.";
    return badRequest(m, [{ field: 'code', message: m }], 'TOTP_INVALID');
  }

  // ── Profile & privacy (NFR-9) ──────────────────────────────────────

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('Your account');
    const db = this.prisma.scoped({ workspaceId: null, userId });
    const [memberships, firmMemberships] = await Promise.all([
      db.membership.findMany({
        where: { userId },
        include: { workspace: { select: { id: true, legalName: true, tradingName: true, mbsStatus: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      db.firmMember.findMany({ where: { userId }, include: { firm: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
    ]);
    // Firm clients the user reaches through their firm (E6-1), unless they're also a direct member.
    const direct = new Set(memberships.map((m) => m.workspaceId));
    const firmClients = firmMemberships.length
      ? await db.workspace.findMany({
          where: { firmId: { in: firmMemberships.map((f) => f.firmId) }, id: { notIn: [...direct] } },
          select: { id: true, legalName: true, tradingName: true, mbsStatus: true, firmId: true },
          orderBy: { legalName: 'asc' },
        })
      : [];
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      twoFactorEnabled: !!user.totpEnabledAt,
      mfaVerified: !!ctx().mfaVerified,
      firms: firmMemberships.map((f) => ({ id: f.firm.id, name: f.firm.name, role: f.role })),
      workspaces: [
        ...memberships.map((m) => ({
          id: m.workspace.id,
          name: m.workspace.tradingName ?? m.workspace.legalName,
          role: m.role,
          mbsStatus: m.workspace.mbsStatus,
          viaFirmId: null as string | null,
        })),
        ...firmClients.map((w) => ({
          id: w.id,
          name: w.tradingName ?? w.legalName,
          role: 'accountant',
          mbsStatus: w.mbsStatus,
          viaFirmId: w.firmId,
        })),
      ],
    };
  }

  async updateName(userId: string, name: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { name } });
    return this.me(userId);
  }

  /** Data-subject access request: everything we hold about the person (not their businesses' tax records). */
  async exportPersonalData(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true, createdAt: true, totpEnabledAt: true, consents: true },
    });
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      select: { createdAt: true, lastSeenAt: true, ip: true, userAgent: true, revokedAt: true },
    });
    const me = await this.me(userId);
    await this.prisma.dataSubjectRequest.create({ data: { userId, kind: 'export', status: 'closed', closedAt: new Date() } });
    return { exportedAt: new Date().toISOString(), user, sessions, workspaces: me.workspaces };
  }

  /** Deletion request. Tax records must be kept (NFR-12), so a person is anonymised after review, not hard-deleted. */
  async requestDeletion(userId: string) {
    const req = await this.prisma.dataSubjectRequest.create({ data: { userId, kind: 'deletion' } });
    await this.audit.record({ entity: 'user', entityId: userId, action: 'privacy.deletion_requested', workspaceId: null });
    return { requestId: req.id, status: 'open', message: 'We have your request and will reply within 30 days.' };
  }
}
