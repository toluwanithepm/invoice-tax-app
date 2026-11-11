import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { can, requires2fa, type Permission, type Role } from '@einv/shared';
import { PERMISSION_KEY } from '../common/decorators';
import { forbidden, notFound } from '../common/errors';
import { ctx, setCtx } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant isolation, layer 1 of 2 (layer 2 is Postgres RLS):
 * any route with a :workspaceId param requires membership of that workspace and an explicit
 * @RequirePermission. Non-members get 404 rather than 403 so workspace ids can't be probed.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  private readonly log = new Logger('WorkspaceGuard');
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const raw = req.params?.workspaceId;
    const workspaceId = typeof raw === 'string' ? raw : undefined;
    if (!workspaceId) return true;

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) {
      this.log.error(`Route ${req.method} ${req.route?.path} has no @RequirePermission — denied by default`);
      throw forbidden();
    }

    const userId = ctx().userId;
    if (!userId || !UUID_RE.test(workspaceId)) throw notFound('That workspace');

    const db = this.prisma.scoped({ workspaceId, userId });
    const [membership, workspace, user] = await Promise.all([
      db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } }),
      db.workspace.findUnique({ where: { id: workspaceId }, select: { require2fa: true, firmId: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } }),
    ]);
    if (!workspace) throw notFound('That workspace');

    // Direct membership wins; otherwise members of the linked accounting firm act as its accountant (E6-1).
    let role = (membership?.role as Role | undefined) ?? null;
    if (!role && workspace.firmId) {
      const firmMember = await db.firmMember.findUnique({ where: { firmId_userId: { firmId: workspace.firmId, userId } } });
      if (firmMember) role = 'accountant';
    }
    if (!role) throw notFound('That workspace');

    if (workspace.require2fa && requires2fa(role)) {
      if (!user?.totpEnabledAt) {
        throw forbidden('This workspace requires two-step verification. Turn it on in your security settings.', 'TWO_FACTOR_SETUP_REQUIRED');
      }
      if (!ctx().mfaVerified) throw forbidden('Enter your authenticator code to continue.', 'MFA_REQUIRED');
    }

    if (!can(role, permission)) throw forbidden();
    setCtx({ workspaceId, role });
    return true;
  }
}
