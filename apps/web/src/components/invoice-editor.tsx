'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, CloudOff, Plus, Send, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { computeTotals, DOC_TYPE_LABELS, VAT_LABELS, VAT_TREATMENTS, type VatTreatment } from '@einv/shared';
import { CustomerForm } from '@/components/customer-form';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Label, Select, Textarea } from '@/components/ui/form';
import { Alert, Card, CardBody, CardHeader, Steps } from '@/components/ui/layout';
import { InfoTip, Term } from '@/components/ui/help';
import { JOURNEY } from '@/components/status';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useRole, useWorkspace, useWsId } from '@/lib/hooks';
import type { Customer, Invoice, Page, PlainError, Product } from '@/lib/types';
import { cn, naira, todayIso } from '@/lib/utils';

interface LineForm {
  key: string;
  productId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  vatTreatment: VatTreatment;
}
interface DraftForm {
  customerId: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  lines: LineForm[];
}

let keySeq = 0;
const newKey = () => `l${++keySeq}`;
const blankLine = (): LineForm => ({ key: newKey(), productId: null, description: '', quantity: '1', unitPrice: '', discount: '', vatTreatment: 'standard' });
const toNum = (s: string) => {
  const n = Number(String(s).replace(/[,\s₦]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function fromInvoice(inv?: Invoice): DraftForm {
  if (!inv) return { customerId: '', issueDate: todayIso(), dueDate: '', notes: '', lines: [blankLine()] };
  return {
    customerId: inv.customerId ?? '',
    issueDate: inv.issueDate,
    dueDate: inv.dueDate ?? '',
    notes: inv.notes ?? '',
    lines: inv.lines.length
      ? inv.lines.map((l) => ({
          key: newKey(),
          productId: l.productId,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          discount: l.discount ? String(l.discount) : '',
          vatTreatment: l.vatTreatment,
        }))
      : [blankLine()],
  };
}

const toBody = (f: DraftForm) => ({
  customerId: f.customerId || null,
  issueDate: f.issueDate,
  dueDate: f.dueDate || null,
  notes: f.notes || null,
  lines: f.lines
    .filter((l) => l.description.trim() || l.unitPrice)
    .map((l) => ({
      productId: l.productId,
      description: l.description,
      quantity: toNum(l.quantity),
      unitPrice: toNum(l.unitPrice),
      discount: toNum(l.discount),
      vatTreatment: l.vatTreatment,
    })),
});

/** E3-1 / E3-2 / E3-3: create and edit drafts with live totals, autosave, pre-submission checks and one-click submit. */
export function InvoiceEditor({ invoice }: { invoice?: Invoice }) {
  const ws = useWsId();
  const workspace = useWorkspace();
  const { can } = useRole();
  const router = useRouter();
  const qc = useQueryClient();
  const [form, setForm] = useState<DraftForm>(() => fromInvoice(invoice));
  const [id, setId] = useState<string | null>(invoice?.id ?? null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(invoice ? 'saved' : 'idle');
  const [problems, setProblems] = useState<PlainError[]>(invoice?.errors ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [addCustomer, setAddCustomer] = useState(false);
  // Progressive disclosure: most invoices have no discount, so the column appears only on request.
  const [showDiscount, setShowDiscount] = useState(() => !!invoice?.lines.some((l) => l.discount > 0));
  const dirty = useRef(false);
  const inflight = useRef<Promise<string | null> | null>(null);
  const isNote = invoice && invoice.docType !== 'invoice';

  const customers = useQuery({ queryKey: ['customers', ws, 'all'], queryFn: () => api.get<Page<Customer>>(`/v1/workspaces/${ws}/customers?limit=100`) });
  const products = useQuery({ queryKey: ['products', ws, 'all'], queryFn: () => api.get<Page<Product>>(`/v1/workspaces/${ws}/products?limit=100`) });

  const totals = useMemo(
    () =>
      computeTotals(
        form.lines.map((l) => ({ description: l.description, quantity: toNum(l.quantity), unitPrice: toNum(l.unitPrice), discount: toNum(l.discount), vatTreatment: l.vatTreatment })),
      ),
    [form.lines],
  );

  const update = (patch: Partial<DraftForm>) => {
    dirty.current = true;
    setForm((f) => ({ ...f, ...patch }));
  };
  const updateLine = (key: string, patch: Partial<LineForm>) => {
    dirty.current = true;
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  };

  async function save(): Promise<string | null> {
    if (!dirty.current && id) return id;
    dirty.current = false;
    setSaveState('saving');
    try {
      const body = toBody(form);
      const saved = id ? await api.put<Invoice>(`/v1/workspaces/${ws}/invoices/${id}`, body) : await api.post<Invoice>(`/v1/workspaces/${ws}/invoices`, body);
      qc.setQueryData(['invoice', ws, saved.id], saved);
      if (!id) {
        setId(saved.id);
        window.history.replaceState(null, '', `/w/${ws}/invoices/${saved.id}`);
      }
      setSaveState('saved');
      return saved.id;
    } catch (err) {
      dirty.current = true;
      setSaveState('error');
      if (err instanceof ApiError && err.errors.length) setProblems(err.errors);
      else toast.error(errorMessage(err));
      return null;
    }
  }

  // Autosave 1.2 s after the last change (once there is something worth saving).
  useEffect(() => {
    if (!dirty.current) return;
    const hasContent = form.customerId || form.lines.some((l) => l.description.trim());
    if (!id && !hasContent) return;
    const t = setTimeout(() => {
      inflight.current = save();
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  async function flush() {
    if (inflight.current) await inflight.current;
    return save();
  }

  async function checkProblems() {
    const savedId = await flush();
    if (!savedId) return;
    const r = await api.post<{ ok: boolean; errors: PlainError[] }>(`/v1/workspaces/${ws}/invoices/${savedId}/validate`);
    setProblems(r.errors);
    if (r.ok) toast.success('No problems found. Ready to submit.');
  }

  async function submit() {
    setSubmitting(true);
    try {
      const savedId = await flush();
      if (!savedId) return;
      const r = await api.post<Invoice>(`/v1/workspaces/${ws}/invoices/${savedId}/submit`);
      qc.setQueryData(['invoice', ws, savedId], r);
      void qc.invalidateQueries({ queryKey: ['invoices', ws] });
      void qc.invalidateQueries({ queryKey: ['summary', ws] });
      if (r.status === 'cleared') toast.success(`Cleared by NRS · IRN ${r.irn}`);
      else if (r.status === 'pending_approval') toast.info('Sent for approval');
      else if (r.status === 'queued') toast.warning("NRS isn't responding. We'll keep retrying and tell you when it clears.");
      else if (r.status === 'rejected') {
        setProblems(r.errors);
        toast.error('NRS rejected this invoice. See what to fix below.');
        return;
      }
      // On the invoice's own page the cache update above switches to the cleared view.
      // From /invoices/new the URL was already rewritten to the draft's address (history.replaceState),
      // so a client-side replace to that same URL is a no-op: load the invoice page for real.
      if (!invoice) window.location.replace(`/w/${ws}/invoices/${savedId}`);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) {
        setProblems(err.errors);
        toast.error(err.detail);
      } else toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function discard() {
    if (!id) return router.push(`/w/${ws}/invoices`);
    if (!confirm('Delete this draft? This cannot be undone.')) return;
    try {
      await api.del(`/v1/workspaces/${ws}/invoices/${id}`);
      void qc.invalidateQueries({ queryKey: ['invoices', ws] });
      router.replace(`/w/${ws}/invoices`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const fieldError = (field: string) => problems.find((p) => p.field === field)?.message;
  const lineError = (i: number) => problems.filter((p) => p.field?.startsWith(`lines.${i}.`)).map((p) => p.message)[0];
  const approvalsOn = workspace.data?.approvalRequired;
  const canClear = can('invoices.submit') && (!approvalsOn || can('invoices.approve'));
  const submitLabel = canClear ? (isNote ? `Submit ${DOC_TYPE_LABELS[invoice!.docType].toLowerCase()}` : 'Submit to NRS') : 'Send for approval';
  const submitBlocked = !can('invoices.submit') && !approvalsOn;
  const selectedCustomer = customers.data?.items.find((c) => c.id === form.customerId);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <Card className="px-5 py-4 sm:px-6">
          <Steps steps={JOURNEY} current={0} />
        </Card>
        {isNote && invoice?.originalInvoice && (
          <Alert tone="info" title={`${DOC_TYPE_LABELS[invoice.docType]} against ${invoice.originalInvoice.number}`}>
            IRN {invoice.originalInvoice.irn} · Reason: {invoice.reason}
          </Alert>
        )}

        <Card>
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Label htmlFor="customer">Customer</Label>
              {isNote ? (
                <p className="text-sm font-medium">{invoice?.customer?.name}</p>
              ) : (
                <div className="flex gap-2">
                  <Select
                    id="customer"
                    value={form.customerId}
                    aria-invalid={!!fieldError('customerId') || !!fieldError('customer.tin') || undefined}
                    onChange={(e) => (e.target.value === '__new' ? setAddCustomer(true) : update({ customerId: e.target.value }))}
                  >
                    <option value="">Choose a customer…</option>
                    {customers.data?.items.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.tin}
                      </option>
                    ))}
                    <option value="__new">+ Add a new customer</option>
                  </Select>
                </div>
              )}
              {(fieldError('customerId') || fieldError('customer.tin')) && (
                <p role="alert" className="mt-1 text-xs font-medium text-red-600">
                  {fieldError('customerId') ?? fieldError('customer.tin')}
                </p>
              )}
              {selectedCustomer && <p className="mt-1 text-xs text-subtle">{[selectedCustomer.kind, selectedCustomer.email, selectedCustomer.address].filter(Boolean).join(' · ')}</p>}
            </div>
            <Field id="issueDate" label="Issue date" error={fieldError('issueDate')}>
              <Input type="date" value={form.issueDate} max={todayIso()} onChange={(e) => update({ issueDate: e.target.value })} />
            </Field>
            {!isNote && (
              <Field id="dueDate" label="Due date" error={fieldError('dueDate')}>
                <Input type="date" value={form.dueDate} min={form.issueDate} onChange={(e) => update({ dueDate: e.target.value })} />
              </Field>
            )}
          </CardBody>
        </Card>

        <Card className="@container">
          <CardHeader title="What you're selling" description="Start typing to pick a saved product. VAT is worked out for you." />
          <div className="divide-y divide-line">
            <div
              className={cn(
                'hidden gap-2 px-5 py-2 text-xs font-medium text-subtle @3xl:grid',
                showDiscount ? 'grid-cols-[minmax(9rem,1fr)_56px_96px_80px_112px_96px_32px]' : 'grid-cols-[minmax(9rem,1fr)_56px_104px_128px_104px_32px]',
              )}
            >
              <span>Description</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Unit price</span>
              {showDiscount && <span className="text-right">Discount</span>}
              <span className="flex items-center gap-1">
                VAT <InfoTip term="vatTreatment" />
              </span>
              <span className="text-right">Amount</span>
              <span />
            </div>
            {form.lines.map((l, i) => {
              const computed = totals.lines[i];
              const err = lineError(i);
              return (
                <div key={l.key} className={cn('px-4 py-3 @3xl:px-5', err && 'bg-red-50/50')}>
                  <div
                    className={cn(
                      'grid grid-cols-2 gap-2 @3xl:items-start',
                      showDiscount ? '@3xl:grid-cols-[minmax(9rem,1fr)_56px_96px_80px_112px_96px_32px]' : '@3xl:grid-cols-[minmax(9rem,1fr)_56px_104px_128px_104px_32px]',
                    )}
                  >
                    <div className="col-span-2 @3xl:col-span-1">
                      <label className="sr-only" htmlFor={`d-${l.key}`}>
                        Line {i + 1} description
                      </label>
                      <Input
                        id={`d-${l.key}`}
                        list={`products-${ws}`}
                        placeholder="Item or service"
                        value={l.description}
                        aria-invalid={!!fieldError(`lines.${i}.description`) || undefined}
                        onChange={(e) => {
                          const p = products.data?.items.find((x) => x.name === e.target.value);
                          updateLine(
                            l.key,
                            p ? { description: p.name, productId: p.id, unitPrice: String(p.unitPrice), vatTreatment: p.vatTreatment } : { description: e.target.value, productId: null },
                          );
                        }}
                      />
                    </div>
                    <LineInput label="Qty" value={l.quantity} onChange={(v) => updateLine(l.key, { quantity: v })} invalid={!!fieldError(`lines.${i}.quantity`)} />
                    <LineInput label="Unit price (₦)" value={l.unitPrice} onChange={(v) => updateLine(l.key, { unitPrice: v })} invalid={!!fieldError(`lines.${i}.quantity`)} />
                    {showDiscount && <LineInput label="Discount (₦)" value={l.discount} onChange={(v) => updateLine(l.key, { discount: v })} />}
                    <div>
                      <label className="mb-1 block text-xs text-subtle @3xl:sr-only" htmlFor={`v-${l.key}`}>
                        VAT
                      </label>
                      <Select id={`v-${l.key}`} value={l.vatTreatment} onChange={(e) => updateLine(l.key, { vatTreatment: e.target.value as VatTreatment })}>
                        {VAT_TREATMENTS.map((t) => (
                          <option key={t} value={t}>
                            {VAT_LABELS[t]}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="tabular flex h-10 items-center justify-end text-sm font-medium @3xl:justify-end">
                      <span className="mr-auto text-xs text-subtle @3xl:hidden">Amount</span>
                      {naira(computed?.net ?? 0)}
                    </div>
                    <div className="col-span-2 flex justify-end @3xl:col-span-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove line ${i + 1}`}
                        disabled={form.lines.length === 1}
                        onClick={() => update({ lines: form.lines.filter((x) => x.key !== l.key) })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {err && (
                    <p role="alert" className="mt-1 text-xs font-medium text-red-600">
                      {err}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <datalist id={`products-${ws}`}>
            {products.data?.items.map((p) => (
              <option key={p.id} value={p.name}>
                {naira(p.unitPrice)} · {VAT_LABELS[p.vatTreatment]}
              </option>
            ))}
          </datalist>
          <div className="border-t border-line px-5 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="secondary" size="sm" onClick={() => update({ lines: [...form.lines, blankLine()] })}>
                <Plus /> Add another item
              </Button>
              {!showDiscount && (
                <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setShowDiscount(true)}>
                  Add a discount
                </button>
              )}
            </div>
          </div>
        </Card>

        {!isNote && (
          <Card>
            <CardBody>
              <Field id="notes" label="Notes to customer" hint="Optional. Shown on the invoice.">
                <Textarea value={form.notes} onChange={(e) => update({ notes: e.target.value })} rows={2} />
              </Field>
            </CardBody>
          </Card>
        )}
      </div>

      <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
        <Card>
          <CardBody className="space-y-2 text-sm">
            <Row label="Subtotal" value={naira(totals.subtotal)} />
            {totals.discountTotal > 0 && <Row label="Discounts" value={`−${naira(totals.discountTotal)}`} />}
            <Row label="VAT" value={naira(totals.vatTotal)} />
            <div className="border-t border-line pt-2">
              <Row label="Total" value={naira(totals.total)} strong />
            </div>
          </CardBody>
          <div className="space-y-3 border-t border-line p-4">
            {canClear && (
              <p className="text-[13px] leading-relaxed text-muted">
                We check it for common mistakes, then send it to <Term k="nrs" /> for <Term k="clearance">approval</Term>. Approved invoices get an <Term k="irn" /> and can't be edited.
              </p>
            )}
            <Button className="w-full" size="lg" onClick={submit} loading={submitting} disabled={submitBlocked}>
              {canClear ? <ShieldCheck /> : <Send />} {submitLabel}
            </Button>
            {submitBlocked && <p className="text-xs text-subtle">Your role can prepare invoices. An owner, admin or approver submits them.</p>}
            <Button variant="secondary" className="w-full" onClick={checkProblems} disabled={submitting}>
              Check for problems
            </Button>
            <SaveIndicator state={saveState} />
          </div>
        </Card>

        {problems.length > 0 && (
          <Card className="border-red-200">
            <CardHeader title={<span className="flex items-center gap-2 text-red-700"><AlertCircle className="size-4" /> Fix before submitting</span>} />
            <ul className="space-y-2 px-5 py-4 text-sm">
              {problems.map((p, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-red-500" />
                  <span>
                    {p.message}
                    {p.field?.startsWith('seller.') && (
                      <>
                        {' '}
                        <Link className="font-medium text-brand-700 underline" href={p.field === 'seller.mbs' ? `/onboarding?ws=${ws}` : `/w/${ws}/settings`}>
                          Fix in settings
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {(!invoice || (invoice.status === 'draft' && !invoice.number)) && (
          <Button variant="ghost" className="w-full text-red-600 hover:bg-red-50 hover:text-red-700" onClick={discard}>
            <Trash2 /> {id ? 'Delete draft' : 'Discard'}
          </Button>
        )}
      </aside>

      <div className="h-20 xl:hidden" aria-hidden />
      {/* Phones: the total and the main action stay in reach while scrolling the items. */}
      <div className="fixed inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white/95 px-4 py-3 backdrop-blur lg:bottom-0 xl:hidden">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div>
            <p className="text-xs text-subtle">Total incl. VAT</p>
            <p className="tabular text-lg font-semibold">{naira(totals.total)}</p>
          </div>
          <Button onClick={submit} loading={submitting} disabled={submitBlocked}>
            {canClear ? <ShieldCheck /> : <Send />} {canClear ? 'Submit' : 'Send for approval'}
          </Button>
        </div>
      </div>

      <Dialog open={addCustomer} onOpenChange={setAddCustomer} title="Add a customer">
        <CustomerForm
          ws={ws}
          onCancel={() => setAddCustomer(false)}
          onSaved={(c) => {
            qc.setQueryData(['customers', ws, 'all'], (old: Page<Customer> | undefined) => ({ items: [...(old?.items ?? []), c], nextCursor: null }));
            update({ customerId: c.id });
            setAddCustomer(false);
          }}
        />
      </Dialog>
    </div>
  );
}

function LineInput({ label, value, onChange, invalid }: { label: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-subtle @3xl:sr-only">{label}</span>
      <Input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className="tabular text-right" aria-invalid={invalid || undefined} placeholder="0" />
    </label>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between', strong && 'text-base font-semibold')}>
      <span className={strong ? '' : 'text-muted'}>{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  const map = {
    idle: { icon: null, text: 'Not saved yet' },
    saving: { icon: null, text: 'Saving…' },
    saved: { icon: <CheckCircle2 className="size-3.5 text-brand-600" />, text: 'Draft saved' },
    error: { icon: <CloudOff className="size-3.5 text-red-600" />, text: "Couldn't save. Your next change will try again." },
  }[state];
  return (
    <p className="flex items-center justify-center gap-1.5 text-xs text-subtle" aria-live="polite">
      {map.icon} {map.text}
    </p>
  );
}
