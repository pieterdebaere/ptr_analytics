import { badRequest } from './errors.js';

export type JsonObject = Record<string, unknown>;

export function isPlainObject(v: unknown): v is JsonObject {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The request body as a plain JSON object, or 400. */
export function objectBody(body: unknown): JsonObject {
  if (!isPlainObject(body)) throw badRequest('invalid request body');
  return body;
}

export function field(o: JsonObject, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

export function stringField(o: JsonObject, key: string, opts: { min?: number; max: number; trim?: boolean }): string {
  const v = field(o, key);
  if (typeof v !== 'string') throw badRequest(`invalid ${key}`);
  const s = opts.trim ? v.trim() : v;
  if (s.length < (opts.min ?? 1) || s.length > opts.max) throw badRequest(`invalid ${key}`);
  return s;
}
