/** Frequently asked questions — shown on the landing page and in the Help centre. */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Do I really have to e-invoice?',
    a: 'Yes. Under the Nigeria Tax Administration framework, business-to-business and business-to-government invoices must be approved ("cleared") by NRS through its Merchant Buyer Solution. Large businesses started first; businesses with turnover under ₦1bn are expected to start by July 2027. When you sign up we show your exact date.',
  },
  {
    q: 'What does "approved by NRS" actually mean?',
    a: 'When you submit an invoice we send it to NRS. NRS checks it and returns an Invoice Reference Number (IRN) and QR stamp. That stamp proves the invoice is genuine, and your buyer needs it to claim back the VAT they paid you. It usually takes a few seconds.',
  },
  {
    q: 'What happens if NRS rejects an invoice?',
    a: 'We tell you exactly what to fix, in plain English, next to the field that needs changing. Fix it and submit again — the history of every attempt is kept.',
  },
  {
    q: 'What if NRS is down?',
    a: "Your invoice waits safely in a queue and we keep trying automatically for up to 72 hours. You don't need to do anything, and it will never be approved twice.",
  },
  {
    q: 'I made a mistake on an approved invoice. Can I edit it?',
    a: 'Approved invoices are locked by law. Instead, raise a credit note to reduce it (for example a return or refund) or a debit note to add to it (for example a delivery charge you forgot). Both are linked to the original IRN.',
  },
  {
    q: 'I sell to consumers in a shop. Do I need an invoice per sale?',
    a: 'No. For retail (B2C) sales you report each day’s total to NRS within 24 hours. Upload the export from your till and we send it automatically. If there were no sales, confirm "no sales" for that day.',
  },
  {
    q: 'Can my accountant use this with me?',
    a: 'Yes. Accounting firms get one login for all their clients and a dashboard showing who needs attention. Give your accountant access with their 8-character firm code in Settings → Team, and remove it any time.',
  },
  {
    q: 'How does this help with my monthly VAT return?',
    a: 'Every approved invoice, credit note and retail day adds up in VAT & reports. You see the VAT you charged for the month, can compare it with what you filed, and export it to Excel or PDF.',
  },
  {
    q: 'Is my data safe?',
    a: 'Your data is encrypted in transit and at rest, bank details are encrypted separately, and each business can only ever see its own records. We follow the Nigeria Data Protection Act 2023, and you can download or delete your personal data from Settings.',
  },
  {
    q: 'Do I need to install anything or be technical?',
    a: 'No. It works in your browser on a phone or computer. Connecting to NRS is three automatic steps that take about a minute.',
  },
  {
    q: 'How much does it cost?',
    a: 'Every business starts with a free 14-day trial that includes up to 20 approved invoices, no card needed. Then Starter is ₦5,000 a month (50 invoices), Business ₦15,000 (500 invoices and approval for large invoices) and Pro ₦40,000 (unlimited). Pay yearly and get two months free. Pay by card, bank transfer or USSD.',
  },
  {
    q: 'What happens if I reach my limit or my payment fails?',
    a: 'Only sending to NRS pauses. You can still create drafts and open, share and download every approved invoice. We warn you at 80% of your monthly allowance, and if a renewal fails we keep trying for 7 days while sending carries on as normal.',
  },
  {
    q: 'How do I check a supplier’s invoice is genuine?',
    a: 'Open “Check an invoice” (at the bottom of every page, or einvoice.ng/verify), then type the IRN printed on the invoice or scan its QR code. Only claim VAT on supplier invoices that NRS has approved.',
  },
];
