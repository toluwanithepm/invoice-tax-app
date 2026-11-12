'use client';
import { ChevronDown, FilePlus2, MessageCircle, ReceiptText, ShieldCheck, BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { FAQ } from '@/lib/faq';
import { cn } from '@/lib/utils';

export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight text-ink', className)}>
      <span className="grid size-8 place-items-center rounded-lg bg-brand-700 text-white">
        <ReceiptText className="size-4" aria-hidden />
      </span>
      E-Invoice
    </span>
  );
}

export function SiteHeader({ signedIn, appHref }: { signedIn: boolean; appHref: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/" aria-label="E-Invoice home">
          <BrandMark />
        </Link>
        <nav aria-label="Site" className="hidden items-center gap-7 text-sm font-medium text-muted md:flex">
          <Link href="/#how" className="hover:text-ink">
            How it works
          </Link>
          <Link href="/#accountants" className="hover:text-ink">
            For accountants
          </Link>
          <Link href="/help" className="hover:text-ink">
            Help
          </Link>
          <Link href="/#faq" className="hover:text-ink">
            FAQ
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          {signedIn ? (
            <Button asChild size="sm">
              <Link href={appHref}>Open the app</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/signup">Get started</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm text-muted sm:grid-cols-3 sm:px-6">
        <div>
          <BrandMark />
          <p className="mt-3 max-w-xs">NRS-approved invoices for Nigerian businesses and their accountants.</p>
        </div>
        <div className="space-y-2">
          <p className="font-semibold text-ink">Product</p>
          <Link href="/#how" className="block hover:text-ink">
            How it works
          </Link>
          <Link href="/help" className="block hover:text-ink">
            Help centre & glossary
          </Link>
          <Link href="/signup" className="block hover:text-ink">
            Create an account
          </Link>
        </div>
        <div className="space-y-2">
          <p className="font-semibold text-ink">Privacy</p>
          <p>We process personal data under the Nigeria Data Protection Act 2023.</p>
          <p>Data Protection Officer: dpo@einvoice.ng</p>
        </div>
      </div>
    </footer>
  );
}

export const STEPS = [
  { icon: FilePlus2, title: 'Create an invoice', body: 'Pick a customer and add what you sold. VAT is worked out for you.' },
  { icon: ShieldCheck, title: 'NRS approves it', body: 'We check for mistakes, then NRS stamps it with an IRN and QR code — usually in seconds.' },
  { icon: MessageCircle, title: 'Send it, get paid', body: 'Share on WhatsApp, by email or link. Your customer gets a clean page and PDF.' },
  { icon: BarChart3, title: 'VAT return, done', body: 'Approved invoices add up automatically into your monthly VAT figures.' },
];

export function HowItWorks({ compact = false }: { compact?: boolean }) {
  return (
    <ol className={cn('grid gap-4', compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-4')}>
      {STEPS.map((s, i) => (
        <li key={s.title} className="relative rounded-xl border border-line bg-surface p-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-700">
              <s.icon className="size-5" aria-hidden />
            </span>
            <span className="text-xs font-semibold text-subtle">Step {i + 1}</span>
          </div>
          <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">{s.body}</p>
        </li>
      ))}
    </ol>
  );
}

export function FaqList({ items = FAQ }: { items?: typeof FAQ }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {items.map((f) => (
        <details key={f.q} className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-medium hover:bg-slate-50 sm:px-6 [&::-webkit-details-marker]:hidden">
            {f.q}
            <ChevronDown className="size-4 shrink-0 text-subtle transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <p className="px-5 pb-5 text-[15px] leading-relaxed text-muted sm:px-6">{f.a}</p>
        </details>
      ))}
    </div>
  );
}

/** Illustrative invoice showing the NRS approval stamp (decorative; numbers are examples). */
export function InvoiceMock() {
  return (
    <div className="relative mx-auto w-full max-w-md" aria-hidden>
      <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-gradient-to-br from-brand-100 via-brand-50 to-transparent blur-2xl" />
      <div className="rotate-[1.5deg] rounded-xl border border-line bg-surface p-5 shadow-pop">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold">Amaka Foods Ltd</p>
            <p className="text-xs text-subtle">TIN 12345678-0001</p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold text-subtle">Invoice</p>
            <p className="text-sm font-semibold">INV-000128</p>
          </div>
        </div>
        <div className="mt-4 space-y-2 border-y border-line py-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted">Rice 50kg × 10</span>
            <span className="tabular">₦450,000.00</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Delivery</span>
            <span className="tabular">₦15,000.00</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">VAT (7.5%)</span>
            <span className="tabular">₦34,875.00</span>
          </div>
        </div>
        <div className="mt-3 flex items-end justify-between">
          <div>
            <p className="text-xs text-subtle">Total</p>
            <p className="tabular text-2xl font-semibold tracking-tight">₦499,875.00</p>
          </div>
          <div className="grid size-16 grid-cols-5 gap-0.5 rounded-md border border-line p-1.5">
            {Array.from({ length: 25 }, (_, i) => (
              <span key={i} className={cn('rounded-[1px]', [0, 1, 2, 4, 5, 6, 10, 12, 14, 16, 18, 19, 20, 22, 24, 8, 13].includes(i) ? 'bg-ink' : 'bg-transparent')} />
            ))}
          </div>
        </div>
      </div>
      <div className="absolute -bottom-12 left-2 flex -rotate-3 items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 shadow-pop sm:-left-6">
        <ShieldCheck className="size-5 text-brand-700" />
        <div>
          <p className="text-xs font-semibold text-brand-900">Approved by NRS</p>
          <p className="font-mono text-[10px] text-brand-800">IRN INV000128-7F3A21C9-20261112</p>
        </div>
      </div>
    </div>
  );
}
