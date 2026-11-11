import Link from 'next/link';
import { Suspense } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { OtpFlow } from '@/components/otp-flow';

export const metadata = { title: 'Sign in' };

export default function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  return (
    <AuthShell
      title="Sign in"
      subtitle="We'll send you a one-time code. No password needed."
      footer={
        <>
          New here?{' '}
          <Link href="/signup" className="font-medium text-brand-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <Expired searchParams={searchParams} />
      <Suspense>
        <OtpFlow mode="login" />
      </Suspense>
    </AuthShell>
  );
}

async function Expired({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  if (!expired) return null;
  return <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">You were signed out after 30 minutes without activity.</p>;
}
