import Link from 'next/link';
import { ReceiptText } from 'lucide-react';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2 font-semibold text-ink ${className}`}>
      <span className="grid size-8 place-items-center rounded-lg bg-brand-700 text-white">
        <ReceiptText className="size-4" aria-hidden />
      </span>
      E-Invoice
    </Link>
  );
}

/** Centered card layout for sign-in, sign-up, 2FA and invitations. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center">
      <Logo className="mb-8" />
      <div className="w-full max-w-sm rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
      <p className="mt-10 max-w-sm text-center text-xs text-subtle">
        We process your data under the Nigeria Data Protection Act 2023. Questions? Contact our Data Protection Officer at dpo@einvoice.ng.
      </p>
    </main>
  );
}
