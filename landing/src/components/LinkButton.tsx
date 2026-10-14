import type { AnchorHTMLAttributes } from 'react';
import type { VariantProps } from 'class-variance-authority';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Size = 'md' | 'lg' | 'sm';

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-[0.95rem] rounded-xl',
};

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: Size;
  external?: boolean;
}

/** An `<a>` styled as a shadcn/ui button (links must stay real anchors). */
export function LinkButton({ variant = 'default', size = 'md', external, className, children, ...props }: LinkButtonProps) {
  return (
    <a
      className={cn(buttonVariants({ variant }), SIZE[size], 'gap-2', className)}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...props}
    >
      {children}
    </a>
  );
}
