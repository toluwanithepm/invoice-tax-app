import { AsyncLocalStorage } from 'async_hooks';
import type { Role } from '@einv/shared';

/** Per-request (or per-job) context. The database layer reads workspaceId/userId from here to apply RLS. */
export interface RequestContext {
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
  userId?: string | null;
  userName?: string | null;
  sessionId?: string | null;
  mfaVerified?: boolean;
  workspaceId?: string | null;
  role?: Role | null;
}

const als = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => als.run(ctx, fn);
export const ctx = (): RequestContext => als.getStore() ?? { requestId: 'system' };
/** Mutates the current context (used by guards once the user/workspace is known). */
export const setCtx = (patch: Partial<RequestContext>) => {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
};
export const requireUserId = () => {
  const id = ctx().userId;
  if (!id) throw new Error('No authenticated user in context');
  return id;
};
export const requireWorkspaceId = () => {
  const id = ctx().workspaceId;
  if (!id) throw new Error('No workspace in context');
  return id;
};
