import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldDef } from '../api/uptime';
import {
  FieldDefForm,
  fieldValuesToConfig,
  initialFieldValues,
  isFieldVisible,
  validateFieldValues,
  visibleFields,
} from '../components/forms/FieldDefForm';
import { groupFields, isStatusCodeRange } from '../components/forms/field-values';

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

/** Sets the value of a React-controlled input/textarea and fires the input event. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const FIELDS: FieldDef[] = [
  { key: 'url', label: 'URL', kind: 'url', required: true, placeholder: 'https://' },
  { key: 'method', label: 'Method', kind: 'select', default: 'GET', options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }], group: 'Request' },
  { key: 'body', label: 'Body', kind: 'textarea', showIf: { key: 'method', equals: ['POST'] }, group: 'Request' },
  { key: 'host', label: 'Host', kind: 'host' },
  { key: 'port', label: 'Port', kind: 'number', min: 1, max: 65535, default: 443 },
  { key: 'follow', label: 'Follow redirects', kind: 'boolean', default: true },
  { key: 'keywords', label: 'Keywords', kind: 'list' },
  { key: 'headers', label: 'Headers', kind: 'keyvalue', group: 'Request' },
  { key: 'accepted', label: 'Accepted status codes', kind: 'statuscodes', default: ['200-299'] },
  { key: 'authMethod', label: 'Auth', kind: 'select', options: [{ value: 'none', label: 'None' }, { value: 'basic', label: 'Basic' }], default: 'none', group: 'Authentication' },
  { key: 'username', label: 'Username', kind: 'text', showIf: { key: 'authMethod', equals: ['basic'] }, group: 'Authentication' },
  { key: 'password', label: 'Password', kind: 'password', required: true, showIf: { key: 'authMethod', equals: ['basic'] }, group: 'Authentication' },
  { key: 'token', label: 'Token', kind: 'text', secret: true, group: 'Authentication' },
  { key: 'mtls', label: 'Client cert', kind: 'textarea', selfHostedOnly: true, group: 'Advanced' },
];

function Harness({ initial, secretsSet, hosted, onValues }: { initial: Record<string, unknown>; secretsSet?: string[]; hosted?: boolean; onValues: (v: Record<string, unknown>) => void }) {
  const [values, setValues] = useState(initial);
  return (
    <FieldDefForm
      fields={FIELDS}
      values={values}
      onChange={(v) => {
        setValues(v);
        onValues(v);
      }}
      secretsSet={secretsSet}
      hosted={hosted}
      errors={{ url: 'Enter a valid URL.' }}
    />
  );
}

describe('field-values helpers', () => {
  it('builds initial values from config / defaults and never prefills secrets', () => {
    const v = initialFieldValues(FIELDS, { url: 'https://x.test/', port: '8443', password: 'leaked', token: 'leaked', headers: { 'X-A': '1' }, keywords: 'a\nb' });
    expect(v.url).toBe('https://x.test/');
    expect(v.port).toBe(8443);
    expect(v.method).toBe('GET');
    expect(v.follow).toBe(true);
    expect(v.accepted).toEqual(['200-299']);
    expect(v.headers).toEqual([{ key: 'X-A', value: '1' }]);
    expect(v.keywords).toEqual(['a', 'b']);
    expect(v.password).toBeUndefined();
    expect(v.token).toBeUndefined();
    expect(v.body).toBe('');
  });

  it('evaluates showIf (including chains) and hides selfHostedOnly in hosted mode', () => {
    const v = initialFieldValues(FIELDS);
    const pw = FIELDS.find((f) => f.key === 'password')!;
    expect(isFieldVisible(pw, FIELDS, v)).toBe(false);
    expect(isFieldVisible(pw, FIELDS, { ...v, authMethod: 'basic' })).toBe(true);
    const chained: FieldDef[] = [
      { key: 'a', label: 'A', kind: 'boolean' },
      { key: 'b', label: 'B', kind: 'select', options: [{ value: 'x', label: 'x' }], showIf: { key: 'a', equals: [true] } },
      { key: 'c', label: 'C', kind: 'text', showIf: { key: 'b', equals: ['x'] } },
    ];
    expect(visibleFields(chained, { a: false, b: 'x' }).map((f) => f.key)).toEqual(['a']);
    expect(visibleFields(chained, { a: true, b: 'x' }).map((f) => f.key)).toEqual(['a', 'b', 'c']);
    expect(visibleFields(FIELDS, v, true).some((f) => f.key === 'mtls')).toBe(false);
    expect(visibleFields(FIELDS, v, false).some((f) => f.key === 'mtls')).toBe(true);
  });

  it('serialises config with secret semantics (keep = omitted, clear = null) and drops hidden fields', () => {
    const v = { ...initialFieldValues(FIELDS), url: ' https://x.test/ ', keywords: [' a ', '', 'b'], headers: [{ key: ' X ', value: 'y' }, { key: '', value: '' }], body: 'hidden', token: '' };
    const cfg = fieldValuesToConfig(FIELDS, v);
    expect(cfg.url).toBe('https://x.test/');
    expect(cfg.keywords).toEqual(['a', 'b']);
    expect(cfg.headers).toEqual([{ key: 'X', value: 'y' }]);
    expect('body' in cfg).toBe(false);
    expect('token' in cfg).toBe(false);
    expect('password' in cfg).toBe(false);
    expect(fieldValuesToConfig(FIELDS, { ...v, token: null }).token).toBeNull();
    expect(fieldValuesToConfig(FIELDS, { ...v, token: 'new' }).token).toBe('new');
    expect('mtls' in fieldValuesToConfig(FIELDS, v, true)).toBe(false);
  });

  it('validates required, numbers, urls, status codes and secrets', () => {
    const base = { ...initialFieldValues(FIELDS), url: '' };
    expect(validateFieldValues(FIELDS, base).url).toMatch(/required/);
    expect(validateFieldValues(FIELDS, { ...base, url: 'not a url' }).url).toMatch(/valid URL/);
    expect(validateFieldValues(FIELDS, { ...base, url: 'https://ok.test', port: 70000 }).port).toMatch(/at most 65535/);
    expect(validateFieldValues(FIELDS, { ...base, url: 'https://ok.test', accepted: ['200-299', '99'] }).accepted).toMatch(/not a status code/);
    expect(validateFieldValues(FIELDS, { ...base, url: 'https://ok.test', host: 'https://x/y' }).host).toBeDefined();
    const basic = { ...base, url: 'https://ok.test', authMethod: 'basic' };
    expect(validateFieldValues(FIELDS, basic).password).toMatch(/required/);
    // stored secret satisfies "required" unless it is being cleared
    expect(validateFieldValues(FIELDS, basic, { secretsSet: ['password'] }).password).toBeUndefined();
    expect(validateFieldValues(FIELDS, { ...basic, password: null }, { secretsSet: ['password'] }).password).toMatch(/required/);
    expect(Object.keys(validateFieldValues(FIELDS, { ...basic, password: 'pw' }))).toEqual([]);
  });

  it('checks status code ranges and groups fields', () => {
    expect(isStatusCodeRange('200-299')).toBe(true);
    expect(isStatusCodeRange('301')).toBe(true);
    expect(isStatusCodeRange('299-200')).toBe(false);
    expect(isStatusCodeRange('2xx')).toBe(false);
    expect(groupFields(FIELDS).map((g) => g.group)).toEqual([null, 'Request', 'Authentication', 'Advanced']);
  });
});

describe('FieldDefForm', () => {
  it('renders every kind, groups, help and errors', () => {
    const onValues = vi.fn();
    act(() => root.render(<Harness initial={initialFieldValues(FIELDS)} onValues={onValues} />));
    const text = container.textContent ?? '';
    for (const label of ['URL', 'Method', 'Host', 'Port', 'Follow redirects', 'Keywords', 'Headers', 'Accepted status codes', 'Auth', 'Token']) expect(text).toContain(label);
    expect(text).not.toContain('Password'); // showIf hidden
    expect(text).not.toContain('Body');
    expect(container.querySelectorAll('legend').length).toBe(2); // Request, Authentication
    expect(text).toContain('Advanced'); // collapsible group
    expect(text).toContain('Enter a valid URL.');
    expect(container.querySelector('[data-field="url"] input')!.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
    expect(text).toContain('200-299');
  });

  it('edits text, number, list, boolean, key/value and status codes', () => {
    const onValues = vi.fn();
    act(() => root.render(<Harness initial={initialFieldValues(FIELDS)} onValues={onValues} />));
    const last = () => onValues.mock.calls[onValues.mock.calls.length - 1]![0] as Record<string, unknown>;
    act(() => type(container.querySelector<HTMLInputElement>('[data-field="url"] input')!, 'https://new.test/'));
    expect(last().url).toBe('https://new.test/');
    act(() => type(container.querySelector<HTMLInputElement>('[data-field="port"] input')!, '8080'));
    expect(last().port).toBe(8080);
    act(() => type(container.querySelector<HTMLInputElement>('[data-field="port"] input')!, ''));
    expect(last().port).toBeUndefined();
    act(() => type(container.querySelector<HTMLTextAreaElement>('[data-field="keywords"] textarea')!, 'one\ntwo'));
    expect(last().keywords).toEqual(['one', 'two']);
    act(() => container.querySelector<HTMLElement>('[role="switch"]')!.click());
    expect(last().follow).toBe(false);
    const addEntry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add entry')!;
    act(() => addEntry.click());
    expect(last().headers).toEqual([{ key: '', value: '' }]);
    act(() => type(container.querySelector<HTMLInputElement>('[aria-label="Name 1"]')!, 'Authorization'));
    expect(last().headers).toEqual([{ key: 'Authorization', value: '' }]);
    const preset = [...container.querySelectorAll('button')].find((b) => b.textContent === '+300-399')!;
    act(() => preset.click());
    expect(last().accepted).toEqual(['200-299', '300-399']);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove 200-299"]')!.click());
    expect(last().accepted).toEqual(['300-399']);
  });

  it('shows showIf fields when the controlling value matches', () => {
    act(() => root.render(<Harness initial={{ ...initialFieldValues(FIELDS), authMethod: 'basic' }} onValues={() => {}} />));
    expect(container.textContent).toContain('Username');
    expect(container.textContent).toContain('Password');
  });

  it('secret fields: never prefilled, "set" placeholder, Clear sends null, Undo keeps', () => {
    const onValues = vi.fn();
    act(() => root.render(<Harness initial={{ ...initialFieldValues(FIELDS), token: undefined }} secretsSet={['token']} onValues={onValues} />));
    const input = container.querySelector<HTMLInputElement>('[data-field="token"] input')!;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('•••• set — leave empty to keep');
    expect(input.getAttribute('autocomplete')).toBe('new-password');
    const clear = container.querySelector<HTMLButtonElement>('[aria-label="Clear stored Token"]')!;
    act(() => clear.click());
    expect(onValues.mock.calls.at(-1)![0].token).toBeNull();
    expect(container.textContent).toContain('Will be removed when you save');
    const undo = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Undo'))!;
    act(() => undo.click());
    expect(onValues.mock.calls.at(-1)![0].token).toBeUndefined();
    act(() => type(container.querySelector<HTMLInputElement>('[data-field="token"] input')!, 's3cret'));
    expect(onValues.mock.calls.at(-1)![0].token).toBe('s3cret');
  });

  it('secret fields without a stored value have no Clear action', () => {
    act(() => root.render(<Harness initial={initialFieldValues(FIELDS)} onValues={() => {}} />));
    expect(container.querySelector('[aria-label="Clear stored Token"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-field="token"] input')!.placeholder).not.toContain('set');
  });

  it('hides self-hosted-only fields in hosted mode', () => {
    act(() => root.render(<Harness initial={initialFieldValues(FIELDS)} hosted onValues={() => {}} />));
    expect(container.textContent).not.toContain('Advanced');
    expect(container.textContent).not.toContain('Client cert');
  });

  it('renders labels and help as text (no HTML injection)', () => {
    const evil: FieldDef[] = [{ key: 'x', label: '<img src=x onerror=alert(1)>', kind: 'text', help: '<b>bold</b>' }];
    act(() => root.render(<FieldDefForm fields={evil} values={{ x: '' }} onChange={() => {}} />));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
