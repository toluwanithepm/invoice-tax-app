import { Injectable } from '@nestjs/common';
import { ROLE_LABELS, type Role } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { NotificationsService } from '../platform/notifications.service';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { randomToken, sha256 } from '../common/crypto';
import { ctx, requireUserId, requireWorkspaceId } from '../common/request-context';
import { env } from '../config/env';

const INVITE_TTL_MS = 7 * 86_400_000;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotificationsService,
  ) {}

  async list() {
    const db = this.prisma.scoped();
    const members = await db.membership.findMany({ where: { workspaceId: requireWorkspaceId() }, orderBy: { createdAt: 'asc' } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
      select: { id: true, name: true, email: true, phone: true, totpEnabledAt: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const invitations = ['owner', 'admin'].includes(ctx().role ?? '')
      ? await db.invitation.findMany({ where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })
      : [];
    return {
      members: members.map((m) => {
        const u = byId.get(m.userId);
        return {
          userId: m.userId,
          name: u?.name ?? null,
          email: u?.email ?? null,
          phone: u?.phone ?? null,
          role: m.role,
          twoFactorEnabled: !!u?.totpEnabledAt,
          joinedAt: m.createdAt.toISOString(),
        };
      }),
      invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() })),
    };
  }

  async invite(email: string, role: Role) {
    if (role === 'owner' && ctx().role !== 'owner') throw forbidden('Only an owner can invite another owner.');
    const workspaceId = requireWorkspaceId();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      const m = await this.prisma.scoped().membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: existing.id } } });
      if (m) throw conflict(`${email} is already a member of this workspace.`, 'ALREADY_MEMBER');
    }
    const token = randomToken();
    const ws = await this.prisma.scoped().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const inv = await this.prisma.scoped().invitation.create({
      data: {
        workspaceId,
        email,
        role,
        tokenHash: sha256(token),
        invitedBy: requireUserId(),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    const url = `${env().PUBLIC_APP_URL}/invite/${token}`;
    await this.notify.send({
      workspaceId,
      channel: 'email',
      recipient: email,
      subject: `You've been invited to ${ws.tradingName ?? ws.legalName}`,
      body: `${ctx().userName ?? 'A colleague'} invited you to join ${ws.tradingName ?? ws.legalName} as ${ROLE_LABELS[role]}. Accept within 7 days: ${url}`,
    });
    await this.audit.record({ entity: 'invitation', entityId: inv.id, action: 'member.invited', detail: { email, role } });
    return { id: inv.id, email, role, expiresAt: inv.expiresAt.toISOString(), inviteUrl: url };
  }

  async revokeInvitation(id: string) {
    const r = await this.prisma.scoped().invitation.updateMany({ where: { id, acceptedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw notFound('That invitation');
    await this.audit.record({ entity: 'invitation', entityId: id, action: 'member.invitation_revoked' });
  }

  private async ownerCount() {
    return this.prisma.scoped().membership.count({ where: { workspaceId: requireWorkspaceId(), role: 'owner' } });
  }

  async changeRole(userId: string, role: Role) {
    const workspaceId = requireWorkspaceId();
    const db = this.prisma.scoped();
    const m = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!m) throw notFound('That member');
    if ((role === 'owner' || m.role === 'owner') && ctx().role !== 'owner') throw forbidden('Only an owner can change owner access.');
    if (m.role === 'owner' && role !== 'owner' && (await this.ownerCount()) <= 1) {
      throw badRequest('A workspace needs at least one owner. Make someone else an owner first.', [], 'LAST_OWNER');
    }
    await db.membership.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role } });
    await this.audit.record({ entity: 'member', entityId: userId, action: 'member.role_changed', detail: { from: m.role, to: role } });
    return { userId, role };
  }

  async remove(userId: string) {
    const workspaceId = requireWorkspaceId();
    const db = this.prisma.scoped();
    const m = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!m) throw notFound('That member');
    if (m.role === 'owner' && ctx().role !== 'owner') throw forbidden('Only an owner can remove an owner.');
    if (m.role === 'owner' && (await this.ownerCount()) <= 1) {
      throw badRequest("You can't remove the last owner.", [], 'LAST_OWNER');
    }
    await db.membership.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
    await this.audit.record({ entity: 'member', entityId: userId, action: 'member.removed', detail: { role: m.role } });
  }

  private async resolve(token: string) {
    const rows = await this.prisma.$queryRaw<{ invitation_id: string; workspace_id: string }[]>`
      SELECT * FROM app.resolve_invitation(${sha256(token)})`;
    const row = rows[0];
    if (!row) throw notFound('That invitation (it may have expired or been used)');
    return row;
  }

  async preview(token: string) {
    const row = await this.resolve(token);
    const db = this.prisma.scoped({ workspaceId: row.workspace_id });
    const inv = await db.invitation.findUniqueOrThrow({ where: { id: row.invitation_id } });
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: row.workspace_id } });
    return { workspaceName: ws.tradingName ?? ws.legalName, role: inv.role, email: inv.email };
  }

  async accept(token: string) {
    const userId = requireUserId();
    const row = await this.resolve(token);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.prisma.scopedTx(
      async (tx) => {
        const inv = await tx.invitation.findUniqueOrThrow({ where: { id: row.invitation_id } });
        if (!user.email || user.email.toLowerCase() !== inv.email.toLowerCase()) {
          throw forbidden(`This invitation is for ${inv.email}. Sign in with that email to accept it.`, 'INVITE_EMAIL_MISMATCH');
        }
        await tx.membership.upsert({
          where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId } },
          create: { workspaceId: inv.workspaceId, userId, role: inv.role },
          update: {},
        });
        await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
        await this.audit.record(
          { entity: 'member', entityId: userId, action: 'member.joined', detail: { role: inv.role }, workspaceId: inv.workspaceId },
          tx,
        );
        return { workspaceId: inv.workspaceId, role: inv.role };
      },
      { workspaceId: row.workspace_id, userId },
    );
  }
}
