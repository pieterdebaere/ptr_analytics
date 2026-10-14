// Safe Markdown subset → React elements (docs/uptime/ANALYSIS.md §8.7.4).
// Never produces HTML strings and never uses dangerouslySetInnerHTML: raw HTML in the
// input is shown as text. Supported: paragraphs, line breaks, **bold**, *italic*,
// `code`, fenced code blocks, bullet/numbered lists, headings (rendered as h3/h4), and
// links / autolinks restricted to http(s): and mailto:.
import { Fragment, type ReactNode } from 'react';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

export const MARKDOWN_MAX_LENGTH = 20_000;
const MAX_INLINE_DEPTH = 6;
const MAX_URL_LENGTH = 2048;
const LINK_REL = 'noopener noreferrer nofollow ugc';

/* ------------------------------------------------------------------ links */

/**
 * Returns a normalised href for http(s)/mailto URLs, or null for anything else
 * (javascript:, data:, vbscript:, relative URLs, protocol-relative, control chars …).
 */
export function safeMarkdownHref(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > MAX_URL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f‪-‮⁦-⁩\\]/.test(v)) return null;
  if (!/^(?:https?:\/\/|mailto:)/i.test(v)) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  }
  if (url.protocol === 'mailto:') {
    const addr = url.pathname;
    if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(decodeURIComponentSafe(addr))) return null;
    return `mailto:${addr}`;
  }
  return null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* ------------------------------------------------------------------ inline */

type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

const ESCAPABLE = new Set('\\`*_{}[]()#+-.!>|~<'.split(''));
const AUTOLINK_RE = /^(?:https?:\/\/|mailto:)[^\s<>]*[^\s<>.,;:!?'")\]]/i;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** Finds the closing delimiter `delim` at or after `from` (not escaped, non-empty content). */
function findClose(s: string, from: number, delim: string): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > 0) i = end;
      continue;
    }
    if (s.startsWith(delim, i) && i > from && s[i - 1] !== ' ') {
      if (delim === '*' && s[i + 1] === '*') {
        // skip a nested ** pair
        const inner = s.indexOf('**', i + 2);
        if (inner > 0) {
          i = inner + 1;
          continue;
        }
      }
      if (delim === '_' && isWordChar(s[i + delim.length])) continue;
      return i;
    }
  }
  return -1;
}

/** Finds the next unescaped `]` (link texts do not nest). */
function findBracket(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === ']') return i;
  }
  return -1;
}

/** Closing `)` of a link destination (parentheses may nest), scanning a bounded window. */
function findParen(s: string, from: number): number {
  let depth = 0;
  const stop = Math.min(s.length, from + MAX_URL_LENGTH + 64);
  for (let i = from; i < stop; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return i;
      depth--;
    } else if (ch === '\n') return -1;
  }
  return -1;
}

