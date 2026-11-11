'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Card, CardBody, CardHeader } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useRole, useWsId } from '@/lib/hooks';

/** Client side of E6: give an accounting firm access with its code, or take it away. */
export function FirmLinkCard() {
  const ws = useWsId();
  const { can } = useRole();
  const qc = useQueryClient();
  const linked = useQuery({ queryKey: ['linked-firm', ws], queryFn: () => api.get<{ firmId: string; firmName: string } | null>(`/v1/workspaces/${ws}/firm`) });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const manage = can('members.manage');

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<{ firmName: string }>(`/v1/workspaces/${ws}/firm/connect`, { code });
      toast.success(`${r.firmName} can now work in your books`);
      setCode('');
      void qc.invalidateQueries({ queryKey: ['linked-firm', ws] });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'No firm has that code. Check it with your accountant.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!confirm(`Remove ${linked.data?.firmName}'s access to this business?`)) return;
    await api.del(`/v1/workspaces/${ws}/firm`).catch((err) => toast.error(errorMessage(err)));
    void qc.invalidateQueries({ queryKey: ['linked-firm', ws] });
  }

  return (
    <Card className="mt-6">
      <CardHeader title="Accounting firm" description="Let your accountants manage invoices and VAT for this business. You can remove access at any time." />
      <CardBody>
        {linked.data ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p>
              <span className="font-medium">{linked.data.firmName}</span> has access as your accountant.
            </p>
            {manage && (
              <Button variant="secondary" size="sm" onClick={disconnect}>
                Remove access
              </Button>
            )}
          </div>
        ) : manage ? (
          <form onSubmit={connect} className="flex flex-wrap items-end gap-2" noValidate>
            <Field id="firm-code" label="Firm code" hint="8 letters or numbers, from your accountant." error={error} className="w-56">
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} className="font-mono tracking-widest" />
            </Field>
            <Button type="submit" loading={busy} disabled={code.length !== 8} className="mb-5">
              Give access
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted">No accounting firm is linked.</p>
        )}
      </CardBody>
    </Card>
  );
}
