'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader, Spinner } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useWsId } from '@/lib/hooks';
import type { AuditEvent, Page } from '@/lib/types';
import { dateTime } from '@/lib/utils';

const LABELS: Record<string, string> = {
  'workspace.created': 'Created the workspace',
  'workspace.updated': 'Updated business settings',
  'workspace.tin_verified': 'Checked the Tax ID with NRS',
  'workspace.logo_updated': 'Changed the logo',
  'mbs.connected': 'Connected to MBS',
  'mbs.sandbox_test_passed': 'Cleared a sandbox test invoice',
  'mbs.live': 'Went live on MBS',
  'invoice.created': 'Created an invoice',
  'invoice.updated': 'Edited an invoice',
  'invoice.deleted': 'Deleted a draft',
  'invoice.submitted': 'Submitted an invoice to NRS',
  'invoice.approval_requested': 'Sent an invoice for approval',
  'invoice.approved_and_submitted': 'Approved and submitted an invoice',
  'invoice.approval_declined': 'Sent an invoice back',
  'invoice.cleared': 'Invoice cleared by NRS',
  'invoice.rejected': 'Invoice rejected by NRS',
  'invoice.queued': 'NRS unavailable — invoice queued',
  'invoice.failed': 'Invoice failed after 72 hours',
  'invoice.shared': 'Shared an invoice',
  'invoice.share_revoked': 'Withdrew a share link',
  'credit_note.created': 'Raised a credit note',
  'debit_note.created': 'Raised a debit note',
  'customer.created': 'Added a customer',
  'customer.updated': 'Edited a customer',
  'customer.archived': 'Archived a customer',
  'product.created': 'Added a product',
  'product.updated': 'Edited a product',
  'product.archived': 'Archived a product',
  'member.invited': 'Invited someone',
  'member.joined': 'Joined the workspace',
  'member.role_changed': 'Changed a role',
  'member.removed': 'Removed someone',
  'member.invitation_revoked': 'Cancelled an invitation',
  'import.customers': 'Imported customers',
  'import.products': 'Imported products',
};

// Lowercase only the first letter so acronyms (NRS, MBS) survive.
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** E9-2: append-only log of who did what, when. */
export default function AuditPage() {
  const ws = useWsId();
  const q = useInfiniteQuery({
    queryKey: ['audit', ws],
    initialPageParam: '',
    queryFn: ({ pageParam }) => api.get<Page<AuditEvent>>(`/v1/workspaces/${ws}/audit?limit=50${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title="Audit log" description="Every change and submission, with who did it and when. Records can't be edited or deleted." />
      <Card>
        {q.isLoading ? (
          <Spinner />
        ) : !items.length ? (
          <EmptyState icon={<History />} title="Nothing recorded yet" />
        ) : (
          <ol className="divide-y divide-line">
            {items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{e.actorName ?? 'System'}</span> <span className="text-muted">{lowerFirst(LABELS[e.action] ?? e.action)}</span>
                  {e.entity === 'invoice' && e.entityId && (
                    <>
                      {' '}
                      <Link href={`/w/${ws}/invoices/${e.entityId}`} className="text-brand-700 hover:underline">
                        open
                      </Link>
                    </>
                  )}
                  {typeof e.detail?.irn === 'string' && <span className="ml-1 font-mono text-xs text-subtle">IRN {e.detail.irn}</span>}
                </div>
                <time className="shrink-0 text-xs text-subtle" dateTime={e.createdAt}>
                  {dateTime(e.createdAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
        {q.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <Button variant="ghost" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
              Load older
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
