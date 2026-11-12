'use client';
import { CreditCard, Landmark, Smartphone } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { formatKobo } from '@einv/shared';
import { Logo } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardBody } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const METHODS = [
  { key: 'card', label: 'Card', icon: CreditCard },
  { key: 'bank_transfer', label: 'Bank transfer', icon: Landmark },
  { key: 'ussd', label: 'USSD', icon: Smartphone },
] as const;

/**
 * Stand-in for the payment partner's hosted page, used only when no Paystack key is set
 * (local development). The API refuses it in production.
 */
function TestCheckout() {
  const params = useSearchParams();
  const reference = params.get('reference') ?? '';
  const amount = Number(params.get('amount') ?? 0);
  const [method, setMethod] = useState<(typeof METHODS)[number]['key']>('card');
  const [busy, setBusy] = useState<'success' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only ever return to a page on this site. Read after mount: the URL check needs `window`.
  const [back, setBack] = useState<URL | null | undefined>(undefined);
  useEffect(() => {
    try {
      const u = new URL(params.get('return') ?? '', window.location.origin);
      setBack(u.origin === window.location.origin && params.get('return') ? u : null);
    } catch {
      setBack(null);
    }
  }, [params]);

  async function finish(outcome: 'success' | 'failed') {
    if (!back) return;
    setBusy(outcome);
    setError(null);
    try {
      await api.post(`/v1/billing/test-checkout/${encodeURIComponent(reference)}`, { outcome, channel: method });
      back.searchParams.set('reference', reference);
      window.location.assign(back.toString());
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-8">
      <Logo />
      <div className="flex flex-1 flex-col justify-center py-10">
        <Alert tone="warning" title="Test payment">
          No real money moves. This page stands in for the payment partner while online payments aren't connected.
        </Alert>
        <Card className="mt-4">
          <CardBody className="space-y-5">
            <div>
              <p className="text-sm text-muted">Amount</p>
              <p className="tabular text-3xl font-semibold">{formatKobo(amount)}</p>
              <p className="mt-1 font-mono text-xs text-subtle">{reference}</p>
            </div>
            <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-3 gap-2">
              {METHODS.map((m) => (
                <button
                  key={m.key}
                  role="radio"
                  aria-checked={method === m.key}
                  onClick={() => setMethod(m.key)}
                  className={cn('flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs font-medium', method === m.key ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-muted hover:text-ink')}
                >
                  <m.icon className="size-5" aria-hidden />
                  {m.label}
                </button>
              ))}
            </div>
            {back === null && <Alert tone="error">This payment link is incomplete. Go back and start again.</Alert>}
            {error && <Alert tone="error">{error}</Alert>}
            <div className="space-y-2">
              <Button className="w-full" onClick={() => finish('success')} loading={busy === 'success'} disabled={!back || !!busy}>
                Pay {formatKobo(amount)}
              </Button>
              <Button className="w-full" variant="ghost" onClick={() => finish('failed')} loading={busy === 'failed'} disabled={!back || !!busy}>
                Simulate a declined payment
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </main>
  );
}

export default function TestCheckoutPage() {
  return (
    <Suspense>
      <TestCheckout />
    </Suspense>
  );
}
