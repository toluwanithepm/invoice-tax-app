'use client';
import { useState } from 'react';
import { isValidTin, normaliseTin } from '@einv/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { InfoTip } from '@/components/ui/help';
import { Alert } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { Customer } from '@/lib/types';

/** E2-1: customer with a validated Tax ID; duplicate Tax IDs are flagged before saving. */
export function CustomerForm({ ws, customer, onSaved, onCancel }: { ws: string; customer?: Customer; onSaved: (c: Customer) => void; onCancel?: () => void }) {
  const [v, setV] = useState({
    name: customer?.name ?? '',
    kind: customer?.kind ?? 'B2B',
    tin: customer?.tin ?? '',
    email: customer?.email ?? '',
    phone: customer?.phone ?? '',
    address: customer?.address ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string>();
  const [duplicate, setDuplicate] = useState<Customer | null>(null);
  const [registry, setRegistry] = useState<{ found: boolean; legalName?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function checkTin() {
    const tin = normaliseTin(v.tin);
    if (!isValidTin(tin)) return setRegistry(null);
    try {
      setRegistry(await api.get<{ found: boolean; legalName?: string }>(`/v1/workspaces/${ws}/tin-lookup/${tin}`));
    } catch {
      setRegistry(null);
    }
  }

  async function save(allowDuplicate = false) {
    setErrors({});
    setGeneral(undefined);
    setBusy(true);
    const body = { ...v, email: v.email || null, phone: v.phone || null, address: v.address || null };
    try {
      const c = customer
        ? await api.put<Customer>(`/v1/workspaces/${ws}/customers/${customer.id}`, body)
        : await api.post<Customer>(`/v1/workspaces/${ws}/customers${allowDuplicate ? '?allowDuplicate=true' : ''}`, body);
      onSaved(c);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DUPLICATE_CUSTOMER') setDuplicate(err.body.existing as Customer);
      else if (err instanceof ApiError && err.errors.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.field ?? '', x.message])));
      else setGeneral(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const mismatch = registry?.legalName && v.name && registry.legalName.toLowerCase().replace(/\W/g, '') !== v.name.toLowerCase().replace(/\W/g, '');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-4"
      noValidate
    >
      <Field id="c-name" label="Customer name" error={errors.name}>
        <Input value={v.name} onChange={set('name')} autoFocus autoComplete="organization" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="c-tin" label="Tax ID (TIN)" help={<InfoTip term="tin" />} error={errors.tin} hint="We check it with NRS as you type">
          <Input value={v.tin} onChange={set('tin')} onBlur={checkTin} placeholder="12345678-0001" inputMode="numeric" />
        </Field>
        <Field id="c-kind" label="Customer type" help={<InfoTip title="Business or government?">Choose B2B for companies and B2G for ministries or agencies. Both need the customer's Tax ID. For sales to ordinary consumers, use Retail sales instead.</InfoTip>} error={errors.kind}>
          <Select value={v.kind} onChange={set('kind')}>
            <option value="B2B">Business (B2B)</option>
            <option value="B2G">Government (B2G)</option>
          </Select>
        </Field>
      </div>
      {registry && !registry.found && <Alert tone="warning">NRS has no record of this Tax ID. Invoices to this customer will be rejected.</Alert>}
      {mismatch && (
        <Alert
          tone="warning"
          action={
            <Button type="button" size="sm" variant="secondary" onClick={() => setV((s) => ({ ...s, name: registry!.legalName! }))}>
              Use it
            </Button>
          }
        >
          NRS has this Tax ID registered to <strong>{registry!.legalName}</strong>.
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="c-email" label="Email" hint="For sending invoices" error={errors.email}>
          <Input value={v.email} onChange={set('email')} type="email" />
        </Field>
        <Field id="c-phone" label="Phone" hint="For WhatsApp" error={errors.phone}>
          <Input value={v.phone} onChange={set('phone')} type="tel" />
        </Field>
      </div>
      <Field id="c-address" label="Address" error={errors.address}>
        <Input value={v.address} onChange={set('address')} />
      </Field>
      {duplicate && (
        <Alert
          tone="warning"
          title="Possible duplicate"
          action={
            <Button type="button" size="sm" variant="secondary" onClick={() => save(true)} loading={busy}>
              Save anyway
            </Button>
          }
        >
          You already have <strong>{duplicate.name}</strong> with this Tax ID. Save only if this is a different branch.
        </Alert>
      )}
      {general && <Alert tone="error">{general}</Alert>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={busy}>
          {customer ? 'Save changes' : 'Add customer'}
        </Button>
      </div>
    </form>
  );
}
