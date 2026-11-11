'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleDashed, Loader2, ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Logo } from '@/components/auth-shell';
import { BrandingForm } from '@/components/branding-form';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert, Card, Spinner } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { Workspace } from '@/lib/types';
import { cn, shortDate } from '@/lib/utils';

const STEPS = ['Your business', 'Invoice details', 'Connect to NRS', 'Done'];

function Onboarding() {
  const params = useSearchParams();
  const router = useRouter();
  const [wsId, setWsId] = useState<string | null>(params.get('ws'));
  const [step, setStep] = useState(0);
  const ws = useQuery({
    queryKey: ['ws', wsId],
    queryFn: () => api.get<Workspace>(`/v1/workspaces/${wsId}`),
    enabled: !!wsId,
  });

  // Resume where the user left off — only when they arrive with an existing workspace,
  // not right after creating one (they need to see the Tax ID result first).
  const resume = useRef(!!params.get('ws'));
  useEffect(() => {
    if (!ws.data || !resume.current) return;
    resume.current = false;
    if (ws.data.mbsStatus === 'live') setStep(3);
    else if (ws.data.tinVerified && !ws.data.nameMismatch) setStep(ws.data.bankAccountLast4 ? 2 : 1);
  }, [ws.data]);

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
      <Logo />
      <ol className="mt-8 grid grid-cols-4 gap-2" aria-label="Setup progress">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined}>
            <div className={cn('h-1.5 rounded-full', i <= step ? 'bg-brand-600' : 'bg-slate-200')} />
            <p className={cn('mt-2 hidden text-xs sm:block', i === step ? 'font-medium text-ink' : 'text-subtle')}>{s}</p>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-subtle sm:hidden">
        Step {step + 1} of 4 · {STEPS[step]}
      </p>

      <div className="mt-8">
        {wsId && ws.isLoading ? (
          <Spinner />
        ) : step === 0 ? (
          <BusinessStep
            workspace={ws.data ?? null}
            onCreated={(w) => {
              setWsId(w.id);
              router.replace(`/onboarding?ws=${w.id}`);
            }}
            onNext={() => setStep(1)}
          />
        ) : step === 1 && ws.data ? (
          <Card className="p-5 sm:p-6">
            <h1 className="text-xl font-semibold">Make your invoices look like yours</h1>
            <p className="mt-1 text-sm text-muted">Your logo and bank details appear on every invoice and share link. You can change these later.</p>
            <div className="mt-6">
              <BrandingForm workspace={ws.data} onSaved={() => setStep(2)} submitLabel="Save and continue" secondary={<Button variant="ghost" onClick={() => setStep(2)}>Skip for now</Button>} />
            </div>
          </Card>
        ) : step === 2 && ws.data ? (
          <ConnectStep workspace={ws.data} onDone={() => setStep(3)} />
        ) : step === 3 && ws.data ? (
          <Card className="p-6 text-center sm:p-10">
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-brand-100 text-brand-700">
              <ShieldCheck className="size-7" />
            </div>
            <h1 className="mt-4 text-xl font-semibold">You're ready to issue cleared invoices</h1>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              {ws.data.legalName} is connected to NRS. Every invoice you submit gets an IRN and QR stamp your buyers can trust.
            </p>
            <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
              <Button size="lg" onClick={() => router.push(`/w/${ws.data!.id}/invoices/new`)}>
                Create your first invoice
              </Button>
              <Button size="lg" variant="secondary" onClick={() => router.push(`/w/${ws.data!.id}`)}>
                Go to dashboard
              </Button>
            </div>
          </Card>
        ) : null}
      </div>
    </main>
  );
}

