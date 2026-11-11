'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Download, FileSpreadsheet, ShoppingCart, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { VAT_LABELS, type VatTreatment } from '@einv/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label, Select } from '@/components/ui/form';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useRole, useWsId } from '@/lib/hooks';
import { cn, dateTime, naira, shortDate } from '@/lib/utils';

interface Day {
  id: string | null;
  date: string;
  status: 'open' | 'missing' | 'pending' | 'submitting' | 'accepted' | 'rejected' | 'failed';
  noSales: boolean;
  rows: number;
  vat: number;
  gross: number;
  deadlineAt: string;
  reportRef: string | null;
  errors: { message: string }[];
}
interface Upload {
  id: string;
  fileName: string;
  headers: string[];
  rowCount: number;
  preview: string[][];
  fields: string[];
  suggestedMapping: Record<string, string>;
}
interface Result {
  total: number;
  valid: number;
  invalid: number;
  errors: { row: number; field: string | null; message: string }[];
  days: { date: string; rows: number; gross: number; vat: number }[];
  dryRun: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  date: 'Sale date',
  receiptNo: 'Receipt number',
  description: 'Description',
  amount: 'Amount paid (VAT included)',
  vatTreatment: 'VAT treatment',
  buyerName: 'Buyer name',
  buyerPhone: 'Buyer phone',
};
const REQUIRED = ['date', 'receiptNo', 'amount'];

const STATUS: Record<Day['status'], { label: string; tone: 'neutral' | 'green' | 'amber' | 'red' | 'blue'; Icon: React.ElementType }> = {
  open: { label: 'Today — still open', tone: 'neutral', Icon: Clock },
  missing: { label: 'Not reported', tone: 'red', Icon: XCircle },
  pending: { label: 'Waiting to send', tone: 'amber', Icon: Clock },
  submitting: { label: 'Sending', tone: 'blue', Icon: Clock },
  accepted: { label: 'Accepted by NRS', tone: 'green', Icon: CheckCircle2 },
  rejected: { label: 'Rejected', tone: 'red', Icon: XCircle },
  failed: { label: 'Failed', tone: 'red', Icon: XCircle },
};

function hoursLeft(deadline: string) {
  const h = (new Date(deadline).getTime() - Date.now()) / 3_600_000;
  return h;
}

