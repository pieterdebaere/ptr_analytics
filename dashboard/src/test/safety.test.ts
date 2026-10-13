import { describe, expect, it } from 'vitest';
import {
  displayText,
  hostMatchesDomains,
  isSafeHostname,
  loginUrl,
  normalizeDomain,
  pageHref,
  referrerHref,
  safeNextPath,
} from '../lib/safety';

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
  it('rejects paths that normalise to a protocol-relative URL', () => {
    for (const bad of [
      '/.//evil.example',
      '/%2e//evil.example',
      '/%2E//evil.example',
      '/a/..//evil.example',
      '/..//evil.example',
      '/%2e%2e//x',
      '/%2E%2e//x',
      '/.%2e//x',
      '/sites/../..//evil.example',
      '/./evil',
      '/a/.',
      '/a/..',
      '/%2f/evil.example',
      '/%2F%2Fevil.example',
      '/x%5cevil.example',
      '/x%5Cevil.example',
      '/.//evil.example?x=1#y',
    ]) {
      expect(safeNextPath(bad), bad).toBeNull();
      expect(loginUrl(bad), bad).toBe('/login');
    }
  });
  it('never returns a path that starts with // or /\\', () => {
    const inputs = ['/.//a', '/a/../../b', '/%2e/', '/sites/x?next=//evil', '/x#//y', '/..', '/...//x', '/a..//b'];
    for (const input of inputs) {
      const out = safeNextPath(input);
      if (out !== null) {
        expect(out[0]).toBe('/');
        expect(out[1]).not.toBe('/');
        expect(out[1]).not.toBe('\\');
      }
    }
  });
  it('still accepts dots that are not dot segments and encoded characters in the query', () => {
    expect(safeNextPath('/sites/abc/file.txt')).toBe('/sites/abc/file.txt');
    expect(safeNextPath('/a..b/...')).toBe('/a..b/...');
    expect(safeNextPath('/sites/abc?path=%2F..%2Fblog')).toBe('/sites/abc?path=%2F..%2Fblog');
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

describe('hostMatchesDomains', () => {
  const domains = ['example.com', 'www.shop.test', '*.example.org', 'localhost'];
  it('accepts configured domains, www variants and wildcard subdomains', () => {
    expect(hostMatchesDomains('example.com', domains)).toBe(true);
    expect(hostMatchesDomains('www.example.com', domains)).toBe(true);
    expect(hostMatchesDomains('shop.test', domains)).toBe(true); // bare variant of www.shop.test
    expect(hostMatchesDomains('www.shop.test', domains)).toBe(true);
    expect(hostMatchesDomains('example.org', domains)).toBe(true);
    expect(hostMatchesDomains('a.b.example.org', domains)).toBe(true);
    expect(hostMatchesDomains('shop.example', ['www.shop.example'])).toBe(true);
  });
  it('rejects everything else', () => {
    for (const bad of ['evil.com', 'blog.example.com', 'example.com.evil.com', 'notexample.org', 'localhost', 'EXAMPLE.COM', '', null, undefined]) {
      expect(hostMatchesDomains(bad, domains), String(bad)).toBe(false);
    }
    expect(hostMatchesDomains('example.com', [])).toBe(false);
  });
});

describe('displayText', () => {
  it('replaces control and bidi override characters', () => {
    expect(displayText('abc\u202Edef')).toBe('abc\uFFFDdef');
    expect(displayText('\u2066x\u2069\u202A\u202B\u202C\u202D')).toBe('\uFFFDx\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD');
    expect(displayText('a\u0000b\nc\u007fd\u0085e')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uFFFDe');
  });
  it('keeps normal text, including RTL scripts', () => {
    expect(displayText('/blog/héllo')).toBe('/blog/héllo');
    expect(displayText('\u0645\u0631\u062d\u0628\u0627')).toBe('\u0645\u0631\u062d\u0628\u0627');
  });
});
