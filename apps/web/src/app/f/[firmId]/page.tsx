'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Copy, LogOut, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Logo } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Spinner } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { cn, naira, shortDate } from '@/lib/utils';

interface Firm {
  id: string;
  name: string;
  role: 'admin' | 'accountant';
  connectCode: string;
  members: { userId: string; role: string; name: string | null; email: string | null }[];
  invitations: { id: string; email: string; role: string; expiresAt: string }[];
  billing: { clients: number; perClientPrice: number; monthlyTotal: number };
}
interface Dashboard {
  today: string;
  nextVatDue: string;
  totals: { clients: number; needsAttention: number; awaitingApproval: number; outputVatThisMonth: number };
  clients: {
    workspaceId: string;
    name: string;
    tin: string;
    mbsStatus: string;
    b2cEnabled: boolean;
    drafts: number;
    awaitingApproval: number;
    inProgress: number;
    needsFixing: number;
    clearedThisMonth: number;
    outputVatThisMonth: number;
    b2cMissingDays: number;
    attention: number;
    planName: string;
    planStatus: 'trialing' | 'trial_ended' | 'active' | 'past_due' | 'lapsed';
    planStatusLabel: string;
    planEndsAt: string | null;
  }[];
}

/** E6-1 / E6-2 / E6-4: the accountant's home — every client's compliance status in one place. */
export default function FirmPage() {
  const { firmId } = useParams<{ firmId: string }>();
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const firm = useQuery({ queryKey: ['firm', firmId], queryFn: () => api.get<Firm>(`/v1/firms/${firmId}`) });
  const dash = useQuery({ queryKey: ['firm-dash', firmId], queryFn: () => api.get<Dashboard>(`/v1/firms/${firmId}/dashboard`) });
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);

  async function logout() {
    await api.post('/v1/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }

  if (firm.isLoading) return <Spinner />;
  if (firm.error || !firm.data) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="error">{errorMessage(firm.error)}</Alert>
      </div>
    );
  }
  const f = firm.data;
  const d = dash.data;
  const ownBusinesses = me.data?.workspaces.filter((w) => !w.viaFirmId) ?? [];

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b border-line bg-white px-4 py-3 sm:px-8">
        <div className="flex items-center gap-4">
          <Logo />
          <span className="hidden text-sm text-muted sm:inline">/ {f.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {ownBusinesses[0] && (
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/w/${ownBusinesses[0].id}`}>My business</Link>
            </Button>
          )}
          <button onClick={logout} className="rounded-md p-2 text-subtle hover:bg-slate-100 hover:text-ink" aria-label="Sign out" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
        <PageHeader
          title={f.name}
          description={d ? `${d.totals.clients} clients · next VAT returns due ${shortDate(d.nextVatDue)}` : undefined}
          actions={
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add client
            </Button>
          }
        />

        <div className="grid gap-4 sm:grid-cols-4">
          <Stat label="Clients" value={d?.totals.clients} />
          <Stat label="Need attention" value={d?.totals.needsAttention} warn={!!d?.totals.needsAttention} />
          <Stat label="Waiting for client approval" value={d?.totals.awaitingApproval} />
          <Stat label="Output VAT this month" value={d ? naira(d.totals.outputVatThisMonth) : undefined} />
        </div>

        <Card className="mt-6">
          <CardHeader title="Clients" description="Sorted by what needs attention first. Click a client to work in their books." />
          {dash.isLoading ? (
            <Spinner />
          ) : !d?.clients.length ? (
            <EmptyState
              title="No clients yet"
              description={`Add a client, or give clients your firm code (${f.connectCode}) so they can link their existing account.`}
              action={<Button onClick={() => setAdding(true)}>Add your first client</Button>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-left text-xs text-subtle">
                  <tr>
                    <th className="px-5 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 font-medium">NRS</th>
                    <th className="px-3 py-2 font-medium">Plan</th>
                    <th className="px-3 py-2 text-right font-medium">Pending</th>
                    <th className="px-3 py-2 text-right font-medium">Rejected</th>
                    <th className="px-3 py-2 text-right font-medium">B2C missing</th>
                    <th className="px-3 py-2 text-right font-medium">VAT this month</th>
                    <th className="px-5 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.clients.map((c) => (
                    <tr key={c.workspaceId} className={cn(c.attention > 0 && 'bg-amber-50/40')}>
                      <td className="px-5 py-3">
                        <p className="font-medium">
                          {c.attention > 0 && <AlertTriangle className="mr-1.5 inline size-4 text-amber-600" aria-label="Needs attention" />}
                          {c.name}
                        </p>
                        <p className="text-xs text-subtle">TIN {c.tin}</p>
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={c.mbsStatus === 'live' ? 'green' : 'amber'}>{c.mbsStatus === 'live' ? 'Live' : 'Not live'}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <span className="block whitespace-nowrap">{c.planName}</span>
                        <span className={cn('text-xs', c.planStatus === 'active' || c.planStatus === 'trialing' ? 'text-subtle' : 'font-medium text-red-700')}>
                          {c.planStatus === 'active' || c.planStatus === 'trialing' ? `until ${shortDate(c.planEndsAt)}` : c.planStatusLabel}
                        </span>
                      </td>
                      <td className="tabular px-3 py-3 text-right">
                        {c.drafts + c.awaitingApproval + c.inProgress || '—'}
                        {c.awaitingApproval > 0 && <span className="block text-xs text-subtle">{c.awaitingApproval} to approve</span>}
                      </td>
                      <td className={cn('tabular px-3 py-3 text-right', c.needsFixing > 0 && 'font-semibold text-red-700')}>{c.needsFixing || '—'}</td>
                      <td className={cn('tabular px-3 py-3 text-right', c.b2cMissingDays > 0 && 'font-semibold text-red-700')}>
                        {c.b2cEnabled ? c.b2cMissingDays || '—' : <span className="text-subtle">off</span>}
                      </td>
                      <td className="tabular px-3 py-3 text-right">{naira(c.outputVatThisMonth)}</td>
                      <td className="px-5 py-3 text-right">
                        <Button size="sm" variant="secondary" asChild>
                          <Link href={`/w/${c.workspaceId}`}>
                            Open <ArrowRight />
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card>
            <CardHeader title="Firm code" description="Clients already using E-Invoice enter this in Settings → Accounting firm to give you access." />
            <CardBody className="flex items-center gap-3">
              <span className="rounded-lg bg-canvas px-3 py-2 font-mono text-lg tracking-widest">{f.connectCode}</span>
              <Button variant="ghost" size="icon" aria-label="Copy firm code" onClick={() => navigator.clipboard?.writeText(f.connectCode).then(() => toast.success('Copied'))}>
                <Copy />
              </Button>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Firm plan" description="One monthly bill for all your clients." />
            <CardBody className="space-y-1 text-sm">
              <p>
                {f.billing.clients} clients × {naira(f.billing.perClientPrice)}
              </p>
              <p className="tabular text-xl font-semibold">{naira(f.billing.monthlyTotal)} / month</p>
              <p className="text-xs text-subtle">Online payment is coming soon. You won't be charged yet.</p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Team" action={f.role === 'admin' && <Button size="sm" variant="secondary" onClick={() => setInviting(true)}>Invite</Button>} />
            <ul className="divide-y divide-line text-sm">
              {f.members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between px-5 py-2.5">
                  <span className="min-w-0 truncate">{m.name ?? m.email}</span>
                  <Badge>{m.role === 'admin' ? 'Admin' : 'Accountant'}</Badge>
                </li>
              ))}
              {f.invitations.map((i) => (
                <li key={i.id} className="flex items-center justify-between px-5 py-2.5 text-muted">
                  <span className="truncate">{i.email}</span>
                  <span className="text-xs">invited</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </main>

      {adding && (
        <AddClientDialog
          firmId={firmId}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ['firm-dash', firmId] });
            void qc.invalidateQueries({ queryKey: ['firm', firmId] });
            void qc.invalidateQueries({ queryKey: ['me'] });
          }}
        />
      )}
      {inviting && (
        <InviteDialog
          firmId={firmId}
          onClose={() => setInviting(false)}
          onDone={() => {
            setInviting(false);
            void qc.invalidateQueries({ queryKey: ['firm', firmId] });
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number | string | undefined; warn?: boolean }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-sm text-muted">{label}</p>
      <p className={cn('tabular mt-1 text-2xl font-semibold', warn && 'text-amber-700')}>{value ?? '—'}</p>
    </Card>
  );
}

function AddClientDialog({ firmId, onClose, onDone }: { firmId: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ legalName: '', tin: '', turnover: '', ownerEmail: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  async function submit() {
    setBusy(true);
    setErrors({});
    setGeneral(undefined);
    try {
      const r = await api.post<{ workspace: { tinVerified: boolean }; invitation: { email: string } | null }>(`/v1/firms/${firmId}/clients`, {
        legalName: v.legalName,
        tin: v.tin,
        turnover: v.turnover ? Number(v.turnover.replace(/[,\s₦]/g, '')) : null,
        ownerEmail: v.ownerEmail || null,
      });
      toast.success(r.invitation ? `Client added. Invitation sent to ${r.invitation.email}.` : 'Client added');
      if (!r.workspace.tinVerified) toast.warning("We couldn't verify that Tax ID with NRS. Check it before connecting the client.");
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.field ?? '', x.message])));
      else setGeneral(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a client"
      description="We check the Tax ID with NRS. You'll work in the client's books as their accountant."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!v.legalName || !v.tin}>
            Add client
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="c-legal" label="Registered business name" error={errors.legalName}>
          <Input value={v.legalName} onChange={set('legalName')} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="c-tin" label="Tax ID (TIN)" error={errors.tin}>
            <Input value={v.tin} onChange={set('tin')} placeholder="12345678-0001" />
          </Field>
          <Field id="c-turnover" label="Annual turnover (₦)" error={errors.turnover}>
            <Input value={v.turnover} onChange={set('turnover')} inputMode="numeric" />
          </Field>
        </div>
        <Field id="c-owner" label="Business owner's email" hint="Optional. We'll invite them as the owner so they can approve invoices." error={errors.ownerEmail}>
          <Input value={v.ownerEmail} onChange={set('ownerEmail')} type="email" />
        </Field>
        {general && <Alert tone="error">{general}</Alert>}
      </div>
    </Dialog>
  );
}

function InviteDialog({ firmId, onClose, onDone }: { firmId: string; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'accountant' | 'admin'>('accountant');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api.post(`/v1/firms/${firmId}/invitations`, { email, role });
      toast.success(`Invitation sent to ${email}`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Invite a colleague"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!email}>
            Send invitation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="fi-email" label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field id="fi-role" label="Role" hint="Admins can invite and remove colleagues. Everyone can work on every client.">
          <Select value={role} onChange={(e) => setRole(e.target.value as 'accountant' | 'admin')}>
            <option value="accountant">Accountant</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}
