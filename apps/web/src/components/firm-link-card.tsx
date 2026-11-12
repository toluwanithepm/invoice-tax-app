'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/form';
import { InfoTip } from '@/components/ui/help';
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
          <form onSubmit={connect} noValidate>
            <Label htmlFor="firm-code">
              Firm code <InfoTip term="firmCode" />
            </Label>
            <div className="flex gap-2">
              <Input
                id="firm-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={8}
                aria-invalid={!!error || undefined}
                aria-describedby="firm-code-msg"
                className="w-44 font-mono tracking-widest"
              />
              <Button type="submit" loading={busy} disabled={code.length !== 8}>
                Give access
              </Button>
            </div>
            <p id="firm-code-msg" role={error ? 'alert' : undefined} className={error ? 'mt-1.5 text-[13px] font-medium text-red-600' : 'mt-1.5 text-[13px] text-subtle'}>
              {error ?? '8 letters or numbers, from your accountant.'}
            </p>
          </form>
        ) : (
          <p className="text-sm text-muted">No accounting firm is linked.</p>
        )}
      </CardBody>
    </Card>
  );
}
