import { Container } from '~/components/Section';

const STATS = [
  { value: '~3 KB', label: 'gzipped script' },
  { value: '0', label: 'cookies set' },
  { value: '0', label: 'IP addresses stored' },
  { value: '24 h', label: 'visitor-hash lifetime' },
] as const;

export function Stats() {
  return (
    <section aria-label="At a glance" className="border-y">
      <Container>
        <dl className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="flex flex-col items-center gap-1 bg-background px-4 py-7 text-center">
              <dt className="order-2 text-sm text-muted-foreground">{s.label}</dt>
              <dd className="order-1 text-3xl font-semibold tracking-tight tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
