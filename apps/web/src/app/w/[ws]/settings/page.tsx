'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { ROLE_LABELS, ROLES, type Role } from '@einv/shared';
import { BrandingForm } from '@/components/branding-form';
import { TwoFactorCard } from '@/components/two-factor-card';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { Alert, Badge, Card, CardBody, CardHeader, PageHeader, Spinner } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useMe, useRole, useWorkspace, useWsId } from '@/lib/hooks';
import type { Workspace } from '@/lib/types';
import { cn, shortDate } from '@/lib/utils';

const TABS = [
  { key: 'business', label: 'Business' },
  { key: 'branding', label: 'Invoice details' },
  { key: 'members', label: 'Team' },
  { key: 'security', label: 'Security' },
] as const;

function Settings() {
  const ws = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get('tab') ?? 'business') as (typeof TABS)[number]['key'];
  const { can } = useRole();
  if (!ws.data) return <Spinner />;
  return (
    <>
      <PageHeader title="Settings" />
      <div role="tablist" aria-label="Settings sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => router.replace(`?tab=${t.key}`)}
            className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium', tab === t.key ? 'border-brand-700 text-brand-800' : 'border-transparent text-muted hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'business' && <BusinessTab ws={ws.data} canManage={can('workspace.manage')} />}
      {tab === 'branding' &&
        (can('workspace.manage') ? (
          <Card>
            <CardBody>
              <BrandingForm workspace={ws.data} />
            </CardBody>
          </Card>
        ) : (
          <Alert>Only owners, admins and accountants can change invoice details.</Alert>
        ))}
      {tab === 'members' && <MembersTab />}
      {tab === 'security' && <SecurityTab ws={ws.data} canManage={can('workspace.manage')} />}
    </>
  );
}

