'use client';
import { useQuery } from '@tanstack/react-query';
import { Check, Circle, FilePlus2 } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useRole, useWsId } from '@/lib/hooks';
import type { InvoiceSummary, Page, Workspace } from '@/lib/types';
import { naira, shortDate } from '@/lib/utils';

interface Summary {
  workspace: Workspace;
  counts: Record<string, number>;
  thisMonth: { clearedCount: number; clearedTotal: number; outputVat: number };
  checklist: Record<'tinVerified' | 'branding' | 'mbsLive' | 'hasCustomer' | 'hasProduct' | 'firstInvoiceCleared', boolean>;
}

export default function Dashboard() {
  const ws = useWsId();
  const { can } = useRole();
  const summary = useQuery({ queryKey: ['summary', ws], queryFn: () => api.get<Summary>(`/v1/workspaces/${ws}/summary`) });
  const recent = useQuery({ queryKey: ['invoices', ws, 'recent'], queryFn: () => api.get<Page<InvoiceSummary>>(`/v1/workspaces/${ws}/invoices?limit=6`) });
  const s = summary.data;

  const attention = s
    ? [
        { key: 'rejected', label: 'Rejected — need fixing', n: s.counts.rejected ?? 0 },
        { key: 'pending_approval', label: 'Waiting for approval', n: s.counts.pending_approval ?? 0 },
        { key: 'queued', label: 'Queued — retrying', n: s.counts.queued ?? 0 },
        { key: 'failed', label: 'Failed', n: s.counts.failed ?? 0 },
        { key: 'draft', label: 'Drafts', n: s.counts.draft ?? 0 },
      ].filter((a) => a.n > 0)
    : [];

  const checklist = s
    ? [
        { done: s.checklist.tinVerified, label: 'Verify your Tax ID', href: `/onboarding?ws=${ws}` },
        { done: s.checklist.branding, label: 'Add bank details for your invoices', href: `/w/${ws}/settings?tab=branding` },
        { done: s.checklist.mbsLive, label: 'Connect to NRS', href: `/onboarding?ws=${ws}` },
        { done: s.checklist.hasCustomer, label: 'Add a customer', href: `/w/${ws}/customers` },
        { done: s.checklist.firstInvoiceCleared, label: 'Clear your first invoice', href: `/w/${ws}/invoices/new` },
      ]
    : [];
  const setupDone = checklist.every((c) => c.done);

  return (
    <>
      <PageHeader
        title={s ? (s.workspace.tradingName ?? s.workspace.legalName) : <Skeleton className="h-8 w-56" />}
        description={s ? `TIN ${s.workspace.tin}` : undefined}
        actions={
          can('invoices.edit') && (
            <Button asChild>
              <Link href={`/w/${ws}/invoices/new`}>
                <FilePlus2 /> New invoice
              </Link>
            </Button>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Cleared this month" value={s ? String(s.thisMonth.clearedCount) : null} />
        <Stat label="Value cleared this month" value={s ? naira(s.thisMonth.clearedTotal) : null} />
        <Stat label="Output VAT this month" value={s ? naira(s.thisMonth.outputVat) : null} hint="From cleared invoices" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader
            title="Recent invoices"
            action={
              <Link href={`/w/${ws}/invoices`} className="text-sm font-medium text-brand-700 hover:underline">
                View all
              </Link>
            }
          />
          {recent.isLoading ? (
            <CardBody className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </CardBody>
          ) : recent.data?.items.length ? (
            <ul className="divide-y divide-line">
              {recent.data.items.map((i) => (
                <li key={i.id}>
                  <Link href={`/w/${ws}/invoices/${i.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{i.customerName ?? 'No customer yet'}</p>
                      <p className="text-xs text-subtle">
                        {i.number ?? 'Draft'} · {shortDate(i.issueDate)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="tabular text-sm font-medium">{naira(i.total)}</span>
                      <StatusBadge status={i.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<FilePlus2 />}
              title="No invoices yet"
              description="Create an invoice, submit it, and NRS clears it with an IRN in seconds."
              action={
                can('invoices.edit') && (
                  <Button asChild size="sm">
                    <Link href={`/w/${ws}/invoices/new`}>Create invoice</Link>
                  </Button>
                )
              }
            />
          )}
        </Card>

        <div className="space-y-6">
          {attention.length > 0 && (
            <Card>
              <CardHeader title="Needs attention" />
              <ul className="divide-y divide-line">
                {attention.map((a) => (
                  <li key={a.key}>
                    <Link href={`/w/${ws}/invoices?status=${a.key}`} className="flex justify-between px-5 py-2.5 text-sm hover:bg-slate-50">
                      {a.label} <span className="font-semibold">{a.n}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {s?.workspace.taxBand && (
            <Card>
              <CardBody>
                <p className="text-xs font-medium uppercase tracking-wide text-subtle">E-invoicing deadline</p>
                <p className="mt-1 text-lg font-semibold">{shortDate(s.workspace.taxBand.goLive)}</p>
                <p className="text-sm text-muted">{s.workspace.taxBand.band}</p>
                <p className="mt-2 text-sm">{s.workspace.mbsStatus === 'live' ? '✓ You are connected and ready.' : 'Finish connecting to NRS before this date.'}</p>
              </CardBody>
            </Card>
          )}

          {s && !setupDone && (
            <Card>
              <CardHeader title="Get set up" description={`${checklist.filter((c) => c.done).length} of ${checklist.length} done`} />
              <ul className="space-y-1 px-3 py-3">
                {checklist.map((c) => (
                  <li key={c.label}>
                    <Link href={c.href} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
                      {c.done ? <Check className="size-4 text-brand-600" aria-label="Done" /> : <Circle className="size-4 text-slate-300" aria-label="To do" />}
                      <span className={c.done ? 'text-subtle line-through' : ''}>{c.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-sm text-muted">{label}</p>
      {value === null ? <Skeleton className="mt-2 h-7 w-28" /> : <p className="tabular mt-1 text-2xl font-semibold">{value}</p>}
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </Card>
  );
}
