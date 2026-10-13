// Display rules for breakdown dimensions. Values are untrusted and rendered as text.
import type { FilterKey } from '../api/types';
import { countryName, flagEmoji } from './countries';
import { isSafeHostname, pageHref, referrerHref } from './safety';

export const DIMENSION_LABELS: Record<FilterKey, string> = {
  path: 'Page',
  hostname: 'Hostname',
  referrer: 'Referrer',
  country: 'Country',
  device: 'Device',
  browser: 'Browser',
  os: 'OS',
  utm_source: 'UTM Source',
  utm_medium: 'UTM Medium',
  utm_campaign: 'UTM Campaign',
  utm_term: 'UTM Term',
  utm_content: 'UTM Content',
  event: 'Event',
};

/** Human readable label for a dimension value (null = missing). */
export function displayValue(dim: FilterKey, value: string | null, locale?: string): string {
  const missing = value === null || value === '';
  switch (dim) {
    case 'referrer':
      return missing ? 'Direct / None' : value;
    case 'country':
      return countryName(value, locale);
    case 'device':
      if (missing) return 'Unknown';
      return value.charAt(0).toUpperCase() + value.slice(1);
    case 'utm_source':
    case 'utm_medium':
    case 'utm_campaign':
    case 'utm_term':
    case 'utm_content':
      return missing ? '(not set)' : value;
    default:
      return missing ? 'Unknown' : value;
  }
}

/** Optional emoji prefix (country flags). */
export function valuePrefix(dim: FilterKey, value: string | null): string {
  if (dim !== 'country' || !value) return '';
  // Only real regions get a flag (Intl.DisplayNames falls back to the code itself).
  if (countryName(value) === value.toUpperCase()) return '';
  return flagEmoji(value);
}

/** The filter value for a row: null rows filter with "" (IS NULL). */
export function filterValueFor(value: string | null): string {
  return value ?? '';
}

/** Hostname to use for page links: active hostname filter, else first plain site domain. */
export function linkHostname(filterHostname: string | undefined, domains: readonly string[]): string | null {
  if (filterHostname && isSafeHostname(filterHostname)) return filterHostname;
  for (const d of domains) if (isSafeHostname(d)) return d;
  return null;
}

/** Safe external link for a row, or null. */
export function rowHref(dim: FilterKey, value: string | null, pageHost: string | null): string | null {
  if (value === null) return null;
  if (dim === 'referrer' || dim === 'hostname') return referrerHref(value);
  if (dim === 'path') return pageHref(pageHost, value);
  return null;
}