function BusinessStep({ workspace, onCreated, onNext }: { workspace: Workspace | null; onCreated: (w: Workspace) => void; onNext: () => void }) {
  const qc = useQueryClient();
  const [legalName, setLegalName] = useState(workspace?.legalName ?? '');
  const [tin, setTin] = useState(workspace?.tin ?? '');
  const [turnover, setTurnover] = useState(workspace?.turnover ? String(workspace.turnover) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [general, setGeneral] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setGeneral(undefined);
    setBusy(true);
    try {
      const w = await api.post<Workspace>('/v1/workspaces', {
        legalName,
        tin,
        turnover: turnover ? Number(turnover.replace(/[,\s₦]/g, '')) : null,
      });
      qc.setQueryData(['ws', w.id], w);
      await qc.invalidateQueries({ queryKey: ['me'] });
      onCreated(w);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.field ?? '', x.message])));
      else setGeneral(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const [renaming, setRenaming] = useState(false);
  async function applyRegistryName() {
    if (!workspace?.registryName) return;
    setRenaming(true);
    try {
      const w = await api.patch<Workspace>(`/v1/workspaces/${workspace.id}`, { legalName: workspace.registryName });
      qc.setQueryData(['ws', w.id], w);
    } catch (err) {
      setGeneral(errorMessage(err));
    } finally {
      setRenaming(false);
    }
  }

  async function recheck() {
    if (!workspace) return;
    const r = await api.post<{ workspace: Workspace; message: string }>(`/v1/workspaces/${workspace.id}/tin/verify`);
    qc.setQueryData(['ws', workspace.id], r.workspace);
  }

  if (workspace) {
    return (
      <Card className="space-y-4 p-5 sm:p-6">
        <h1 className="text-xl font-semibold">{workspace.legalName}</h1>
        {workspace.tinVerified ? (
          workspace.nameMismatch ? (
            <Alert
              tone="warning"
              title="Name doesn't match NRS records"
              action={
                <Button size="sm" variant="secondary" onClick={applyRegistryName} loading={renaming}>
                  Use this name
                </Button>
              }
            >
              NRS has Tax ID {workspace.tin} registered to <strong>{workspace.registryName}</strong>. Invoices with a different name may be rejected.
            </Alert>
          ) : (
            <Alert tone="success" title="Tax ID verified with NRS">
              {workspace.tin} · {workspace.registryName ?? workspace.legalName}
            </Alert>
          )
        ) : (
          <Alert
            tone="error"
            title="We couldn't verify this Tax ID"
            action={
              <Button size="sm" variant="secondary" onClick={recheck}>
                Check again
              </Button>
            }
          >
            Check the number on your TIN certificate. You'll need a verified Tax ID to connect to NRS.
          </Alert>
        )}
        {workspace.taxBand && (
          <div className="rounded-lg border border-line bg-canvas px-4 py-3 text-sm">
            <p className="font-medium">{workspace.taxBand.band}</p>
            <p className="text-muted">E-invoicing applies to you from {shortDate(workspace.taxBand.goLive)}.</p>
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={onNext} disabled={!workspace.tinVerified}>
            Continue
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5 sm:p-6">
      <h1 className="text-xl font-semibold">Tell us about your business</h1>
      <p className="mt-1 text-sm text-muted">We check your Tax ID with NRS and fill in what we can.</p>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <Field id="legalName" label="Registered business name" error={errors.legalName}>
          <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} autoComplete="organization" autoFocus />
        </Field>
        <Field id="tin" label="Tax ID (TIN)" hint="As shown on your TIN certificate, e.g. 12345678-0001" error={errors.tin}>
          <Input value={tin} onChange={(e) => setTin(e.target.value)} inputMode="numeric" placeholder="12345678-0001" />
        </Field>
        <Field id="turnover" label="Annual turnover (₦)" hint="Used to work out your e-invoicing go-live date. Optional." error={errors.turnover}>
          <Input value={turnover} onChange={(e) => setTurnover(e.target.value)} inputMode="numeric" placeholder="e.g. 450,000,000" />
        </Field>
        {general && <Alert tone="error">{general}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" loading={busy}>
            Verify and continue
          </Button>
        </div>
      </form>
    </Card>
  );
}

type StepState = 'todo' | 'running' | 'done' | 'error';

function ConnectStep({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const qc = useQueryClient();
  const initial = (target: Workspace['mbsStatus'][]): StepState => (target.includes(workspace.mbsStatus) ? 'done' : 'todo');
  const [states, setStates] = useState<StepState[]>([
    initial(['sandbox', 'sandbox_passed', 'live']),
    initial(['sandbox_passed', 'live']),
    initial(['live']),
  ]);
  const [error, setError] = useState<string>();
  const [testIrn, setTestIrn] = useState(workspace.mbsTestIrn);
  const running = states.includes('running');

  async function run() {
    setError(undefined);
    const base = `/v1/workspaces/${workspace.id}/mbs`;
    const steps: [number, () => Promise<unknown>][] = [
      [0, () => api.post(`${base}/connect`)],
      [
        1,
        async () => {
          const r = await api.post<{ passed: boolean; irn?: string; errors?: string[] }>(`${base}/test`);
          if (!r.passed) throw new Error('The sandbox rejected the test invoice. Check your business details and try again.');
          setTestIrn(r.irn ?? null);
        },
      ],
      [2, () => api.post(`${base}/go-live`)],
    ];
    for (const [i, fn] of steps) {
      if (states[i] === 'done') continue;
      setStates((s) => s.map((v, j) => (j === i ? 'running' : v)));
      try {
        await fn();
        setStates((s) => s.map((v, j) => (j === i ? 'done' : v)));
      } catch (err) {
        setStates((s) => s.map((v, j) => (j === i ? 'error' : v)));
        setError(err instanceof ApiError ? err.detail : (err as Error).message);
        return;
      }
    }
    await qc.invalidateQueries({ queryKey: ['ws', workspace.id] });
    await qc.invalidateQueries({ queryKey: ['me'] });
    onDone();
  }

  const items = [
    { title: 'Link your business to MBS', body: 'Through our accredited Access Point Provider. No technical setup for you.' },
    { title: 'Clear a test invoice in the sandbox', body: testIrn ? `Test IRN ${testIrn}` : 'Proves the connection works end to end.' },
    { title: 'Go live', body: 'Real invoices you submit are cleared by NRS.' },
  ];

  return (
    <Card className="p-5 sm:p-6">
      <h1 className="text-xl font-semibold">Connect to NRS</h1>
      <p className="mt-1 text-sm text-muted">Three automatic steps. It usually takes under a minute.</p>
      <ol className="mt-6 space-y-4">
        {items.map((it, i) => (
          <li key={it.title} className="flex gap-3">
            <span className="mt-0.5" aria-hidden>
              {states[i] === 'done' ? (
                <Check className="size-5 rounded-full bg-brand-600 p-0.5 text-white" />
              ) : states[i] === 'running' ? (
                <Loader2 className="size-5 animate-spin text-brand-700" />
              ) : (
                <CircleDashed className={cn('size-5', states[i] === 'error' ? 'text-red-600' : 'text-slate-300')} />
              )}
            </span>
            <div>
              <p className="font-medium">
                {it.title} <span className="sr-only">— {states[i]}</span>
              </p>
              <p className="text-sm text-muted">{it.body}</p>
            </div>
          </li>
        ))}
      </ol>
      {error && (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      )}
      <div className="mt-6 flex justify-end">
        <Button onClick={run} loading={running} disabled={!workspace.tinVerified}>
          {states.some((s) => s === 'error') ? 'Try again' : 'Connect now'}
        </Button>
      </div>
    </Card>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Onboarding />
    </Suspense>
  );
}