export function parseInline(s: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  if (depth > MAX_INLINE_DEPTH) return [{ t: 'text', v: s }];

  // Searches that failed once fail for every later start position too: remember them so
  // pathological input ("<<<<…", "[[[[…", "*a *a *a …") stays linear instead of quadratic.
  const failedFrom: Record<string, number> = {};
  const search = (key: string, from: number, fn: () => number): number => {
    const f = failedFrom[key];
    if (f !== undefined && from >= f) return -1;
    const r = fn();
    if (r < 0) failedFrom[key] = from;
    return r;
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    const rest = s.slice(i);

    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1]!)) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      let ticks = 1;
      while (s[i + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      const end = search(fence, i + ticks, () => s.indexOf(fence, i + ticks));
      if (end > i) {
        flush();
        out.push({ t: 'code', v: s.slice(i + ticks, end).replace(/\n/g, ' ') });
        i = end + ticks;
        continue;
      }
      buf += fence;
      i += ticks;
      continue;
    }
    if ((rest.startsWith('**') || rest.startsWith('__')) && s[i + 2] !== undefined && s[i + 2] !== ' ') {
      const delim = rest.slice(0, 2);
      const leftOk = delim === '**' || !isWordChar(s[i - 1]);
      const end = leftOk ? search(delim, i + 2, () => findClose(s, i + 2, delim)) : -1;
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(s.slice(i + 2, end), depth + 1, inLink) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] !== undefined && s[i + 1] !== ' ' && s[i + 1] !== ch) {
      const leftOk = ch === '*' || !isWordChar(s[i - 1]);
      const end = leftOk ? search(ch, i + 1, () => findClose(s, i + 1, ch)) : -1;
      if (end > i + 1) {
        flush();
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, end), depth + 1, inLink) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[' && !inLink) {
      const close = search('[', i + 1, () => findBracket(s, i + 1));
      if (close > i && s[close + 1] === '(') {
        const end = findParen(s, close + 2);
        if (end > close) {
          const target = s.slice(close + 2, end).trim().split(/\s+/)[0] ?? '';
          const text = s.slice(i + 1, close);
          const href = safeMarkdownHref(target.replace(/^<|>$/g, ''));
          flush();
          const children = parseInline(text, depth + 1, true);
          // unsafe target: keep the text, drop the link
          if (href) out.push({ t: 'link', href, c: children });
          else out.push(...children);
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === '<' && !inLink) {
      const end = search('>', i + 1, () => s.indexOf('>', i + 1));
      if (end > i) {
        const href = safeMarkdownHref(s.slice(i + 1, end));
        if (href) {
          flush();
          out.push({ t: 'link', href, c: [{ t: 'text', v: s.slice(i + 1, end).replace(/^mailto:/i, '') }] });
          i = end + 1;
          continue;
        }
      }
    }
    if ((ch === 'h' || ch === 'H' || ch === 'm' || ch === 'M') && !inLink && !isWordChar(s[i - 1])) {
      const m = AUTOLINK_RE.exec(rest);
      if (m) {
        const href = safeMarkdownHref(m[0]);
        if (href) {
          flush();
          out.push({ t: 'link', href, c: [{ t: 'text', v: m[0].replace(/^mailto:/i, '') }] });
          i += m[0].length;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ blocks */

export type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: 3 | 4; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; start: number; items: string[] }
  | { t: 'pre'; text: string };

const BULLET_RE = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED_RE = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; start: number; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join('\n') });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list.t === 'ul' ? { t: 'ul', items: list.items } : { t: 'ol', start: list.start, items: list.items });
    list = null;
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const body: string[] = [];
      n++;
      while (n < lines.length && !lines[n]!.trimStart().startsWith(fence[1]!)) body.push(lines[n++]!);
      blocks.push({ t: 'pre', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ t: 'h', level: h[1]!.length <= 3 ? 3 : 4, text: h[2]! });
      continue;
    }
    const b = BULLET_RE.exec(line);
    const o = b ? null : ORDERED_RE.exec(line);
    if (b || o) {
      flushPara();
      const kind = b ? 'ul' : 'ol';
      if (!list || list.t !== kind) {
        flushList();
        list = { t: kind, start: o ? Math.min(Number(o[1]), 1e9) : 1, items: [] };
      }
      list.items.push(b ? b[1]! : o![2]!);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // continuation of the last list item
      const items = list.items;
      items[items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

/* ------------------------------------------------------------------ render */

/** Tabs become spaces; other control and bidi characters are made visible (U+FFFD). */
function clean(s: string): string {
  return displayText(s.replace(/\t/g, '  '));
}

function renderInline(nodes: Inline[], linkClassName: string | undefined, keyPrefix = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={key}>{clean(n.v)}</Fragment>;
      case 'br':
        return <br key={key} />;
      case 'code':
        return (
          <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {clean(n.v)}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold">
            {renderInline(n.c, linkClassName, `${key}.`)}
          </strong>
        );
      case 'em':
        return <em key={key}>{renderInline(n.c, linkClassName, `${key}.`)}</em>;
      case 'link':
        return (
          <a
            key={key}
            href={n.href}
            target="_blank"
            rel={LINK_REL}
            referrerPolicy="no-referrer"
            className={cn('font-medium underline underline-offset-4 hover:opacity-80', linkClassName)}
          >
            {renderInline(n.c, linkClassName, `${key}.`)}
          </a>
        );
    }
  });
}

/**
 * Renders untrusted Markdown (status page descriptions, footers, incident bodies) as
 * React elements. Input longer than `maxLength` is cut off.
 */
export function SafeMarkdown({
  source,
  className,
  linkClassName,
  maxLength = MARKDOWN_MAX_LENGTH,
}: {
  source: string | null | undefined;
  className?: string;
  linkClassName?: string;
  maxLength?: number;
}) {
  if (typeof source !== 'string' || !source.trim()) return null;
  const truncated = source.length > maxLength;
  const text = truncated ? `${source.slice(0, maxLength)}…` : source;
  const blocks = parseBlocks(text);
  return (
    <div className={cn('bidi-isolate flex flex-col gap-2 break-words [overflow-wrap:anywhere]', className)} data-slot="markdown">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'p':
            return (
              <p key={i} className="leading-relaxed">
                {renderInline(parseInline(b.text), linkClassName)}
              </p>
            );
          case 'h':
            return b.level === 3 ? (
              <h3 key={i} className="mt-1 text-base font-semibold">
                {renderInline(parseInline(b.text), linkClassName)}
              </h3>
            ) : (
              <h4 key={i} className="mt-1 text-sm font-semibold">
                {renderInline(parseInline(b.text), linkClassName)}
              </h4>
            );
          case 'ul':
            return (
              <ul key={i} className="ml-5 list-disc space-y-1">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(parseInline(it), linkClassName)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={b.start} className="ml-5 list-decimal space-y-1">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(parseInline(it), linkClassName)}</li>
                ))}
              </ol>
            );
          case 'pre':
            return (
              <pre key={i} className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[0.8rem] leading-relaxed">
                <code>{b.text.split('\n').map(clean).join('\n')}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
