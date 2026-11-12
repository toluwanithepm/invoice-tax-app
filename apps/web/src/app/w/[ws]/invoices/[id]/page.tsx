'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, Download, FileMinus2, FilePlus2, Mail, MessageCircle, RotateCw, Share2, ShieldCheck, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DOC_TYPE_LABELS, VAT_LABELS } from '@einv/shared';
import { InvoiceEditor } from '@/components/invoice-editor';
import { JOURNEY, StatusBadge } from '@/components/status';
import { InfoTip } from '@/components/ui/help';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Alert, Card, CardBody, CardHeader, PageHeader, Spinner, Steps } from '@/components/ui/layout';
import { api, ApiError, errorMessage, planBlockToast } from '@/lib/api';
import { useMe, useRole, useWorkspace, useWsId } from '@/lib/hooks';
import type { Invoice } from '@/lib/types';
import { dateTime, naira, shortDate, todayIso } from '@/lib/utils';

export default function InvoicePage() {
  const ws = useWsId();
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['invoice', ws, id],
    queryFn: () => api.get<Invoice>(`/v1/workspaces/${ws}/invoices/${id}`),
    // Poll while the tax authority is working on it.
    refetchInterval: (query) => (['submitting', 'queued'].includes(query.state.data?.status ?? '') ? 5000 : false),
  });
  const inv = q.data;

  const back = (
    <Link href={`/w/${ws}/invoices`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
      <ArrowLeft className="size-4" /> Invoices
    </Link>
  );
  if (q.isLoading) return <Spinner />;
  if (q.error || !inv) return <Alert tone="error">{errorMessage(q.error)}</Alert>;

  const title = `${DOC_TYPE_LABELS[inv.docType]} ${inv.number ?? '(draft)'}`;
  return (
    <>
      <PageHeader back={back} title={<span className="flex flex-wrap items-center gap-3">{title} <StatusBadge status={inv.status} /></span>} description={inv.customer?.name ?? inv.buyer?.name} />
      {inv.editable ? (
        <>
          {inv.status === 'rejected' && (
            <Alert tone="error" className="mb-6" title="NRS rejected this invoice">
              Fix the items listed on the right and submit again. Earlier attempts stay in the history.
            </Alert>
          )}
          {inv.status === 'failed' && (
            <Alert tone="error" className="mb-6" title="We couldn't reach NRS for 72 hours">
              Submit again to retry.
            </Alert>
          )}
          <InvoiceEditor key={inv.id + inv.status} invoice={inv} />
        </>
      ) : (
        <InvoiceView inv={inv} />
      )}
    </>
  );
}

