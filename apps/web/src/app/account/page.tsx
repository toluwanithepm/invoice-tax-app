'use client';
import Link from 'next/link';
import { Logo } from '@/components/auth-shell';
import { TwoFactorCard } from '@/components/two-factor-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/layout';
import { useMe } from '@/lib/hooks';

/** Account-level security, reachable even when a workspace blocks entry until 2FA is on. */
export default function AccountPage() {
  const me = useMe();
  return (
    <main id="main" className="mx-auto max-w-xl space-y-6 px-4 py-8">
      <Logo />
      {!me.data?.twoFactorEnabled && (
        <Alert tone="info" title="Two-step verification required">
          A workspace you belong to requires two-step verification for your role. Turn it on to continue.
        </Alert>
      )}
      <TwoFactorCard />
      {me.data?.twoFactorEnabled && (
        <Button asChild>
          <Link href="/">Continue to my workspace</Link>
        </Button>
      )}
    </main>
  );
}
