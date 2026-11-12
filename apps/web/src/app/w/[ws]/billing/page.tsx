'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, Download } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  PLANS,
  PLAN_IDS,
  formatKobo,
  isUpgrade,
  periodEnd,
  priceKobo,
  prorationCredit,
  MIN_CHARGE_KOBO,
  type BillingInterval,
  type PlanId,
} from '@einv/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/form';
import { Alert, Badge, Card, CardBody, CardHeader, PageHeader, Progress, Skeleton, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useBilling, useRole, useWsId } from '@/lib/hooks';
import type { BillingSummary, PaymentRow } from '@/lib/types';
import { cn, shortDate } from '@/lib/utils';

const STATUS_TONE = { trialing: 'blue', active: 'green', past_due: 'amber', lapsed: 'red', trial_ended: 'red' } as const;
const daysLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : 0);

function Billing() {
  const ws = useWsId();
  const billing = useBilling();
  const { can } = useRole();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const confirming = useRef(false);

  // Returning from the payment page: confirm with the gateway (through the API), then tidy the URL.
  useEffect(() => {
    const reference = params.get('reference') ?? params.get('trxref');
    if (!reference || confirming.current) return;
    confirming.current = true;
    api
      .post<{ status: string; summary: BillingSummary }>(`/v1/workspaces/${ws}/billing/confirm`, { reference })
      .then((r) => {
        qc.setQueryData(['billing', ws], r.summary);
        void qc.invalidateQueries({ queryKey: ['payments', ws] });
        void qc.invalidateQueries({ queryKey: ['ws', ws] });
        if (r.status === 'success') toast.success(`Payment received. You're on ${r.summary.planName}.`);
        else if (r.status === 'pending') toast.info("We're waiting for your bank to confirm. This page will update when it does.");
        else toast.error("The payment didn't go through. You haven't been charged.");
      })
      .catch((err) => toast.error(errorMessage(err)))
      .finally(() => router.replace(`/w/${ws}/billing`));
  }, [params, ws, qc, router]);

  const b = billing.data;
  return (
    <>
      <PageHeader title="Plan & billing" description="Your plan, what you've used and your receipts." />
      {!b ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          <CurrentPlan b={b} canManage={can('billing.manage')} />
          <PlanPicker b={b} canManage={can('billing.manage')} />
          {can('billing.view') && <Payments b={b} canManage={can('billing.manage')} />}
        </div>
      )}
    </>
  );
}

