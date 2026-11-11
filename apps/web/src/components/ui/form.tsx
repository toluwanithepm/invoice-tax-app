import * as React from 'react';
import { cn } from '@/lib/utils';

const control =
  'block w-full rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-subtle shadow-sm transition-colors focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-slate-50 disabled:text-subtle aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-red-500/20';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(control, 'h-10', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(control, 'min-h-20 py-2', className)} {...props} />
));
Textarea.displayName = 'Textarea';

/** Native select: accessible, light, and good on mobile. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(control, 'h-10 pr-8', className)} {...props} />
));
Select.displayName = 'Select';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-sm font-medium text-ink', className)} {...props} />;
}

/** Label + control + hint + error, wired up with aria attributes. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  id,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string;
  children: React.ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
  className?: string;
  id: string;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      {React.cloneElement(children, { id, 'aria-invalid': !!error || undefined, 'aria-describedby': describedBy })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function Checkbox({ label, className, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label className={cn('flex items-start gap-2.5 text-sm text-ink', className)}>
      <input type="checkbox" className="mt-0.5 size-4 rounded border-line accent-brand-700" {...props} />
      <span>{label}</span>
    </label>
  );
}
