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
// An encoded form (base64, or the value with every character %-escaped, JSON \u-escaped or as an HTML entity) is also
// found when line breaks or other white space split it (QA TC-3096: both engines put a blank line around a tool call,
// so a base64 key the AI wrote across one came out in two parts; base64 is also often wrapped at 76 characters), and
// when JSON text writes those breaks as \n, \r or \t. The value as written is not: "QA FAKE KEY" is ordinary text.
// How (formSpans): the one big pattern runs on the text as it is; only where a long run of encoded-form characters is
// broken by white space is a copy of that stretch made without the breaks, the encoded forms' own (smaller) pattern
// runs on it, and what it finds is mapped back to the text, breaks included. The big pattern never has white space in
// it: on Bun 1.3.12 that made it about 1.7 times larger and a 1 MB answer took seconds.
// Values shorter than MIN_SECRET are left alone: they would hide ordinary words. Not caught: a service that changes the
// value in another way (hashes it, hex-encodes it, changes its case, reverses it, or splits it as written).

export const HIDDEN = '[hidden key]'
/** shorter values are not hidden (they would match ordinary words) */
export const MIN_SECRET = 8

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** a number in hex digits, each letter in either case: 0x2f -> "2[fF]" */
const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0').replace(/[A-F]/g, (c) => `[${c}${c.toLowerCase()}]`)
const NAMED: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }

/** One character as a pattern: itself, or as a URL, JSON or HTML text would escape it. Letters and digits
 * are accepted in escaped form too. In base64, "+" and "/" may also be the URL-safe "-" and "_". */
