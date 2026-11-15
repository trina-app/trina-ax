// Small readers for what arrives at an app's address (parse.ts and presets/*): every value is read by its type, and
// anything else in a body is ignored.
import crypto from 'node:crypto'

export const sha = (s: string | Uint8Array) => crypto.createHash('sha256').update(s).digest('hex')
export const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
/** a nested value: get(o, 'data', 'issue', 'id') */
export function get(o: unknown, ...path: string[]): unknown {
  let v: unknown = o
  for (const p of path) { const x = obj(v); if (!x) return undefined; v = x[p] }
  return v
}
/** a string (or a finite number as text) at the path, else '' */
export const str = (o: unknown, ...path: string[]) => { const v = get(o, ...path); return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '' }
/** a finite number at the path (a numeric string too), else null */
export const num = (o: unknown, ...path: string[]): number | null => {
  const v = get(o, ...path)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v)
  return null
}
/** an array at the path (at most `max` items), else [] */
export const arr = (o: unknown, max: number, ...path: string[]): unknown[] => { const v = get(o, ...path); return Array.isArray(v) ? v.slice(0, max) : [] }
export const firstLine = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? ''
/** the body as UTF-8 text (bad bytes replaced) */
export const textOf = (raw: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(raw)
/** the body as JSON, else undefined */
export function jsonOf(raw: Uint8Array): unknown {
  try { return JSON.parse(textOf(raw)) } catch { return undefined }
}
