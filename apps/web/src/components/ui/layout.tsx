import { AlertCircle, Check, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line bg-surface', className)} {...props} />;
}
export function CardHeader({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-5 sm:px-6', className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4 sm:px-6', className)} {...props} />;
}

export function PageHeader({ title, description, actions, back }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; back?: React.ReactNode }) {
  return (
    <div className="mb-6 sm:mb-8">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold sm:text-[28px] sm:leading-9">{title}</h1>
          {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

const alertStyles = {
  info: { box: 'border-sky-200 bg-sky-50 text-sky-950', icon: 'text-sky-600', Icon: Info },
  success: { box: 'border-brand-200 bg-brand-50 text-brand-900', icon: 'text-brand-600', Icon: CheckCircle2 },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-950', icon: 'text-amber-600', Icon: TriangleAlert },
  error: { box: 'border-red-200 bg-red-50 text-red-950', icon: 'text-red-600', Icon: AlertCircle },
};
export function Alert({ tone = 'info', title, children, className, action }: { tone?: keyof typeof alertStyles; title?: React.ReactNode; children?: React.ReactNode; className?: string; action?: React.ReactNode }) {
  const { box, icon, Icon } = alertStyles[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-xl border px-4 py-3.5 text-sm', box, className)}>
      <Icon className={cn('mt-0.5 size-[18px] shrink-0', icon)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'opacity-90')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

const badgeTones = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-brand-50 text-brand-800 ring-brand-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-sky-50 text-sky-800 ring-sky-200',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: keyof typeof badgeTones; children: React.ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', badgeTones[tone], className)}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-slate-200/70', className)} />;
}

/** Empty states explain what the area is for and offer exactly one next step. */
export function EmptyState({ icon, title, description, action }: { icon?: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-4 rounded-xl bg-brand-50 p-3.5 text-brand-700 [&_svg]:size-6">{icon}</div>}
      <p className="text-base font-semibold">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center py-16 text-sm text-muted">
      <span className="mr-2 inline-block size-4 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" aria-hidden />
      {label}…
    </div>
  );
}

const progressTone = { brand: 'bg-brand-600', amber: 'bg-amber-500', red: 'bg-red-600' };
export function Progress({ value, label, tone = 'brand' }: { value: number; label: string; tone?: keyof typeof progressTone }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label} className="h-2 overflow-hidden rounded-full bg-slate-100">
      <div className={cn('h-full rounded-full transition-all duration-500', progressTone[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Horizontal step indicator — shows where something is in its journey so users always know
 * what happened and what comes next (visibility of system status).
 */
export function Steps({ steps, current, failed }: { steps: string[]; current: number; failed?: boolean }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="flex min-w-0 flex-1 items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold',
                done && 'bg-brand-600 text-white',
                active && !failed && 'bg-brand-100 text-brand-800 ring-2 ring-brand-600',
                active && failed && 'bg-red-100 text-red-700 ring-2 ring-red-500',
                !done && !active && 'bg-slate-100 text-subtle',
              )}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            {/* On phones only the current step is labelled; the numbered dots carry the rest. */}
            <span className={cn('truncate text-xs font-medium sm:block sm:text-sm', active ? 'text-ink' : 'hidden', done ? 'text-muted' : !active && 'text-subtle')}>{s}</span>
            {i < steps.length - 1 && <span className={cn('hidden h-px flex-1 sm:block', done ? 'bg-brand-300' : 'bg-line')} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
