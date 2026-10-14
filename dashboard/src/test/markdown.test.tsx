import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown, droppedLinkTargets, parseBlocks, safeMarkdownHref } from '../components/markdown/SafeMarkdown';

const html = (src: string, maxLength?: number) => renderToStaticMarkup(<SafeMarkdown source={src} maxLength={maxLength} />);

function dom(src: string, maxLength?: number): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html(src, maxLength); // test only: parse the static markup to inspect it
  return div;
}

describe('safeMarkdownHref', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/x',
    'relative/path',
    '/\\evil.example',
    '///evil.example',
    '/a b',
    '/<script>',
    'file:///etc/passwd',
    'https://user:pass@evil.example/',
    'http://',
    'https://exa‮mple.com',
    'mailto:',
    'mailto:not-an-address',
    `https://example.com/${'a'.repeat(3000)}`,
  ])('rejects %j', (url) => {
    expect(safeMarkdownHref(url)).toBeNull();
  });

  it('accepts http(s) and mailto', () => {
    expect(safeMarkdownHref('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d');
    expect(safeMarkdownHref('HTTP://Example.COM')).toBe('http://example.com/');
    expect(safeMarkdownHref('mailto:ops@example.com')).toBe('mailto:ops@example.com');
  });

  it('accepts same-origin paths in [text](…) links only', () => {
    expect(safeMarkdownHref('/status/acme/feed.xml')).toBe('/status/acme/feed.xml');
    expect(safeMarkdownHref('/status/acme/feed.xml', false)).toBeNull();
    const a = dom('[RSS](/status/acme/feed.xml) and </b> and <//evil.example>').querySelectorAll('a');
    expect(Array.from(a).map((x) => x.getAttribute('href'))).toEqual(['/status/acme/feed.xml']);
    expect(droppedLinkTargets('[a](/ok) [b](example.com) [c](ftp://x.io/f) [d](https://x.io)')).toEqual(['example.com', 'ftp://x.io/f']);
  });
});

describe('SafeMarkdown XSS', () => {
  it('renders raw HTML as text', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/<script|<img|<a /i);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('drops unsafe link targets but keeps the text', () => {
    for (const target of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', '//evil.example', 'vbscript:x']) {
      const el = dom(`click [here](${target}) now`);
      expect(el.querySelector('a')).toBeNull();
      expect(el.textContent).toContain('click here now');
    }
    expect(dom('<javascript:alert(1)>').querySelector('a')).toBeNull();
  });

  it('does not allow attribute injection through link targets or texts', () => {
    const el = dom('[x](https://example.com/"onmouseover="alert(1)) [<b onclick=alert(1)>y</b>](https://example.com)');
    const links = Array.from(el.querySelectorAll('a'));
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttributeNames().sort()).toEqual(['class', 'href', 'referrerpolicy', 'rel', 'target']);
      expect(a.getAttribute('href')).toMatch(/^https:\/\/example\.com\//);
    }
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/%22onmouseover=%22alert(1)');
    expect(el.querySelector('b')).toBeNull();
  });

  it('renders safe links with target and rel', () => {
    const a = dom('See [docs](https://example.com/docs) or https://status.example.com.').querySelectorAll('a');
    expect(a).toHaveLength(2);
    expect(a[0]!.getAttribute('target')).toBe('_blank');
    expect(a[0]!.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
    expect(a[1]!.getAttribute('href')).toBe('https://status.example.com/');
    expect(a[1]!.textContent).toBe('https://status.example.com');
  });

  it('makes control and bidi override characters visible', () => {
    const el = dom('evil‮txt.exe \u0007bell');
    expect(el.textContent).toContain('evil�txt.exe');
    expect(el.textContent).toContain('�bell');
  });

  it('survives pathological input quickly', () => {
    const inputs = ['*'.repeat(20_000), '['.repeat(20_000), '<'.repeat(20_000), '*a '.repeat(6000), '**a '.repeat(5000), '`'.repeat(20_000), '_a '.repeat(6000)];
    const t0 = performance.now();
    for (const s of inputs) expect(() => html(s)).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(() => html('*'.repeat(50) + 'x' + '*'.repeat(50))).not.toThrow();
  });

  it('truncates long input', () => {
    const el = dom('a'.repeat(100), 10);
    expect(el.textContent).toBe(`${'a'.repeat(10)}…`);
  });
});

describe('SafeMarkdown formatting', () => {
  it('renders emphasis, code, line breaks and paragraphs', () => {
    const el = dom('**bold** and *italic* and _under_ and `<code>`\nnext line\n\nsecond para');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(Array.from(el.querySelectorAll('em')).map((e) => e.textContent)).toEqual(['italic', 'under']);
    expect(el.querySelector('code')?.textContent).toBe('<code>');
    expect(el.querySelectorAll('p')).toHaveLength(2);
    expect(el.querySelector('p br')).not.toBeNull();
  });

  it('keeps intra-word underscores and escaped characters literal', () => {
    const el = dom('snake_case_name and \\*not italic\\*');
    expect(el.querySelector('em')).toBeNull();
    expect(el.textContent).toBe('snake_case_name and *not italic*');
  });

  it('renders lists and headings as h3/h4 only', () => {
    const el = dom('# Title\n### Sub\n#### Small\n\n- one\n- **two**\n\n3. three\n4. four');
    expect(el.querySelector('h1,h2')).toBeNull();
    expect(Array.from(el.querySelectorAll('h3')).map((h) => h.textContent)).toEqual(['Title', 'Sub']);
    expect(el.querySelector('h4')?.textContent).toBe('Small');
    expect(Array.from(el.querySelectorAll('ul li')).map((l) => l.textContent)).toEqual(['one', 'two']);
    expect(el.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(el.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('renders fenced code blocks literally', () => {
    const el = dom('```\n<b>x</b>\n  y\n```');
    expect(el.querySelector('pre code')?.textContent).toBe('<b>x</b>\n  y');
    expect(el.querySelector('b')).toBeNull();
  });

  it('returns nothing for empty input', () => {
    expect(html('')).toBe('');
    expect(html('   \n ')).toBe('');
    expect(parseBlocks('a\n\n\nb')).toHaveLength(2);
  });
});