function CurrentPlan({ b, canManage }: { b: BillingSummary; canManage: boolean }) {
  const ws = useWsId();
  const qc = useQueryClient();
  const trial = b.plan === 'trial';
  const renewPrice = !trial && b.interval ? formatKobo(priceKobo((b.nextPlan ?? b.plan) as PlanId, (b.nextInterval ?? b.interval) as BillingInterval)) : null;

  async function keepPlan() {
    try {
      qc.setQueryData(['billing', ws], await api.del<BillingSummary>(`/v1/workspaces/${ws}/billing/scheduled-change`));
      toast.success('Your current plan will continue.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardBody className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{b.planName}</h2>
              {b.status !== 'trialing' && <Badge tone={STATUS_TONE[b.status]}>{b.statusLabel}</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">
              {b.status === 'trialing' && `${daysLeft(b.trialEndsAt)} days left · ends ${shortDate(b.trialEndsAt)}`}
              {b.status === 'trial_ended' && `Ended ${shortDate(b.trialEndsAt)}`}
              {b.status === 'active' && (b.autoRenew ? `Renews ${shortDate(b.currentPeriodEnd)} for ${renewPrice}` : `Paid until ${shortDate(b.currentPeriodEnd)} · won't renew automatically`)}
              {b.status === 'past_due' && `Payment was due ${shortDate(b.currentPeriodEnd)}`}
              {b.status === 'lapsed' && `Paused since ${shortDate(b.graceEndsAt)}`}
              {!trial && b.interval && <span className="text-subtle"> · billed {b.interval}</span>}
            </p>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted">{trial ? 'Invoices sent to NRS during your trial' : 'Invoices sent to NRS this month'}</span>
            <span className="tabular font-medium">
              {b.usage.used}
              {b.usage.limit !== null ? <span className="text-subtle"> of {b.usage.limit}</span> : <span className="text-subtle"> · unlimited</span>}
            </span>
          </div>
          {b.usage.share !== null && <Progress value={b.usage.share} label="Invoice allowance used" tone={b.usage.share >= 1 ? 'red' : b.usage.warn ? 'amber' : 'brand'} />}
          {b.usage.warn && b.canSend && b.usage.limit !== null && (
            <p className="mt-2 text-[13px] text-amber-800">
              {b.usage.limit - b.usage.used} left. {trial ? 'Choose a plan to keep going after your trial.' : 'Upgrade before you run out to keep sending without a pause.'}
            </p>
          )}
        </div>

        {b.block && (
          <Alert tone="error" title="Sending to NRS is paused">
            {b.block.message}
          </Alert>
        )}
        {b.status === 'past_due' && (
          <Alert tone="warning" title="Payment due">
            Sending keeps working until {shortDate(b.graceEndsAt)}. {b.card ? `We'll keep trying your card ending ${b.card.last4} daily.` : 'Pay below to avoid a pause.'}
          </Alert>
        )}
        {b.nextPlan && (
          <Alert
            tone="info"
            action={
              canManage && (
                <Button size="sm" variant="secondary" onClick={keepPlan}>
                  Keep {b.planName}
                </Button>
              )
            }
          >
            Changes to {PLANS[b.nextPlan].name} ({b.nextInterval}) on {shortDate(b.currentPeriodEnd)}.
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}

function PlanPicker({ b, canManage }: { b: BillingSummary; canManage: boolean }) {
  const ws = useWsId();
  const qc = useQueryClient();
  const [interval, setInterval] = useState<BillingInterval>((b.interval as BillingInterval) ?? 'monthly');
  const [chosen, setChosen] = useState<PlanId | null>(null);
  const [busy, setBusy] = useState(false);
  const paid = b.plan !== 'trial' && b.status === 'active' && !!b.interval && !!b.currentPeriodEnd;
  const current = paid ? { plan: b.plan as PlanId, interval: b.interval as BillingInterval } : null;

  function quote(plan: PlanId) {
    const list = priceKobo(plan, interval);
    if (!current) return { kind: 'new' as const, list, credit: 0, now: list };
    if (current.plan === plan && current.interval === interval) return { kind: 'current' as const, list, credit: 0, now: 0 };
    if (!isUpgrade(current, { plan, interval })) return { kind: 'later' as const, list, credit: 0, now: 0 };
    const credit = Math.min(list, prorationCredit({ ...current, periodEnd: new Date(b.currentPeriodEnd!) }, new Date()));
    return { kind: 'upgrade' as const, list, credit, now: Math.max(MIN_CHARGE_KOBO, list - credit) };
  }

  async function go() {
    if (!chosen) return;
    setBusy(true);
    try {
      const r = await api.post<{ scheduled: true; effectiveAt: string } | { scheduled: false; authorizationUrl: string }>(`/v1/workspaces/${ws}/billing/checkout`, {
        plan: chosen,
        interval,
      });
      if (r.scheduled) {
        await qc.invalidateQueries({ queryKey: ['billing', ws] });
        toast.success(`You'll move to ${PLANS[chosen].name} on ${shortDate(r.effectiveAt)}.`);
        setChosen(null);
      } else {
        window.location.assign(r.authorizationUrl);
        return; // keep the button busy while the payment page loads
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
    setBusy(false);
  }

  const q = chosen ? quote(chosen) : null;
  return (
    <section aria-labelledby="plans-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="plans-title" className="text-base font-semibold">
            {current ? 'Change plan' : 'Choose a plan'}
          </h2>
          <p className="mt-0.5 text-sm text-muted">Pay by card, bank transfer or USSD. Prices include everything; no setup fees.</p>
        </div>
        <div role="radiogroup" aria-label="Billing period" className="inline-flex rounded-lg border border-line bg-canvas p-0.5 text-sm">
          {(['monthly', 'yearly'] as const).map((i) => (
            <button
              key={i}
              role="radio"
              aria-checked={interval === i}
              onClick={() => setInterval(i)}
              className={cn('rounded-md px-3 py-1.5 font-medium', interval === i ? 'bg-surface text-ink ring-1 ring-line' : 'text-muted hover:text-ink')}
            >
              {i === 'monthly' ? 'Monthly' : 'Yearly'}
              {i === 'yearly' && <span className="ml-1.5 text-xs font-normal text-brand-700">2 months free</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const p = PLANS[id];
          const qq = quote(id);
          const featured = id === 'business';
          return (
            <div key={id} className={cn('flex flex-col rounded-xl border bg-surface p-5', featured ? 'border-brand-600' : 'border-line')}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{p.name}</h3>
                {qq.kind === 'current' ? <Badge tone="green">Current plan</Badge> : featured && <Badge tone="green">Most popular</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted">{p.tagline}</p>
              <p className="mt-4">
                <span className="tabular text-2xl font-semibold">{formatKobo(qq.list)}</span>
                <span className="text-sm text-subtle"> /{interval === 'monthly' ? 'month' : 'year'}</span>
              </p>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-brand-700" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              {canManage && (
                <Button
                  className="mt-5 w-full"
                  variant={featured && qq.kind !== 'current' ? 'primary' : 'secondary'}
                  disabled={qq.kind === 'current' || !b.checkoutAvailable}
                  onClick={() => setChosen(id)}
                >
                  {qq.kind === 'current' ? 'Your plan' : qq.kind === 'upgrade' ? `Upgrade to ${p.name}` : qq.kind === 'later' ? `Switch to ${p.name}` : `Choose ${p.name}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {!canManage && <p className="mt-3 text-sm text-muted">Only owners and admins can change the plan.</p>}
      {!b.checkoutAvailable && (
        <Alert tone="info" className="mt-4">
          Online payment isn't switched on yet. Contact support to activate a plan.
        </Alert>
      )}

      <Dialog
        open={!!chosen}
        onOpenChange={(o) => !o && !busy && setChosen(null)}
        title={chosen && q ? (q.kind === 'later' ? `Switch to ${PLANS[chosen].name}?` : q.kind === 'upgrade' ? `Upgrade to ${PLANS[chosen].name}` : `${PLANS[chosen].name} plan`) : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setChosen(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={go} loading={busy}>
              {q?.kind === 'later' ? 'Switch at renewal' : `Pay ${q ? formatKobo(q.now) : ''}`}
            </Button>
          </>
        }
      >
        {chosen && q && (
          <dl className="space-y-2 text-sm">
            {q.kind === 'later' ? (
              <p className="text-muted">
                You keep {b.planName} until {shortDate(b.currentPeriodEnd)}, then move to {PLANS[chosen].name} at {formatKobo(q.list)} per {interval === 'monthly' ? 'month' : 'year'}. Nothing to pay today.
              </p>
            ) : (
              <>
                <Row label={`${PLANS[chosen].name}, ${interval}`} value={formatKobo(q.list)} />
                {q.credit > 0 && <Row label={`Credit for unused days on ${b.planName}`} value={`− ${formatKobo(q.credit)}`} />}
                <div className="border-t border-line pt-2">
                  <Row label="To pay today" value={formatKobo(q.now)} strong />
                </div>
                <p className="pt-2 text-[13px] text-subtle">
                  Starts today and renews on {shortDate(periodEnd(new Date(), interval).toISOString())}. You'll go to our payment partner to pay by card, bank transfer or USSD.
                  {b.testMode && ' Test mode: no real money moves.'}
                </p>
              </>
            )}
          </dl>
        )}
      </Dialog>
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'font-semibold')}>
      <dt className={strong ? undefined : 'text-muted'}>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

function Payments({ b, canManage }: { b: BillingSummary; canManage: boolean }) {
  const ws = useWsId();
  const qc = useQueryClient();
  const payments = useQuery({ queryKey: ['payments', ws], queryFn: () => api.get<PaymentRow[]>(`/v1/workspaces/${ws}/billing/payments`) });

  async function setAutoRenew(autoRenew: boolean) {
    try {
      qc.setQueryData(['billing', ws], await api.patch<BillingSummary>(`/v1/workspaces/${ws}/billing`, { autoRenew }));
      toast.success(autoRenew ? 'Your plan will renew automatically.' : "Your plan won't renew automatically. We'll remind you before it ends.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
      <Card className="self-start">
        <CardHeader title="Payment method" />
        <CardBody className="space-y-4 pt-0">
          <div className="flex items-center gap-3 text-sm">
            <span className="grid size-9 place-items-center rounded-lg bg-canvas text-muted">
              <CreditCard className="size-4" aria-hidden />
            </span>
            {b.card ? (
              <span>
                <span className="font-medium capitalize">{b.card.brand ?? 'Card'}</span> ending <span className="font-mono">{b.card.last4}</span>
                {b.card.expiry && <span className="block text-xs text-subtle">Expires {b.card.expiry}</span>}
              </span>
            ) : (
              <span className="text-muted">No saved card. Pay by card to save one for renewals.</span>
            )}
          </div>
          {canManage && b.plan !== 'trial' && (
            <Checkbox
              checked={b.autoRenew}
              onChange={(e) => setAutoRenew(e.target.checked)}
              label={
                <>
                  <span className="font-medium">Renew automatically</span>
                  <span className="block text-xs text-muted">{b.card ? 'We charge the saved card when your plan renews.' : "We'll email you to pay when your plan is due."}</span>
                </>
              }
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Receipts" />
        {payments.isLoading ? (
          <CardBody>
            <Skeleton className="h-16" />
          </CardBody>
        ) : !payments.data?.length ? (
          <CardBody className="pt-0 text-sm text-muted">No payments yet. Receipts appear here and are emailed to you.</CardBody>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {payments.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {p.planName} · {p.interval}
                    {p.kind === 'renewal' && <span className="font-normal text-subtle"> · renewal</span>}
                  </p>
                  <p className="text-xs text-subtle">
                    {shortDate(p.paidAt ?? p.createdAt)}
                    {p.receiptNumber && <span className="font-mono"> · {p.receiptNumber}</span>}
                    {p.failureReason && <span> · {p.failureReason}</span>}
                  </p>
                </div>
                <span className="tabular">{formatKobo(p.amount)}</span>
                {p.status === 'success' ? (
                  <Button asChild size="sm" variant="ghost" aria-label={`Download receipt ${p.receiptNumber}`}>
                    <a href={`/api/v1/workspaces/${ws}/billing/payments/${p.id}/receipt.pdf`}>
                      <Download /> PDF
                    </a>
                  </Button>
                ) : (
                  <Badge tone="red">Failed</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Billing />
    </Suspense>
  );
}
