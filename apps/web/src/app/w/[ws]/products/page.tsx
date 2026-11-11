'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { VAT_LABELS, VAT_TREATMENTS, type VatTreatment } from '@einv/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useRole, useWsId } from '@/lib/hooks';
import type { Page, Product } from '@/lib/types';
import { naira } from '@/lib/utils';

export default function ProductsPage() {
  const ws = useWsId();
  const { can } = useRole();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const list = useQuery({ queryKey: ['products', ws], queryFn: () => api.get<Page<Product>>(`/v1/workspaces/${ws}/products?limit=100`) });

  return (
    <>
      <PageHeader
        title="Products and services"
        description="Each item carries its VAT treatment, so invoice totals are always right."
        actions={
          can('records.edit') && (
            <>
              <Button variant="secondary" asChild>
                <Link href={`/w/${ws}/import?kind=products`}>Import</Link>
              </Button>
              <Button onClick={() => setEditing('new')}>
                <Plus /> Add item
              </Button>
            </>
          )
        }
      />
      <Card>
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.items.length ? (
          <EmptyState icon={<Package />} title="No products yet" description="Add the things you sell, or import a spreadsheet." />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{p.name}</p>
                  <p className="text-sm text-muted">{[p.sku, p.description].filter(Boolean).join(' · ') || '—'}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={p.vatTreatment === 'standard' ? 'blue' : 'neutral'}>{VAT_LABELS[p.vatTreatment]}</Badge>
                  <span className="tabular font-medium">{naira(p.unitPrice)}</span>
                  {can('records.edit') && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add a product or service' : 'Edit item'}>
        {editing && (
          <ProductForm
            ws={ws}
            product={editing === 'new' ? undefined : editing}
            onDone={() => {
              setEditing(null);
              void qc.invalidateQueries({ queryKey: ['products', ws] });
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function ProductForm({ ws, product, onDone }: { ws: string; product?: Product; onDone: () => void }) {
  const [v, setV] = useState({
    name: product?.name ?? '',
    sku: product?.sku ?? '',
    description: product?.description ?? '',
    unitPrice: product ? String(product.unitPrice) : '',
    vatTreatment: (product?.vatTreatment ?? '') as VatTreatment | '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body = { ...v, unitPrice: v.unitPrice.replace(/[,\s₦]/g, ''), sku: v.sku || null, description: v.description || null, vatTreatment: v.vatTreatment || undefined };
    try {
      if (product) await api.put(`/v1/workspaces/${ws}/products/${product.id}`, body);
      else await api.post(`/v1/workspaces/${ws}/products`, body);
      toast.success('Saved');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.field ?? '', x.message])));
      else setGeneral(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field id="p-name" label="Name" error={errors.name}>
        <Input value={v.name} onChange={set('name')} autoFocus />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="p-price" label="Unit price (₦, before VAT)" error={errors.unitPrice}>
          <Input value={v.unitPrice} onChange={set('unitPrice')} inputMode="decimal" />
        </Field>
        <Field id="p-vat" label="VAT treatment" error={errors.vatTreatment}>
          <Select value={v.vatTreatment} onChange={set('vatTreatment')}>
            <option value="">Choose…</option>
            {VAT_TREATMENTS.map((t) => (
              <option key={t} value={t}>
                {VAT_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="p-sku" label="Code / SKU" error={errors.sku}>
          <Input value={v.sku} onChange={set('sku')} />
        </Field>
        <Field id="p-desc" label="Description" error={errors.description}>
          <Input value={v.description} onChange={set('description')} />
        </Field>
      </div>
      {general && <Alert tone="error">{general}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
