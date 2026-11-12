import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/** 40px default (44px hit area on touch via padding in layouts); flat, no shadows. */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand-700 text-white hover:bg-brand-800',
        secondary: 'border border-line-strong bg-surface text-ink hover:bg-slate-50',
        ghost: 'text-muted hover:bg-slate-100 hover:text-ink',
        soft: 'bg-brand-50 text-brand-800 hover:bg-brand-100',
        danger: 'bg-red-600 text-white hover:bg-red-700',
        link: 'h-auto px-0 text-brand-700 underline-offset-4 hover:underline',
      },
      size: { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4', lg: 'h-11 px-5', icon: 'size-10' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
        {asChild ? (
          children
        ) : (
          <>
            {loading && <Loader2 className="animate-spin" aria-hidden />}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
