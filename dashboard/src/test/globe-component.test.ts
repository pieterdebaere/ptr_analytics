import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Globe } from '../components/globe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom has no canvas: keep its "not implemented" noise out of the output.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Globe', () => {
  it('renders with no data', () => {
    act(() => root.render(createElement(Globe, {})));
    const el = container.querySelector('[data-slot="globe"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('tabindex')).toBe('0');
    expect(el?.getAttribute('aria-label')).toMatch(/no visitors/);
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(3);
  });

  it('ignores unknown / null countries and summarises the rest', () => {
    const countries = [
      { country: 'US', value: 120 },
      { country: 'BE', value: 30 },
      { country: 'ZZ', value: 99999 },
      { country: null as unknown as string, value: 5 },
      { country: 'DE', value: Number.NaN },
    ];
    const pings = [
      { id: '1', country: 'US' },
      { id: '2', country: 'nowhere' },
      { id: '3', country: null as unknown as string },
    ];
    act(() =>
      root.render(createElement(Globe, { countries, pings, valueLabel: 'pageviews', controls: false }, createElement('span', null, 'overlay'))),
    );
    const label = container.querySelector('[data-slot="globe"]')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('2 countries');
    expect(label).toContain('pageviews');
    expect(label).toContain('United States');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toContain('overlay');
    // re-render with new pings / empty data must not throw
    act(() => root.render(createElement(Globe, { countries: [], pings: [{ id: '4', country: 'FR' }] })));
  });
});
