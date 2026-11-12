'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Alert } from '@/components/ui/layout';
import { useBilling, useRole, useWsId } from '@/lib/hooks';
import { shortDate } from '@/lib/utils';

const daysLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : 0);

/**
 * At most one plan message at a time, most urgent first, and only when it needs action
 * (E10-1 trial ending, E10-2 payment due, E10-3 80% of the allowance used).
 */
export function PlanBanner() {
  const wsId = useWsId();
  const pathname = usePathname();
  const { data: b } = useBilling();
  const { can } = useRole();
  if (!b || pathname.startsWith(`/w/${wsId}/billing`)) return null;

  const action = can('billing.manage') ? (
    <Link href={`/w/${wsId}/billing`} className="shrink-0 self-center text-sm font-semibold underline underline-offset-4">
      {b.status === 'past_due' || b.status === 'lapsed' ? 'Pay now' : 'See plans'}
    </Link>
  ) : undefined;
  const ask = can('billing.manage') ? '' : ' Ask an owner or admin to update the plan.';

  if (b.block) {
    return (
      <Alert tone="error" className="mx-auto mb-6 max-w-6xl" title="Sending to NRS is paused" action={action}>
        {b.block.message}
        {ask}
      </Alert>
    );
  }
  if (b.status === 'past_due') {
    return (
      <Alert tone="warning" className="mx-auto mb-6 max-w-6xl" title="Payment due" action={action}>
        Your plan payment didn't go through. Sending keeps working until {shortDate(b.graceEndsAt)}.{ask}
      </Alert>
    );
  }
  if (b.status === 'trialing' && daysLeft(b.trialEndsAt) <= 3) {
    const d = daysLeft(b.trialEndsAt);
    return (
      <Alert tone="info" className="mx-auto mb-6 max-w-6xl" title={d <= 1 ? 'Your free trial ends today' : `Your free trial ends in ${d} days`} action={action}>
        Choose a plan to keep sending invoices to NRS without a break.{ask}
      </Alert>
    );
  }
  if (b.usage.warn && b.usage.limit !== null) {
    return (
      <Alert tone="info" className="mx-auto mb-6 max-w-6xl" title={`${b.usage.limit - b.usage.used} invoices left ${b.plan === 'trial' ? 'in your trial' : 'this month'}`} action={action}>
        You've sent {b.usage.used} of {b.usage.limit}. Upgrade before you run out so sending never pauses.{ask}
      </Alert>
    );
  }
  return null;
}
