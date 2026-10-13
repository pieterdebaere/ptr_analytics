import { describe, expect, it } from 'vitest';
import {
  axisDateFormat,
  changeTone,
  formatChange,
  formatCompact,
  formatDuration,
  formatMs,
  formatNumber,
  formatPercent,
  percentChange,
  tooltipDateFormat,
} from '../lib/format';
import { formatVital, rateScore, rateValue } from '../lib/vitals';

describe('numbers', () => {
  it('formats plain and compact numbers', () => {
    expect(formatNumber(1234567, 'en-US')).toBe('1,234,567');
    expect(formatCompact(999, 'en-US')).toBe('999');
    expect(formatCompact(1234, 'en-US')).toBe('1.2K');
    expect(formatCompact(1_500_000, 'en-US')).toBe('1.5M');
    expect(formatCompact(Number.NaN, 'en-US')).toBe('–');
  });
  it('formats percentages', () => {
    expect(formatPercent(0.4321, 'en-US')).toBe('43%');
    expect(formatPercent(null)).toBe('–');
    expect(formatPercent(1, 'en-US')).toBe('100%');
  });
});

describe('percent change', () => {
  it('computes relative change', () => {
    expect(percentChange(125, 100)).toBeCloseTo(0.25);
    expect(percentChange(50, 100)).toBeCloseTo(-0.5);
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(null, 10)).toBeNull();
    expect(percentChange(0.4, 0.5)).toBeCloseTo(-0.2);
  });
  it('formats with sign', () => {
    expect(formatChange(0.253, 'en-US')).toBe('+25%');
    expect(formatChange(-0.1, 'en-US')).toBe('−10%');
    expect(formatChange(0.001, 'en-US')).toBe('0%');
    expect(formatChange(12.5, 'en-US')).toBe('+1,250%');
    expect(formatChange(null)).toBe('');
  });
  it('colours changes, inverted when lower is better', () => {
    expect(changeTone(0.2)).toBe('good');
    expect(changeTone(-0.2)).toBe('bad');
    expect(changeTone(0.2, true)).toBe('bad');
    expect(changeTone(-0.2, true)).toBe('good');
    expect(changeTone(0)).toBe('neutral');
    expect(changeTone(null)).toBe('neutral');
  });
});

describe('durations', () => {
  it('formats milliseconds', () => {
    expect(formatMs(850, 'en-US')).toBe('850 ms');
    expect(formatMs(999.6, 'en-US')).toBe('1,000 ms');
    expect(formatMs(1234, 'en-US')).toBe('1.23 s');
    expect(formatMs(null)).toBe('–');
  });
  it('formats seconds', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(200)).toBe('3m 20s');
    expect(formatDuration(3720)).toBe('1h 2m');
    expect(formatDuration(-1)).toBe('–');
  });
});

describe('date formats', () => {
  const t = Date.UTC(2026, 0, 15, 13, 0, 0);
  it('formats per interval in the given tz', () => {
    expect(axisDateFormat('hour', 'en-US', 'UTC').format(t)).toBe('1 PM');
    expect(axisDateFormat('day', 'en-US', 'UTC').format(t)).toBe('Jan 15');
    expect(axisDateFormat('month', 'en-US', 'UTC').format(t)).toBe('Jan 26');
    expect(axisDateFormat('hour', 'en-US', 'Asia/Tokyo').format(t)).toBe('10 PM');
    expect(tooltipDateFormat('month', 'en-US', 'UTC').format(t)).toBe('January 2026');
  });
});

describe('vitals', () => {
  it('rates values with web.dev thresholds', () => {
    expect(rateValue('LCP', 2500)).toBe('good');
    expect(rateValue('LCP', 2501)).toBe('needs-improvement');
    expect(rateValue('LCP', 4001)).toBe('poor');
    expect(rateValue('CLS', 0.1)).toBe('good');
    expect(rateValue('CLS', 0.3)).toBe('poor');
    expect(rateValue('INP', null)).toBeNull();
  });
  it('rates the score', () => {
    expect(rateScore(90)).toBe('good');
    expect(rateScore(89.9)).toBe('needs-improvement');
    expect(rateScore(50)).toBe('needs-improvement');
    expect(rateScore(49)).toBe('poor');
    expect(rateScore(null)).toBeNull();
  });
  it('formats p75 values', () => {
    expect(formatVital('CLS', 0.05234, 'en-US')).toBe('0.052');
    expect(formatVital('LCP', 2345, 'en-US')).toBe('2.35 s');
    expect(formatVital('INP', 180, 'en-US')).toBe('180 ms');
    expect(formatVital('TTFB', null)).toBe('–');
  });
});
