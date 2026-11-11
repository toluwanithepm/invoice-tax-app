import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ctx } from '../common/request-context';

export interface AuditInput {
  entity: string;
  entityId?: string | null;
  action: string;
  detail?: Record<string, unknown>;
  workspaceId?: string | null;
}

/**
 * Append-only audit trail (E9-2, NFR-11). Rows can't be updated or deleted: the runtime role has
 * no UPDATE/DELETE grant and a trigger rejects them anyway. Retained ≥ 6 years (NFR-12).
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: Prisma.TransactionClient) {
    const c = ctx();
    const workspaceId = input.workspaceId !== undefined ? input.workspaceId : (c.workspaceId ?? null);
    const data = {
      workspaceId,
      actorId: c.userId ?? null,
      actorName: c.userName ?? (c.userId ? null : 'System'),
      entity: input.entity,
      entityId: input.entityId ?? null,
      action: input.action,
      detail: (input.detail ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: c.ip ?? null,
      requestId: c.requestId,
    };
    // createMany issues INSERT without RETURNING. With RETURNING, Postgres would also apply the
    // SELECT policy to the new row, which refuses account-level events (workspace_id IS NULL).
    if (tx) return tx.auditEvent.createMany({ data: [data] });
    return this.prisma.scoped({ workspaceId }).auditEvent.createMany({ data: [data] });
  }

  async list(filter: { entity?: string; entityId?: string; cursor?: string; limit: number }) {
    const rows = await this.prisma.scoped().auditEvent.findMany({
      where: { entity: filter.entity, entityId: filter.entityId },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, filter.limit);
    return { items, nextCursor: rows.length > filter.limit ? items[items.length - 1]!.id : null };
  }
}
