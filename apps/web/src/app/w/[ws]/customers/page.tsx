'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CustomerForm } from '@/components/customer-form';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useRole, useWsId } from '@/lib/hooks';
import type { Customer, Page } from '@/lib/types';

export default function CustomersPage() {
  const ws = useWsId();
  const { can } = useRole();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery({
    queryKey: ['customers', ws, debounced],
    queryFn: () => api.get<Page<Customer>>(`/v1/workspaces/${ws}/customers?limit=100${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`),
  });

  async function archive(c: Customer) {
    if (!confirm(`Archive ${c.name}? Existing invoices are not affected.`)) return;
    try {
      await api.del(`/v1/workspaces/${ws}/customers/${c.id}`);
      void qc.invalidateQueries({ queryKey: ['customers', ws] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Customers"
        description="Saved with their Tax IDs so you never retype them."
        actions={
          can('records.edit') && (
            <>
              <Button variant="secondary" asChild>
                <Link href={`/w/${ws}/import?kind=customers`}>Import</Link>
              </Button>
              <Button onClick={() => setEditing('new')}>
                <UserPlus /> Add customer
              </Button>
            </>
          )
        }
      />
      <div className="relative mb-4 sm:w-72">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input aria-label="Search customers" placeholder="Name or Tax ID" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
      </div>
      <Card>
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.items.length ? (
          <EmptyState icon={<Users />} title={debounced ? 'No customers match' : 'No customers yet'} description="Add customers one by one or import a spreadsheet." />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {c.name} <Badge className="ml-1">{c.kind}</Badge>
                  </p>
                  <p className="text-sm text-muted">
                    TIN {c.tin}
                    {c.email ? ` · ${c.email}` : ''}
                    {c.phone ? ` · ${c.phone}` : ''}
                  </p>
                </div>
                {can('records.edit') && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => archive(c)}>
                      Archive
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add a customer' : 'Edit customer'}>
        {editing && (
          <CustomerForm
            ws={ws}
            customer={editing === 'new' ? undefined : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void qc.invalidateQueries({ queryKey: ['customers', ws] });
              toast.success('Customer saved');
            }}
          />
        )}
      </Dialog>
    </>
  );
}
