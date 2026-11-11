'use client';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import { useParams } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { DOC_TYPE_LABELS, VAT_LABELS, type DocType, type VatTreatment } from '@einv/shared';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { naira, shortDate } from '@/lib/utils';

interface PublicInvoice {
  docType: DocType;
  number: string;
  issueDate: string;
  dueDate: string | null;
  irn: string;
  qrPayload: string;
  clearedAt: string;
  seller: {
    name: string;
    tradingName: string | null;
    tin: string;
    address: string | null;
    email: string | null;
    phone: string | null;
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
    terms: string | null;
    brandColor: string | null;
    hasLogo: boolean;
  };
  buyer: { name: string; tin: string; address: string | null } | null;
  originalInvoice: { number: string; irn: string } | null;
  reason: string | null;
  notes: string | null;
  lines: { description: string; quantity: number; unitPrice: number; discount: number; vatTreatment: VatTreatment; net: number }[];
  subtotal: number;
  discountTotal: number;
  vatTotal: number;
  total: number;
}

/** E3-6: what the buyer sees when they open a WhatsApp or email link. Mobile first. */
export default function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const q = useQuery({ queryKey: ['public', token], queryFn: () => api.get<PublicInvoice>(`/v1/public/invoices/${token}`), retry: false });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data)
    return (
      <main id="main" className="mx-auto max-w-md p-6">
        <Alert tone="error" title="This invoice link isn't available">
          {errorMessage(q.error)} Ask the sender for a new link.
        </Alert>
      </main>
    );
  const inv = q.data;
  const s = inv.seller;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <article className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
        <header className="flex items-start justify-between gap-4 border-b border-line p-5 sm:p-6" style={{ borderTop: `4px solid ${s.brandColor ?? '#166534'}` }}>
          <div className="min-w-0">
            {s.hasLogo && (
              <img src={`/api/v1/public/invoices/${token}/logo`} alt="" className="mb-3 h-10 w-auto object-contain" />
            )}
            <p className="font-semibold">{s.tradingName ?? s.name}</p>
            <p className="text-xs text-muted">
              TIN {s.tin}
              {s.address ? ` · ${s.address}` : ''}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">{DOC_TYPE_LABELS[inv.docType]}</p>
            <p className="font-semibold">{inv.number}</p>
            <p className="text-xs text-muted">{shortDate(inv.issueDate)}</p>
          </div>
        </header>

        <section className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">Billed to</p>
            <p className="mt-1 font-medium">{inv.buyer?.name}</p>
            <p className="text-sm text-muted">TIN {inv.buyer?.tin}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">Amount due</p>
            <p className="tabular mt-1 text-2xl font-semibold">{naira(inv.total)}</p>
            {inv.dueDate && <p className="text-sm text-muted">by {shortDate(inv.dueDate)}</p>}
          </div>
        </section>

        {inv.originalInvoice && (
          <p className="px-5 pb-2 text-sm text-muted sm:px-6">
            Against invoice {inv.originalInvoice.number} (IRN {inv.originalInvoice.irn}). {inv.reason}
          </p>
        )}

        <ul className="divide-y divide-line border-y border-line">
          {inv.lines.map((l, i) => (
            <li key={i} className="flex justify-between gap-3 px-5 py-3 text-sm sm:px-6">
              <div className="min-w-0">
                <p>{l.description}</p>
                <p className="text-xs text-subtle">
                  {l.quantity} × {naira(l.unitPrice)}
                  {l.discount > 0 && ` − ${naira(l.discount)} discount`} · {VAT_LABELS[l.vatTreatment]}
                </p>
              </div>
              <span className="tabular shrink-0">{naira(l.net)}</span>
            </li>
          ))}
        </ul>
        <div className="ml-auto max-w-xs space-y-1 px-5 py-4 text-sm sm:px-6">
          <div className="flex justify-between">
            <span className="text-muted">Subtotal</span>
            <span className="tabular">{naira(inv.subtotal - inv.discountTotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">VAT</span>
            <span className="tabular">{naira(inv.vatTotal)}</span>
          </div>
          <div className="flex justify-between text-base font-semibold">
            <span>Total</span>
            <span className="tabular">{naira(inv.total)}</span>
          </div>
        </div>

        {(s.bankName || s.bankAccountNumber) && (
          <section className="mx-5 mb-5 rounded-lg bg-canvas p-4 text-sm sm:mx-6">
            <p className="font-medium">Pay to</p>
            <p className="tabular mt-1">
              {s.bankName} · <span className="font-mono">{s.bankAccountNumber}</span>
            </p>
            <p className="text-muted">{s.bankAccountName}</p>
          </section>
        )}

        <footer className="flex flex-col items-center gap-4 border-t border-line bg-brand-50/50 p-5 sm:flex-row sm:p-6">
          <div className="rounded-lg border border-line bg-white p-2">
            <QRCodeSVG value={inv.qrPayload} size={112} level="M" aria-label="NRS QR stamp" />
          </div>
          <div className="text-center text-sm sm:text-left">
            <p className="flex items-center justify-center gap-1.5 font-semibold text-brand-800 sm:justify-start">
              <ShieldCheck className="size-4" /> Cleared by the Nigeria Revenue Service
            </p>
            <p className="mt-1 text-xs text-subtle">Invoice Reference Number</p>
            <p className="break-all font-mono text-xs">{inv.irn}</p>
          </div>
        </footer>
      </article>

      <div className="mt-4 flex justify-center">
        <Button asChild size="lg">
          <a href={`/api/v1/public/invoices/${token}/pdf`}>
            <Download /> Download PDF
          </a>
        </Button>
      </div>
      {(inv.notes || s.terms) && (
        <div className="mt-6 space-y-2 text-xs text-muted">
          {inv.notes && <p>{inv.notes}</p>}
          {s.terms && <p>{s.terms}</p>}
        </div>
      )}
    </main>
  );
}
