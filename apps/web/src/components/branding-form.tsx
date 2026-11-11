'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ImageUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Alert } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { Workspace } from '@/lib/types';

/** E1-4: logo, contact, bank details and terms that appear on every invoice. */
export function BrandingForm({
  workspace,
  onSaved,
  submitLabel = 'Save',
  secondary,
}: {
  workspace: Workspace;
  onSaved?: (w: Workspace) => void;
  submitLabel?: string;
  secondary?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    tradingName: workspace.tradingName ?? '',
    address: workspace.address ?? '',
    email: workspace.email ?? '',
    phone: workspace.phone ?? '',
    bankName: workspace.bankName ?? '',
    bankAccountNumber: workspace.bankAccountNumber ?? '',
    bankAccountName: workspace.bankAccountName ?? workspace.legalName,
    invoiceTerms: workspace.invoiceTerms ?? 'Payment due within 30 days of the invoice date.',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);
  const [hasLogo, setHasLogo] = useState(workspace.hasLogo);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function uploadLogo(file: File) {
    const fd = new FormData();
    fd.append('logo', file);
    try {
      await api.upload(`/v1/workspaces/${workspace.id}/logo`, fd, 'PUT');
      setHasLogo(true);
      setLogoVersion((n) => n + 1);
      toast.success('Logo updated');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setGeneral(undefined);
    setBusy(true);
    const nullIfEmpty = (s: string) => (s.trim() ? s.trim() : null);
    try {
      const w = await api.patch<Workspace>(`/v1/workspaces/${workspace.id}`, {
        tradingName: nullIfEmpty(v.tradingName),
        address: nullIfEmpty(v.address),
        email: nullIfEmpty(v.email),
        phone: nullIfEmpty(v.phone),
        bankName: nullIfEmpty(v.bankName),
        bankAccountNumber: nullIfEmpty(v.bankAccountNumber.replace(/\s/g, '')),
        bankAccountName: nullIfEmpty(v.bankAccountName),
        invoiceTerms: nullIfEmpty(v.invoiceTerms),
      });
      qc.setQueryData(['ws', w.id], (old: Workspace | undefined) => ({ ...old, ...w, bankAccountNumber: v.bankAccountNumber || null }));
      onSaved?.(w);
      if (!onSaved) toast.success('Saved');
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.field ?? '', x.message])));
      else setGeneral(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="flex items-center gap-4">
        <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed border-line bg-canvas">
          {hasLogo ? (
            <img src={`/api/v1/workspaces/${workspace.id}/logo?v=${logoVersion}`} alt="Business logo" className="size-full object-contain" />
          ) : (
            <ImageUp className="size-6 text-subtle" aria-hidden />
          )}
        </div>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="sr-only"
            id="logo"
            onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])}
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            {hasLogo ? 'Change logo' : 'Upload logo'}
          </Button>
          <p className="mt-1 text-xs text-subtle">PNG or JPEG, under 300 KB.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="tradingName" label="Trading name" hint="If different from your registered name" error={errors.tradingName}>
          <Input value={v.tradingName} onChange={set('tradingName')} />
        </Field>
        <Field id="phone" label="Business phone" error={errors.phone}>
          <Input value={v.phone} onChange={set('phone')} type="tel" placeholder="0803 123 4567" />
        </Field>
        <Field id="email" label="Business email" error={errors.email}>
          <Input value={v.email} onChange={set('email')} type="email" />
        </Field>
        <Field id="address" label="Address" error={errors.address}>
          <Input value={v.address} onChange={set('address')} />
        </Field>
      </div>

      <fieldset className="rounded-lg border border-line p-4">
        <legend className="px-1 text-sm font-medium">Where buyers should pay</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="bankName" label="Bank" error={errors.bankName}>
            <Input value={v.bankName} onChange={set('bankName')} placeholder="e.g. GTBank" />
          </Field>
          <Field id="bankAccountNumber" label="Account number" error={errors.bankAccountNumber}>
            <Input value={v.bankAccountNumber} onChange={set('bankAccountNumber')} inputMode="numeric" maxLength={10} placeholder="10 digits" />
          </Field>
          <Field id="bankAccountName" label="Account name" error={errors.bankAccountName}>
            <Input value={v.bankAccountName} onChange={set('bankAccountName')} />
          </Field>
        </div>
        <p className="mt-2 text-xs text-subtle">Stored encrypted. Shown on your invoices so buyers can pay you.</p>
      </fieldset>

      <Field id="invoiceTerms" label="Invoice terms" error={errors.invoiceTerms}>
        <Textarea value={v.invoiceTerms} onChange={set('invoiceTerms')} rows={3} />
      </Field>

      {general && <Alert tone="error">{general}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        {secondary}
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
