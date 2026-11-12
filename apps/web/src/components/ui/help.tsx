'use client';
import * as P from '@radix-ui/react-popover';
import * as T from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { GLOSSARY, type GlossaryKey } from '@/lib/glossary';
import { cn } from '@/lib/utils';

/**
 * Explanations at the moment of need (progressive disclosure). Popovers rather than hover-only
 * tooltips so they work with a tap on phones and with the keyboard.
 */
function HelpPopover({ trigger, title, children, learnMore }: { trigger: React.ReactNode; title?: React.ReactNode; children: React.ReactNode; learnMore?: string }) {
  return (
    <P.Root>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-w-72 animate-rise rounded-xl border border-line bg-surface p-3.5 text-sm shadow-pop"
        >
          {title && <p className="mb-1 font-semibold text-ink">{title}</p>}
          <div className="leading-relaxed text-muted">{children}</div>
          {learnMore && (
            <Link href={learnMore} className="mt-2 inline-block text-xs font-medium text-brand-700 hover:underline">
              Learn more in Help
            </Link>
          )}
          <P.Arrow className="fill-surface" />
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

/** Small ⓘ next to a label. */
export function InfoTip({ term, title, children, className }: { term?: GlossaryKey; title?: string; children?: React.ReactNode; className?: string }) {
  const entry = term ? GLOSSARY[term] : null;
  const label = title ?? entry?.term ?? 'More information';
  return (
    <HelpPopover
      title={title ?? entry?.term}
      learnMore={term ? `/help#${term}` : undefined}
      trigger={
        <button
          type="button"
          aria-label={`What is ${label}?`}
          className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full text-subtle align-middle transition-colors hover:bg-slate-100 hover:text-ink', className)}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      }
    >
      {children ?? entry?.short}
    </HelpPopover>
  );
}

/** A jargon word in running text, underlined; tap or click for its meaning. */
export function Term({ k, children }: { k: GlossaryKey; children?: React.ReactNode }) {
  const entry = GLOSSARY[k];
  return (
    <HelpPopover
      title={entry.term}
      learnMore={`/help#${k}`}
      trigger={
        <button type="button" className="cursor-help underline decoration-subtle/60 decoration-dotted underline-offset-[3px] hover:decoration-ink">
          {children ?? entry.term}
        </button>
      }
    >
      {entry.short}
    </HelpPopover>
  );
}

/** Hover/focus label for icon-only buttons. */
export function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <T.Provider delayDuration={300}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content sideOffset={6} className="z-50 animate-fade-in rounded-md bg-ink px-2 py-1 text-xs font-medium text-white shadow-pop">
            {label}
            <T.Arrow className="fill-ink" />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
