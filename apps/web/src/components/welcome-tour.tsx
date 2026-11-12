'use client';
import * as D from '@radix-ui/react-dialog';
import { BarChart3, FilePlus2, MessageCircle, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/hooks';
import { cn } from '@/lib/utils';

const SLIDES = [
  {
    icon: Sparkles,
    title: 'Welcome to E-Invoice',
    body: 'Nigerian law now requires every business invoice to be approved by NRS before it counts for tax. We handle that for you — here is how it works in four steps.',
  },
  {
    icon: FilePlus2,
    title: '1. Create an invoice',
    body: 'Pick a customer, add what you sold. We work out VAT for you and save your draft as you type.',
  },
  {
    icon: ShieldCheck,
    title: '2. NRS approves it in seconds',
    body: 'We check for common mistakes first, then send it. Approved invoices get an IRN and QR stamp that prove they are genuine.',
  },
  {
    icon: MessageCircle,
    title: '3. Send it and get paid',
    body: 'Share by WhatsApp, email or link. Your customer gets a clean page with a PDF. Mark it paid when the money arrives.',
  },
  {
    icon: BarChart3,
    title: '4. Your VAT return, done',
    body: 'Every approved invoice adds up in VAT & reports, ready for your monthly return. Your accountant can work with you too.',
  },
];

const OPEN_EVENT = 'einv:open-tour';
/** Re-open the tour from anywhere (e.g. the Help centre). */
export const openWelcomeTour = () => window.dispatchEvent(new Event(OPEN_EVENT));

/** Short, skippable, shown once per person; replayable from Help. */
export function WelcomeTour() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const key = me.data ? `einv:tour:v1:${me.data.id}` : null;

  useEffect(() => {
    if (!key) return;
    try {
      if (!localStorage.getItem(key)) setOpen(true);
    } catch {
      /* storage unavailable: don't show */
    }
  }, [key]);

  useEffect(() => {
    const h = () => {
      setI(0);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, h);
    return () => window.removeEventListener(OPEN_EVENT, h);
  }, []);

  function close() {
    setOpen(false);
    try {
      if (key) localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
  }

  const s = SLIDES[i]!;
  const last = i === SLIDES.length - 1;
  return (
    <D.Root open={open} onOpenChange={(o) => !o && close()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 animate-fade-in bg-ink/40 backdrop-blur-[2px]" />
        <D.Content className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 animate-rise overflow-hidden rounded-2xl bg-surface shadow-pop">
          <div className="relative bg-gradient-to-br from-brand-700 to-brand-900 px-6 pb-10 pt-8 text-white">
            <D.Close className="absolute right-3 top-3 rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white" aria-label="Skip tour">
              <X className="size-4" />
            </D.Close>
            <div className="grid size-14 place-items-center rounded-xl bg-white/15 ring-1 ring-white/25">
              <s.icon className="size-7" aria-hidden />
            </div>
          </div>
          <div className="-mt-4 rounded-t-3xl bg-surface px-6 pb-6 pt-6">
            <D.Title className="text-xl font-semibold">{s.title}</D.Title>
            <D.Description className="mt-2 text-sm leading-relaxed text-muted">{s.body}</D.Description>
            <div className="mt-6 flex items-center justify-between">
              <div className="flex gap-1.5" aria-label={`Step ${i + 1} of ${SLIDES.length}`}>
                {SLIDES.map((_, n) => (
                  <span key={n} className={cn('h-1.5 rounded-full transition-all', n === i ? 'w-6 bg-brand-600' : 'w-1.5 bg-line-strong')} />
                ))}
              </div>
              <div className="flex gap-2">
                {i > 0 ? (
                  <Button variant="ghost" size="sm" onClick={() => setI(i - 1)}>
                    Back
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={close}>
                    Skip
                  </Button>
                )}
                <Button size="sm" onClick={() => (last ? close() : setI(i + 1))} autoFocus>
                  {last ? 'Get started' : 'Next'}
                </Button>
              </div>
            </div>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
