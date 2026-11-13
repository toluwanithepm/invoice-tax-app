'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Alert } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';

type Channel = 'email' | 'sms';

/**
 * E1-1: passwordless sign-in / sign-up with a one-time code by email or SMS.
 * The same component serves /login and /signup (signup also collects name + consent).
 */
export function OtpFlow({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [channel, setChannel] = useState<Channel>('email');
  const [identifier, setIdentifier] = useState(params.get('id') ?? '');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [challenge, setChallenge] = useState<{ id: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsAccount, setNeedsAccount] = useState(false);

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (mode === 'signup' && !consent) return setError({ field: 'consent', message: 'Accept the privacy notice to create your account.' });
    setBusy(true);
    try {
      const r = await api.post<{ challengeId: string; devCode?: string }>('/v1/auth/otp/request', {
        channel,
        identifier,
        ...(mode === 'signup' ? { name, consent } : {}),
      });
      setChallenge({ id: r.challengeId, devCode: r.devCode });
      setCode('');
    } catch (err) {
      setError({ field: err instanceof ApiError ? (err.errors[0]?.field ?? undefined) ?? undefined : undefined, message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ isNew: boolean; mfaRequired: boolean }>('/v1/auth/otp/verify', { challengeId: challenge.id, code });
      await qc.invalidateQueries();
      const next = params.get('next');
      const hasNext = !!next && next.startsWith('/') && !next.startsWith('//');
      const safeNext = hasNext ? next! : '/';
      router.replace(r.mfaRequired ? `/2fa?next=${encodeURIComponent(safeNext)}` : hasNext ? safeNext : r.isNew ? '/onboarding' : '/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONSENT_REQUIRED') {
        setNeedsAccount(true);
        setChallenge(null);
      } else {
        setError({ field: 'code', message: errorMessage(err) });
      }
    } finally {
      setBusy(false);
    }
  }

  if (needsAccount) {
    return (
      <Alert tone="info" title="No account yet">
        There's no account for {identifier}.{' '}
        <Link
          className="font-medium underline"
          href={`/signup?id=${encodeURIComponent(identifier)}${params.get('next') ? `&next=${encodeURIComponent(params.get('next')!)}` : ''}`}
        >
          Create one
        </Link>{' '}
        — it takes two minutes.
      </Alert>
    );
  }

  if (challenge) {
    return (
      <form onSubmit={verify} className="space-y-4" noValidate>
        <p className="text-sm text-muted">
          We sent a 6-digit code to <span className="font-medium text-ink">{identifier}</span>. It expires in 5 minutes.
        </p>
        {challenge.devCode && (
          <Alert tone="warning" title="Development mode">
            Your code is <span className="font-mono font-semibold">{challenge.devCode}</span>
          </Alert>
        )}
        <Field id="code" label="Code" error={error?.field === 'code' ? error.message : undefined}>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="text-center font-mono text-lg tracking-[0.5em]"
          />
        </Field>
        {error && error.field !== 'code' && <Alert tone="error">{error.message}</Alert>}
        <Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>
          {mode === 'signup' ? 'Create account' : 'Sign in'}
        </Button>
        <div className="flex justify-between text-sm">
          <button type="button" className="text-muted hover:text-ink" onClick={() => setChallenge(null)}>
            Change {channel === 'email' ? 'email' : 'number'}
          </button>
          <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => requestCode()} disabled={busy}>
            Send a new code
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={requestCode} className="space-y-4" noValidate>
      <div role="tablist" aria-label="Sign in with" className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {(['email', 'sms'] as const).map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={channel === c}
            onClick={() => {
              setChannel(c);
              setIdentifier('');
              setError(null);
            }}
            className={`rounded-md py-1.5 font-medium ${channel === c ? 'bg-white' : 'text-muted'}`}
          >
            {c === 'email' ? 'Email' : 'Phone'}
          </button>
        ))}
      </div>
      {mode === 'signup' && (
        <Field id="name" label="Your name">
          <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
      )}
      <Field id="identifier" label={channel === 'email' ? 'Email address' : 'Mobile number'} error={error?.field === 'identifier' ? error.message : undefined}>
        <Input
          type={channel === 'email' ? 'email' : 'tel'}
          inputMode={channel === 'email' ? 'email' : 'tel'}
          autoComplete={channel === 'email' ? 'email' : 'tel'}
          placeholder={channel === 'email' ? 'you@business.ng' : '0803 123 4567'}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoFocus
          required
        />
      </Field>
      {mode === 'signup' && (
        <div>
          <Checkbox
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            label={
              <>
                I agree to the processing of my personal data as described in the <Link href="/privacy" target="_blank" rel="noopener" className="font-medium text-brand-700 underline underline-offset-2">
                  privacy notice
                </Link>.
              </>
            }
          />
          {error?.field === 'consent' && <p className="mt-1 text-xs font-medium text-red-600">{error.message}</p>}
        </div>
      )}
      {error && !['identifier', 'consent'].includes(error.field ?? '') && <Alert tone="error">{error.message}</Alert>}
      <Button type="submit" className="w-full" loading={busy} disabled={!identifier}>
        Send code
      </Button>
    </form>
  );
}
