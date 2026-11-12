import { AlertTriangle, CheckCircle2, Clock, FileEdit, Loader2, RotateCw, UserCheck } from 'lucide-react';
import { STATUS_LABELS, type InvoiceStatus } from '@einv/shared';
import { Badge } from '@/components/ui/layout';

/** Status is never colour alone: each has an icon and a plain-language label. */
const TONES: Record<InvoiceStatus, { tone: 'neutral' | 'green' | 'amber' | 'red' | 'blue'; Icon: React.ElementType; spin?: boolean }> = {
  draft: { tone: 'neutral', Icon: FileEdit },
  pending_approval: { tone: 'blue', Icon: UserCheck },
  submitting: { tone: 'blue', Icon: Loader2, spin: true },
  queued: { tone: 'amber', Icon: Clock },
  cleared: { tone: 'green', Icon: CheckCircle2 },
  rejected: { tone: 'red', Icon: AlertTriangle },
  failed: { tone: 'red', Icon: RotateCw },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const { tone, Icon, spin } = TONES[status] ?? TONES.draft;
  return (
    <Badge tone={tone}>
      <Icon className={spin ? 'size-3 animate-spin' : 'size-3'} aria-hidden />
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Where an invoice is in its journey: Draft → Checked by NRS → Sent → Paid. */
export const JOURNEY = ['Draft', 'NRS approved', 'Sent', 'Paid'];
export function journeyStep(status: InvoiceStatus, opts: { shared?: boolean; paid?: boolean }) {
  if (status !== 'cleared') return 0;
  if (opts.paid) return 4;
  return opts.shared ? 3 : 2;
}
