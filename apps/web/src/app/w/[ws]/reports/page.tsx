'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { DOC_TYPE_LABELS, lagosToday, monthLabel, type DocType } from '@einv/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Label, Select } from '@/components/ui/form';
import { InfoTip } from '@/components/ui/help';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Skeleton, Spinner } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useRole, useWsId } from '@/lib/hooks';
import type { Customer, Page } from '@/lib/types';
import { cn, naira, shortDate } from '@/lib/utils';

interface Dashboard {
  months: { month: string; sales: number; vat: number }[];
  thisMonth: { month: string; sales: number; vatOwed: number; dueDate: string };
  outstanding: {
    total: number;
    overdue: number;
    count: number;
    items: { id: string; number: string; customer: string | null; issueDate: string; dueDate: string | null; owed: number; overdue: boolean }[];
  };
}
interface Recon {
  month: string;
  monthLabel: string;
  dueDate: string;
  invoices: { count: number; net: number; vat: number };
  debitNotes: { count: number; net: number; vat: number };
  creditNotes: { count: number; net: number; vat: number };
  b2c: { days: number; net: number; vat: number; enabled: boolean };
  byTreatment: { treatment: string; net: number; vat: number }[];
  outputVat: number;
  declared: { vat: number; note: string | null; updatedAt: string } | null;
  difference: number | null;
  exceptions: {
    unclearedDocuments: { id: string; number: string | null; docType: DocType; statusLabel: string; customer: string | null; vat: number }[];
    unclearedVat: number;
    b2cMissingDays: { date: string; status: string }[];
  };
}

const TREATMENT_LABELS: Record<string, string> = { standard: 'Standard (7.5%)', zero: 'Zero-rated', exempt: 'Exempt' };

function Reports() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get('tab') === 'vat' ? 'vat' : 'overview';
  return (
    <>
      <PageHeader title="VAT & reports" description="See your sales and who owes you, and prepare your monthly VAT return." />
      <div role="tablist" aria-label="Report" className="mb-6 flex gap-1 border-b border-line">
        {[
          { key: 'overview', label: 'Overview' },
          { key: 'vat', label: 'VAT reconciliation' },
        ].map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => router.replace(`?tab=${t.key}`)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === t.key ? 'border-brand-700 text-brand-800' : 'border-transparent text-muted hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <Overview /> : <VatReconciliation />}
    </>
  );
}

