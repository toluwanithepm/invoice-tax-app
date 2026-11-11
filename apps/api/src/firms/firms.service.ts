import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { lagosToday, vatReturnDueDate, type FirmClientCreate } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { NotificationsService } from '../platform/notifications.service';
import { TAX_ID_REGISTRY, type TaxIdRegistry } from '../access-point/access-point';
import { MembersService } from '../members/members.service';
import { workspaceDto } from '../workspaces/workspaces.service';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { randomToken, sha256, uuidv7 } from '../common/crypto';
import { num } from '../common/zod';
import { ctx, requireUserId, requireWorkspaceId } from '../common/request-context';
import { env } from '../config/env';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I confusion
const INVITE_TTL_MS = 7 * 86_400_000;
const TRIAL_DAYS = 14;

/**
 * E6: accounting firms. A firm owns client workspaces; every firm member can open them all
 * (as the "accountant" role) from one login. Clients can also link an existing workspace to a
 * firm by entering the firm's connect code, and can unlink it at any time.
 */
@Injectable()
export class FirmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotificationsService,
    private readonly members: MembersService,
    @Inject(TAX_ID_REGISTRY) private readonly registry: TaxIdRegistry,
  ) {}

  private db() {
    return this.prisma.scoped({ workspaceId: null, userId: requireUserId() });
  }

  /** Throws 404 (not 403) for non-members so firm ids can't be probed. */
  async membership(firmId: string, needAdmin = false) {
    const m = await this.db().firmMember.findUnique({ where: { firmId_userId: { firmId, userId: requireUserId() } } });
    if (!m) throw notFound('That firm');
    if (needAdmin && m.role !== 'admin') throw forbidden('Only firm admins can do that.');
    return m;
  }

  async create(name: string) {
    const userId = requireUserId();
    const id = uuidv7();
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    await this.prisma.scopedTx(
      async (tx) => {
        await tx.firm.create({ data: { id, name, createdBy: userId, connectCode: code } });
        // createMany: no RETURNING, so the new row isn't checked against the select policy mid-statement.
        await tx.firmMember.createMany({ data: [{ firmId: id, userId, role: 'admin' }] });
      },
      { workspaceId: null, userId },
    );
    await this.audit.record({ entity: 'firm', entityId: id, action: 'firm.created', detail: { name }, workspaceId: null });
    return this.get(id);
  }

  async mine() {
    const userId = requireUserId();
    const rows = await this.db().firmMember.findMany({ where: { userId }, include: { firm: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((m) => ({ id: m.firm.id, name: m.firm.name, role: m.role }));
  }

  async get(firmId: string) {
    const me = await this.membership(firmId);
    const db = this.db();
    const firm = await db.firm.findUniqueOrThrow({ where: { id: firmId } });
    const [members, invitations, clients] = await Promise.all([
      db.firmMember.findMany({ where: { firmId }, orderBy: { createdAt: 'asc' } }),
      me.role === 'admin' ? db.firmInvitation.findMany({ where: { firmId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }) : [],
      db.workspace.findMany({ where: { firmId }, select: { id: true } }),
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: members.map((m) => m.userId) } }, select: { id: true, name: true, email: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      id: firm.id,
      name: firm.name,
      role: me.role,
      connectCode: firm.connectCode,
      members: members.map((m) => ({ userId: m.userId, role: m.role, name: byId.get(m.userId)?.name ?? null, email: byId.get(m.userId)?.email ?? null })),
      invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() })),
      // E6-4: one bill for all clients at the firm rate. Collecting payment arrives with billing in Phase 3.
      billing: { clients: clients.length, perClientPrice: firm.perClientPrice, monthlyTotal: clients.length * firm.perClientPrice },
    };
  }

  /** E6-2: compliance status across all clients, in one query. */
  async dashboard(firmId: string) {
    await this.membership(firmId);
    const today = lagosToday();
    const rows = await this.prisma.scopedTx(
      (tx) =>
        tx.$queryRaw<
          {
            workspace_id: string;
            legal_name: string;
            trading_name: string | null;
            tin: string;
            mbs_status: string;
            b2c_enabled: boolean;
            drafts: bigint;
            awaiting_approval: bigint;
            in_progress: bigint;
            needs_fixing: bigint;
            cleared_this_month: bigint;
            output_vat_this_month: unknown;
            b2c_missing_days: bigint;
            last_activity: Date | null;
          }[]
        >`SELECT * FROM app.firm_dashboard(${firmId}::uuid, ${today}::date)`,
      { workspaceId: null, userId: requireUserId() },
    );
    // The return for last month is due on the 21st of this month; after the 21st, next month's.
    const lastMonth = new Date(today.slice(0, 7) + '-01T00:00:00Z');
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    const dueThisMonth = vatReturnDueDate(lastMonth.toISOString().slice(0, 7));
    const nextVatDue = today <= dueThisMonth ? dueThisMonth : vatReturnDueDate(today.slice(0, 7));
    const clients = rows.map((r) => ({
      workspaceId: r.workspace_id,
      name: r.trading_name ?? r.legal_name,
      legalName: r.legal_name,
      tin: r.tin,
      mbsStatus: r.mbs_status,
      b2cEnabled: r.b2c_enabled,
      drafts: Number(r.drafts),
      awaitingApproval: Number(r.awaiting_approval),
      inProgress: Number(r.in_progress),
      needsFixing: Number(r.needs_fixing),
      clearedThisMonth: Number(r.cleared_this_month),
      outputVatThisMonth: num(r.output_vat_this_month),
      b2cMissingDays: Number(r.b2c_missing_days),
      lastActivity: r.last_activity?.toISOString() ?? null,
      attention: Number(r.needs_fixing) + Number(r.b2c_missing_days) + (r.mbs_status === 'live' ? 0 : 1),
    }));
    return {
      today,
      nextVatDue,
      totals: {
        clients: clients.length,
        needsAttention: clients.filter((c) => c.attention > 0).length,
        awaitingApproval: clients.reduce((s, c) => s + c.awaitingApproval, 0),
        outputVatThisMonth: Math.round(clients.reduce((s, c) => s + c.outputVatThisMonth * 100, 0)) / 100,
      },
      clients: clients.sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name)),
    };
  }

  /** E6-1: the firm sets up a client business; optionally invites the business owner. */
  async createClient(firmId: string, input: FirmClientCreate) {
    await this.membership(firmId);
    const userId = requireUserId();
    const id = uuidv7();
    const record = await this.registry.lookup(input.tin);
    const ws = await this.prisma.scoped({ workspaceId: id, userId }).workspace.create({
      data: {
        id,
        firmId,
        firmLinkedAt: new Date(),
        legalName: input.legalName,
        tin: input.tin,
        turnover: input.turnover ?? null,
        tinVerifiedAt: record.found ? new Date() : null,
        registryName: record.legalName ?? null,
        address: record.address ?? null,
        trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
      },
    });
    await this.audit.record({ entity: 'workspace', entityId: id, action: 'firm.client_created', detail: { firmId }, workspaceId: id });
    let invitation = null;
    if (input.ownerEmail) invitation = await this.members.createInvitation(id, input.ownerEmail, 'owner');
    return { workspace: workspaceDto(ws), invitation };
  }

  async invite(firmId: string, email: string, role: 'admin' | 'accountant') {
    await this.membership(firmId, true);
    const db = this.db();
    const firm = await db.firm.findUniqueOrThrow({ where: { id: firmId } });
    const token = randomToken();
    const inv = await db.firmInvitation.create({
      data: { firmId, email, role, tokenHash: sha256(token), invitedBy: requireUserId(), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    const url = `${env().PUBLIC_APP_URL}/firm-invite/${token}`;
    await this.notify.send({
      channel: 'email',
      recipient: email,
      subject: `Join ${firm.name} on E-Invoice`,
      body: `${ctx().userName ?? 'A colleague'} invited you to join ${firm.name}, where you can manage the firm's clients. Accept within 7 days: ${url}`,
    });
    await this.audit.record({ entity: 'firm', entityId: firmId, action: 'firm.member_invited', detail: { email, role }, workspaceId: null });
    return { id: inv.id, email, role, expiresAt: inv.expiresAt.toISOString(), inviteUrl: url };
  }

  async previewInvitation(token: string) {
    const rows = await this.prisma.$queryRaw<{ firm_name: string; email: string; role: string }[]>`
      SELECT firm_name, email, role FROM app.resolve_firm_invitation(${sha256(token)})`;
    if (!rows[0]) throw notFound('That invitation (it may have expired or been used)');
    return { firmName: rows[0].firm_name, email: rows[0].email, role: rows[0].role };
  }

  async acceptInvitation(token: string) {
    const userId = requireUserId();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    try {
      const rows = await this.prisma.scopedTx(
        (tx) => tx.$queryRaw<{ firm_id: string; role: string }[]>`SELECT * FROM app.accept_firm_invitation(${sha256(token)}, ${user.email ?? ''})`,
        { workspaceId: null, userId },
      );
      const r = rows[0]!;
      await this.audit.record({ entity: 'firm', entityId: r.firm_id, action: 'firm.member_joined', detail: { role: r.role }, workspaceId: null });
      return { firmId: r.firm_id, role: r.role };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('EMAIL_MISMATCH')) {
        throw forbidden('This invitation is for a different email address. Sign in with the invited email to accept it.', 'INVITE_EMAIL_MISMATCH');
      }
      if (msg.includes('NOT_FOUND')) throw notFound('That invitation (it may have expired or been used)');
      throw e;
    }
  }

  async removeMember(firmId: string, userId: string) {
    await this.membership(firmId, true);
    const db = this.db();
    const target = await db.firmMember.findUnique({ where: { firmId_userId: { firmId, userId } } });
    if (!target) throw notFound('That member');
    if (target.role === 'admin' && (await db.firmMember.count({ where: { firmId, role: 'admin' } })) <= 1) {
      throw badRequest("You can't remove the firm's last admin.", [], 'LAST_ADMIN');
    }
    await db.firmMember.delete({ where: { firmId_userId: { firmId, userId } } });
    await this.audit.record({ entity: 'firm', entityId: firmId, action: 'firm.member_removed', detail: { userId }, workspaceId: null });
  }

  // ── Client side: link a workspace to a firm by code ───────────────

  async linkedFirm() {
    const workspaceId = requireWorkspaceId();
    const rows = await this.prisma.scopedTx(
      (tx) => tx.$queryRaw<{ firm_id: string; firm_name: string }[]>`SELECT * FROM app.linked_firm(${workspaceId}::uuid)`,
    );
    return rows[0] ? { firmId: rows[0].firm_id, firmName: rows[0].firm_name } : null;
  }

  async connect(code: string) {
    const workspaceId = requireWorkspaceId();
    const rows = await this.prisma.$queryRaw<{ firm_id: string; firm_name: string }[]>`SELECT * FROM app.resolve_firm_code(${code})`;
    const firm = rows[0];
    if (!firm) throw notFound('A firm with that code');
    const ws = await this.prisma.scoped().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    if (ws.firmId === firm.firm_id) return { firmId: firm.firm_id, firmName: firm.firm_name };
    if (ws.firmId) throw conflict('This business is already linked to a firm. Remove that link first.', 'ALREADY_LINKED');
    await this.prisma.scoped().workspace.update({ where: { id: workspaceId }, data: { firmId: firm.firm_id, firmLinkedAt: new Date() } });
    await this.audit.record({ entity: 'workspace', entityId: workspaceId, action: 'firm.linked', detail: { firmId: firm.firm_id, firmName: firm.firm_name } });
    return { firmId: firm.firm_id, firmName: firm.firm_name };
  }

  async disconnect() {
    const workspaceId = requireWorkspaceId();
    const linked = await this.linkedFirm();
    await this.prisma.scoped().workspace.update({ where: { id: workspaceId }, data: { firmId: null, firmLinkedAt: null } });
    await this.audit.record({ entity: 'workspace', entityId: workspaceId, action: 'firm.unlinked', detail: { firmId: linked?.firmId ?? null } });
  }
}
