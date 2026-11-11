import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { ctx } from '../common/request-context';

/**
 * Database access with tenant isolation (NFR-14), layer 2 of 2.
 *
 * The API connects as `app_runtime`, which is subject to Postgres RLS. Every tenant-scoped
 * query must run with `app.workspace_id` / `app.user_id` set *in the same transaction*:
 *  - `scoped()`   → client whose every model call is wrapped as [set_config(both), query] in one transaction
 *  - `scopedTx()` → interactive transaction with the settings applied first (multi-statement work)
 * Without a context, RLS returns zero rows rather than leaking data.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ transactionOptions: { maxWait: 5_000, timeout: 15_000 } });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private settings(workspaceId: string | null | undefined, userId: string | null | undefined) {
    // One statement (one round trip) sets both transaction-local settings.
    return this.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId ?? ''}, true), set_config('app.user_id', ${userId ?? ''}, true)`;
  }

  /** Model client bound to the current request's workspace and user. */
  scoped(override?: { workspaceId?: string | null; userId?: string | null }) {
    const c = ctx();
    const workspaceId = override && 'workspaceId' in override ? override.workspaceId : c.workspaceId;
    const userId = override && 'userId' in override ? override.userId : c.userId;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const base = this;
    return this.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            const results = await base.$transaction([base.settings(workspaceId, userId), query(args) as any]);
            return results[1];
          },
        },
      },
    });
  }

  /** Interactive transaction with RLS context applied. Keep external calls (MBS, email) outside it. */
  scopedTx<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    override?: { workspaceId?: string | null; userId?: string | null },
  ): Promise<T> {
    const c = ctx();
    const workspaceId = override && 'workspaceId' in override ? override.workspaceId : c.workspaceId;
    const userId = override && 'userId' in override ? override.userId : c.userId;
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId ?? ''}, true), set_config('app.user_id', ${userId ?? ''}, true)`;
      return fn(tx);
    });
  }
}

export type ScopedClient = ReturnType<PrismaService['scoped']>;

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