/** E7-3: sales, outstanding payments and VAT owed at a glance, filterable by customer. */
function Overview() {
  const ws = useWsId();
  const { can } = useRole();
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState('');
  const [show, setShow] = useState<'all' | 'overdue'>('all');
  const customers = useQuery({ queryKey: ['customers', ws, 'all'], queryFn: () => api.get<Page<Customer>>(`/v1/workspaces/${ws}/customers?limit=100`) });
  const q = useQuery({
    queryKey: ['reports-dashboard', ws, customerId],
    queryFn: () => api.get<Dashboard>(`/v1/workspaces/${ws}/reports/dashboard?months=12${customerId ? `&customerId=${customerId}` : ''}`),
  });
  const d = q.data;

  async function markPaid(id: string) {
    try {
      await api.patch(`/v1/workspaces/${ws}/invoices/${id}/payment`, { paid: true });
      toast.success('Marked as paid');
      void qc.invalidateQueries({ queryKey: ['reports-dashboard', ws] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const items = d?.outstanding.items.filter((i) => show === 'all' || i.overdue) ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Label htmlFor="cust">Customer</Label>
          <Select id="cust" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">All customers</option>
            {customers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label={d ? `Sales in ${monthLabel(d.thisMonth.month)}` : 'Sales this month'} value={d ? naira(d.thisMonth.sales) : null} hint="Before VAT, from cleared invoices and B2C" />
        <Tile label="VAT owed this month" value={d ? naira(d.thisMonth.vatOwed) : null} hint={d ? `Return due ${shortDate(d.thisMonth.dueDate)}` : undefined} />
        <Tile
          label="Owed to you"
          value={d ? naira(d.outstanding.total) : null}
          hint={d ? (d.outstanding.overdue > 0 ? `${naira(d.outstanding.overdue)} overdue` : 'Nothing overdue') : undefined}
          warn={!!d && d.outstanding.overdue > 0}
        />
      </div>

      <Card>
        <CardHeader title="Net sales by month" description="Last 12 months. Credit notes are deducted." />
        <CardBody>{q.isLoading ? <Skeleton className="h-48" /> : d ? <SalesChart months={d.months} /> : null}</CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Unpaid invoices"
          description="Cleared invoices you haven't marked as paid, net of credit and debit notes."
          action={
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm" role="tablist" aria-label="Show">
              {(['all', 'overdue'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={show === k} onClick={() => setShow(k)} className={cn('rounded-md px-2.5 py-1', show === k ? 'bg-white' : 'text-muted')}>
                  {k === 'all' ? 'All' : 'Overdue'}
                </button>
              ))}
            </div>
          }
        />
        {q.isLoading ? (
          <Spinner />
        ) : !items.length ? (
          <EmptyState icon={<CheckCircle2 />} title={show === 'overdue' ? 'Nothing overdue' : 'Nothing outstanding'} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <Link href={`/w/${ws}/invoices/${i.id}`} className="font-medium hover:underline">
                    {i.number}
                  </Link>{' '}
                  <span className="text-muted">· {i.customer}</span>
                  <p className="text-xs text-subtle">
                    Issued {shortDate(i.issueDate)}
                    {i.dueDate && ` · due ${shortDate(i.dueDate)}`} {i.overdue && <Badge tone="red" className="ml-1">Overdue</Badge>}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular font-medium">{naira(i.owed)}</span>
                  {can('invoices.payments') && (
                    <Button size="sm" variant="secondary" onClick={() => markPaid(i.id)}>
                      Mark paid
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Tile({ label, value, hint, warn }: { label: string; value: string | null; hint?: string; warn?: boolean }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-sm text-muted">{label}</p>
      {value === null ? <Skeleton className="mt-2 h-7 w-28" /> : <p className="tabular mt-1 text-2xl font-semibold">{value}</p>}
      {hint && <p className={cn('mt-0.5 text-xs', warn ? 'font-medium text-red-700' : 'text-subtle')}>{hint}</p>}
    </Card>
  );
}

/** Single-series column chart: one brand hue, rounded data-ends, 2px gaps, hover tooltip, table for screen readers. */
function SalesChart({ months }: { months: Dashboard['months'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...months.map((m) => m.sales));
  const fmtShort = (n: number) => (n >= 1e6 ? `₦${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `₦${Math.round(n / 1e3)}k` : naira(n));
  const label = (m: string) => new Date(m + '-01T00:00:00Z').toLocaleDateString('en-NG', { month: 'short', timeZone: 'UTC' });
  const ticks = [0, 0.5, 1].map((t) => t * max);
  return (
    <div>
      <div className="relative flex h-48 gap-3">
        <div className="flex w-12 shrink-0 flex-col justify-between text-right text-[11px] text-subtle" aria-hidden>
          {[...ticks].reverse().map((t) => (
            <span key={t}>{fmtShort(t)}</span>
          ))}
        </div>
        <div className="relative flex flex-1 items-end gap-[2px] border-b border-line" aria-hidden>
          {[0.5, 1].map((t) => (
            <div key={t} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-line/70" style={{ bottom: `${t * 100}%` }} />
          ))}
          {months.map((m, i) => (
            <div key={m.month} className="relative flex h-full flex-1 items-end justify-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <div
                className={cn('w-full max-w-8 rounded-t-[4px] transition-colors', hover === i ? 'bg-brand-700' : 'bg-brand-500')}
                style={{ height: `${(Math.max(0, m.sales) / max) * 100}%`, minHeight: m.sales > 0 ? 2 : 0 }}
              />
              {hover === i && (
                <div className="absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-line bg-white px-2.5 py-1.5 text-xs shadow-md">
                  <p className="font-medium text-ink">{monthLabel(m.month)}</p>
                  <p className="tabular text-muted">Sales {naira(m.sales)}</p>
                  <p className="tabular text-muted">VAT {naira(m.vat)}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="ml-[3.75rem] mt-1 flex gap-[2px] text-[11px] text-subtle" aria-hidden>
        {months.map((m) => (
          <span key={m.month} className="flex-1 text-center">
            {label(m.month)}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Net sales and VAT by month</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Net sales</th>
            <th>VAT</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <td>{monthLabel(m.month)}</td>
              <td>{naira(m.sales)}</td>
              <td>{naira(m.vat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** E7-1 / E7-2: output VAT for the month vs the figure filed, with exports. */
function VatReconciliation() {
  const ws = useWsId();
  const { can } = useRole();
  const qc = useQueryClient();
  const thisMonth = lagosToday().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const q = useQuery({ queryKey: ['vat', ws, month], queryFn: () => api.get<Recon>(`/v1/workspaces/${ws}/reports/vat/${month}`) });
  const r = q.data;
  const [declared, setDeclared] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.put<Recon>(`/v1/workspaces/${ws}/reports/vat/${month}/declaration`, { declaredVat: declared.replace(/[,\s₦]/g, '') });
      qc.setQueryData(['vat', ws, month], res);
      setDeclared('');
      toast.success('Saved');
    } catch (err) {
      setError(err instanceof ApiError ? (err.errors[0]?.message ?? err.detail) : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const months = Array.from({ length: 13 }, (_, i) => {
    const d = new Date(thisMonth + '-01T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - i);
    return d.toISOString().slice(0, 7);
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-56">
          <Label htmlFor="month">Month</Label>
          <Select id="month" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" asChild>
            <a href={`/api/v1/workspaces/${ws}/reports/vat/${month}/export.xlsx`}>
              <FileSpreadsheet /> Excel
            </a>
          </Button>
          <Button variant="secondary" asChild>
            <a href={`/api/v1/workspaces/${ws}/reports/vat/${month}/export.pdf`}>
              <Download /> PDF
            </a>
          </Button>
        </div>
      </div>

      {q.isLoading || !r ? (
        q.error ? <Alert tone="error">{errorMessage(q.error)}</Alert> : <Spinner />
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-1">
                    VAT you charged in {r.monthLabel} <InfoTip term="outputVat" />
                  </span>
                }
                description={`Your VAT return for this month is due ${shortDate(r.dueDate)}.`}
              />
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-subtle">
                  <tr>
                    <th className="px-5 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 text-right font-medium">Count</th>
                    <th className="px-3 py-2 text-right font-medium">Net</th>
                    <th className="px-5 py-2 text-right font-medium">VAT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  <Row label="Approved invoices" count={r.invoices.count} net={r.invoices.net} vat={r.invoices.vat} />
                  <Row label="Debit notes" count={r.debitNotes.count} net={r.debitNotes.net} vat={r.debitNotes.vat} />
                  <Row label="Credit notes (deducted)" count={r.creditNotes.count} net={-r.creditNotes.net} vat={-r.creditNotes.vat} />
                  <Row label={r.b2c.enabled ? 'Retail sales (B2C)' : 'Retail sales (off)'} count={r.b2c.days} net={r.b2c.net} vat={r.b2c.vat} />
                </tbody>
                <tfoot>
                  <tr className="border-t border-line-strong font-semibold">
                    <td className="px-5 py-3" colSpan={3}>
                      VAT to pay
                    </td>
                    <td className="tabular px-5 py-3 text-right">{naira(r.outputVat)}</td>
                  </tr>
                </tfoot>
              </table>
              <div className="border-t border-line px-5 py-3">
                <p className="mb-2 text-xs font-medium text-subtle">By VAT treatment</p>
                <dl className="divide-y divide-line text-sm">
                  {r.byTreatment.map((t) => (
                    <div key={t.treatment} className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-muted">{TREATMENT_LABELS[t.treatment]}</dt>
                      <dd className="tabular text-right">
                        {naira(t.net)} <span className="text-subtle">net</span> · {naira(t.vat)} <span className="text-subtle">VAT</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Card>

            <Card>
              <CardHeader title="Compare with your return" description="Enter the output VAT you filed for this month." />
              <CardBody className="space-y-4">
                {r.declared ? (
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-muted">Filed</dt>
                      <dd className="tabular font-medium">{naira(r.declared.vat)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted">From the app</dt>
                      <dd className="tabular">{naira(r.outputVat)}</dd>
                    </div>
                    <div className="flex justify-between border-t border-line pt-1">
                      <dt className="font-medium">Difference</dt>
                      <dd className={cn('tabular font-semibold', r.difference ? 'text-red-700' : 'text-brand-800')}>{naira(r.difference ?? 0)}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-sm text-muted">Nothing entered yet.</p>
                )}
                {r.difference === 0 && (
                  <Alert tone="success" title="Matches your return">
                    Every cleared invoice and B2C day is accounted for.
                  </Alert>
                )}
                {!!r.difference && (
                  <Alert tone="warning" title="There's a difference">
                    Check the items listed below. VAT on documents not yet cleared: {naira(r.exceptions.unclearedVat)}.
                  </Alert>
                )}
                {can('vat.declare') && (
                  <form onSubmit={save} className="space-y-2" noValidate>
                    <Field id="declared" label={r.declared ? 'Update the filed figure (₦)' : 'Output VAT filed (₦)'} error={error}>
                      <Input value={declared} onChange={(e) => setDeclared(e.target.value)} inputMode="decimal" placeholder="e.g. 26,625.00" />
                    </Field>
                    <Button type="submit" size="sm" loading={busy} disabled={!declared}>
                      Save
                    </Button>
                  </form>
                )}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Not included" description="Documents dated this month that haven't cleared, and B2C days not yet accepted by NRS." />
            {!r.exceptions.unclearedDocuments.length && !r.exceptions.b2cMissingDays.length ? (
              <EmptyState icon={<CheckCircle2 />} title="Nothing left out" />
            ) : (
              <ul className="divide-y divide-line text-sm">
                {r.exceptions.unclearedDocuments.map((x) => (
                  <li key={x.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <span>
                      <AlertTriangle className="mr-1.5 inline size-4 text-amber-600" aria-hidden />
                      <Link href={`/w/${ws}/invoices/${x.id}`} className="font-medium hover:underline">
                        {DOC_TYPE_LABELS[x.docType]} {x.number ?? '(draft)'}
                      </Link>{' '}
                      <span className="text-muted">
                        · {x.customer ?? 'no customer'} · {x.statusLabel}
                      </span>
                    </span>
                    <span className="tabular">{naira(x.vat)} VAT</span>
                  </li>
                ))}
                {r.exceptions.b2cMissingDays.map((x) => (
                  <li key={x.date} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <span>
                      <AlertTriangle className="mr-1.5 inline size-4 text-amber-600" aria-hidden />
                      Retail sales for {shortDate(x.date)} · <span className="text-muted">{x.status === 'missing' ? 'not reported' : x.status}</span>
                    </span>
                    <Link href={`/w/${ws}/b2c`} className="text-brand-700 hover:underline">
                      Fix
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Row({ label, count, net, vat }: { label: string; count: number; net: number; vat: number }) {
  return (
    <tr>
      <td className="px-5 py-2.5">{label}</td>
      <td className={cn('tabular px-3 py-2.5 text-right', !count && 'text-subtle')}>{count || '—'}</td>
      <td className={cn('tabular px-3 py-2.5 text-right', !count && 'text-subtle')}>{count ? naira(net) : '—'}</td>
      <td className={cn('tabular px-5 py-2.5 text-right', !count && 'text-subtle')}>{count ? naira(vat) : '—'}</td>
    </tr>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Reports />
    </Suspense>
  );
}
