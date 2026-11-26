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
  { kind: 'command', words: new Set(['command', 'cmd']) },
  // "summary": an event's or an issue's title in the Calendar and Jira APIs
  { kind: 'text', words: new Set(['name', 'title', 'subject', 'summary', 'headline', 'topic', 'text', 'message']) },
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

/** characters that show nothing or turn text around (bidi controls, joiners aside): never in a step line */
const INVISIBLE = /(?![\t\n\r\u200d\ufe0e\ufe0f])[\p{Cc}\p{Cf}\p{DI}\p{Co}]/gu
const oneLine = (s: string) => s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
const clipEnd = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
/** a path cut at its start: the end names the file */
const clipStart = (s: string, n: number) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s)

/** The secrets in a value left out, before anything cuts it (a cut through a key would leave part of it): what
 * findSecrets finds, a value after a flag or label named like a secret ("--password=…", "--token …"), the password of
 * "-u user:password" / "--user", the "-p<password>" of the database clients that take one there (mysql, mariadb …) and
 * sshpass's "-p <password>", an AWS access key id and a 40-character secret key, and a session id in an address's path
 * (";jsessionid=…"). Any other "-p…" flag ("-print", "-pthread") stays. */
export function hideInValue(v: string, command = false): string {
  let out = v.replace(/;\s*jsessionid=[^/?#\s]*/gi, '')
    .replace(/((?:^|[\s"'])--?(?:password|passwd|pass|pwd|passphrase|token|secret|api[-_]?key|apikey|auth|authorization)(?:=|:\s*|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1…')
    .replace(/((?:^|\s)(?:-u|--user)(?:=|\s+)["']?[^\s:"']+):[^\s"']+/g, '$1:…')
    // an AWS access key id (AKIA…, ASIA…) and a secret access key: 40 characters of base64 with both cases
    .replace(/(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, '…')
    .replace(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9/+]/.test(m) ? '…' : m))
  if (command) {
    out = out.replace(/(^|[|;&(]\s*)((?:sudo\s+)?(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb|mariadb-dump|mariadb-admin)\b[^|;&]*)/g, (_m, pre: string, seg: string) => pre + seg.replace(/(\s)-p(?!\s)\S+/g, '$1-p…'))
      .replace(/(^|[|;&(]\s*)((?:sudo\s+)?sshpass\b[^|;&]*)/g, (_m, pre: string, seg: string) => pre + seg.replace(/(\s)-p\s*(?!-)\S+/g, '$1-p …'))
  }
  return maskSecrets(out, '…').replace(/(?:…\s*){2,}/g, '…')
}

/** An address as a step shows it: host (no "www.") and path, no scheme, user, query, fragment or path parameters
 * (";jsessionid=…"); an id or a key in the path as "…". Secrets out first, then cut. */
export function stepUrl(raw: string, max = 60): string | null {
  let u: URL
  try { u = new URL(oneLine(raw)) } catch { return null }
  if (!/^https?:$|^wss?:$|^ftp:$/.test(u.protocol)) return null
  const host = u.hostname.replace(/^www\./, '')
  const segs = u.pathname.split('/').filter(Boolean).map((p) => { let d = p.split(';')[0]!; try { d = decodeURIComponent(d) } catch {} d = oneLine(d); return !d || opaqueValue(d) || hideInValue(d) !== d ? '…' : d })
  const shown = hideInValue([host, ...segs].join('/').replace(/(?:\/…)+/g, '/…'))
  return clipEnd(shown, max)
}

/** An address of a kind no step shows (a file on this computer, inline data, script): never in a line. Only an address:
 * the scheme and then no space ("javascript: closures tutorial" is words) */
const OTHER_SCHEME = /^(?:file|data|javascript|vbscript|blob|about|chrome|jar|smb):(?!\s)/i

/** A value of the kind its argument is, as a step shows it, or null when nothing in it may show. Secrets come out of
 * the whole value first; only then is it cut to fit. */
export function stepValue(value: string, kind: KeyKind): { text: string; quoted: boolean } | null {
  const v = oneLine(value)
  if (!v || opaqueValue(v)) return null
  const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(v)
  if (kind === 'url' || looksUrl || OTHER_SCHEME.test(v)) {
    const u = stepUrl(v)
    return u ? { text: u, quoted: false } : null
  }
  // one long run without a space, a dot or a slash is no words a person wrote (a key, a token, an encoded blob)
  if (kind !== 'path' && kind !== 'command' && !/[\s./]/.test(v) && v.length >= 40) return null
  // code in an argument named like words: never as it is (people reading the steps are not developers); its address may
  if (kind !== 'path' && kind !== 'command' && codeLike(v)) { const u = addressIn(v); return u ? { text: u, quoted: false } : null }
  const whole = kind === 'command' ? oneLine(value.trim().split('\n')[0]!) : v
  const masked = hideInValue(whole, kind === 'command')
  // a value that was all secret shows nothing
  if (!/[\p{L}\p{N}]/u.test(masked.replace(/…/g, ''))) return null
  const text = kind === 'path' ? clipStart(masked, 60) : clipEnd(masked, 60)
  return { text, quoted: kind === 'text' }
}

/** Arguments that hold code (a script, an expression): never a step's key input, since the people reading the steps are not
 * developers; an address inside it may show (`Run a browser script · example.com`). A shell command is not one of
 * them: it shows, as in Claude Code. */
const CODE_WORDS = new Set(['script', 'scripts', 'code', 'javascript', 'js', 'source', 'expression', 'expr', 'eval', 'snippet', 'program', 'function', 'func', 'lambda', 'sql'])
export const codeArgName = (name: string): boolean => { const w = words(name); return w.some((x) => CODE_WORDS.has(x)) || CODE_WORDS.has(w.join('')) }
/** Text that reads as code rather than words (an arrow, a call on an object, a statement keyword, braces, `$(…)`). */
export const codeLike = (v: string): boolean =>
  /=>|\$\(|`|\b(?:await|function|const|let|var|return|import|def|lambda|SELECT|INSERT|UPDATE|DELETE)\s|\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(|[{};]\s*$|^\s*[{[(]|\/\/\s|\)\s*;|==|!=|&&|\|\|/.test(v)
/** The first web address in a piece of code, as a step shows it, or null. */
const addressIn = (v: string): string | null => { const m = /https?:\/\/[^\s"'`)<>\]]+/i.exec(v); return m ? stepUrl(m[0]) : null }

type Schema = { properties?: Record<string, unknown>; required?: unknown } | null | undefined

/** Last words of an argument's name that say it picks what kind of operation the call does ("action": "create",
 * "mode": "append"), not the item it acts on: never a step's key input (QA: `Google Calendar · 일정 관리 · "create"`). */
const CHOICE_WORDS = new Set(['action', 'actions', 'operation', 'op', 'mode', 'method', 'verb', 'type', 'kind', 'format', 'status', 'state',
  'scope', 'level', 'order', 'sort', 'direction', 'visibility', 'role', 'strategy', 'style', 'variant', 'category', 'priority'])
/** An argument that is a choice among a few words, not a name: its schema gives the values (`enum`, `const`, or a
 * `oneOf`/`anyOf` of them), or its name's last word is a CHOICE_WORDS one. */
export function choiceArg(name: string, schema?: unknown): boolean {
  const w = words(name)
  if (CHOICE_WORDS.has(w.at(-1) ?? '')) return true
  const s = (schema && typeof schema === 'object' ? schema : null) as Schema
  const p = s?.properties && typeof s.properties === 'object' && Object.hasOwn(s.properties, name) ? (s.properties as Record<string, unknown>)[name] : null
  const fixed = (x: unknown): boolean => !!x && typeof x === 'object' && (Array.isArray((x as { enum?: unknown }).enum) || Object.hasOwn(x as object, 'const'))
  if (fixed(p)) return true
  const alts = p && typeof p === 'object' ? ((p as { oneOf?: unknown }).oneOf ?? (p as { anyOf?: unknown }).anyOf) : null
  return Array.isArray(alts) && alts.length > 0 && alts.every((x) => fixed(x) || (!!x && typeof x === 'object' && (x as { type?: unknown }).type === 'null'))
}

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
 * the first required string argument of the schema that is not a choice (choiceArg: an `action`, a `mode`, an
 * `enum`). Never an argument named like a secret, or a value that is one.
 */
export function stepKeyInput(input: unknown, schema?: unknown): { text: string; quoted: boolean; more: number } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const a = input as Record<string, unknown>
  const s = (schema && typeof schema === 'object' ? schema : null) as Schema
  const required = Array.isArray(s?.required) ? (s!.required as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const props = s?.properties && typeof s.properties === 'object' ? Object.keys(s.properties) : []
  const all = [...new Set([...required, ...props, ...Object.keys(a)])].filter((k) => Object.hasOwn(a, k) && !secretArgName(k))
  const order = all.filter((k) => !codeArgName(k))
  const ranked = order.map((k, i) => ({ k, i, r: rankOf(k) })).filter((x) => x.r).sort((x, y) => x.r!.rank - y.r!.rank || x.i - y.i)
  for (const { k, r } of ranked) {
    const v = valueOf(a[k])
    const shown = v && stepValue(v.s, r!.kind)
    if (shown) return { ...shown, more: v!.more }
  }
  for (const k of required) {
    if (secretArgName(k) || codeArgName(k) || choiceArg(k, s) || !Object.hasOwn(a, k)) continue
    const v = valueOf(a[k])
    const shown = v && v.s.length <= 200 ? stepValue(v.s, 'text') : null
    if (shown) return { ...shown, more: v!.more }
  }
  // only code: the address it opens, if it names one
  for (const k of all.filter(codeArgName)) {
    const v = valueOf(a[k])
    const u = v ? addressIn(v.s) : null
    if (u) return { text: u, quoted: false, more: 0 }
  }
  return null
}

/** " · "<query>"", " · <address>" (+N for a list), or '' : what a step line adds after a tool's name. */
export function keyInputSuffix(input: unknown, schema?: unknown): string {
  const k = stepKeyInput(input, schema)
  if (!k) return ''
  return ` · ${k.quoted ? `"${k.text}"` : k.text}${k.more ? ` +${k.more}` : ''}`
}
