'use client';
import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/** Accessible modal (focus trap, Esc to close, labelled). A bottom sheet on phones, centred on larger screens. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 animate-fade-in bg-ink/40 backdrop-blur-[2px]" />
        <D.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] animate-rise overflow-y-auto rounded-t-3xl bg-surface shadow-pop sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-6">
            <div>
              <D.Title className="text-lg font-semibold">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
            </div>
            <D.Close className="-mr-2 -mt-1 rounded-lg p-2 text-subtle hover:bg-slate-100 hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="px-6 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-slate-50/60 px-6 py-4">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
