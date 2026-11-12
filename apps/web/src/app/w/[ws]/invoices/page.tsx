'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FilePlus2, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { DOC_TYPE_LABELS } from '@einv/shared';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useRole, useWsId } from '@/lib/hooks';
import type { InvoiceSummary, Page } from '@/lib/types';
import { cn, naira, shortDate } from '@/lib/utils';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'pending_approval', label: 'Needs approval' },
  { key: 'submitting,queued', label: 'With NRS' },
  { key: 'cleared', label: 'Approved' },
  { key: 'rejected,failed', label: 'Needs fixing' },
];

function InvoiceList() {
  const ws = useWsId();
  const { can } = useRole();
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useInfiniteQuery({
    queryKey: ['invoices', ws, status, debounced],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api.get<Page<InvoiceSummary>>(
        `/v1/workspaces/${ws}/invoices?limit=25${status ? `&status=${status}` : ''}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Invoices, credit notes and debit notes"
        actions={
          can('invoices.edit') && (
            <Button asChild className="lg:hidden">
              <Link href={`/w/${ws}/invoices/new`}>
                <FilePlus2 /> New invoice
              </Link>
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={status === f.key}
              onClick={() => router.replace(`/w/${ws}/invoices${f.key ? `?status=${f.key}` : ''}`)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1 text-sm',
                status === f.key ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-white text-muted hover:text-ink',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input aria-label="Search invoices" placeholder="Number, IRN or customer" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
      </div>

      <Card>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-5">
            <Alert tone="error">{errorMessage(list.error)}</Alert>
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<FilePlus2 />} title={status || debounced ? 'No invoices match' : 'No invoices yet'} description={status || debounced ? 'Try another filter or search.' : 'Your invoices will show here.'} />
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full text-sm md:table">
              <thead className="border-b border-line text-left text-xs text-subtle">
                <tr>
                  <th className="px-5 py-3 font-medium">Number</th>
                  <th className="px-3 py-3 font-medium">Customer</th>
                  <th className="px-3 py-3 font-medium">Date</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((i) => (
                  <tr key={i.id} className="cursor-pointer hover:bg-slate-50" onClick={() => router.push(`/w/${ws}/invoices/${i.id}`)}>
                    <td className="px-5 py-3">
                      <Link href={`/w/${ws}/invoices/${i.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {i.number ?? 'Draft'}
                      </Link>
                      {i.docType !== 'invoice' && <span className="ml-2 text-xs text-subtle">{DOC_TYPE_LABELS[i.docType]}</span>}
                    </td>
                    <td className="max-w-56 truncate px-3 py-3">{i.customerName ?? <span className="text-subtle">—</span>}</td>
                    <td className="px-3 py-3 text-muted">{shortDate(i.issueDate)}</td>
                    <td className="px-3 py-3">
                      <StatusBadge status={i.status} />
                    </td>
                    <td className="tabular px-5 py-3 text-right font-medium">{naira(i.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Mobile list */}
            <ul className="divide-y divide-line md:hidden">
              {items.map((i) => (
                <li key={i.id}>
                  <Link href={`/w/${ws}/invoices/${i.id}`} className="block px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{i.customerName ?? 'No customer yet'}</span>
                      <span className="tabular shrink-0 font-medium">{naira(i.total)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-subtle">
                      <span>
                        {i.number ?? 'Draft'} · {shortDate(i.issueDate)}
                      </span>
                      <StatusBadge status={i.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            {list.hasNextPage && (
              <div className="border-t border-line p-3 text-center">
                <Button variant="ghost" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <InvoiceList />
    </Suspense>
  );
}