function charPattern(ch: string, base64 = false): string {
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
function base64Patterns(value: string, cores: string[] = []): string[] {
  const bytes = Buffer.from(value)
  const out: string[] = []
  for (const skip of [0, 1, 2]) {
    const rest = bytes.subarray(skip)
    const whole = Math.floor(rest.length / 3) * 3
    const core = rest.subarray(0, whole).toString('base64')
    if (core.length < MIN_SECRET) continue
    const tail = rest.subarray(whole).toString('base64')
    const bare = tail.replace(/=+$/, '')
    cores.push(core)
    out.push(textPattern(core, true) + (bare ? `(?:${textPattern(bare, true)}(?:${charPattern('=', true)}){0,${tail.length - bare.length}})?` : ''))
  }
  return out
}

/** The value with every character escaped one way (%-escaped UTF-8 bytes in either case, JSON \\u, an HTML entity in
 * decimal or hex): with base64Patterns, what the copy without breaks is searched for (formSpans). Never the value as
 * written: split by white space, that is ordinary text. */
function escapedPatterns(value: string): string[] {
  const chars = [...value]
  const out = [[...Buffer.from(value)].map((b) => '%' + hex(b, 2)).join('')]
  out.push(chars.map((c) => { const cp = c.codePointAt(0)!; return `(?:&#0*${cp};|&#[xX]0*${hex(cp, 1)};)` }).join(''))
  if (chars.every((c) => c.codePointAt(0)! <= 0xffff)) out.push(chars.map((c) => '\\\\u' + hex(c.codePointAt(0)!, 4)).join(''))
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

// longer patterns first: a whole base64 text before its core, a value before a shorter one inside it
const joined = (patterns: Set<string>) => new RegExp([...patterns].sort((a, b) => b.length - a.length).join('|'), 'g')

/** One pattern (flag g) for every form of these values, or null when there is nothing to hide. */
export function secretRegex(values: Iterable<string | null | undefined>): RegExp | null {
  return secretForms(values)?.re ?? null
}

/** The patterns of these values: `re` every form as it is written; `encoded` the encoded forms only (base64, the value
 * fully escaped), for the copy of a stretch without its breaks (formSpans); `seed` how such a form must begin (the
 * first characters of each base64 text, or an escape), a quick test before `encoded` runs on a copy. */
export interface SecretForms { re: RegExp; encoded: RegExp; seed: RegExp }

export function secretForms(values: Iterable<string | null | undefined>): SecretForms | null {
  const all = new Set<string>(), encoded = new Set<string>(), seeds = new Set<string>(['%[0-9A-Fa-f]{2}%', '&#', '\\\\u[0-9A-Fa-f]{4}\\\\u'])
  for (const v of secretValuesOf(values)) {
    all.add(textPattern(v))
    const cores: string[] = []
    for (const p of base64Patterns(v, cores)) { all.add(p); encoded.add(p) }
    // each character in any form the encoded pattern takes it in (\/ in JSON, %2F, -, _ …), or a stretch whose form
    // starts with an escaped + or / would never be searched
    for (const c of cores) seeds.add(textPattern(c.slice(0, 4), true))
    // unsplit, textPattern finds these already (it takes each character in any form)
    for (const p of escapedPatterns(v)) encoded.add(p)
  }
  if (!all.size) return null
  return { re: joined(all), encoded: joined(encoded), seed: new RegExp([...seeds].join('|')) }
}

/** Stretches of the characters encoded forms are made of (base64, URL-safe base64, %, JSON and HTML escapes) with
 * white space between them; one with a break (white space, or \n, \r, \t as written in JSON) may hold a form split
 * there. One character class: Bun 1.3.12 takes seconds over 1 MB with alternatives here. */
const STRETCH = /[A-Za-z0-9+/=_%&#;\\-]+(?:\s+[A-Za-z0-9+/=_%&#;\\-]+)*/g
const HAS_BREAK = /\s|\\[nrt]/
const BREAKS = /\s+|\\[nrt]/g

/** The stretch without its breaks, and where each character was. */
function compact(text: string, from: number, to: number): { text: string; at: number[] } {
  let out = ''
  const at: number[] = []
  for (let i = from; i < to; i++) {
    const c = text[i]!
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || /\s/.test(c)) continue
    if (c === '\\' && /[nrt]/.test(text[i + 1] ?? '')) { i++; continue }
    out += c
    at.push(i)
  }
  return { text: out, at }
}

/** The places of every form of the values in `text`, in order, joined where they touch: each match of `re`, and each
 * encoded form split by breaks (found on a copy without them, breaks included in the place). Only a stretch of
 * encoded-form characters with a break in it is copied, and `encoded` runs only on a copy where a form could begin
 * (`seed`): ordinary text costs one scan of a character class and a copy of its stretches. */
export function formSpans(text: string, f: SecretForms): [number, number][] {
  const spans: [number, number][] = []
  f.re.lastIndex = 0
  for (const m of text.matchAll(f.re)) if (m[0]) spans.push([m.index!, m.index! + m[0].length])
  STRETCH.lastIndex = 0
  for (const m of text.matchAll(STRETCH)) {
    // the shortest form is 12 characters (base64 of MIN_SECRET bytes); a stretch without a break was searched above
    if (m[0].length < 13 || !HAS_BREAK.test(m[0])) continue
    // a quick look first (no map): long enough without the breaks, and a form could begin there
    const bare = m[0].replace(BREAKS, '')
    if (bare.length < 12 || !f.seed.test(bare)) continue
    const c = compact(text, m.index!, m.index! + m[0].length)
    f.encoded.lastIndex = 0
    for (const e of c.text.matchAll(f.encoded)) if (e[0]) spans.push([c.at[e.index!]!, c.at[e.index! + e[0].length - 1]! + 1])
  }
  if (spans.length < 2) return spans
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const out: [number, number][] = [spans[0]!]
  for (const [a, b] of spans.slice(1)) {
    const last = out[out.length - 1]!
    if (a < last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** `text` with every form of the values replaced: HIDDEN, or what `by` gives for the form as written there. */
export function replaceForms(text: string, f: SecretForms, by: (form: string) => string = () => HIDDEN): string {
  if (!text) return text
  const spans = formSpans(text, f)
  if (!spans.length) return text
  let out = '', at = 0
  for (const [a, b] of spans) { out += text.slice(at, a) + by(text.slice(a, b)); at = b }
  return out + text.slice(at)
}

/** A function that replaces every form of these values with HIDDEN. Values shorter than MIN_SECRET are left out. */
export function secretHider(values: Iterable<string | null | undefined>): (text: string) => string {
  const f = secretForms(values)
  if (!f) return (s) => s
  return (text) => replaceForms(text, f)
}

/** The same for every string (and key) in a JSON-like value. */
export function hideDeep<T>(value: T, hide: (s: string) => string): T {
  if (typeof value === 'string') return hide(value) as T
  if (Array.isArray(value)) return value.map((v) => hideDeep(v, hide)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [hide(k), hideDeep(v, hide)])) as T
  return value
}
