import { describe, expect, it } from 'vitest';
import { countryName, flagEmoji } from '../lib/countries';
import { displayValue, filterValueFor, linkHostname, rowHref, valuePrefix } from '../lib/dimensions';
import { generatePassword, validateNewPassword } from '../lib/password';
import { installSnippet, snippetOrigin } from '../lib/snippet';

describe('countries', () => {
  it('builds flag emoji only for ISO codes', () => {
    expect(flagEmoji('BE')).toBe('\u{1F1E7}\u{1F1EA}');
    expect(flagEmoji('be')).toBe('\u{1F1E7}\u{1F1EA}');
    expect(flagEmoji('BEL')).toBe('');
    expect(flagEmoji(null)).toBe('');
    expect(flagEmoji('1A')).toBe('');
  });
  it('localises names with fallbacks', () => {
    expect(countryName('BE', 'en')).toBe('Belgium');
    expect(countryName('DE', 'de')).toBe('Deutschland');
    expect(countryName(null)).toBe('Unknown');
    expect(countryName('<b>x</b>')).toBe('<b>x</b>');
  });
});

describe('dimensions', () => {
  it('labels null values', () => {
    expect(displayValue('referrer', null)).toBe('Direct / None');
    expect(displayValue('country', null)).toBe('Unknown');
    expect(displayValue('utm_source', null)).toBe('(not set)');
    expect(displayValue('device', 'mobile')).toBe('Mobile');
    expect(displayValue('path', '/x')).toBe('/x');
    expect(filterValueFor(null)).toBe('');
    expect(filterValueFor('/a')).toBe('/a');
    expect(valuePrefix('country', 'BE')).toBe('\u{1F1E7}\u{1F1EA}');
    expect(valuePrefix('country', 'XX')).toBe('');
    expect(valuePrefix('country', null)).toBe('');
    expect(valuePrefix('path', 'BE')).toBe('');
  });
  it('builds safe row links', () => {
    const domains = ['example.com', '*.example.org'];
    expect(rowHref('referrer', 'google.com', null, domains)).toBe('https://google.com/');
    expect(rowHref('referrer', 'javascript:alert(1)', null, domains)).toBeNull();
    expect(rowHref('hostname', 'www.example.com', null, domains)).toBe('https://www.example.com/');
    expect(rowHref('hostname', 'blog.example.org', null, domains)).toBe('https://blog.example.org/');
    expect(rowHref('path', '/blog', 'example.com', domains)).toBe('https://example.com/blog');
    expect(rowHref('path', '/blog', null, domains)).toBeNull();
    expect(rowHref('country', 'BE', 'example.com', domains)).toBeNull();
    expect(rowHref('referrer', null, null, domains)).toBeNull();
  });
  it('only links hostname rows that belong to the site', () => {
    const domains = ['example.com', '*.example.org'];
    expect(rowHref('hostname', 'evil.com', null, domains)).toBeNull();
    expect(rowHref('hostname', 'example.com.evil.com', null, domains)).toBeNull();
    expect(rowHref('hostname', 'blog.example.com', null, domains)).toBeNull();
    expect(rowHref('hostname', 'www.example.com', null, [])).toBeNull();
  });
  it('picks a link hostname', () => {
    expect(linkHostname(undefined, ['*.example.com', 'localhost', 'example.org'])).toBe('example.org');
    expect(linkHostname('', ['example.org'])).toBe('example.org');
    expect(linkHostname('blog.example.com', ['*.example.com'])).toBe('blog.example.com');
    expect(linkHostname('example.com', ['*.example.com'])).toBe('example.com');
    expect(linkHostname('www.example.org', ['example.org'])).toBe('www.example.org');
    expect(linkHostname('example.org', ['www.example.org'])).toBe('example.org');
    expect(linkHostname('javascript:x', ['*.example.com'])).toBeNull();
  });
  it('does not build page links for a hostname filter outside the site domains', () => {
    // a crafted dashboard link like ?hostname=evil.com must not retarget page links
    expect(linkHostname('evil.com', ['example.com'])).toBeNull();
    expect(linkHostname('blog.example.com', ['example.org'])).toBeNull();
    expect(linkHostname('example.com.evil.com', ['example.com', '*.example.com'])).toBeNull();
    expect(linkHostname('notexample.com', ['*.example.com'])).toBeNull();
    expect(rowHref('path', '/blog', linkHostname('evil.com', ['example.com']), ['example.com'])).toBeNull();
  });
  it('makes labels display-safe', () => {
    expect(displayValue('path', '/a\u202Egpj.exe')).toBe('/a\uFFFDgpj.exe');
    expect(displayValue('referrer', 'x\u0000y\u009bz')).toBe('x\uFFFDy\uFFFDz');
    expect(displayValue('path', '/\u05e9\u05dc\u05d5\u05dd')).toBe('/\u05e9\u05dc\u05d5\u05dd');
  });
});

describe('snippet', () => {
  it('uses publicUrl origin or falls back', () => {
    expect(snippetOrigin('https://analytics.example.com/', 'http://localhost:5173')).toBe('https://analytics.example.com');
    expect(snippetOrigin(null, 'http://localhost:5173/')).toBe('http://localhost:5173');
    expect(snippetOrigin('javascript:alert(1)', 'https://a.example')).toBe('https://a.example');
    expect(installSnippet('https://a.example', 'abc123def456')).toBe(
      '<script defer src="https://a.example/script.js" data-site="abc123def456"></script>',
    );
  });
});

describe('password', () => {
  it('generates random passwords of the requested length', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toHaveLength(20);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
    expect(validateNewPassword(a)).toBeNull();
  });
  it('validates length and confirmation', () => {
    expect(validateNewPassword('short')).toMatch(/12/);
    expect(validateNewPassword('a'.repeat(257))).toMatch(/256/);
    expect(validateNewPassword('a'.repeat(12), 'b'.repeat(12))).toMatch(/match/);
    expect(validateNewPassword('a'.repeat(12), 'a'.repeat(12))).toBeNull();
  });
});
