'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Alert, Badge, Card, CardBody, CardHeader } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';

/** TOTP two-step verification setup, shown in Settings and on the account page. */
export function TwoFactorCard({ onEnabled }: { onEnabled?: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const [setup, setSetup] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    try {
      setSetup(await api.post<{ qrDataUrl: string; secret: string }>('/v1/auth/2fa/setup'));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  async function enable() {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/v1/auth/2fa/enable', { code });
      setRecovery(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await qc.invalidateQueries({ queryKey: ['me'] });
      onEnabled?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    const c = prompt('Enter a code from your authenticator app to turn two-step verification off');
    if (!c) return;
    try {
      await api.post('/v1/auth/2fa/disable', { code: c });
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Two-step verification is off');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader title="Two-step verification" description="Adds an authenticator-app code after your one-time code." />
      <CardBody className="space-y-4">
        {me.data?.twoFactorEnabled && !recovery ? (
          <div className="flex items-center justify-between">
            <Badge tone="green">On</Badge>
            <Button variant="secondary" size="sm" onClick={disable}>
              Turn off
            </Button>
          </div>
        ) : setup ? (
          <div className="space-y-3">
            <p className="text-sm">Scan this with Google Authenticator, Microsoft Authenticator or similar, then enter the 6-digit code.</p>
            <img src={setup.qrDataUrl} alt="QR code for your authenticator app" className="size-44 rounded-lg border border-line" />
            <p className="break-all text-xs text-subtle">Can't scan? Enter this key: {setup.secret}</p>
            <div className="flex gap-2">
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" inputMode="numeric" maxLength={6} aria-label="Authenticator code" />
              <Button onClick={enable} loading={busy} disabled={code.length !== 6}>
                Turn on
              </Button>
            </div>
          </div>
        ) : (
          !recovery && <Button onClick={start}>Set up two-step verification</Button>
        )}
        {recovery && (
          <Alert tone="warning" title="Save your recovery codes">
            <p>Each works once if you lose your phone. We won't show them again.</p>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">
              {recovery.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}
