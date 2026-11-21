// Hiding a connection's stored secrets in what its service sends back (docs/INTEGRATIONS.md "Secrets"). A service may
// echo what it received: an endpoint that lists the request's headers, an error page that repeats Authorization, an MCP
// tool that returns its own token. Each value (the key; OAuth access and refresh tokens and the client secret) is
// replaced by HIDDEN wherever it appears, in the forms services commonly write it in, before an answer reaches the AI,
// the chat, the steps, logs or the audit (tools.ts `hiding`: every result of a connection tool; mcp.ts: a JSON-RPC
// error message and the saved tool lists, before they are cut; the values come from service.ts `hider`).
//
// Forms: the value itself (so also "Bearer <value>"); any of its characters %-escaped (either case, "+" for a space),
// JSON-escaped (\/, \", \\, \uXXXX) or as an HTML entity; base64 (standard or URL-safe, padded or not) of any text that
// contains it: the value alone, "user:<value>" for basic auth, "<value>:", at each of the three byte alignments.
// Values shorter than MIN_SECRET are left alone: they would hide ordinary words. Not caught: a service that changes the
// value in another way (hashes it, hex-encodes it, changes its case, splits or reverses it).
//
// Size: spelled out in all of its forms, a character of a value takes about 200 pattern characters, and Bun refuses a
// regular expression much over about a million ("regular expression too large"). Long OAuth tokens (Atlassian's v2
// sign-in, QA TC-4770), and the earlier tokens a server keeps hiding after refreshes, went past that: the person's
// whole redactor failed, and so did every check of the connection. So:
// - each value's forms depend on that value only, never on how many others there are: a value of LONG_SECRET
//   characters or more matches its letters and digits only as written (no escaper writes those; its other characters
//   keep every escaped form, and its base64 forms stay); a shorter one keeps every form;
// - the patterns go into as many regular expressions as needed, longest value first, each at most MAX_GROUP_CHARS;
// - a value too large for one of them on its own drops its base64 forms; still too large, SecretTooLarge is thrown
//   (never a value left out): whoever builds the hider fails closed (redact.ts, service.ts hider);
// - patterns and built chains are kept (a small cache), so a hider of the same values costs nothing the next time.

import crypto from 'node:crypto'

export const HIDDEN = '[hidden key]'
/** shorter values are not hidden (they would match ordinary words) */
export const MIN_SECRET = 8
/** values this long or longer match their letters and digits only as written (see Size above) */
export const LONG_SECRET = 64
/** the most pattern characters one regular expression of a hider takes (see Size above) */
export const MAX_GROUP_CHARS = 400_000

/** A stored value too large to hide in any form we can build: the hider is not made, and its maker withholds instead.
 * The message names only the length. */
export class SecretTooLarge extends Error {
  name = 'SecretTooLarge'
  constructor(readonly length: number) { super(`a stored secret of ${length} characters is too large to hide`) }
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** a number in hex digits, each letter in either case: 0x2f -> "2[fF]" */
const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0').replace(/[A-F]/g, (c) => `[${c}${c.toLowerCase()}]`)
const NAMED: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }

/** One character as a pattern: itself, or as a URL, JSON or HTML text would escape it. Letters and digits
 * are accepted in escaped form too, unless `plain` (a value past the size budget). In base64, "+" and "/" may also be
 * the URL-safe "-" and "_". */
function charPattern(ch: string, base64 = false, plain = false): string {
  if (plain && /^[A-Za-z0-9]$/.test(ch)) return ch
  const cp = ch.codePointAt(0)!
  const alts = new Set([literal(ch), [...Buffer.from(ch)].map((b) => '%' + hex(b, 2)).join(''), `&#0*${cp};`, `&#[xX]0*${hex(cp, 1)};`])
  if (cp <= 0xffff) alts.add('\\\\u' + hex(cp, 4))
  if ('/"\\\''.includes(ch)) alts.add('\\\\' + literal(ch))
  if (NAMED[ch]) alts.add(`&${NAMED[ch]};`)
  if (ch === ' ') alts.add('\\+')
  if (base64 && ch === '+') alts.add('-')
  if (base64 && ch === '/') alts.add('_')
  return `(?:${[...alts].join('|')})`
}
const textPattern = (s: string, base64 = false, plain = false) => [...s].map((c) => charPattern(c, base64, plain)).join('')

/** base64 of any text that contains the value, one pattern per alignment: the groups made of the value's bytes only,
 * then (when the value ends the encoded text) its last one or two bytes with their padding. Up to two bytes at either
 * edge share a group with the text around them and stay. */
function base64Patterns(value: string, plain = false): string[] {
  const bytes = Buffer.from(value)
  const out: string[] = []
  for (const skip of [0, 1, 2]) {
    const rest = bytes.subarray(skip)
    const whole = Math.floor(rest.length / 3) * 3
    const core = rest.subarray(0, whole).toString('base64')
    if (core.length < MIN_SECRET) continue
    const tail = rest.subarray(whole).toString('base64')
    const bare = tail.replace(/=+$/, '')
    out.push(textPattern(core, true, plain) + (bare ? `(?:${textPattern(bare, true, plain)}(?:${charPattern('=', true)}){0,${tail.length - bare.length}})?` : ''))
  }
  return out
}

