import { CheckCircle2, Clock, FileEdit, RotateCw, ShieldAlert, XCircle } from 'lucide-react';
import { STATUS_LABELS, type InvoiceStatus } from '@einv/shared';
import { Badge } from '@/components/ui/layout';

const TONES: Record<InvoiceStatus, { tone: 'neutral' | 'green' | 'amber' | 'red' | 'blue'; Icon: React.ElementType }> = {
  draft: { tone: 'neutral', Icon: FileEdit },
  pending_approval: { tone: 'blue', Icon: Clock },
  submitting: { tone: 'blue', Icon: RotateCw },
  queued: { tone: 'amber', Icon: RotateCw },
  cleared: { tone: 'green', Icon: CheckCircle2 },
  rejected: { tone: 'red', Icon: XCircle },
  failed: { tone: 'red', Icon: ShieldAlert },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const { tone, Icon } = TONES[status] ?? TONES.draft;
  return (
    <Badge tone={tone}>
      <Icon className="size-3" aria-hidden />
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
