'use client';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Briefcase, CalendarClock, CheckCircle2, Lock, MessageSquareText, Smartphone, Store } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { FaqList, HowItWorks, InvoiceMock, SiteFooter, SiteHeader } from '@/components/marketing';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/layout';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';

/** Where a signed-in person should land. */
function appHome(me: Me) {
  const first = me.workspaces.find((w) => !w.viaFirmId) ?? null;
  const firm = me.firms[0];
  if (!first && firm) return `/f/${firm.id}`;
  if (!first) return '/onboarding';
  if (first.mbsStatus !== 'live' && ['owner', 'admin', 'accountant'].includes(first.role)) return `/onboarding?ws=${first.id}`;
  return `/w/${first.id}`;
}

function Landing() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.peek<Me>('/v1/me'), retry: false });
  const signedIn = !!me.data;

  // Signed-in people go straight to work, unless they deliberately opened the home page (?home).
  useEffect(() => {
    if (me.data && !params.has('home')) router.replace(appHome(me.data));
  }, [me.data, params, router]);

  if (me.isLoading || (me.data && !params.has('home'))) return <Spinner label="Opening your workspace" />;
  const appHref = me.data ? appHome(me.data) : '/signup';

  return (
    <div className="min-h-dvh">
      <SiteHeader signedIn={signedIn} appHref={appHref} />
      <main id="main">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-12 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-20">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800">
              <CalendarClock className="size-3.5" aria-hidden /> E-invoicing is now law in Nigeria
            </p>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-[-0.02em] sm:text-5xl lg:text-[56px]">
              Invoices NRS approves <span className="text-brand-700">in seconds.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
              Create an invoice, we send it to the Nigeria Revenue Service, and your customer gets it on WhatsApp — with the IRN and QR stamp they need. No ERP, no IT team.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link href={appHref}>
                  {signedIn ? 'Open the app' : 'Start free — 14 days'} <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link href="#how">See how it works</Link>
              </Button>
            </div>
            <ul className="mt-8 grid gap-2 text-sm text-muted sm:grid-cols-2">
              {['First approved invoice in about 10 minutes', 'Plain English — no tax codes', 'Works on any phone', 'Your accountant can join you'].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 shrink-0 text-brand-600" aria-hidden /> {t}
                </li>
              ))}
            </ul>
          </div>
          <InvoiceMock />
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-20 border-t border-line bg-surface py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <p className="text-sm font-semibold text-brand-700">How it works</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight">Four steps, and the tax part is handled for you</h2>
            <p className="mt-3 max-w-2xl text-muted">Since 2026, business invoices must be checked and approved by NRS before they count for tax. Here is what that looks like with E-Invoice.</p>
            <div className="mt-10">
              <HowItWorks />
            </div>
          </div>
        </section>

        {/* Who it's for */}
        <section id="accountants" className="scroll-mt-20 py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="max-w-2xl text-3xl font-semibold tracking-tight">Built for the people who actually do the invoicing</h2>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {[
                { icon: Store, title: 'Business owners', body: 'Get paid faster by large buyers who now require NRS-approved invoices. Track who owes you and what VAT you owe.' },
                { icon: MessageSquareText, title: 'Finance staff', body: 'Save customers and products once, fix rejected invoices with clear instructions, and upload daily till sales in one go.' },
                { icon: Briefcase, title: 'Accountants', body: 'One login for every client, a dashboard of who needs attention, and VAT reports that match the return.' },
              ].map((c) => (
                <div key={c.title} className="rounded-xl border border-line bg-surface p-6">
                  <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-700">
                    <c.icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-lg font-semibold">{c.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted">{c.body}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="flex items-start gap-3 rounded-xl bg-brand-900 p-6 text-white">
                <Smartphone className="mt-0.5 size-5 shrink-0 text-brand-200" aria-hidden />
                <p className="text-[15px] leading-relaxed text-brand-50">Designed for phones first, and light enough to work on a slow connection.</p>
              </div>
              <div className="flex items-start gap-3 rounded-xl bg-brand-900 p-6 text-white">
                <Lock className="mt-0.5 size-5 shrink-0 text-brand-200" aria-hidden />
                <p className="text-[15px] leading-relaxed text-brand-50">Encrypted, private to your business, and compliant with the Nigeria Data Protection Act 2023.</p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-20 border-t border-line bg-surface py-20">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.6fr]">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">Questions, answered</h2>
              <p className="mt-3 text-muted">
                New to e-invoicing? Start here. There’s more in the{' '}
                <Link href="/help" className="font-medium text-brand-700 hover:underline">
                  Help centre
                </Link>
                .
              </p>
            </div>
            <FaqList />
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-20">
          <div className="mx-auto max-w-4xl px-4 text-center sm:px-6">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Be ready before your deadline</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted">Set up takes about ten minutes. Your first 14 days are free.</p>
            <Button asChild size="lg" className="mt-8">
              <Link href={appHref}>
                {signedIn ? 'Open the app' : 'Create your account'} <ArrowRight />
              </Link>
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <Landing />
    </Suspense>
  );
}