/** The values worth hiding: each as given and trimmed, MIN_SECRET characters or longer. */
export function secretValuesOf(values: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const raw of values) {
    if (!raw) continue
    for (const v of [raw, raw.trim()]) if (v.length >= MIN_SECRET) out.add(v)
  }
  return [...out]
}

/** The patterns of one value: 0 every form; 1 letters and digits only as written; 2 that, without the base64 forms. */
function valuePatterns(v: string, level: 0 | 1 | 2): string[] {
  const plain = level > 0
  return level === 2 ? [textPattern(v, false, true)] : [textPattern(v, false, plain), ...base64Patterns(v, plain)]
}
const patternSize = (ps: readonly string[]) => ps.reduce((n, p) => n + p.length + 1, 0)

/** A Map that forgets the entry used longest ago past `max` entries. */
class Lru<K, V> {
  private m = new Map<K, V>()
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.m.get(k)
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v) }
    return v
  }
  set(k: K, v: V) {
    this.m.delete(k)
    this.m.set(k, v)
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K)
  }
  clear() { this.m.clear() }
}
const PATTERNS = new Lru<string, readonly string[]>(512)
const CHAINS = new Lru<string, readonly RegExp[]>(64)

/** One value's patterns, longest first (see Size above); SecretTooLarge when even its smallest do not fit one group. */
export function patternsOf(v: string): readonly string[] {
  const have = PATTERNS.get(v)
  if (have) return have
  let ps = valuePatterns(v, v.length >= LONG_SECRET ? 1 : 0)
  if (patternSize(ps) > MAX_GROUP_CHARS) ps = valuePatterns(v, 2)
  if (patternSize(ps) > MAX_GROUP_CHARS) throw new SecretTooLarge(v.length)
  // within a value the longer patterns first (a whole base64 text before its core)
  const sorted = [...ps].sort((a, b) => b.length - a.length)
  PATTERNS.set(v, sorted)
  return sorted
}

/** The regular expressions (flag g) for every form of these values, longest value first, each at most MAX_GROUP_CHARS;
 * empty when there is nothing to hide. Hiding applies them in order (hideWith). SecretTooLarge: see Size above. */
export function secretRegexes(values: Iterable<string | null | undefined>): readonly RegExp[] {
  const vs = secretValuesOf(values).sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
  if (!vs.length) return []
  const key = crypto.createHash('sha256').update(vs.join('\0')).digest('hex')
  const have = CHAINS.get(key)
  if (have) return have
  // longer values first (a value before a shorter one inside it), in groups of at most MAX_GROUP_CHARS
  const groups: string[][] = []
  let size = Infinity
  const seen = new Set<string>()
  for (const v of vs) {
    const ps = patternsOf(v).filter((p) => !seen.has(p))
    for (const p of ps) seen.add(p)
    const n = patternSize(ps)
    if (!ps.length) continue
    if (size + n > MAX_GROUP_CHARS) { groups.push([]); size = 0 }
    groups.at(-1)!.push(...ps)
    size += n
  }
  const chain = groups.map((g) => new RegExp(g.join('|'), 'g'))
  CHAINS.set(key, chain)
  return chain
}

/** `text` with every match of the chain replaced, one regular expression after the other. */
export function hideWith(res: readonly RegExp[], text: string, replace: string | ((m: string) => string) = HIDDEN): string {
  let out = text
  for (const re of res) out = typeof replace === 'string' ? out.replace(re, replace) : out.replace(re, replace)
  return out
}

/** whether any regular expression of the chain matches somewhere in `text` */
export function matchesAny(res: readonly RegExp[], text: string): boolean {
  return res.some((re) => text.search(re) >= 0)
}

/** An error for the log: its name and the start of its message with every long token-like run taken out (an error
 * from parsing or building may quote what it was given). */
export function errorForLog(e: unknown): string {
  if (!(e instanceof Error)) return typeof e
  return `${e.name}: ${e.message.slice(0, 200).replace(/[A-Za-z0-9._~+\/=%-]{20,}/g, '[…]')}`
}

/** forget the kept patterns and chains (tests) */
export function clearSecretCache() { PATTERNS.clear(); CHAINS.clear() }

/** A function that replaces every form of these values with HIDDEN. Values shorter than MIN_SECRET are left out. */
export function secretHider(values: Iterable<string | null | undefined>): (text: string) => string {
  const res = secretRegexes(values)
  if (!res.length) return (s) => s
  return (text) => hideWith(res, text)
}

/** The same for every string (and key) in a JSON-like value. */
export function hideDeep<T>(value: T, hide: (s: string) => string): T {
  if (typeof value === 'string') return hide(value) as T
  if (Array.isArray(value)) return value.map((v) => hideDeep(v, hide)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [hide(k), hideDeep(v, hide)])) as T
  return value
}
