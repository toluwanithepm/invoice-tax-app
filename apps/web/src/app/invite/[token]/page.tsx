'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ROLE_LABELS, type Role } from '@einv/shared';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<{ workspaceName: string; role: Role; email: string }>(`/v1/invitations/${token}`),
  });

  async function accept() {
    setBusy(true);
    try {
      const r = await api.post<{ workspaceId: string }>(`/v1/invitations/${token}/accept`);
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace(`/w/${r.workspaceId}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Join a workspace">
      {preview.isLoading && <Spinner />}
      {preview.error && <Alert tone="error">{errorMessage(preview.error)}</Alert>}
      {preview.data && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            You've been invited to <span className="font-medium text-ink">{preview.data.workspaceName}</span> as{' '}
            <span className="font-medium text-ink">{ROLE_LABELS[preview.data.role]}</span>.
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