/** E5: daily retail sales reporting. */
export default function B2cPage() {
  const ws = useWsId();
  const { can } = useRole();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['b2c', ws], queryFn: () => api.get<{ enabled: boolean; today: string; days: Day[] }>(`/v1/workspaces/${ws}/b2c/days?days=14`) });
  const [view, setView] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ['b2c', ws] });

  async function act(date: string, action: 'submit' | 'no-sales' | 'delete') {
    if (action === 'delete' && !confirm(`Delete the sales uploaded for ${shortDate(date)}?`)) return;
    if (action === 'no-sales' && !confirm(`Confirm there were no retail sales on ${shortDate(date)}? This is reported to NRS.`)) return;
    setBusy(date + action);
    try {
      if (action === 'delete') await api.del(`/v1/workspaces/${ws}/b2c/days/${date}`);
      else {
        const r = await api.post<Day>(`/v1/workspaces/${ws}/b2c/days/${date}/${action}`);
        if (r.status === 'accepted') toast.success(`${shortDate(date)} accepted by NRS`);
        else if (r.errors[0]) toast.warning(r.errors[0].message);
      }
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function enable(on: boolean) {
    try {
      await api.put(`/v1/workspaces/${ws}/b2c/settings`, { enabled: on });
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <Alert tone="error">{errorMessage(q.error)}</Alert>;
  const { enabled, days, today } = q.data;

  if (!enabled) {
    return (
      <>
        <PageHeader title="Retail sales (B2C)" />
        <Card>
          <EmptyState
            icon={<ShoppingCart />}
            title="Do you sell to consumers?"
            description="Retail (B2C) sales must be reported to NRS within 24 hours of each day closing. Turn this on to upload sales from your till and get alerts before each deadline."
            action={can('workspace.manage') ? <Button onClick={() => enable(true)}>Turn on B2C reporting</Button> : <p className="text-sm text-muted">Ask an owner or admin to turn this on.</p>}
          />
        </Card>
      </>
    );
  }

  const urgent = days.filter((d) => ['missing', 'pending', 'rejected', 'failed'].includes(d.status) && hoursLeft(d.deadlineAt) > 0 && hoursLeft(d.deadlineAt) < 24);
  return (
    <>
      <PageHeader
        title="Retail sales (B2C)"
        description="Each day's sales go to NRS automatically just after midnight. They must be accepted within 24 hours."
        actions={can('workspace.manage') && <Button variant="ghost" onClick={() => enable(false)}>Turn off</Button>}
      />
      {urgent.map((d) => (
        <Alert key={d.date} tone="warning" className="mb-4" title={`${shortDate(d.date)} is due in ${Math.max(1, Math.floor(hoursLeft(d.deadlineAt)))} hours`}>
          {d.status === 'missing' ? 'Upload that day’s sales, or confirm there were none.' : d.errors[0]?.message ?? 'It has not been accepted yet.'}
        </Alert>
      ))}

      {can('b2c.manage') && <Uploader onDone={reload} />}

      <Card className="mt-6">
        <CardHeader title="Last 14 days" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-subtle">
              <tr>
                <th className="px-5 py-2 font-medium">Day</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Receipts</th>
                <th className="px-3 py-2 text-right font-medium">Sales</th>
                <th className="px-3 py-2 text-right font-medium">VAT</th>
                <th className="px-5 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {days.map((d) => {
                const s = STATUS[d.status];
                // A day can only be reported once it's over in Lagos time; the server enforces this too.
                const closed = d.date < today;
                return (
                  <tr key={d.date}>
                    <td className="px-5 py-2.5">
                      <p className="font-medium">{shortDate(d.date)}</p>
                      {closed && d.status !== 'accepted' && <p className="text-xs text-subtle">Due {dateTime(d.deadlineAt)}</p>}
                      {!closed && d.rows > 0 && <p className="text-xs text-subtle">Sends automatically after midnight</p>}
                      {d.reportRef && <p className="font-mono text-[11px] text-subtle">{d.reportRef}</p>}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={s.tone}>
                        <s.Icon className="size-3" aria-hidden /> {d.noSales && d.status === 'accepted' ? 'No sales — accepted' : s.label}
                      </Badge>
                      {d.errors[0] && d.status !== 'accepted' && <p className="mt-1 max-w-56 text-xs text-red-700">{d.errors[0].message}</p>}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">{d.rows || '—'}</td>
                    <td className="tabular px-3 py-2.5 text-right">{d.rows ? naira(d.gross) : '—'}</td>
                    <td className="tabular px-3 py-2.5 text-right">{d.rows ? naira(d.vat) : '—'}</td>
                    <td className="px-5 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        {d.rows > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setView(d.date)}>
                            View
                          </Button>
                        )}
                        {can('b2c.manage') && closed && ['pending', 'rejected', 'failed'].includes(d.status) && d.rows > 0 && (
                          <Button size="sm" variant="secondary" onClick={() => act(d.date, 'submit')} loading={busy === d.date + 'submit'}>
                            Send now
                          </Button>
                        )}
                        {can('b2c.manage') && closed && (d.status === 'missing' || (d.rows === 0 && d.status !== 'accepted')) && (
                          <Button size="sm" variant="secondary" onClick={() => act(d.date, 'no-sales')} loading={busy === d.date + 'no-sales'}>
                            No sales
                          </Button>
                        )}
                        {can('b2c.manage') && d.id && ['pending', 'rejected', 'failed'].includes(d.status) && d.rows > 0 && (
                          <Button size="sm" variant="ghost" className="text-red-600" onClick={() => act(d.date, 'delete')}>
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {view && <DayDialog date={view} onClose={() => setView(null)} />}
    </>
  );
}

function DayDialog({ date, onClose }: { date: string; onClose: () => void }) {
  const ws = useWsId();
  const q = useQuery({
    queryKey: ['b2c-day', ws, date],
    queryFn: () =>
      api.get<{ sales: { receiptNo: string; description: string | null; gross: number; vat: number; vatTreatment: VatTreatment }[] }>(`/v1/workspaces/${ws}/b2c/days/${date}`),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Sales on ${shortDate(date)}`} className="sm:max-w-2xl">
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs uppercase tracking-wide text-subtle">
              <tr>
                <th className="py-2 font-medium">Receipt</th>
                <th className="py-2 font-medium">Item</th>
                <th className="py-2 font-medium">VAT</th>
                <th className="py-2 text-right font-medium">Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {q.data?.sales.map((s) => (
                <tr key={s.receiptNo}>
                  <td className="py-1.5 font-mono text-xs">{s.receiptNo}</td>
                  <td className="py-1.5">{s.description ?? '—'}</td>
                  <td className="py-1.5 text-muted">{VAT_LABELS[s.vatTreatment]}</td>
                  <td className="tabular py-1.5 text-right">{naira(s.gross)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

/** E5-2: upload a POS export, map columns, check every row, then import. */
function Uploader({ onDone }: { onDone: () => void }) {
  const ws = useWsId();
  const ref = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function onFile(file: File) {
    setBusy(true);
    setError(undefined);
    setResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const u = await api.upload<Upload>(`/v1/workspaces/${ws}/b2c/uploads`, fd);
      setUpload(u);
      setMapping(u.suggestedMapping);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  }
  async function commit(dryRun: boolean) {
    if (!upload) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<Result>(`/v1/workspaces/${ws}/b2c/uploads/${upload.id}/commit${dryRun ? '?dryRun=true' : ''}`, { mapping });
      setResult(r);
      if (!dryRun) {
        toast.success(`Imported ${r.valid} sales across ${r.days.length} day(s)`);
        setUpload(null);
        onDone();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function template() {
    const t = await api.get<{ fileName: string; csv: string }>('/v1/b2c-template');
    const url = URL.createObjectURL(new Blob([t.csv], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: t.fileName }).click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader
        title="Upload sales from your till"
        description="CSV or Excel export from your POS. Amounts include VAT. Buyer details are optional."
        action={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={template}>
              <Download /> Template
            </Button>
            <input ref={ref} type="file" accept=".csv,.xlsx" className="sr-only" id="b2c-file" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <Button size="sm" onClick={() => ref.current?.click()} loading={busy && !upload}>
              <FileSpreadsheet /> Choose file
            </Button>
          </div>
        }
      />
      {error && (
        <CardBody>
          <Alert tone="error">{error}</Alert>
        </CardBody>
      )}
      {upload && (
        <>
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {upload.fields.map((f) => (
              <div key={f}>
                <Label htmlFor={`b2c-${f}`}>
                  {FIELD_LABELS[f]}
                  {REQUIRED.includes(f) && <span className="text-red-600"> *</span>}
                </Label>
                <Select id={`b2c-${f}`} value={mapping[f] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value }))}>
                  <option value="">— Not in my file —</option>
                  {upload.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </CardBody>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
            <p className="text-sm text-muted">
              {upload.fileName} · {upload.rowCount.toLocaleString()} rows
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => commit(true)} loading={busy}>
                Check rows
              </Button>
              <Button onClick={() => commit(false)} loading={busy} disabled={!result?.dryRun || result.valid === 0}>
                Import {result?.dryRun ? `${result.valid} sales` : ''}
              </Button>
            </div>
          </div>
        </>
      )}
      {result && (
        <div className="border-t border-line">
          <div className="px-5 py-3 text-sm">
            <p className="font-medium">
              {result.valid} ready · {result.invalid} with problems
            </p>
            <ul className="mt-1 text-muted">
              {result.days.map((d) => (
                <li key={d.date}>
                  {shortDate(d.date)}: {d.rows} sales, {naira(d.gross)} incl. {naira(d.vat)} VAT
                </li>
              ))}
            </ul>
          </div>
          {result.errors.length > 0 && (
            <ul className={cn('max-h-60 space-y-1 overflow-y-auto border-t border-line px-5 py-3 text-sm')}>
              {result.errors.map((e, i) => (
                <li key={i}>
                  <span className="font-medium">Row {e.row}:</span> {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
