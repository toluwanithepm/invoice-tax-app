'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { can, type Permission } from '@einv/shared';
import { api } from './api';
import type { Me, Workspace } from './types';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/v1/me') });

export function useWsId() {
  const p = useParams<{ ws: string }>();
  return p.ws;
}

export function useWorkspace() {
  const ws = useWsId();
  return useQuery({ queryKey: ['ws', ws], queryFn: () => api.get<Workspace>(`/v1/workspaces/${ws}`), enabled: !!ws });
}

/** Current user's role in the open workspace, and a permission check that mirrors the API. */
export function useRole() {
  const ws = useWsId();
  const me = useMe();
  const role = me.data?.workspaces.find((w) => w.id === ws)?.role ?? null;
  return { role, can: (p: Permission) => can(role, p) };
}
