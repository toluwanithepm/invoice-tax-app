'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';

function TwoFactor() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.post('/v1/auth/2fa/verify', { code: code.trim() });
      await qc.invalidateQueries();
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Two-step verification" subtitle="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field id="totp" label="Code" error={error}>
          <Input autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="text-center font-mono text-lg tracking-widest" />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={code.trim().length < 6}>
          Continue
        </Button>
      </form>
    </AuthShell>
  );
}

export default function TwoFactorPage() {
  return (
    <Suspense>
      <TwoFactor />
    </Suspense>
  );
}
