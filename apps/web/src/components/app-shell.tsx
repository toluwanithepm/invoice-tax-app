'use client';
import * as DM from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  Briefcase,
  Check,
  ChevronsUpDown,
  CircleHelp,
  FileText,
  Home,
  LogOut,
  Menu,
  Package,
  Plus,
  Settings,
  ShoppingCart,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Permission } from '@einv/shared';
import { Logo } from '@/components/auth-shell';
import { WelcomeTour } from '@/components/welcome-tour';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/layout';
import { api, ApiError } from '@/lib/api';
import { useMe, useRole, useWorkspace, useWsId } from '@/lib/hooks';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  perm: Permission;
  exact?: boolean;
  show?: boolean;
}

/**
 * Information architecture: five everyday destinations (Hick's law, Miller's law), the
 * occasional ones (Help, Settings) set apart at the bottom, and the most common action —
 * creating an invoice — always one click away (Fitts's law).
 */
function useNav(b2cEnabled: boolean): NavItem[] {
  return [
    { href: '', label: 'Home', icon: Home, perm: 'workspace.view', exact: true },
    { href: '/invoices', label: 'Invoices', icon: FileText, perm: 'workspace.view' },
    { href: '/customers', label: 'Customers', icon: Users, perm: 'workspace.view' },
    { href: '/products', label: 'Products', icon: Package, perm: 'workspace.view' },
    { href: '/reports', label: 'VAT & reports', icon: BarChart3, perm: 'reports.view' },
    { href: '/b2c', label: 'Retail sales', icon: ShoppingCart, perm: 'workspace.view', show: b2cEnabled },
  ];
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const wsId = useWsId();
  const me = useMe();
  const ws = useWorkspace();
  const { can, role } = useRole();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const base = `/w/${wsId}`;
  const nav = useNav(!!ws.data?.b2cEnabled).filter((n) => n.show !== false && can(n.perm));

  useEffect(() => setOpen(false), [pathname]);

  if (me.isLoading || ws.isLoading) return <Spinner />;
  if (ws.error instanceof ApiError && ws.error.code === 'TWO_FACTOR_SETUP_REQUIRED') {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="warning" title="Two-step verification required" action={<Link href="/account" className="shrink-0 text-sm font-semibold underline">Set it up</Link>}>
          {ws.error.detail}
        </Alert>
      </div>
    );
  }
  if (ws.error || !ws.data) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="error" title="Business not found">
          It may not exist, or you may not have access. <Link href="/" className="underline">Go to your businesses</Link>
        </Alert>
      </div>
    );
  }

  const isActive = (n: NavItem) => (n.exact ? pathname === base + n.href : pathname.startsWith(base + n.href));
  const linkCls = (active: boolean) =>
    cn(
      'flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition-colors',
      active ? 'bg-slate-900/[0.06] text-ink' : 'text-muted hover:bg-slate-900/[0.04] hover:text-ink',
    );
  const secondary = (
    <>
      <Link href="/help" className={linkCls(pathname.startsWith('/help'))}>
        <CircleHelp className="size-[18px]" aria-hidden /> Help & guides
      </Link>
      <Link href={`${base}/settings`} className={linkCls(pathname.startsWith(`${base}/settings`) || pathname.startsWith(`${base}/audit`) || pathname.startsWith(`${base}/import`))}>
        <Settings className="size-[18px]" aria-hidden /> Settings
      </Link>
    </>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_minmax(0,1fr)]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-5 border-r border-line bg-canvas px-3 py-5 lg:flex">
        <Logo className="px-2" href={base} />
        <WorkspaceSwitcher />
        {can('invoices.edit') && (
          <Button asChild className="w-full justify-center">
            <Link href={`${base}/invoices/new`}>
              <Plus /> New invoice
            </Link>
          </Button>
        )}
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {nav.map((n) => (
            <Link key={n.label} href={base + n.href} aria-current={isActive(n) ? 'page' : undefined} className={linkCls(isActive(n))}>
              <n.icon className="size-[18px]" aria-hidden />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-3">
          {secondary}
          <UserMenu />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-white/90 px-4 py-2.5 backdrop-blur lg:hidden">
        <Logo href={base} />
        <span className="max-w-[45%] truncate text-sm font-medium text-muted">{ws.data.tradingName ?? ws.data.legalName}</span>
      </header>

      <main id="main" className="min-w-0 px-4 pb-28 pt-6 sm:px-6 lg:px-12 lg:pb-12 lg:pt-10">
        {ws.data.mbsStatus !== 'live' && ['owner', 'admin', 'accountant'].includes(role ?? '') && (
          <Alert
            tone="warning"
            className="mx-auto mb-6 max-w-6xl"
            title="One step left: connect to NRS"
            action={
              <Link href={`/onboarding?ws=${wsId}`} className="shrink-0 self-center text-sm font-semibold text-amber-900 underline">
                Finish setup
              </Link>
            }
          >
            You can draft invoices now. They can be sent to NRS once setup is complete — it takes about a minute.
          </Alert>
        )}
        <div className="mx-auto max-w-6xl animate-rise">{children}</div>
      </main>

      {/* Mobile bottom tab bar: primary destinations within thumb reach */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        <div className="mx-auto grid max-w-md grid-cols-5 items-end px-2">
          {[nav[0], nav[1]].filter(Boolean).map((n) => (
            <TabLink key={n!.label} href={base + n!.href} icon={n!.icon} label={n!.label} active={isActive(n!)} />
          ))}
          <div className="flex justify-center">
            {can('invoices.edit') ? (
              <Link href={`${base}/invoices/new`} aria-label="New invoice" className="-mt-5 grid size-14 place-items-center rounded-full bg-brand-700 text-white shadow-pop ring-4 ring-white active:scale-95">
                <Plus className="size-6" />
              </Link>
            ) : (
              <span />
            )}
          </div>
          {nav[2] && <TabLink href={base + nav[2].href} icon={nav[2].icon} label={nav[2].label} active={isActive(nav[2])} />}
          <button onClick={() => setOpen(true)} className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-muted" aria-label="More">
            <Menu className="size-5" />
            More
          </button>
        </div>
      </nav>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button className="absolute inset-0 bg-ink/30" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] animate-rise overflow-y-auto rounded-t-3xl bg-canvas p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-semibold">Menu</p>
              <button onClick={() => setOpen(false)} className="rounded-md p-2 text-muted hover:bg-slate-100" aria-label="Close">
                <X className="size-5" />
              </button>
            </div>
            <WorkspaceSwitcher />
            <nav aria-label="All pages" className="mt-3 flex flex-col gap-0.5">
              {nav.map((n) => (
                <Link key={n.label} href={base + n.href} className={linkCls(isActive(n))}>
                  <n.icon className="size-[18px]" aria-hidden />
                  {n.label}
                </Link>
              ))}
              <div className="my-2 border-t border-line" />
              {secondary}
            </nav>
            <div className="mt-2 border-t border-line pt-2">
              <UserMenu />
            </div>
          </div>
        </div>
      )}

      <WelcomeTour />
    </div>
  );
}