function InvoiceView({ inv }: { inv: Invoice }) {
  const ws = useWsId();
  const { can } = useRole();
  const me = useMe();
  const workspace = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const [share, setShare] = useState(false);
  // E9-3: over the approval amount, the person who sent it can't also approve it.
  const limit = workspace.data?.approvalThreshold ?? null;
  const overLimit = limit !== null && inv.total >= limit;
  const ownRequest = overLimit && !!me.data && inv.submittedBy === me.data.id;
  const [note, setNote] = useState<null | 'credit_note' | 'debit_note'>(null);
  const [busy, setBusy] = useState(false);
  const refresh = (r: Invoice) => {
    qc.setQueryData(['invoice', ws, inv.id], r);
    void qc.invalidateQueries({ queryKey: ['invoices', ws] });
  };

  async function approve() {
    setBusy(true);
    try {
      const r = await api.post<Invoice>(`/v1/workspaces/${ws}/invoices/${inv.id}/approve`);
      refresh(r);
      toast.success(r.status === 'cleared' ? `Approved and cleared · IRN ${r.irn}` : 'Approved');
    } catch (err) {
      if (!planBlockToast(err, ws, toast.error)) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function decline() {
    const reason = prompt('Why are you sending it back?');
    if (!reason) return;
    try {
      refresh(await api.post<Invoice>(`/v1/workspaces/${ws}/invoices/${inv.id}/decline`, { reason }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        {inv.docType === 'invoice' && (
          <Card className="px-5 py-4 sm:px-6">
            <Steps steps={JOURNEY} current={inv.status === 'cleared' ? (inv.paidAt ? 4 : 2) : inv.status === 'pending_approval' || inv.status === 'queued' ? 1 : 0} failed={['rejected', 'failed'].includes(inv.status)} />
          </Card>
        )}
        {inv.status === 'queued' && (
          <Alert tone="warning" title="NRS isn't responding right now">
            We'll keep retrying automatically for up to 72 hours — attempt {inv.attempts}, next try {dateTime(inv.nextAttemptAt)}. You don't need to do anything.
          </Alert>
        )}
        {inv.status === 'pending_approval' && (
          <Alert
            tone="info"
            title="Waiting for approval"
            action={
              can('invoices.approve') &&
              !ownRequest && (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="secondary" onClick={decline}>
                    <X /> Send back
                  </Button>
                  <Button size="sm" onClick={approve} loading={busy}>
                    <Check /> Approve and submit
                  </Button>
                </div>
              )
            }
          >
            {overLimit
              ? `It is at or above your ${naira(limit)} approval amount, so someone other than the person who sent it must approve it.`
              : 'An approver needs to release this invoice before it goes to NRS.'}
            {ownRequest && ' We have let the other approvers know.'}
          </Alert>
        )}

        <Card>
          <CardBody className="grid gap-6 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-subtle">Bill to</p>
              <p className="mt-1 font-medium">{inv.buyer?.name ?? inv.customer?.name}</p>
              <p className="text-sm text-muted">TIN {inv.buyer?.tin ?? inv.customer?.tin}</p>
              {(inv.buyer?.address ?? inv.customer?.address) && <p className="text-sm text-muted">{inv.buyer?.address ?? inv.customer?.address}</p>}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Issue date</dt>
              <dd>{shortDate(inv.issueDate)}</dd>
              {inv.dueDate && (
                <>
                  <dt className="text-muted">Due date</dt>
                  <dd>{shortDate(inv.dueDate)}</dd>
                </>
              )}
              {inv.originalInvoice && (
                <>
                  <dt className="text-muted">Against</dt>
                  <dd>
                    <Link href={`/w/${ws}/invoices/${inv.originalInvoice.id}`} className="text-brand-700 hover:underline">
                      {inv.originalInvoice.number}
                    </Link>
                  </dd>
                </>
              )}
              {inv.reason && (
                <>
                  <dt className="text-muted">Reason</dt>
                  <dd>{inv.reason}</dd>
                </>
              )}
            </dl>
          </CardBody>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs text-subtle">
                <tr>
                  <th className="px-5 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 font-medium">VAT</th>
                  <th className="px-5 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {inv.lines.map((l, i) => (
                  <tr key={l.id ?? i}>
                    <td className="px-5 py-2.5">{l.description}</td>
                    <td className="tabular px-3 py-2.5 text-right">{l.quantity}</td>
                    <td className="tabular px-3 py-2.5 text-right">{naira(l.unitPrice)}</td>
                    <td className="px-3 py-2.5 text-muted">{VAT_LABELS[l.vatTreatment]}</td>
                    <td className="tabular px-5 py-2.5 text-right">{naira(l.net ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ml-auto max-w-xs space-y-1 border-t border-line px-5 py-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Subtotal</span>
              <span className="tabular">{naira(inv.subtotal)}</span>
            </div>
            {inv.discountTotal > 0 && (
              <div className="flex justify-between">
                <span className="text-muted">Discounts</span>
                <span className="tabular">−{naira(inv.discountTotal)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted">VAT</span>
              <span className="tabular">{naira(inv.vatTotal)}</span>
            </div>
            <div className="flex justify-between pt-1 text-base font-semibold">
              <span>Total</span>
              <span className="tabular">{naira(inv.total)}</span>
            </div>
          </div>
        </Card>

        {inv.adjustments.length > 0 && (
          <Card>
            <CardHeader title="Credit and debit notes" />
            <ul className="divide-y divide-line">
              {inv.adjustments.map((a) => (
                <li key={a.id}>
                  <Link href={`/w/${ws}/invoices/${a.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
                    <span>
                      {DOC_TYPE_LABELS[a.docType]} {a.number ?? '(draft)'}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular">{naira(a.total)}</span> <StatusBadge status={a.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <History inv={inv} />
      </div>

      <aside className="space-y-4">
        {inv.status === 'cleared' && inv.irn && inv.qrPayload && (
          <Card className="border-brand-200">
            <CardBody className="text-center">
              <p className="flex items-center justify-center gap-1.5 text-sm font-semibold text-brand-800">
                <ShieldCheck className="size-4" /> Approved by NRS
              </p>
              <div className="mx-auto mt-3 w-fit rounded-lg border border-line bg-white p-2">
                <QRCodeSVG value={inv.qrPayload} size={148} level="M" aria-label="NRS QR stamp" />
              </div>
              <p className="mt-3 flex items-center justify-center gap-1 text-xs text-subtle">
                Invoice Reference Number (IRN) <InfoTip term="irn" />
              </p>
              <p className="break-all font-mono text-sm">{inv.irn}</p>
              <p className="mt-1 text-xs text-subtle">{dateTime(inv.clearedAt)}</p>
            </CardBody>
          </Card>
        )}
        <Card>
          <CardBody className="space-y-2">
            {inv.status === 'cleared' && can('invoices.share') && (
              <Button className="w-full" onClick={() => setShare(true)}>
                <Share2 /> Send to customer
              </Button>
            )}
            {inv.status === 'cleared' && inv.docType === 'invoice' && <PaymentControl inv={inv} onChange={refresh} />}
            <Button variant="secondary" className="w-full" asChild>
              <a href={`/api/v1/workspaces/${ws}/invoices/${inv.id}/pdf`} target="_blank" rel="noopener">
                <Download /> Download PDF
              </a>
            </Button>
            {inv.status === 'cleared' && inv.docType === 'invoice' && can('invoices.edit') && (
              <>
                <div className="border-t border-line pt-3">
                  <p className="mb-2 flex items-center gap-1 text-xs font-medium text-subtle">
                    Need to change it? <InfoTip title="Changing an approved invoice">Approved invoices can't be edited. Use a credit note to reduce it (returns, refunds) or a debit note to add to it (under-billing).</InfoTip>
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setNote('credit_note')}>
                      <FileMinus2 /> Credit note
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setNote('debit_note')}>
                      <FilePlus2 /> Debit note
                    </Button>
                  </div>
                </div>
              </>
            )}
            {['submitting', 'queued'].includes(inv.status) && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-subtle">
                <RotateCw className="size-3 animate-spin" /> Checking for updates…
              </p>
            )}
          </CardBody>
        </Card>
      </aside>

      {share && <ShareDialog inv={inv} onClose={() => setShare(false)} />}
      {note && (
        <NoteDialog
          inv={inv}
          docType={note}
          onClose={() => setNote(null)}
          onCreated={(n) => {
            setNote(null);
            router.push(`/w/${ws}/invoices/${n.id}`);
          }}
        />
      )}
    </div>
  );
}

/** E7-3: record payment (the only change allowed on a cleared invoice). */
function PaymentControl({ inv, onChange }: { inv: Invoice; onChange: (r: Invoice) => void }) {
  const ws = useWsId();
  const { can } = useRole();
  const [busy, setBusy] = useState(false);
  async function set(paid: boolean) {
    setBusy(true);
    try {
      const r = await api.patch<{ paidAt: string | null }>(`/v1/workspaces/${ws}/invoices/${inv.id}/payment`, { paid });
      onChange({ ...inv, paidAt: r.paidAt });
      toast.success(paid ? 'Marked as paid' : 'Marked as unpaid');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  if (inv.paidAt) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">
        <span>Paid {shortDate(inv.paidAt)}</span>
        {can('invoices.payments') && (
          <button className="text-xs underline" onClick={() => set(false)} disabled={busy}>
            Undo
          </button>
        )}
      </div>
    );
  }
  return can('invoices.payments') ? (
    <Button variant="secondary" className="w-full" onClick={() => set(true)} loading={busy}>
      <Check /> Mark as paid
    </Button>
  ) : null;
}

function History({ inv }: { inv: Invoice }) {
  if (!inv.history.length) return null;
  const label: Record<string, string> = { cleared: 'Approved by NRS', rejected: 'NRS asked for changes', unavailable: 'NRS unavailable — waited and retried' };
  return (
    <Card>
      <CardHeader title="Submission history" />
      <ol className="space-y-2 px-5 py-4 text-sm">
        {inv.history.map((h) => (
          <li key={h.attempt} className="flex justify-between gap-3">
            <span>
              Attempt {h.attempt}: {label[h.outcome] ?? h.outcome}
            </span>
            <span className="text-subtle">
              {dateTime(h.at)} · {(h.durationMs / 1000).toFixed(1)}s
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** E3-6: link, WhatsApp or email. */
function ShareDialog({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const ws = useWsId();
  const [email, setEmail] = useState(inv.customer?.email ?? '');
  const [phone, setPhone] = useState(inv.customer?.phone ?? '');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  async function send(channel: 'link' | 'email' | 'whatsapp') {
    setBusy(channel);
    setError(undefined);
    try {
      const r = await api.post<{ url: string; whatsappUrl: string | null }>(`/v1/workspaces/${ws}/invoices/${inv.id}/share`, {
        channel,
        recipient: channel === 'email' ? email : channel === 'whatsapp' ? phone || undefined : undefined,
      });
      if (channel === 'link') {
        setLink(r.url);
        await navigator.clipboard?.writeText(r.url).catch(() => undefined);
        toast.success('Link copied');
      } else if (channel === 'whatsapp' && r.whatsappUrl) {
        window.open(r.whatsappUrl, '_blank', 'noopener');
      } else {
        toast.success(`Sent to ${email}`);
        onClose();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Send to customer" description="Your customer gets a mobile-friendly page with a PDF download.">
      <div className="space-y-5">
        <div className="space-y-2">
          <Field id="wa" label="WhatsApp number">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" placeholder="0803 123 4567" />
          </Field>
          <Button variant="secondary" className="w-full" onClick={() => send('whatsapp')} loading={busy === 'whatsapp'}>
            <MessageCircle /> Open WhatsApp
          </Button>
        </div>
        <div className="space-y-2">
          <Field id="em" label="Email">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
          </Field>
          <Button variant="secondary" className="w-full" onClick={() => send('email')} loading={busy === 'email'} disabled={!email}>
            <Mail /> Send email
          </Button>
        </div>
        <div className="space-y-2 border-t border-line pt-4">
          {link ? (
            <div className="flex gap-2">
              <Input readOnly value={link} aria-label="Share link" onFocus={(e) => e.target.select()} />
              <Button variant="secondary" size="icon" aria-label="Copy link" onClick={() => navigator.clipboard?.writeText(link).then(() => toast.success('Copied'))}>
                <Copy />
              </Button>
            </div>
          ) : (
            <Button variant="ghost" className="w-full" onClick={() => send('link')} loading={busy === 'link'}>
              <Copy /> Copy a share link
            </Button>
          )}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}

/** E4-1 / E4-2: credit or debit note against the cleared invoice's IRN. */
function NoteDialog({ inv, docType, onClose, onCreated }: { inv: Invoice; docType: 'credit_note' | 'debit_note'; onClose: () => void; onCreated: (n: Invoice) => void }) {
  const ws = useWsId();
  const isCredit = docType === 'credit_note';
  const tpl = useQuery({
    queryKey: ['credit-template', inv.id],
    queryFn: () => api.get<{ remaining: number }>(`/v1/workspaces/${ws}/invoices/${inv.id}/credit-template`),
    enabled: isCredit,
  });
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'full' | 'amount'>(isCredit ? 'full' : 'amount');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState(isCredit ? 'Credit against ' + inv.number : 'Additional charge on ' + inv.number);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setErrors({});
    // Full credit copies the original lines; otherwise a single line at the standard rate.
    const lines =
      mode === 'full'
        ? inv.lines.map((l) => ({ productId: l.productId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, vatTreatment: l.vatTreatment }))
        : [{ description, quantity: 1, unitPrice: Number(amount.replace(/[,\s₦]/g, '')) || 0, discount: 0, vatTreatment: inv.lines[0]?.vatTreatment ?? 'standard' }];
    try {
      const n = await api.post<Invoice>(`/v1/workspaces/${ws}/invoices/${inv.id}/${isCredit ? 'credit-notes' : 'debit-notes'}`, { reason, issueDate: todayIso(), lines });
      onCreated(n);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.field ?? 'general', x.message])));
      else setErrors({ general: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={isCredit ? 'Raise a credit note' : 'Raise a debit note'}
      description={`Linked to ${inv.number} · IRN ${inv.irn}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} loading={busy} disabled={reason.trim().length < 3}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {isCredit && tpl.data && <p className="text-sm text-muted">Up to {naira(tpl.data.remaining)} can still be credited on this invoice.</p>}
        <Field id="reason" label="Reason" error={errors.reason} hint={isCredit ? 'e.g. Returned goods, agreed discount' : 'e.g. Under-billed freight'}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>
        {isCredit && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Amount</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} className="accent-brand-700" /> Full credit ({naira(inv.total)})
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={mode === 'amount'} onChange={() => setMode('amount')} className="accent-brand-700" /> Part of it
            </label>
          </fieldset>
        )}
        {mode === 'amount' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="n-desc" label="Description">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field id="n-amt" label="Amount before VAT (₦)">
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </Field>
          </div>
        )}
        {(errors.lines || errors.general) && <Alert tone="error">{errors.lines ?? errors.general}</Alert>}
        <p className="text-xs text-subtle">The note opens as a draft so you can adjust the lines before submitting it to NRS.</p>
      </div>
    </Dialog>
  );
}
