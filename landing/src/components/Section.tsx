import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8', className)}>{children}</div>;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('inline-flex items-center gap-2 font-mono text-xs font-medium tracking-wider text-brand uppercase', className)}>
      <span className="h-px w-6 bg-brand/60" aria-hidden="true" />
      {children}
    </p>
  );
}

export interface SectionHeadingProps {
  id?: string;
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  align?: 'left' | 'center';
  className?: string;
}

export function SectionHeading({ id, eyebrow, title, description, align = 'center', className }: SectionHeadingProps) {
  return (
    <div className={cn('flex flex-col gap-4', align === 'center' ? 'mx-auto max-w-2xl items-center text-center' : 'max-w-xl', className)}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 id={id} className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h2>
      {description ? <p className="text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">{description}</p> : null}
    </div>
  );
}

/** A full-width page section with optional top border and grid background. */
export function Section({
  id,
  labelledBy,
  className,
  children,
  grid = false,
}: {
  id?: string;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
  grid?: boolean;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn('relative py-20 sm:py-24', className)}>
      {grid ? <div className="pointer-events-none absolute inset-0 -z-10 bg-grid mask-fade-y opacity-70" aria-hidden="true" /> : null}
      {children}
    </section>
  );
}
