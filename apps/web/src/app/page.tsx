'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui/layout';
import { useMe } from '@/lib/hooks';

/** Sends people to the right place: sign-in, onboarding, or their first workspace. */
export default function Home() {
  const me = useMe();
  const router = useRouter();
  useEffect(() => {
    if (!me.data) return;
    const first = me.data.workspaces[0];
    if (!first) router.replace('/onboarding');
    else if (first.mbsStatus !== 'live' && ['owner', 'admin', 'accountant'].includes(first.role)) router.replace(`/onboarding?ws=${first.id}`);
    else router.replace(`/w/${first.id}`);
  }, [me.data, router]);
  return <Spinner label="Opening your workspace" />;
}
