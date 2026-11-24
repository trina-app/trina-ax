// The one input a step line shows after a tool's name, like Claude Code shows a call's search query, address, path or
// command (docs/decisions/20261124-step-key-input.md): `Search Engine · "YC Korea founders 2025"`,
// `Scrape as Markdown · linkedin.com/in/…`. Chosen from the call's arguments and the tool's input schema by what each
// argument is called, never from a list of tools or services, so a connection added tomorrow reads the same way.
// What may never show: an argument named like a secret (token, key, password, auth, cookie …), a value that looks like
// one (findSecrets) or like a random id, an address's query, fragment and user part. Long values are cut.
import { looksRandom, maskSecrets, secretLabel } from './secrets'

/** What an argument is, by the last word of its name ("search_query" -> query, "pageUrl" -> url), best first. */
const KINDS: { kind: KeyKind; words: ReadonlySet<string> }[] = [
  { kind: 'text', words: new Set(['query', 'q', 'search', 'keyword', 'keywords', 'prompt', 'question', 'term', 'terms']) },
  { kind: 'url', words: new Set(['url', 'urls', 'uri', 'link', 'links', 'href', 'website', 'domain', 'site']) },
  { kind: 'path', words: new Set(['path', 'paths', 'file', 'files', 'filename', 'filepath', 'folder', 'dir', 'directory']) },
  { kind: 'command', words: new Set(['command', 'cmd', 'script']) },
  { kind: 'text', words: new Set(['name', 'title', 'subject', 'topic', 'text', 'message']) },
]
export type KeyKind = 'text' | 'url' | 'path' | 'command'

/** Words of an argument's name that mark it as a secret wherever they stand ("auth_header", "session_id"). */
const SECRET_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'passphrase', 'apikey', 'auth', 'authorization',
  'cookie', 'cookies', 'credential', 'credentials', 'session', 'signature', 'sig', 'bearer', 'otp', 'jwt', 'key', 'keys', 'pin', 'passcode', 'cvv', 'ssn'])

const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** An argument's name that says it holds a secret: never shown, whatever its value. */
export function secretArgName(name: string): boolean {
  if (secretLabel(name)) return true
  const w = words(name)
  return w.some((x) => SECRET_WORDS.has(x)) || SECRET_WORDS.has(w.join(''))
}

const rankOf = (name: string): { rank: number; kind: KeyKind } | null => {
  const w = words(name)
  const last = w.at(-1) ?? ''
  const whole = w.join('')
  for (let i = 0; i < KINDS.length; i++) if (KINDS[i]!.words.has(last) || KINDS[i]!.words.has(whole)) return { rank: i, kind: KINDS[i]!.kind }
  return null
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
/** One run of characters that means nothing to a person: an id, a hash, base64, a generated token. */
export function opaqueValue(s: string): boolean {
  const v = s.trim()
  if (UUID.test(v) || /^[0-9a-f]{16,}$/i.test(v)) return true
  if (/\s/.test(v) || v.length < 20) return false
  return looksRandom(v) || (/^[A-Za-z0-9+/=]{32,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v))
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clipEnd = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
/** a path cut at its start: the end names the file */
const clipStart = (s: string, n: number) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s)

/** An address as a step shows it: host (no "www.") and path, no scheme, user, query or fragment; an id in the path as "…". */
export function stepUrl(raw: string, max = 60): string | null {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (!/^https?:$|^wss?:$|^ftp:$/.test(u.protocol)) return null
  const host = u.hostname.replace(/^www\./, '')
  const segs = u.pathname.split('/').filter(Boolean).map((p) => { let d = p; try { d = decodeURIComponent(p) } catch {} return opaqueValue(d) || maskSecrets(d) !== d ? '…' : d })
  const shown = [host, ...segs].join('/').replace(/(?:\/…)+/g, '/…')
  return maskSecrets(clipEnd(shown, max), '…')
}

/** A value of the kind its argument is, as a step shows it, or null when nothing in it may show. */
export function stepValue(value: string, kind: KeyKind): { text: string; quoted: boolean } | null {
  const v = oneLine(value)
  if (!v || opaqueValue(v)) return null
  const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(v)
  if (kind === 'url' || looksUrl) {
    const u = stepUrl(v)
    if (u) return { text: u, quoted: false }
    if (kind === 'url') return null
  }
  let text: string
  if (kind === 'path') text = clipStart(v, 60)
  else if (kind === 'command') text = clipEnd(value.trim().split('\n')[0]!.trim(), 60)
  else text = clipEnd(v, 60)
  // a secret inside the words is left out, and a value that was all secret shows nothing
  const masked = maskSecrets(text, '…').replace(/(?:…\s*){2,}/g, '…')
  if (!/[\p{L}\p{N}]/u.test(masked.replace(/…/g, ''))) return null
  return { text: masked, quoted: kind === 'text' }
}

type Schema = { properties?: Record<string, unknown>; required?: unknown } | null | undefined

/** One string argument (or the first of a list of strings, with how many more) that may show. */
function valueOf(v: unknown): { s: string; more: number } | null {
  if (typeof v === 'string') return v.trim() ? { s: v, more: 0 } : null
  if (Array.isArray(v)) {
    const strs = v.filter((x): x is string => typeof x === 'string' && !!x.trim())
    return strs.length ? { s: strs[0]!, more: strs.length - 1 } : null
  }
  return null
}

/**
 * The key input of one call, or null: the best-named argument (a query, then an address, a path, a command, a name or
 * title), ties going to the schema's required arguments, then its order, then the call's. Without a well-named one,
 * the first required string argument of the schema. Never an argument named like a secret, or a value that is one.
 */
export function stepKeyInput(input: unknown, schema?: unknown): { text: string; quoted: boolean; more: number } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const a = input as Record<string, unknown>
  const s = (schema && typeof schema === 'object' ? schema : null) as Schema
  const required = Array.isArray(s?.required) ? (s!.required as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const props = s?.properties && typeof s.properties === 'object' ? Object.keys(s.properties) : []
  const order = [...new Set([...required, ...props, ...Object.keys(a)])].filter((k) => Object.hasOwn(a, k) && !secretArgName(k))
  const ranked = order.map((k, i) => ({ k, i, r: rankOf(k) })).filter((x) => x.r).sort((x, y) => x.r!.rank - y.r!.rank || x.i - y.i)
  for (const { k, r } of ranked) {
    const v = valueOf(a[k])
    const shown = v && stepValue(v.s, r!.kind)
    if (shown) return { ...shown, more: v!.more }
  }
  for (const k of required) {
    if (secretArgName(k) || !Object.hasOwn(a, k)) continue
    const v = valueOf(a[k])
    const shown = v && v.s.length <= 200 ? stepValue(v.s, 'text') : null
    if (shown) return { ...shown, more: v!.more }
  }
  return null
}

/** " · "<query>"", " · <address>" (+N for a list), or '' : what a step line adds after a tool's name. */
export function keyInputSuffix(input: unknown, schema?: unknown): string {
  const k = stepKeyInput(input, schema)
  if (!k) return ''
  return ` · ${k.quoted ? `"${k.text}"` : k.text}${k.more ? ` +${k.more}` : ''}`
}
