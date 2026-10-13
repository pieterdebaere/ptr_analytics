import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreakdownRows, FilterChips } from '../components/analytics';
import { AreaChart, RingGauge, Sparkline } from '../components/charts';

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
    const buttons = container.querySelectorAll<HTMLButtonElement>('button.row-main');
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
          onSelect={() => {}}
          rows={[{ value: 'BE', visitors: 1, count: 1 }]}
        />,
      ),
    );
    expect(container.textContent).toContain('\u{1F1E7}\u{1F1EA}');
    expect(container.textContent).toMatch(/Belgi/);
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
  it('renders an area chart without inline style attributes on SVG', () => {
    const t0 = Date.UTC(2026, 0, 1);
    act(() =>
      root.render(
        <AreaChart
          points={[0, 1, 2, 3].map((i) => ({ t: t0 + i * 86_400_000, value: i * 10 }))}
          interval="day"
          label="Visitors"
          valueLabel="Visitors"
          formatValue={(v) => String(v)}
        />,
      ),
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('path.chart-line')).toHaveLength(1);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('renders sparkline and gauge', () => {
    act(() =>
      root.render(
        <>
          <Sparkline values={[1, 2, 3]} label="trend" />
          <RingGauge score={92.4} tone="good" label="score" />
        </>,
      ),
    );
    expect(container.querySelector('.sparkline-line')).not.toBeNull();
    expect(container.querySelector('.gauge-text')!.textContent).toBe('92');
  });
});
