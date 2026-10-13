import { describe, expect, it } from 'vitest';
import { isSafeHostname, loginUrl, normalizeDomain, pageHref, referrerHref, safeNextPath } from '../lib/safety';

describe('safeNextPath', () => {
  it('accepts same-origin relative paths', () => {
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/sites/abc?period=30d&path=%2Fblog')).toBe('/sites/abc?period=30d&path=%2Fblog');
    expect(safeNextPath('/settings#x')).toBe('/settings#x');
  });
  it('rejects open redirects', () => {
    for (const bad of [
      '//evil.com',
      '//evil.com/x',
      '/\\evil.com',
      '\\\\evil.com',
      'https://evil.com',
      'javascript:alert(1)',
      'evil.com',
      '/foo\\bar',
      '/\tevil',
      ' /x',
      '/x y',
      '',
      null,
      undefined,
    ]) {
      expect(safeNextPath(bad as string)).toBeNull();
    }
  });
  it('does not loop back to login', () => {
    expect(safeNextPath('/login?next=/x')).toBe('/');
  });
  it('builds the login URL', () => {
    expect(loginUrl('/sites/abc?period=30d')).toBe('/login?next=%2Fsites%2Fabc%3Fperiod%3D30d');
    expect(loginUrl('/')).toBe('/login');
    expect(loginUrl('//evil.com')).toBe('/login');
  });
});

describe('isSafeHostname / referrerHref', () => {
  it('accepts plain public hostnames', () => {
    expect(isSafeHostname('google.com')).toBe(true);
    expect(isSafeHostname('news.ycombinator.com')).toBe(true);
    expect(isSafeHostname('xn--bcher-kva.example')).toBe(true);
    expect(isSafeHostname('a-b.co.uk')).toBe(true);
  });
  it('rejects anything else', () => {
    for (const bad of [
      'javascript:alert(1)',
      'localhost',
      '127.0.0.1',
      'evil.com/path',
      'evil.com:8080',
      'user@evil.com',
      '-bad.com',
      'bad-.com',
      'EVIL.COM',
      'evil.com.',
      'a..com',
      'evil.c',
      ' evil.com',
      'evil.com"onmouseover=x',
      '',
      null,
    ]) {
      expect(isSafeHostname(bad)).toBe(false);
    }
  });
  it('builds https links only for safe hosts', () => {
    expect(referrerHref('google.com')).toBe('https://google.com/');
    expect(referrerHref('javascript:alert(1)')).toBeNull();
    expect(referrerHref(null)).toBeNull();
  });
});

describe('pageHref', () => {
  it('builds page links', () => {
    expect(pageHref('example.com', '/blog/post')).toBe('https://example.com/blog/post');
    expect(pageHref('example.com', '/a b')).toBeNull();
  });
  it('rejects unsafe paths and hosts', () => {
    expect(pageHref('example.com', 'javascript:alert(1)')).toBeNull();
    expect(pageHref('example.com', '//evil.com/x')).toBeNull();
    expect(pageHref('example.com', '/\\evil.com')).toBeNull();
    expect(pageHref('example.com', 'blog')).toBeNull();
    expect(pageHref('example.com', '@evil.com')).toBeNull();
    expect(pageHref('localhost', '/x')).toBeNull();
    expect(pageHref(null, '/x')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('normalises input', () => {
    expect(normalizeDomain('Example.com')).toBe('example.com');
    expect(normalizeDomain('https://www.example.com/path?x=1')).toBe('www.example.com');
    expect(normalizeDomain('example.com:8080')).toBe('example.com');
    expect(normalizeDomain('example.com.')).toBe('example.com');
    expect(normalizeDomain('*.example.com')).toBe('*.example.com');
    expect(normalizeDomain('localhost')).toBe('localhost');
  });
  it('rejects invalid entries', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('*')).toBeNull();
    expect(normalizeDomain('exa mple.com')).toBeNull();
    expect(normalizeDomain('foo')).toBeNull();
    expect(normalizeDomain('*.*.example.com')).toBeNull();
    expect(normalizeDomain('<script>.com')).toBeNull();
  });
});
