'use client';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ScanLine, SearchCheck, XCircle } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { SiteFooter, SiteHeader } from '@/components/marketing';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert, Card, CardBody } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import type { IrnCheck, Me } from '@/lib/types';
import { naira, shortDate } from '@/lib/utils';

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
  }
}

/** E8-1: check that an invoice was approved by NRS, from its IRN or its QR code. */
function Verify() {
  const params = useSearchParams();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.peek<Me>('/v1/me'), retry: false });
  const firstWs = me.data?.workspaces[0]?.id;
  const appHref = firstWs ? `/w/${firstWs}` : me.data?.firms[0] ? `/f/${me.data.firms[0].id}` : '/signup';

  const [q, setQ] = useState(params.get('q') ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IrnCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [canScan, setCanScan] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  const check = useCallback(async (value: string) => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.get<IrnCheck>(`/v1/public/irn?q=${encodeURIComponent(v)}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    setCanScan(typeof window !== 'undefined' && !!window.BarcodeDetector && !!navigator.mediaDevices?.getUserMedia);
    const initial = params.get('q');
    if (initial) void check(initial);
  }, [params, check]);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setScanning(false);
  }, []);
  useEffect(() => stop, [stop]);

  async function scan() {
    if (!window.BarcodeDetector) return;
    setError(null);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setScanning(true);
      const el = video.current!;
      el.srcObject = stream.current;
      await el.play();
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        if (!stream.current) return;
        const codes = await detector.detect(el).catch(() => []);
        if (codes[0]?.rawValue) {
          stop();
          setQ(codes[0].rawValue);
          void check(codes[0].rawValue);
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      stop();
      setError("We couldn't open the camera. Type the IRN printed on the invoice instead.");
    }
  }

  return (
    <div className="min-h-dvh">
      <SiteHeader signedIn={!!me.data} appHref={appHref} />
      <main id="main" className="mx-auto max-w-xl px-4 py-12 sm:px-6 sm:py-16">
        <p className="text-sm font-semibold text-brand-700">Check an invoice</p>
        <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Was this invoice approved by NRS?</h1>
        <p className="mt-3 text-muted">
          Enter the IRN printed on the invoice, or scan its QR code. Buyers should check supplier invoices before claiming the VAT on them.
        </p>

        <form
          className="mt-8 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void check(q);
          }}
        >
          <Field id="irn" label="IRN or QR code text" hint="For example INV000123-1A2B3C4D-20261112">
            <Input value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={busy} disabled={!q.trim()}>
              <SearchCheck /> Check
            </Button>
            {canScan && !scanning && (
              <Button type="button" variant="secondary" onClick={scan}>
                <ScanLine /> Scan QR code
              </Button>
            )}
            {scanning && (
              <Button type="button" variant="ghost" onClick={stop}>
                Stop camera
              </Button>
            )}
          </div>
        </form>

        <video ref={video} className={scanning ? 'mt-4 aspect-square w-full rounded-xl bg-ink object-cover' : 'hidden'} muted playsInline aria-label="Camera preview" />

        <div aria-live="polite" className="mt-6">
          {error && <Alert tone="error">{error}</Alert>}
          {result?.valid && (
            <Card className="border-brand-200">
              <CardBody className="space-y-4">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="size-7 shrink-0 text-brand-700" aria-hidden />
                  <div>
                    <p className="font-semibold">Approved by NRS</p>
                    <p className="text-sm text-muted">This invoice is genuine and registered with NRS.</p>
                  </div>
                </div>
                <dl className="divide-y divide-line border-t border-line text-sm">
                  <Item label="IRN" value={<span className="break-all font-mono">{result.irn}</span>} />
                  {result.sellerName && <Item label="Issued by" value={result.sellerName} />}
                  {result.sellerTin && <Item label="Seller Tax ID" value={<span className="font-mono">{result.sellerTin}</span>} />}
                  {result.total != null && <Item label="Invoice total" value={<span className="tabular">{naira(result.total)}</span>} />}
                  {result.issueDate && <Item label="Issue date" value={shortDate(result.issueDate)} />}
                </dl>
                <p className="text-[13px] text-subtle">Make sure these details match the invoice you were given.</p>
              </CardBody>
            </Card>
          )}
          {result && !result.valid && (
            <Card className="border-red-200">
              <CardBody className="flex gap-3">
                <XCircle className="size-7 shrink-0 text-red-600" aria-hidden />
                <div>
                  <p className="font-semibold">{result.reason === 'not_an_irn' ? "That doesn't look like an IRN" : 'Not found at NRS'}</p>
                  <p className="mt-1 text-sm text-muted">
                    {result.reason === 'not_an_irn'
                      ? 'Check you copied the whole IRN from the invoice, including the dashes.'
                      : "NRS has no approved invoice with this IRN. Ask the supplier for an NRS-approved invoice before you claim VAT on it. Test (sandbox) invoices don't count."}
                  </p>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-2.5">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
