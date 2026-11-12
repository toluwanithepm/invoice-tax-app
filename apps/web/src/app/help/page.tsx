'use client';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronDown, CircleHelp, ListChecks, Mail, PlayCircle, Route } from 'lucide-react';
import Link from 'next/link';
import { FaqList, HowItWorks, SiteFooter, SiteHeader } from '@/components/marketing';
import { StatusBadge } from '@/components/status';
import { openWelcomeTour, WelcomeTour } from '@/components/welcome-tour';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { GLOSSARY } from '@/lib/glossary';
import type { Me } from '@/lib/types';
import type { InvoiceStatus } from '@einv/shared';

const STATUS_HELP: { status: InvoiceStatus; meaning: string; todo: string }[] = [
  { status: 'draft', meaning: 'Saved, not sent to NRS yet.', todo: 'Finish it and press Submit to NRS.' },
  { status: 'pending_approval', meaning: 'Waiting for an owner or approver in your business to approve it.', todo: 'Approvers: open it and press Approve and submit.' },
  { status: 'submitting', meaning: 'We are sending it to NRS right now.', todo: 'Nothing — it usually takes a few seconds.' },
  { status: 'queued', meaning: "NRS isn't responding, so it's waiting safely in line.", todo: 'Nothing — we retry automatically for up to 72 hours.' },
  { status: 'cleared', meaning: 'NRS approved it. It has an IRN and QR stamp and is locked.', todo: 'Send it to your customer. Mark it paid when the money arrives.' },
  { status: 'rejected', meaning: 'NRS found a problem.', todo: 'Open it — we show exactly what to fix next to the field — then submit again.' },
  { status: 'failed', meaning: 'We could not reach NRS for 72 hours.', todo: 'Open it and submit again.' },
];

const GUIDES: { title: string; steps: string[] }[] = [
  {
    title: 'Send your first invoice',
    steps: [
      'Finish setup on Home: verify your Tax ID and connect to NRS (about a minute).',
      'Press New invoice. Choose a customer, or add one — we check their Tax ID with NRS.',
      'Add what you sold. Pick saved products to fill in the price and VAT automatically.',
      'Press Submit to NRS. Most invoices are approved in a few seconds.',
      'Press Send to customer to share it by WhatsApp, email or link.',
    ],
  },
  {
    title: 'Fix an invoice NRS rejected',
    steps: [
      'Open the invoice marked "Needs fixing".',
      'Read the list on the right — each problem is in plain English, and the field is highlighted.',
      'Make the change. Your draft saves automatically.',
      'Press Submit to NRS again. Earlier attempts stay in the history.',
    ],
  },
  {
    title: 'Correct an invoice that is already approved',
    steps: [
      'Approved invoices are locked by law, so you never edit them.',
      'Open the invoice and press Credit note to reduce it (returns, refunds, discounts) or Debit note to add to it (an under-charge).',
      'Give a short reason and the amount, then submit the note to NRS like an invoice.',
    ],
  },
  {
    title: 'Report retail (shop) sales',
    steps: [
      'Turn on Retail sales from the menu (owners and admins).',
      'Export the day’s sales from your till as CSV or Excel and upload it. We match the columns for you.',
      'Press Check rows to see any problems, then Import.',
      'Each day is sent to NRS automatically just after midnight. If you sold nothing, press No sales for that day.',
      'You will get an email and SMS 6 hours before a day’s deadline if anything is missing.',
    ],
  },
  {
    title: 'Prepare your monthly VAT return',
    steps: [
      'Open VAT & reports → VAT reconciliation and choose the month.',
      'Check "Not included" for drafts or rejected invoices you still need to finish.',
      'After filing, enter the VAT figure you filed — we show any difference.',
      'Download the Excel or PDF for your records or your accountant.',
    ],
  },
  {
    title: 'Work with your accountant',
    steps: [
      'Ask your accountant for their 8-character firm code.',
      'Go to Settings → Team → Accounting firm and enter it.',
      'They can now prepare invoices and reports for you. Turn on approvals in Settings → Security if you want to approve each invoice yourself.',
      'Remove their access any time from the same place.',
    ],
  },
  {
    title: 'Invite your team',
    steps: [
      'Go to Settings → Team and press Invite someone.',
      'Choose a role: Clerks prepare invoices, Approvers approve and send them, Viewers can only look.',
      'Every action is recorded in Settings → Activity log.',
    ],
  },
];

