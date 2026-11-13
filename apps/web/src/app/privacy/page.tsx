'use client';
import { useQuery } from '@tanstack/react-query';
import { SiteFooter, SiteHeader } from '@/components/marketing';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';

const UPDATED = '13 November 2026';

const SECTIONS: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: 'who',
    title: 'Who we are',
    body: (
      <p>
        E-Invoice helps Nigerian businesses issue invoices approved by the Nigeria Revenue Service (NRS) and keep their VAT records. For the personal data in your account we are the
        data controller. For the personal data inside your invoices (for example your customers' contact details) your business is the controller and we process it on your behalf.
        You can reach our Data Protection Officer at <a href="mailto:dpo@einvoice.ng">dpo@einvoice.ng</a>.
      </p>
    ),
  },
  {
    id: 'what',
    title: 'What we collect',
    body: (
      <ul>
        <li><strong>Account details:</strong> your name, email address or phone number, and sign-in records (time, device and IP address).</li>
        <li><strong>Business details:</strong> business name, Tax ID (TIN), address, logo, bank details for your invoices (account numbers are encrypted), and your team members' names and roles.</li>
        <li><strong>Invoice records:</strong> invoices, credit and debit notes, customers and products you enter or import, and NRS approval details (IRN and QR code).</li>
        <li><strong>Billing:</strong> your plan, payments and receipts. Card details are entered on our payment provider's page; we only keep the card type, last 4 digits and expiry.</li>
        <li><strong>Activity:</strong> an audit log of who created, changed, approved or sent each record.</li>
      </ul>
    ),
  },
  {
    id: 'why',
    title: 'Why we use it, and our lawful basis',
    body: (
      <ul>
        <li><strong>To provide the service you signed up for</strong> (contract): signing you in, sending your invoices to NRS, sharing them with your customers, producing VAT reports.</li>
        <li><strong>To meet legal duties</strong> (legal obligation): submitting invoices to NRS under Nigerian e-invoicing rules and keeping tax records for the period the law requires.</li>
        <li><strong>To keep accounts and payments safe</strong> (legitimate interest): fraud prevention, security monitoring, rate limits and the audit log.</li>
        <li><strong>Your consent</strong>, which you give when you create an account and can withdraw at any time, for processing that does not rely on the bases above.</li>
      </ul>
    ),
  },
  {
    id: 'sharing',
    title: 'Who we share it with',
    body: (
      <>
        <ul>
          <li><strong>NRS and our accredited Access Point Provider</strong>, to approve your invoices.</li>
          <li><strong>Your customers</strong>, when you share an invoice with them.</li>
          <li><strong>Your accountant</strong>, only if you link an accounting firm, and only until you remove its access.</li>
          <li><strong>Service providers</strong> who work for us under contract: hosting and database (Supabase, Vercel), payments (Paystack), and email and SMS delivery.</li>
        </ul>
        <p>We never sell your data or use it for advertising.</p>
      </>
    ),
  },
  {
    id: 'transfers',
    title: 'Where it is stored',
    body: (
      <p>
        Some of our providers store data outside Nigeria. When they do, we rely on the safeguards the Nigeria Data Protection Act 2023 requires, such as contractual commitments and
        adequacy decisions, and data is encrypted in transit and at rest.
      </p>
    ),
  },
  {
    id: 'retention',
    title: 'How long we keep it',
    body: (
      <ul>
        <li><strong>Invoices, notes and the audit log:</strong> at least 6 years, because tax law requires it. They cannot be deleted earlier, even at your request.</li>
        <li><strong>Account and team details:</strong> while your account is open. When you ask us to delete your personal data, we remove your name and contact details and keep the tax records without them.</li>
        <li><strong>Sign-in codes</strong> expire in 5 minutes; sign-in sessions end after 30 minutes without activity.</li>
      </ul>
    ),
  },
  {
    id: 'rights',
    title: 'Your rights',
    body: (
      <>
        <p>Under the Nigeria Data Protection Act 2023 you can:</p>
        <ul>
          <li>get a copy of your data (Settings → Security → <em>Download my data</em>),</li>
          <li>ask us to correct it,</li>
          <li>ask us to delete it (Settings → Security → <em>Request deletion</em>), subject to the tax-record rule above,</li>
          <li>object to or restrict some processing, and withdraw consent,</li>
          <li>complain to the Nigeria Data Protection Commission (NDPC).</li>
        </ul>
        <p>
          For anything else, email <a href="mailto:dpo@einvoice.ng">dpo@einvoice.ng</a>. We reply within 30 days.
        </p>
      </>
    ),
  },
  {
    id: 'security',
    title: 'How we protect it',
    body: (
      <p>
        Encryption in transit and at rest, extra encryption for bank details and two-step verification secrets, strict separation between businesses in our database, optional
        two-step verification, sign-in rate limits and a tamper-proof activity log. If a breach affecting your data happens, we will tell you and the NDPC as the law requires.
      </p>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies',
    body: (
      <p>
        We use only the cookies needed to keep you signed in and to protect forms from cross-site attacks. We don't use advertising or tracking cookies. A preference such as
        whether you have seen the welcome tour is kept in your browser's storage.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to this notice',
    body: <p>If we make important changes, we will tell you by email or in the app before they take effect.</p>,
  },
];

export default function PrivacyPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.peek<Me>('/v1/me'), retry: false });
  const firstWs = me.data?.workspaces[0]?.id;
  const appHref = firstWs ? `/w/${firstWs}` : me.data?.firms[0] ? `/f/${me.data.firms[0].id}` : '/signup';
  return (
    <div className="min-h-dvh">
      <SiteHeader signedIn={!!me.data} appHref={appHref} />
      <main id="main" className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <p className="text-sm font-semibold text-brand-700">Privacy notice</p>
        <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">How we handle your personal data</h1>
        <p className="mt-3 text-muted">Last updated {UPDATED}. Written in plain language; if anything is unclear, ask our Data Protection Officer.</p>

        <nav aria-label="On this page" className="mt-8 rounded-xl border border-line p-5 text-sm">
          <p className="font-medium">On this page</p>
          <ol className="mt-2 grid gap-1 text-muted sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="hover:text-ink hover:underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10 text-[15px] leading-relaxed text-ink [&_a]:font-medium [&_a]:text-brand-700 [&_a]:underline [&_li]:mt-1.5 [&_p+p]:mt-3 [&_p+ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-24">
              <h2 className="mb-3 text-xl font-semibold">{s.title}</h2>
              {s.body}
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