function BusinessTab({ ws, canManage }: { ws: Workspace; canManage: boolean }) {
  const qc = useQueryClient();
  const [legalName, setLegalName] = useState(ws.legalName);
  const [turnover, setTurnover] = useState(ws.turnover ? String(ws.turnover) : '');
  const [prefix, setPrefix] = useState(ws.invoicePrefix);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const w = await api.patch<Workspace>(`/v1/workspaces/${ws.id}`, {
        legalName,
        turnover: turnover ? Number(turnover.replace(/[,\s₦]/g, '')) : null,
        invoicePrefix: prefix,
      });
      qc.setQueryData(['ws', ws.id], (old: Workspace | undefined) => ({ ...old, ...w }));
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Saved');
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.field ?? '', x.message])));
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    try {
      const r = await api.post<{ workspace: Workspace; message: string; found: boolean }>(`/v1/workspaces/${ws.id}/tin/verify`);
      qc.setQueryData(['ws', ws.id], r.workspace);
      (r.found ? toast.success : toast.error)(r.message);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Business details" />
        <CardBody>
          <form onSubmit={save} className="space-y-4" noValidate>
            <Field id="legalName" label="Registered name" error={errors.legalName}>
              <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} disabled={!canManage} />
            </Field>
            <Field id="turnover" label="Annual turnover (₦)" error={errors.turnover}>
              <Input value={turnover} onChange={(e) => setTurnover(e.target.value)} inputMode="numeric" disabled={!canManage} />
            </Field>
            <Field id="prefix" label="Invoice number prefix" hint={`Next invoice looks like ${prefix || 'INV'}-000001`} error={errors.invoicePrefix}>
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} maxLength={6} disabled={!canManage} />
            </Field>
            {canManage && (
              <div className="flex justify-end">
                <Button type="submit" loading={busy}>
                  Save
                </Button>
              </div>
            )}
          </form>
        </CardBody>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader title="Tax ID" action={canManage && <Button size="sm" variant="secondary" onClick={verify}>Check with NRS</Button>} />
          <CardBody className="space-y-2 text-sm">
            <p className="font-mono">{ws.tin}</p>
            {ws.tinVerified ? <Badge tone="green">Verified with NRS</Badge> : <Badge tone="red">Not verified</Badge>}
            {ws.nameMismatch && (
              <Alert tone="warning">
                NRS has this Tax ID registered to <strong>{ws.registryName}</strong>.
              </Alert>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="NRS connection" />
          <CardBody className="space-y-2 text-sm">
            <Badge tone={ws.mbsStatus === 'live' ? 'green' : 'amber'}>{ws.mbsStatus === 'live' ? 'Live' : ws.mbsStatus === 'not_connected' ? 'Not connected' : 'Sandbox'}</Badge>
            {ws.mbsTestIrn && <p className="text-muted">Sandbox test IRN: {ws.mbsTestIrn}</p>}
            {ws.taxBand && (
              <p className="text-muted">
                {ws.taxBand.band} · e-invoicing from {shortDate(ws.taxBand.goLive)}
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

interface MembersResponse {
  members: { userId: string; name: string | null; email: string | null; phone: string | null; role: Role; twoFactorEnabled: boolean }[];
  invitations: { id: string; email: string; role: Role; expiresAt: string }[];
}

function MembersTab() {
  const ws = useWsId();
  const me = useMe();
  const { can, role: myRole } = useRole();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['members', ws], queryFn: () => api.get<MembersResponse>(`/v1/workspaces/${ws}/members`) });
  const [inviting, setInviting] = useState(false);
  const manage = can('members.manage');
  const reload = () => qc.invalidateQueries({ queryKey: ['members', ws] });

  async function changeRole(userId: string, role: Role) {
    try {
      await api.patch(`/v1/workspaces/${ws}/members/${userId}`, { role });
      toast.success('Role updated');
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
      void reload();
    }
  }
  async function remove(userId: string) {
    if (!confirm('Remove this person from the workspace?')) return;
    try {
      await api.del(`/v1/workspaces/${ws}/members/${userId}`);
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  async function revoke(id: string) {
    await api.del(`/v1/workspaces/${ws}/invitations/${id}`).catch((e) => toast.error(errorMessage(e)));
    void reload();
  }

  if (list.isLoading) return <Spinner />;
  return (
    <Card>
      <CardHeader title="Team" description="Only the right people can submit invoices. Every action is recorded in the audit log." action={manage && <Button size="sm" onClick={() => setInviting(true)}>Invite someone</Button>} />
      <ul className="divide-y divide-line">
        {list.data?.members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <p className="font-medium">
                {m.name ?? m.email ?? m.phone} {m.userId === me.data?.id && <span className="text-xs text-subtle">(you)</span>}
              </p>
              <p className="text-sm text-muted">
                {m.email ?? m.phone} {m.twoFactorEnabled && <Badge tone="green" className="ml-1">2-step on</Badge>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {manage && m.userId !== me.data?.id ? (
                <>
                  <Select aria-label={`Role for ${m.name ?? m.email}`} value={m.role} onChange={(e) => changeRole(m.userId, e.target.value as Role)} className="h-9 w-44">
                    {ROLES.filter((r) => r !== 'owner' || myRole === 'owner').map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                  <Button variant="ghost" size="sm" onClick={() => remove(m.userId)}>
                    Remove
                  </Button>
                </>
              ) : (
                <Badge>{ROLE_LABELS[m.role]}</Badge>
              )}
            </div>
          </li>
        ))}
        {list.data?.invitations.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 bg-slate-50/60 px-5 py-3">
            <div>
              <p className="font-medium">{i.email}</p>
              <p className="text-sm text-muted">
                Invited as {ROLE_LABELS[i.role]} · expires {shortDate(i.expiresAt)}
              </p>
            </div>
            {manage && (
              <Button variant="ghost" size="sm" onClick={() => revoke(i.id)}>
                Cancel invite
              </Button>
            )}
          </li>
        ))}
      </ul>
      {inviting && <InviteDialog onClose={() => setInviting(false)} onDone={() => { setInviting(false); void reload(); }} />}
    </Card>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const ws = useWsId();
  const { role: myRole } = useRole();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('clerk');
  const [error, setError] = useState<string>();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function invite() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<{ inviteUrl: string }>(`/v1/workspaces/${ws}/invitations`, { email, role });
      setLink(r.inviteUrl);
      toast.success(`Invitation sent to ${email}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && (link ? onDone() : onClose())}
      title="Invite someone"
      footer={
        link ? (
          <Button onClick={onDone}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={invite} loading={busy} disabled={!email}>
              Send invitation
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="space-y-2 text-sm">
          <p>We emailed the invitation. You can also share this link with them (valid 7 days, only for {email}):</p>
          <Input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
        </div>
      ) : (
        <div className="space-y-4">
          <Field id="inv-email" label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field id="inv-role" label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.filter((r) => r !== 'owner' || myRole === 'owner').map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <ul className="space-y-1 rounded-lg bg-canvas p-3 text-xs text-muted">
            <li><strong>Clerk</strong> prepares invoices; can't submit them.</li>
            <li><strong>Approver</strong> approves and submits invoices.</li>
            <li><strong>Accountant</strong> runs compliance across the business.</li>
            <li><strong>Viewer</strong> can only look.</li>
          </ul>
          {error && <Alert tone="error">{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

function SecurityTab({ ws, canManage }: { ws: Workspace; canManage: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();

  async function patch(body: Partial<Workspace>) {
    try {
      const w = await api.patch<Workspace>(`/v1/workspaces/${ws.id}`, body);
      qc.setQueryData(['ws', ws.id], (old: Workspace | undefined) => ({ ...old, ...w }));
      toast.success('Saved');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  async function exportData() {
    const data = await api.get('/v1/me/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: 'my-data.json' }).click();
    URL.revokeObjectURL(url);
  }
  async function requestDeletion() {
    if (!confirm('Ask us to delete your personal data? Tax records must be kept by law, so your name is removed from them instead.')) return;
    const r = await api.post<{ message: string }>('/v1/me/deletion-request');
    toast.success(r.message);
  }
  async function logoutAll() {
    await api.post('/v1/auth/logout-all');
    qc.clear();
    router.replace('/login');
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <TwoFactorCard />

      {canManage && (
        <Card>
          <CardHeader title="Workspace rules" />
          <CardBody className="space-y-4">
            <Checkbox
              checked={ws.approvalRequired}
              onChange={(e) => patch({ approvalRequired: e.target.checked })}
              label={
                <>
                  <span className="font-medium">Require approval before invoices go to NRS</span>
                  <span className="block text-xs text-muted">Clerks and accountants send invoices to an owner or approver first.</span>
                </>
              }
            />
            <Checkbox
              checked={ws.require2fa}
              onChange={(e) => patch({ require2fa: e.target.checked })}
              label={
                <>
                  <span className="font-medium">Require two-step verification for owners, admins and accountants</span>
                  <span className="block text-xs text-muted">They'll be asked to set it up before they can open this workspace.</span>
                </>
              }
            />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Your data and sessions" />
        <CardBody className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={exportData}>
            Download my data
          </Button>
          <Button variant="secondary" onClick={requestDeletion}>
            Request deletion
          </Button>
          <Button variant="secondary" onClick={logoutAll}>
            Sign out everywhere
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Settings />
    </Suspense>
  );
}
