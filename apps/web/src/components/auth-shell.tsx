import Link from 'next/link';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/components/marketing';

/** Links home: signed-in people land in their workspace, everyone else on the product page. */
export function Logo({ className = '', href = '/' }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={className} aria-label="E-Invoice home">
      <BrandMark />
    </Link>
  );
}

/** Sign-in, sign-up, 2FA and invitations: the form, plus (on large screens) a reminder of the value. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,1.05fr)]">
      <main id="main" className="flex flex-col px-4 py-8 sm:px-8">
        <Logo />
        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
          <h1 className="text-[28px] font-semibold leading-9">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-sm text-muted">{footer}</div>}
        </div>
        <p className="text-xs text-subtle">
          We process your data under the Nigeria Data Protection Act 2023 · DPO: dpo@einvoice.ng ·{' '}
          <Link href="/help" className="underline">
            Help
          </Link>
        </p>
      </main>
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-brand-800 via-brand-900 to-[#06281a] p-12 text-white lg:flex lg:flex-col lg:justify-center">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-brand-600/30 blur-3xl" aria-hidden />
        <div className="relative max-w-md">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold ring-1 ring-white/20">
            <ShieldCheck className="size-3.5" aria-hidden /> NRS e-invoicing, handled
          </span>
          <p className="mt-6 text-3xl font-semibold leading-tight tracking-tight">Create an invoice. NRS approves it. Your customer gets it on WhatsApp.</p>
          <ul className="mt-8 space-y-3 text-sm text-brand-50">
            {['About 10 minutes to your first approved invoice', 'Mistakes caught before NRS sees them', 'Your VAT return adds itself up', 'Bring your accountant along'].map((t) => (
              <li key={t} className="flex items-center gap-3">
                <CheckCircle2 className="size-5 shrink-0 text-brand-300" aria-hidden /> {t}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
