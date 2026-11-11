import Link from 'next/link';
import { Suspense } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { OtpFlow } from '@/components/otp-flow';

export const metadata = { title: 'Create your account' };

export default function SignupPage() {
  return (
    <AuthShell
      title="Create your account"
      subtitle="Issue your first NRS-cleared invoice in about 10 minutes."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <Suspense>
        <OtpFlow mode="signup" />
      </Suspense>
    </AuthShell>
  );
}
