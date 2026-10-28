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

export const HIDDEN = '[hidden key]'
/** shorter values are not hidden (they would match ordinary words) */
export const MIN_SECRET = 8

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** a number in hex digits, each letter in either case: 0x2f -> "2[fF]" */
const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0').replace(/[A-F]/g, (c) => `[${c}${c.toLowerCase()}]`)
const NAMED: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }

/** One character as a pattern: itself, or as a URL, JSON or HTML text would escape it. Letters and digits stay as they
 * are. In base64, "+" and "/" may also be the URL-safe "-" and "_". */
function charPattern(ch: string, base64 = false): string {
  if (/^[A-Za-z0-9]$/.test(ch)) return ch
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
const textPattern = (s: string, base64 = false) => [...s].map((c) => charPattern(c, base64)).join('')

/** base64 of any text that contains the value, one pattern per alignment: the groups made of the value's bytes only,
 * then (when the value ends the encoded text) its last one or two bytes with their padding. Up to two bytes at either
 * edge share a group with the text around them and stay. */
function base64Patterns(value: string): string[] {
  const bytes = Buffer.from(value)
  const out: string[] = []
  for (const skip of [0, 1, 2]) {
    const rest = bytes.subarray(skip)
    const whole = Math.floor(rest.length / 3) * 3
    const core = rest.subarray(0, whole).toString('base64')
    if (core.length < MIN_SECRET) continue
    const tail = rest.subarray(whole).toString('base64')
    const bare = tail.replace(/=+$/, '')
    out.push(textPattern(core, true) + (bare ? `(?:${textPattern(bare, true)}(?:${charPattern('=', true)}){0,${tail.length - bare.length}})?` : ''))
  }
  return out
}

/** A function that replaces every form of these values with HIDDEN. Values shorter than MIN_SECRET are left out. */
export function secretHider(values: Iterable<string | null | undefined>): (text: string) => string {
  const patterns = new Set<string>()
  for (const raw of values) {
    if (!raw) continue
    for (const v of new Set([raw, raw.trim()])) {
      if (v.length < MIN_SECRET) continue
      patterns.add(textPattern(v))
      for (const p of base64Patterns(v)) patterns.add(p)
    }
  }
  if (!patterns.size) return (s) => s
  // longer patterns first: a whole base64 text before its core, a value before a shorter one inside it
  const re = new RegExp([...patterns].sort((a, b) => b.length - a.length).join('|'), 'g')
  return (text) => text.replace(re, HIDDEN)
}

/** The same for every string (and key) in a JSON-like value. */
export function hideDeep<T>(value: T, hide: (s: string) => string): T {
  if (typeof value === 'string') return hide(value) as T
  if (Array.isArray(value)) return value.map((v) => hideDeep(v, hide)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [hide(k), hideDeep(v, hide)])) as T
  return value
}
