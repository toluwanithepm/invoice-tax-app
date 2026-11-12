'use client';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Circle, FilePlus2, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { lagosToday, vatReturnDueDate } from '@einv/shared';
import { StatusBadge } from '@/components/status';
import { openWelcomeTour } from '@/components/welcome-tour';
import { Button } from '@/components/ui/button';
import { InfoTip } from '@/components/ui/help';
import { Card, CardHeader, EmptyState, Progress, Skeleton } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useMe, useRole, useWsId } from '@/lib/hooks';
import type { InvoiceSummary, Page, Workspace } from '@/lib/types';
import { cn, naira, shortDate } from '@/lib/utils';

interface Summary {
  workspace: Workspace;
  counts: Record<string, number>;
  thisMonth: { clearedCount: number; clearedTotal: number; outputVat: number };
  checklist: Record<'tinVerified' | 'branding' | 'mbsLive' | 'hasCustomer' | 'hasProduct' | 'firstInvoiceCleared', boolean>;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Home answers one question first: "what should I do next?" */
export default function Home() {
  const ws = useWsId();
  const me = useMe();
  const { can } = useRole();
  const summary = useQuery({ queryKey: ['summary', ws], queryFn: () => api.get<Summary>(`/v1/workspaces/${ws}/summary`) });
  const recent = useQuery({ queryKey: ['invoices', ws, 'recent'], queryFn: () => api.get<Page<InvoiceSummary>>(`/v1/workspaces/${ws}/invoices?limit=5`) });
  const s = summary.data;
  const firstName = me.data?.name?.split(' ')[0];

  const checklist = s
    ? [
        { done: s.checklist.tinVerified, label: 'Verify your Tax ID', hint: 'So NRS recognises your business', href: `/onboarding?ws=${ws}` },
        { done: s.checklist.mbsLive, label: 'Connect to NRS', hint: 'One click, about a minute', href: `/onboarding?ws=${ws}` },
        { done: s.checklist.branding, label: 'Add bank details', hint: 'So customers know where to pay', href: `/w/${ws}/settings?tab=branding` },
        { done: s.checklist.hasCustomer, label: 'Add your first customer', hint: 'Their Tax ID is checked for you', href: `/w/${ws}/customers` },
        { done: s.checklist.firstInvoiceCleared, label: 'Send your first invoice', hint: 'Approved by NRS in seconds', href: `/w/${ws}/invoices/new` },
      ]
    : [];
  const done = checklist.filter((c) => c.done).length;
  const setupDone = s && done === checklist.length;

  const attention = s
    ? [
        { n: s.counts.rejected ?? 0, text: (n: number) => `${n} invoice${n > 1 ? 's' : ''} need${n > 1 ? '' : 's'} fixing before NRS will approve`, cta: 'Fix', status: 'rejected' },
        { n: s.counts.failed ?? 0, text: (n: number) => `${n} invoice${n > 1 ? 's' : ''} couldn't be sent to NRS`, cta: 'Resend', status: 'failed' },
        { n: s.counts.pending_approval ?? 0, text: (n: number) => `${n} invoice${n > 1 ? 's are' : ' is'} waiting for approval`, cta: 'Review', status: 'pending_approval' },
        { n: s.counts.draft ?? 0, text: (n: number) => `${n} draft${n > 1 ? 's' : ''} not sent yet`, cta: 'Continue', status: 'draft' },
      ].filter((a) => a.n > 0)
    : [];

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          {s ? <p className="text-sm font-medium text-subtle">{s.workspace.tradingName ?? s.workspace.legalName}</p> : <Skeleton className="h-4 w-32" />}
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">
            {greeting()}
            {firstName ? `, ${firstName}` : ''}
          </h1>
        </div>
        {can('invoices.edit') && (
          <Button asChild size="lg" className="hidden sm:inline-flex lg:hidden">
            <Link href={`/w/${ws}/invoices/new`}>
              <FilePlus2 /> New invoice
            </Link>
          </Button>
        )}
      </div>

      {s && !setupDone && (
        <Card className="mb-6 overflow-hidden">
          <div className="grid gap-6 p-5 sm:p-6 md:grid-cols-[1fr_1.4fr]">
            <div>
              <p className="text-sm font-medium text-brand-700">Getting started</p>
              <h2 className="mt-1 text-xl font-semibold">
                {done} of {checklist.length} done
              </h2>
              <p className="mt-1 text-sm text-muted">Finish these and you are ready to issue invoices NRS accepts.</p>
              <div className="mt-4">
                <Progress value={done / checklist.length} label="Setup progress" />
              </div>
              <button onClick={openWelcomeTour} className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
                <PlayCircle className="size-4" /> How does this work?
              </button>
            </div>
            <ol className="space-y-1">
              {checklist.map((c) => (
                <li key={c.label}>
                  <Link
                    href={c.href}
                    className={cn('group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-slate-50', !c.done && 'bg-white')}
                    aria-label={`${c.label}${c.done ? ' (done)' : ''}`}
                  >
                    {c.done ? <CheckCircle2 className="size-5 shrink-0 text-brand-600" aria-hidden /> : <Circle className="size-5 shrink-0 text-line-strong" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm font-medium', c.done && 'text-subtle line-through')}>{c.label}</span>
                      {!c.done && <span className="block text-xs text-subtle">{c.hint}</span>}
                    </span>
                    {!c.done && <ArrowRight className="size-4 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />}
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        </Card>
      )}

      {s && setupDone && (
        <Card className="mb-6">
          <CardHeader title="Needs your attention" />
          {attention.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {attention.map((a) => (
                <li key={a.status} className="flex items-center justify-between gap-3 px-5 py-3 sm:px-6">
                  <span className="text-sm">{a.text(a.n)}</span>
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/w/${ws}/invoices?status=${a.status}`}>{a.cta}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 border-t border-line px-5 py-4 text-sm text-muted sm:px-6">
              <CheckCircle2 className="size-5 text-brand-600" aria-hidden /> You're all caught up.
            </p>
          )}
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Approved by NRS this month" value={s ? naira(s.thisMonth.clearedTotal) : null} hint={s ? `${s.thisMonth.clearedCount} invoice${s.thisMonth.clearedCount === 1 ? '' : 's'}` : undefined} />
        <Stat
          label={
            <span className="inline-flex items-center gap-1">
              VAT to pay this month <InfoTip term="outputVat" />
            </span>
          }
          value={s ? naira(s.thisMonth.outputVat) : null}
          hint="From approved invoices"
        />
        <Stat
          label={
            <span className="inline-flex items-center gap-1">
              Next VAT return due <InfoTip term="vatReturn" />
            </span>
          }
          value={shortDate(nextDue())}
          href={can('reports.view') ? `/w/${ws}/reports?tab=vat` : undefined}
        />
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Recent invoices"
          action={
            <Link href={`/w/${ws}/invoices`} className="text-sm font-semibold text-brand-700 hover:underline">
              View all
            </Link>
          }
        />
        {recent.isLoading ? (
          <div className="space-y-3 px-6 pb-6">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : recent.data?.items.length ? (
          <ul className="divide-y divide-line border-t border-line">
            {recent.data.items.map((i) => (
              <li key={i.id}>
                <Link href={`/w/${ws}/invoices/${i.id}`} className="flex items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-slate-50 sm:px-6">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{i.customerName ?? 'No customer yet'}</p>
                    <p className="text-[13px] text-subtle">
                      {i.number ?? 'Draft'} · {shortDate(i.issueDate)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
                    <span className="tabular text-sm font-semibold">{naira(i.total)}</span>
                    <StatusBadge status={i.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<FilePlus2 />}
            title="Your invoices will appear here"
            description="Create one, and NRS approves it with an IRN in seconds. You can then send it straight to your customer on WhatsApp."
            action={
              can('invoices.edit') && (
                <Button asChild>
                  <Link href={`/w/${ws}/invoices/new`}>Create your first invoice</Link>
                </Button>
              )
            }
          />
        )}
      </Card>
    </>
  );
}

/** After the 21st, the next return due is next month's. */
function nextDue() {
  const today = lagosToday();
  const prev = new Date(today.slice(0, 7) + '-01T00:00:00Z');
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const thisMonthDue = vatReturnDueDate(prev.toISOString().slice(0, 7));
  return today <= thisMonthDue ? thisMonthDue : vatReturnDueDate(today.slice(0, 7));
}

function Stat({ label, value, hint, href }: { label: React.ReactNode; value: string | null; hint?: string; href?: string }) {
  const body = (
    <>
      <p className="text-sm text-muted">{label}</p>
      {value === null ? <Skeleton className="mt-2 h-8 w-32" /> : <p className="tabular mt-1.5 text-[26px] font-semibold leading-8 tracking-tight">{value}</p>}
      {hint && <p className="mt-1 text-[13px] text-subtle">{hint}</p>}
      {href && (
        <Link href={href} className="mt-1 inline-block text-[13px] font-medium text-brand-700 hover:underline">
          See VAT report →
        </Link>
      )}
    </>
  );
  return <Card className="px-5 py-5 sm:px-6">{body}</Card>;
}
