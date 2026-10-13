import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreakdownRows, EventDetailDialog, FilterChips } from '../components/analytics';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { LiveFeed } from '../components/live';
import { Sparkline, TimeSeriesChart } from '../components/stats-charts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('BreakdownRows', () => {
  it('renders untrusted values as text and only links safe values', () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        <BreakdownRows
          dimension="referrer"
          metric="visitors"
          pageHost={null}
          siteDomains={['example.com']}
          onSelect={onSelect}
          rows={[
            { value: 'google.com', visitors: 10, count: 12 },
            { value: 'javascript:alert(1)', visitors: 5, count: 5 },
            { value: '<img src=x onerror=alert(1)>', visitors: 3, count: 3 },
            { value: null, visitors: 2, count: 2 },
          ]}
        />,
      ),
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('Direct / None');
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://google.com/']);
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-slot="breakdown-row"]');
    act(() => buttons[3]!.click());
    expect(onSelect).toHaveBeenCalledWith({ value: null, visitors: 2, count: 2 });
  });

  it('renders countries with flags and localized names', () => {
    act(() =>
      root.render(
        <BreakdownRows
          dimension="country"
          metric="count"
          pageHost={null}
          siteDomains={['example.com']}
          onSelect={() => {}}
          rows={[{ value: 'BE', visitors: 1, count: 1 }]}
        />,
      ),
    );
    expect(container.textContent).toContain('\u{1F1E7}\u{1F1EA}');
    expect(container.textContent).toMatch(/Belgi/);
  });
});

