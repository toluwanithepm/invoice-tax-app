'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';

export default function FirmInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ['firm-invite', token],
    queryFn: () => api.get<{ firmName: string; role: string; email: string }>(`/v1/firm-invitations/${token}`),
  });

  async function accept() {
    setBusy(true);
    try {
      const r = await api.post<{ firmId: string }>(`/v1/firm-invitations/${token}/accept`);
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace(`/f/${r.firmId}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Join an accounting firm">
      {preview.isLoading && <Spinner />}
      {preview.error && <Alert tone="error">{errorMessage(preview.error)}</Alert>}
      {preview.data && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            You've been invited to <span className="font-medium text-ink">{preview.data.firmName}</span> as{' '}
            <span className="font-medium text-ink">{preview.data.role === 'admin' ? 'an admin' : 'an accountant'}</span>. You'll be able to work on all the firm's clients.
          </p>
          {error && <Alert tone="error">{error}</Alert>}
          <Button className="w-full" onClick={accept} loading={busy}>
            Accept invitation
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
