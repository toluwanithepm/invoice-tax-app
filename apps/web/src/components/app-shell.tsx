'use client';
import * as DM from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, Briefcase, ChevronsUpDown, FileText, History, LayoutDashboard, LogOut, Menu, Package, Plus, Settings, ShoppingCart, Upload, Users, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Permission } from '@einv/shared';
import { Logo } from '@/components/auth-shell';
import { Alert, Spinner } from '@/components/ui/layout';
import { api, ApiError } from '@/lib/api';
import { useMe, useRole, useWorkspace, useWsId } from '@/lib/hooks';
import { cn } from '@/lib/utils';

const NAV: { href: string; label: string; icon: React.ElementType; perm: Permission; exact?: boolean }[] = [
  { href: '', label: 'Dashboard', icon: LayoutDashboard, perm: 'workspace.view', exact: true },
  { href: '/invoices', label: 'Invoices', icon: FileText, perm: 'workspace.view' },
  { href: '/reports', label: 'Reports & VAT', icon: BarChart3, perm: 'reports.view' },
  { href: '/b2c', label: 'Retail sales (B2C)', icon: ShoppingCart, perm: 'workspace.view' },
  { href: '/customers', label: 'Customers', icon: Users, perm: 'workspace.view' },
  { href: '/products', label: 'Products', icon: Package, perm: 'workspace.view' },
  { href: '/import', label: 'Import', icon: Upload, perm: 'records.edit' },
  { href: '/audit', label: 'Audit log', icon: History, perm: 'audit.view' },
  { href: '/settings', label: 'Settings', icon: Settings, perm: 'workspace.view' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const wsId = useWsId();
  const me = useMe();
  const ws = useWorkspace();
  const { can, role } = useRole();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const base = `/w/${wsId}`;

  if (me.isLoading || ws.isLoading) return <Spinner />;
  if (ws.error instanceof ApiError && ws.error.code === 'TWO_FACTOR_SETUP_REQUIRED') {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="warning" title="Two-step verification required" action={<Link href="/account" className="shrink-0 text-sm font-medium underline">Set it up</Link>}>
          {ws.error.detail}
        </Alert>
      </div>
    );
  }
  if (ws.error || !ws.data) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="error" title="Workspace not found">
          It may not exist, or you may not be a member. <Link href="/" className="underline">Go to your workspaces</Link>
        </Alert>
      </div>
    );
  }

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.filter((n) => can(n.perm)).map((n) => {
        const href = base + n.href;
        const active = n.exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={n.label}
            href={href}
            onClick={() => setOpen(false)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-brand-50 text-brand-800' : 'text-muted hover:bg-slate-100 hover:text-ink',
            )}
          >
            <n.icon className="size-4" aria-hidden />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-line bg-white lg:flex lg:flex-col lg:gap-6 lg:px-3 lg:py-5">
        <Logo className="px-2" />
        <WorkspaceSwitcher />
        {nav}
        <div className="mt-auto">
          <UserMenu />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
        <Logo />
        <button className="rounded-md p-2 text-muted hover:bg-slate-100" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </header>
      {open && (
        <div className="border-b border-line bg-white px-3 py-4 lg:hidden">
          <div className="mb-3">
            <WorkspaceSwitcher />
          </div>
          {nav}
          <div className="mt-3 border-t border-line pt-3">
            <UserMenu />
          </div>
        </div>
      )}

      <main id="main" className="min-w-0 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        {ws.data.mbsStatus !== 'live' && ['owner', 'admin', 'accountant'].includes(role ?? '') && (
          <Alert
            tone="warning"
            className="mb-6"
            title="You're not connected to NRS yet"
            action={
              <Link href={`/onboarding?ws=${wsId}`} className="shrink-0 text-sm font-medium underline">
                Finish setup
              </Link>
            }
          >
            Invoices can be drafted, but they can't be cleared until setup is complete.
          </Alert>
        )}
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

function WorkspaceSwitcher() {
  const me = useMe();
  const wsId = useWsId();
  const router = useRouter();
  const current = me.data?.workspaces.find((w) => w.id === wsId);
  return (
    <DM.Root>
      <DM.Trigger className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-white px-3 py-2 text-left text-sm shadow-sm hover:bg-slate-50">
        <span className="min-w-0">
          <span className="block truncate font-medium">{current?.name ?? 'Workspace'}</span>
          <span className="block text-xs capitalize text-subtle">{current?.role}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-subtle" aria-hidden />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={6} className="z-50 min-w-56 rounded-lg border border-line bg-white p-1 shadow-lg">
          <DM.Label className="px-2 py-1.5 text-xs text-subtle">Your businesses</DM.Label>
          {me.data?.workspaces.filter((w) => !w.viaFirmId).map((w) => (
            <DM.Item
              key={w.id}
              onSelect={() => router.push(`/w/${w.id}`)}
              className={cn('cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100', w.id === wsId && 'font-medium text-brand-800')}
            >
              {w.name}
            </DM.Item>
          ))}
          {me.data?.firms.map((f) => {
            const clients = me.data!.workspaces.filter((w) => w.viaFirmId === f.id);
            if (!clients.length) return null;
            return (
              <div key={f.id}>
                <DM.Label className="px-2 pb-1 pt-2 text-xs text-subtle">Clients of {f.name}</DM.Label>
                {clients.map((w) => (
                  <DM.Item
                    key={w.id}
                    onSelect={() => router.push(`/w/${w.id}`)}
                    className={cn('cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100', w.id === wsId && 'font-medium text-brand-800')}
                  >
                    {w.name}
                  </DM.Item>
                ))}
              </div>
            );
          })}
          {!!me.data?.firms.length && (
            <>
              <DM.Separator className="my-1 h-px bg-line" />
              <DM.Label className="px-2 py-1.5 text-xs text-subtle">Accounting firms</DM.Label>
              {me.data.firms.map((f) => (
                <DM.Item
                  key={f.id}
                  onSelect={() => router.push(`/f/${f.id}`)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100"
                >
                  <Briefcase className="size-4 text-subtle" /> {f.name}
                </DM.Item>
              ))}
            </>
          )}
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Item onSelect={() => router.push('/onboarding')} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100">
            <Plus className="size-4" /> Add a business
          </DM.Item>
          {!me.data?.firms.length && (
            <DM.Item onSelect={() => router.push('/firm')} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100">
              <Briefcase className="size-4" /> I'm an accountant
            </DM.Item>
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function UserMenu() {
  const me = useMe();
  const wsId = useWsId();
  const router = useRouter();
  const qc = useQueryClient();
  async function logout() {
    await api.post('/v1/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
      <Link href={`/w/${wsId}/settings?tab=security`} className="min-w-0 text-sm hover:underline">
        <span className="block truncate font-medium">{me.data?.name ?? 'Your account'}</span>
        <span className="block truncate text-xs text-subtle">{me.data?.email ?? me.data?.phone}</span>
      </Link>
      <button onClick={logout} className="rounded-md p-2 text-subtle hover:bg-slate-100 hover:text-ink" aria-label="Sign out" title="Sign out">
        <LogOut className="size-4" />
      </button>
    </div>
  );
}