export default function HelpPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.peek<Me>('/v1/me'), retry: false });
  const signedIn = !!me.data;
  const firstWs = me.data?.workspaces[0]?.id;
  const appHref = firstWs ? `/w/${firstWs}` : me.data?.firms[0] ? `/f/${me.data.firms[0].id}` : '/signup';

  return (
    <div className="min-h-dvh">
      <SiteHeader signedIn={signedIn} appHref={appHref} />
      <main id="main" className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
        <p className="text-sm font-semibold text-brand-700">Help centre</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">How can we help?</h1>
        <p className="mt-3 max-w-2xl text-lg text-muted">Short guides, what every status means, and plain-English definitions of the tax words you’ll see.</p>

        <nav aria-label="On this page" className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { href: '#how', icon: Route, label: 'How it works' },
            { href: '#guides', icon: ListChecks, label: 'Step-by-step guides' },
            { href: '#glossary', icon: BookOpen, label: 'Glossary' },
            { href: '#faq', icon: CircleHelp, label: 'FAQ' },
          ].map((l) => (
            <a key={l.href} href={l.href} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4 font-medium transition-colors hover:border-brand-300">
              <span className="grid size-9 place-items-center rounded-xl bg-brand-50 text-brand-700">
                <l.icon className="size-[18px]" aria-hidden />
              </span>
              {l.label}
            </a>
          ))}
        </nav>

        {signedIn && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-900 p-5 text-white">
            <p className="text-[15px]">New here? Take the 30-second tour of how everything fits together.</p>
            <Button variant="secondary" onClick={openWelcomeTour}>
              <PlayCircle /> Replay the tour
            </Button>
          </div>
        )}

        <section id="how" className="mt-16 scroll-mt-24">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <p className="mt-2 max-w-2xl text-muted">
            Since 2026, every invoice one business sends another (or the government) must be approved by the Nigeria Revenue Service before it counts for tax. E-Invoice does the paperwork between you and NRS.
          </p>
          <div className="mt-6">
            <HowItWorks compact />
          </div>

          <h3 className="mt-12 text-lg font-semibold">What each invoice status means</h3>
          <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface">
            <table className="w-full text-left text-[15px]">
              <thead className="border-b border-line bg-slate-50/70 text-xs font-semibold text-subtle">
                <tr>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">What it means</th>
                  <th className="hidden px-5 py-3 md:table-cell">What to do</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {STATUS_HELP.map((s) => (
                  <tr key={s.status} className="align-top">
                    <td className="px-5 py-3.5">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-5 py-3.5 text-muted">
                      {s.meaning}
                      <span className="mt-1 block text-ink md:hidden">{s.todo}</span>
                    </td>
                    <td className="hidden px-5 py-3.5 md:table-cell">{s.todo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="guides" className="mt-16 scroll-mt-24">
          <h2 className="text-2xl font-semibold tracking-tight">Step-by-step guides</h2>
          <div className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {GUIDES.map((g) => (
              <details key={g.title} className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-medium hover:bg-slate-50 sm:px-6 [&::-webkit-details-marker]:hidden">
                  {g.title}
                  <ChevronDown className="size-4 shrink-0 text-subtle transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <ol className="space-y-2.5 px-5 pb-5 sm:px-6">
                  {g.steps.map((st, i) => (
                    <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-muted">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-800">{i + 1}</span>
                      {st}
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        </section>

        <section id="glossary" className="mt-16 scroll-mt-24">
          <h2 className="text-2xl font-semibold tracking-tight">Glossary</h2>
          <p className="mt-2 text-muted">The words you’ll see in the app, in plain English. Look for underlined words and the ⓘ icon in the app to see these where you need them.</p>
          <dl className="mt-6 grid gap-3 sm:grid-cols-2">
            {Object.entries(GLOSSARY).map(([k, g]) => (
              <div key={k} id={k} className="scroll-mt-24 rounded-xl border border-line bg-surface p-5 target:border-brand-400 target:ring-4 target:ring-brand-100">
                <dt className="font-semibold">{g.term}</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-muted">
                  {g.short}
                  {'long' in g && g.long && <span className="mt-2 block">{g.long}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="faq" className="mt-16 scroll-mt-24">
          <h2 className="text-2xl font-semibold tracking-tight">Frequently asked questions</h2>
          <div className="mt-6">
            <FaqList />
          </div>
        </section>

        <section className="mt-16 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-surface p-6">
          <div className="flex items-start gap-3">
            <Mail className="mt-0.5 size-5 text-brand-700" aria-hidden />
            <div>
              <p className="font-semibold">Still stuck?</p>
              <p className="text-[15px] text-muted">Email support@einvoice.ng — we reply within 2 business hours, and faster before VAT deadlines.</p>
            </div>
          </div>
          {signedIn ? (
            <Button asChild variant="secondary">
              <Link href={appHref}>Back to the app</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link href="/signup">Create an account</Link>
            </Button>
          )}
        </section>
      </main>
      <SiteFooter />
      {signedIn && <WelcomeTour />}
    </div>
  );
}