function TabLink({ href, icon: Icon, label, active }: { href: string; icon: React.ElementType; label: string; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={cn('flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', active ? 'text-brand-700' : 'text-muted')}>
      <Icon className="size-5" aria-hidden />
      {label}
    </Link>
  );
}

function WorkspaceSwitcher() {
  const me = useMe();
  const wsId = useWsId();
  const router = useRouter();
  const current = me.data?.workspaces.find((w) => w.id === wsId);
  const own = me.data?.workspaces.filter((w) => !w.viaFirmId) ?? [];
  const item = 'flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-slate-100';
  return (
    <DM.Root>
      <DM.Trigger className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left hover:bg-slate-50">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-sm font-semibold text-brand-800">{(current?.name ?? '?').slice(0, 1)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{current?.name ?? 'Business'}</span>
          <span className="block text-xs capitalize text-subtle">{current?.viaFirmId ? 'Client · accountant' : current?.role}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-subtle" aria-hidden />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={6} className="z-50 w-[var(--radix-dropdown-menu-trigger-width)] min-w-60 animate-rise rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          <DM.Label className="px-2.5 py-1.5 text-xs font-medium text-subtle">Your businesses</DM.Label>
          {own.map((w) => (
            <DM.Item key={w.id} onSelect={() => router.push(`/w/${w.id}`)} className={item}>
              <span className="truncate">{w.name}</span>
              {w.id === wsId && <Check className="size-4 text-brand-700" />}
            </DM.Item>
          ))}
          {me.data?.firms.map((f) => {
            const clients = me.data!.workspaces.filter((w) => w.viaFirmId === f.id);
            return (
              <div key={f.id}>
                <DM.Separator className="my-1 h-px bg-line" />
                <DM.Item onSelect={() => router.push(`/f/${f.id}`)} className={cn(item, 'font-medium')}>
                  <span className="flex items-center gap-2 truncate">
                    <Briefcase className="size-4 text-subtle" /> {f.name}
                  </span>
                  <span className="text-xs text-subtle">Dashboard</span>
                </DM.Item>
                {clients.map((w) => (
                  <DM.Item key={w.id} onSelect={() => router.push(`/w/${w.id}`)} className={cn(item, 'pl-8')}>
                    <span className="truncate">{w.name}</span>
                    {w.id === wsId && <Check className="size-4 text-brand-700" />}
                  </DM.Item>
                ))}
              </div>
            );
          })}
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Item onSelect={() => router.push('/onboarding')} className={cn(item, 'justify-start gap-2 text-muted')}>
            <Plus className="size-4" /> Add a business
          </DM.Item>
          {!me.data?.firms.length && (
            <DM.Item onSelect={() => router.push('/firm')} className={cn(item, 'justify-start gap-2 text-muted')}>
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
  const name = me.data?.name ?? me.data?.email ?? 'You';
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
      <Link href={`/w/${wsId}/settings?tab=security`} className="flex min-w-0 items-center gap-2.5 text-sm hover:opacity-80">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
          {name
            .split(/\s+/)
            .map((p) => p[0])
            .slice(0, 2)
            .join('')
            .toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-xs text-subtle">{me.data?.email ?? me.data?.phone}</span>
        </span>
      </Link>
      <button onClick={logout} className="rounded-md p-2 text-subtle hover:bg-slate-100 hover:text-ink" aria-label="Sign out" title="Sign out">
        <LogOut className="size-4" />
      </button>
    </div>
  );
}