describe('BreakdownRows links and bidi', () => {
  it('only links hostname rows that belong to the site domains', () => {
    act(() =>
      root.render(
        <BreakdownRows
          dimension="hostname"
          metric="visitors"
          pageHost="example.com"
          siteDomains={['example.com', '*.example.org']}
          onSelect={() => {}}
          rows={[
            { value: 'www.example.com', visitors: 3, count: 3 },
            { value: 'blog.example.org', visitors: 2, count: 2 },
            { value: 'evil.com', visitors: 1, count: 1 },
          ]}
        />,
      ),
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://www.example.com/', 'https://blog.example.org/']);
  });

  it('does not link page rows when the page host is not trusted', () => {
    act(() =>
      root.render(
        <BreakdownRows
          dimension="path"
          metric="visitors"
          pageHost={null}
          siteDomains={['example.com']}
          onSelect={() => {}}
          rows={[{ value: '/blog', visitors: 3, count: 3 }]}
        />,
      ),
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('isolates and neutralises bidi overrides in row labels', () => {
    act(() =>
      root.render(
        <BreakdownRows
          dimension="path"
          metric="visitors"
          pageHost="example.com"
          siteDomains={['example.com']}
          onSelect={() => {}}
          rows={[{ value: '/\u202Egnp.exe', visitors: 3, count: 3 }]}
        />,
      ),
    );
    expect(container.textContent).not.toContain('\u202E');
    expect(container.textContent).toContain('/\uFFFDgnp.exe');
    const label = container.querySelector('[data-slot="breakdown-label"]')!;
    expect(label.classList.contains('bidi-isolate')).toBe(true);
    expect(container.innerHTML).not.toContain('\u202E');
  });
});

describe('FilterChips', () => {
  it('shows removable chips', () => {
    const onRemove = vi.fn();
    act(() =>
      root.render(<FilterChips filters={{ path: '/blog', referrer: '' }} onRemove={onRemove} onClear={() => {}} />),
    );
    expect(container.textContent).toContain('/blog');
    expect(container.textContent).toContain('Direct / None');
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Page filter"]');
    act(() => remove!.click());
    expect(onRemove).toHaveBeenCalledWith('path');
  });
});

describe('charts', () => {
  it('renders the Bklit time series chart with an accessible label (nulls are dropped)', () => {
    const t0 = Date.UTC(2026, 0, 1);
    act(() =>
      root.render(
        <TimeSeriesChart
          points={[0, 1, 2, 3].map((i) => ({ t: t0 + i * 86_400_000, value: i === 2 ? null : i * 10 }))}
          interval="day"
          label="Visitors over time"
          valueLabel="Visitors"
          formatValue={(v) => String(v)}
        />,
      ),
    );
    expect(container.querySelector('[role="img"][aria-label="Visitors over time"]')).not.toBeNull();
  });

  it('shows an empty state instead of an empty chart', () => {
    act(() =>
      root.render(<TimeSeriesChart points={[{ t: 1, value: null }]} interval="day" label="x" valueLabel="x" formatValue={String} />),
    );
    expect(container.textContent).toContain('No data for this period');
  });

  it('renders a sparkline placeholder for short series', () => {
    act(() => root.render(<Sparkline values={[3]} label="trend" />));
    expect(container.querySelector('[aria-label="trend"]')).not.toBeNull();
  });
});

describe('LiveFeed', () => {
  it('renders untrusted paths as isolated text with flags only for ISO codes', () => {
    const now = Date.UTC(2026, 0, 1, 12);
    act(() =>
      root.render(
        <LiveFeed
          now={now}
          recent={[
            { ts: now - 1000, country: 'BE', path: '/<img src=x onerror=alert(1)>' },
            { ts: now - 125_000, country: '<b>', path: '/a\u202Eb' },
          ]}
        />,
      ),
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('/<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('/a\uFFFDb');
    expect(container.textContent).toContain('just now');
    expect(container.textContent).toContain('2m ago');
    expect(container.textContent).toContain('\u{1F1E7}\u{1F1EA}');
    expect(container.textContent).not.toContain('<b>');
  });
});

describe('FilterChips bidi', () => {
  it('isolates chip values', () => {
    act(() => root.render(<FilterChips filters={{ path: '/x\u202Ey', utm_source: 'a\u0007b' }} onRemove={() => {}} onClear={() => {}} />));
    const values = Array.from(container.querySelectorAll('.chip-value'));
    expect(values.every((v) => v.classList.contains('bidi-isolate'))).toBe(true);
    expect(container.textContent).not.toContain('\u202E');
    expect(container.textContent).toContain('/x\uFFFDy');
    expect(container.textContent).toContain('a\uFFFDb');
  });
});

describe('EventDetailDialog bidi', () => {
  it('renders the event name, prop keys and values isolated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ rows: [{ key: 'k\u202Eey', value: 'v\u2067al', visitors: 1, count: 1 }] }), { status: 200 }),
      ),
    );
    await act(async () => {
      root.render(
        <EventDetailDialog siteId="abc123def456" query={{ period: '7d', tz: 'UTC' }} event={'Sign\u202Eup'} onClose={() => {}} onFilter={() => {}} />,
      );
    });
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    vi.unstubAllGlobals();
    const title = document.querySelector('[data-slot="dialog-title"] bdi');
    expect(title?.textContent).toBe('Sign\uFFFDup');
    expect(title?.classList.contains('bidi-isolate')).toBe(true);
    expect(document.querySelector('[data-slot="event-prop-key"] bdi')?.textContent).toBe('k\uFFFDey');
    expect(document.querySelector('[data-slot="event-props"] td bdi')?.textContent).toBe('v\uFFFDal');
    expect(document.body.textContent).not.toMatch(/[\u202E\u2067]/);
  });
});

describe('ErrorBoundary', () => {
  function Boom(): never {
    throw new Error('boom');
  }

  it('shows a friendly message with a reload link instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() =>
      root.render(
        <ErrorBoundary variant="app">
          <Boom />
        </ErrorBoundary>,
      ),
    );
    expect(container.textContent).toContain('Something went wrong');
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'Reload the page');
    expect(link).toBeDefined();
    expect(link!.getAttribute('href')!.startsWith('/')).toBe(true);
    expect(container.textContent).not.toContain('boom');
  });

  it('keeps sibling content and resets when the reset key changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = (key: string, crash: boolean) => (
      <div>
        <header>Shell</header>
        <ErrorBoundary resetKey={key}>{crash ? <Boom /> : <p>Page content</p>}</ErrorBoundary>
      </div>
    );
    act(() => root.render(view('/a', true)));
    expect(container.textContent).toContain('Shell');
    expect(container.textContent).toContain('Something went wrong');
    act(() => root.render(view('/a', false)));
    expect(container.textContent).toContain('Something went wrong');
    act(() => root.render(view('/b', false)));
    expect(container.textContent).toContain('Page content');
    expect(container.textContent).not.toContain('Something went wrong');
  });
});
