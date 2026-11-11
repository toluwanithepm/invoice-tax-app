'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Briefcase } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';

/** Start an accounting firm (E6-1). Sends existing firm members to their dashboard. */
export default function FirmSetupPage() {
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (me.data?.firms[0]) router.replace(`/f/${me.data.firms[0].id}`);
  }, [me.data, router]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const f = await api.post<{ id: string }>('/v1/firms', { name });
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace(`/f/${f.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (me.isLoading || me.data?.firms[0]) return <Spinner />;
  return (
    <AuthShell title="Set up your accounting firm" subtitle="Manage every client's e-invoicing and VAT from one login.">
      <form onSubmit={create} className="space-y-4" noValidate>
        <div className="flex items-center gap-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-900">
          <Briefcase className="size-5 shrink-0" aria-hidden />
          You'll get a dashboard of all your clients and a code clients can use to give you access.
        </div>
        <Field id="firm-name" label="Firm name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bello & Co Chartered Accountants" autoFocus />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" className="w-full" loading={busy} disabled={name.trim().length < 2}>
          Create firm
        </Button>
      </form>
    </AuthShell>
  );
}
