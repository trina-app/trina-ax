// Web addresses that came back from an external-service connection, and the echo check (docs/DECISIONS.md "Outbound
// web channels", "save_url", "Web links: a bigger budget"; migrations 325, 329).
//
// What a connection returns (an MCP tool's text or resource link, an api_request answer) can name files at the
// service's own CDN: a generated image's signed URL. save_url may open such an address without a card, as a learned
// link within the link budget (tools/url-gate.ts), like a search result: its content is the service's, and which one
// the AI picks is bounded by the budget. Unless it is an echo: a service may repeat what it was sent, and then the
// "service's address" is one the AI chose (https://attacker.example/?d=<data>). So every tool input of a chat leaves
// marks (chat_sent_marks), and an address that comes back carrying one is recorded as an echo (always a card):
//   - the address itself (also with its case and its runs of / and \ folded), its host and path (16+ characters: the
//     service added or changed the query), or its query string (8+ characters), was in an input;
//   - an address written inside it (%-decoded: https://svc.example/out?to=<the AI's address>) was in an input;
//   - a 20-character window of a long random-looking part of it (opaqueParts, folded to one case so a part moved into
//     a host or re-cased still matches) was in one.
// An address the AI wrote inside one of its own addresses (a redirector's ?q=<address>, a share page's ?u=) counts as
// sent like a top-level one: the site may redirect to it or list it as a link to another site.
// The whole input is read, each string as the AI wrote it (not JSON-escaped). An input too large to mark completely
// (MARK_INPUT_CHARS, MAX_INPUT_URLS, MAX_INPUT_PARTS, INPUT_MARKS) marks the chat as a whole: every address that comes
// back afterwards is an echo (fail closed; before, the part past the limits left no marks, so 64 KB of padding or 500
// other addresses in front of an address hid it). save_url also checks each redirect against the marks.
// Marks are the first 16 bytes of a SHA-256: no input text is kept. Addresses that came from the services themselves
// leave no marks when the AI sends them on (an image-to-image call with the last result's URL), so a chain of edits
// does not ask every time. What is not caught: a service that keeps what it was sent and gives it back later in pieces
// shorter than the marks, or changed in other ways (re-encoded, shortened in another chat); the query-length card
// (MAX_UNCONFIRMED_QUERY) and the budget still apply to those.
//
// The same check covers every learned web link (2026-11-01, with the bigger link budget): a web search result and a
// link of a page web_fetch read are checked against the marks as they come (webEcho; chat_seen_urls.echo), and an echo
// always asks, so the budget only bounds which of the page's own links the AI picks. Search results and links of
// fetched pages are the web's own addresses, like a service's: the AI sending one on (web_fetch's input) leaves no
// marks. A link on the page's own site does not count what the page's address itself carries (a page links to itself
// with ?page=2, an item list repeats its path): that went to the site already when the page was opened. web_fetch also
// checks each redirect like save_url (redirectGuard).
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { Locale } from '@mycel/shared/api'
import { ToolError } from '../policy/errors'
import { extractUrls, normUrl, opaqueParts, siteOf, TEXT as GATE_TEXT, type TurnPerson } from './url-gate'

/** the window length of a random-looking part (the same as opaqueParts' minimum) */
export const MARK_WINDOW = 20
/** a query this long counts as data when it comes back */
export const MARK_QUERY_MIN = 8
/** a host and path this long count as data when they come back with another query */
export const MARK_PATH_MIN = 16
/** one input is marked completely up to these sizes; a larger one marks the chat as a whole (fail closed) */
export const MARK_INPUT_CHARS = 4 * 1024 * 1024
export const MAX_INPUT_URLS = 5000
export const MAX_INPUT_PARTS = 2000
export const INPUT_MARKS = 20_000
/** windows kept of one long part (longer parts are sampled evenly) */
const PART_WINDOWS = 64
/** marks of one chat; past that, every address that comes back is treated as an echo (fail closed) */
export const MAX_CHAT_MARKS = 50_000
/** addresses remembered from one answer of a connection */
export const MAX_URLS_PER_ANSWER = 200

const digest = (kind: string, v: string) => crypto.createHash('sha256').update(kind).update('\0').update(v).digest().subarray(0, 16)
const FULL = digest('full', '')
/** %-escapes decoded where they are valid UTF-8 (a stray "%" elsewhere in the text does not stop the rest) */
const decoded = (s: string) => s.includes('%') ? s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m) } catch { return m } }) : s
/** an address with its case and its runs of / and \ folded (a service that rewrites one still gives the same mark) */
const folded = (u: string) => u.toLowerCase().replace(/[\\/]+/g, '/')
/** host + path (no scheme, no query), folded */
function hostPath(u: URL): string { return folded(u.host + u.pathname) }

/** Windows of the long random-looking parts of `text` (as written and %-decoded), `every`: all of them (an address
 * that came back) or an even sample of PART_WINDOWS per part (an input). null: more parts than `maxParts`. Each window
 * is lowercased (folded) so a part moved into a host (which the URL parser lowercases) or re-cased still matches:
 * opaqueParts decides what is random-looking from the original case, the mark only compares case-insensitively. */
function windows(text: string, every: boolean, maxParts = 200): string[] | null {
  const out = new Set<string>()
  for (const form of new Set([text, decoded(text)])) {
    const parts = opaqueParts(form, maxParts + 1)
    if (parts.length > maxParts) return null
    for (const p of parts) {
      const count = p.length - MARK_WINDOW + 1
      const step = every || count <= PART_WINDOWS ? 1 : count / PART_WINDOWS
      for (let i = 0; i < count; i += step) out.add(p.slice(Math.floor(i), Math.floor(i) + MARK_WINDOW).toLowerCase())
    }
  }
  return [...out]
}

/** The address-level marks of one address: itself, folded, its host + path, its query. */
function addressMarks(u: string): Buffer[] {
  const p = new URL(u)
  const q = p.search.slice(1)
  const hp = hostPath(p)
  return [digest('url', u), digest('folded', folded(u)), ...(hp.length >= MARK_PATH_MIN ? [digest('path', hp)] : []), ...(q.length >= MARK_QUERY_MIN ? [digest('query', q)] : [])]
}

/** The addresses written inside an address (%-decoded: https://svc.example/out?to=<an address>), each also cut at its
 * first "&" (the outer address's next parameter); not the address itself. */
function innerUrls(url: string): Set<string> {
  const inner = new Set<string>()
  for (const u of extractUrls(decoded(url).slice(1), 50)) {
    inner.add(u)
    const cut = u.indexOf('&')
    const n = cut > 0 ? normUrl(u.slice(0, cut)) : null
    if (n) inner.add(n)
  }
  inner.delete(url)
  return inner
}

/** The marks an address carries when it comes back: its own (addressMarks), those of every address written inside it
 * (also cut at its first "&": the outer address's next parameter), every window of its random-looking parts. null: too
 * many such parts to look at (taken as an echo). */
export function urlMarks(url: string): Buffer[] | null {
  const inner = innerUrls(url)
  const ws = windows(url.replace(/^https?:\/\//i, ''), true, MAX_INPUT_PARTS)
  if (ws === null) return null
  return [...addressMarks(url), ...[...inner].flatMap(addressMarks), ...ws.map((w) => digest('w', w))]
}

/** The marks a tool input leaves; `known` addresses (the services' own) leave none. [FULL] when the input is too large
 * to mark completely (the chat then counts every address that comes back as an echo). */
export function inputMarks(text: string, known: (url: string) => boolean = () => false): Buffer[] {
  if (text.length > MARK_INPUT_CHARS) return [FULL]
  const out = new Map<string, Buffer>()
  const add = (b: Buffer) => { out.set(b.toString('hex'), b) }
  const skip = new Set<string>()
  // as written and %-decoded (an address the AI sent %-encoded inside another one)
  const urls = new Set([...extractUrls(text, MAX_INPUT_URLS + 1), ...(text.includes('%') ? extractUrls(decoded(text), MAX_INPUT_URLS + 1) : [])])
  if (urls.size > MAX_INPUT_URLS) return [FULL]
  for (const u of urls) {
    if (known(u)) { for (const w of windows(u.replace(/^https?:\/\//i, ''), true) ?? []) skip.add(w); continue }
    for (const m of addressMarks(u)) add(m)
    // an address the AI wrote inside its address (a redirector's ?q=, a share page's ?u=) is sent too: the site may
    // redirect to it or list it as a link to another site, and that hop or link must count as an echo
    for (const v of innerUrls(u)) for (const m of addressMarks(v)) add(m)
  }
  const ws = windows(text, false, MAX_INPUT_PARTS)
  if (ws === null) return [FULL]
  for (const w of ws) if (!skip.has(w)) add(digest('w', w))
  if (out.size > INPUT_MARKS) return [FULL]
  return [...out.values()]
}

/** What one tool input says, for the marks: every string in it as the AI wrote it (keys too; not JSON-escaped, so a
 * service that gives a value back as written matches), one per line. null: nested too deep or too large to read whole
 * (marks the chat as a whole). */
export function textOf(input: unknown): string | null {
  if (typeof input === 'string') return input
  const out: string[] = []
  let size = 0
  let whole = true
  const walk = (v: unknown, depth: number) => {
    if (!whole) return
    if (size > MARK_INPUT_CHARS || depth > 64) { whole = false; return }
    if (typeof v === 'string') { out.push(v); size += v.length + 1 }
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') { out.push(String(v)); size += 8 }
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); size += k.length + 1; walk(x, depth + 1) }
  }
  walk(input, 0)
  return whole && size <= MARK_INPUT_CHARS ? out.join('\n') : null
}

/** The addresses that came from outside in this chat, not echoes: those connections returned, web search results and
 * links of fetched pages (learned links). Left out of the marks: the AI sending one on chose nothing in it. Not the
 * addresses the person typed or allowed (the AI may have written their parts; a typed address can carry the person's
 * data). */
function knownUrls(db: Database, chatId: string): (url: string) => boolean {
  const conn = db.query('SELECT 1 FROM chat_connection_urls WHERE chat_id = ? AND url = ? AND echo = 0')
  const web = db.query("SELECT 1 FROM chat_seen_urls WHERE chat_id = ? AND url = ? AND echo = 0 AND (source IS NULL OR source IN ('fetched', 'search'))")
  return (url) => !!conn.get(chatId, url) || !!web.get(chatId, url)
}

/** Note what the AI sends in a tool input of this chat (every tool: the server's, the connections', the engine's own). */
export function recordSent(db: Database, chatId: string | null, input: unknown): void {
  if (!chatId || input === undefined || input === null) return
  const text = textOf(input)
  if (text === '') return
  const marks = text === null ? [FULL] : inputMarks(text, knownUrls(db, chatId))
  if (!marks.length) return
  try {
    db.transaction(() => {
      const n = (db.query('SELECT COUNT(*) AS n FROM chat_sent_marks WHERE chat_id = ?').get(chatId) as { n: number }).n
      const ins = db.query('INSERT OR IGNORE INTO chat_sent_marks (chat_id, mark) VALUES (?, ?)')
      if (n + marks.length > MAX_CHAT_MARKS) { ins.run(chatId, FULL); return }
      for (const m of marks) ins.run(chatId, m)
    })()
  } catch { /* a chat deleted meanwhile: nothing to keep */ }
}

/** Does an address carry one of the marks (`has`)? `except`: marks that do not count (hex). */
function carries(url: string, has: (m: Buffer) => boolean, except?: ReadonlySet<string>): boolean {
  const marks = urlMarks(url)
  return marks === null || marks.some((m) => !except?.has(m.toString('hex')) && has(m))
}

/** Is this address (as it came back) an echo of what the AI sent in this chat? `except`: marks that do not count (hex;
 * save_url's redirect check: those of the address it was asked to save, which its own input left) */
export function isEcho(db: Database, chatId: string, url: string, except?: ReadonlySet<string>): boolean {
  const has = db.query('SELECT 1 FROM chat_sent_marks WHERE chat_id = ? AND mark = ?')
  if (has.get(chatId, FULL)) return true
  return carries(url, (m) => !!has.get(chatId, m), except)
}

/** isEcho for many addresses at once (a fetched page's links, a search's results): the chat's marks read once. */
export type EchoCheck = (url: string) => boolean
function echoCheck(db: Database, chatId: string, except?: (url: string) => ReadonlySet<string> | undefined): EchoCheck {
  const set = new Set((db.query('SELECT mark FROM chat_sent_marks WHERE chat_id = ?').all(chatId) as { mark: Uint8Array }[]).map((r) => Buffer.from(r.mark).toString('hex')))
  if (set.has(FULL.toString('hex'))) return () => true
  if (!set.size) return () => false
  return (url) => carries(url, (m) => set.has(m.toString('hex')), except?.(url))
}

/** The site an address belongs to (registrable domain), or its host when it has none (an IP address, a single label). */
function siteKey(url: string): string | null {
  try { return siteOf(url) ?? new URL(url).hostname.toLowerCase() } catch { return null }
}

/**
 * The echo check of learned web links, decided as they come (url-gate rememberUrls): a web search's results (no
 * `page`) or the links of the page web_fetch just read (`page`: the address asked for and the one it ended at after
 * redirects). The page's own addresses are no echo (they were just opened). A link on the page's own site does not
 * count the marks the page's address itself carries: pages link to themselves with another query (?page=2, ?id= of
 * the next item), and what the page's address carried went to that site already when it was opened (after its card,
 * or as the person typed it). A link to another site carrying them still counts (a share link with the page's
 * address, the AI's address written out on a search page), and so does a redirect of an excused link to another site
 * (redirectGuard: a search page's own /url?q=<the AI's address> goes to its own site; where it redirects to is checked
 * in full).
 */
export function webEcho(db: Database, chatId: string, page: string[] = []): EchoCheck {
  const pages = new Set(page.map((p) => normUrl(p)).filter((p): p is string => !!p))
  const sites = new Set([...pages].map(siteKey).filter((x): x is string => !!x))
  const own = new Set([...pages].flatMap((p) => urlMarks(p) ?? []).map((m) => m.toString('hex')))
  const check = echoCheck(db, chatId, (url) => own.size && sites.has(siteKey(url) ?? '') ? own : undefined)
  return (url) => !pages.has(url) && check(url)
}

/** Addresses written out in a connection's answer (as the AI sees it: secrets already hidden), http(s) only. */
export function answerUrls(text: string, links: string[] = []): string[] {
  const out = new Set<string>()
  for (const u of [...links.map((l) => normUrl(l)).filter((x): x is string => !!x), ...extractUrls(text, MAX_URLS_PER_ANSWER)]) {
    // an address with a hidden key in it is no address (hide.ts writes "[hidden key]" in its place)
    if (/%5Bhidden|\[hidden/i.test(u) || u.length > 4000) continue
    out.add(u)
    if (out.size >= MAX_URLS_PER_ANSWER) break
  }
  return [...out]
}

/** Remember the addresses a connection's answer named, for save_url; each checked for an echo now (against what the
 * AI had sent before, this call's own input included). */
export function rememberConnectionUrls(db: Database, chatId: string, urls: string[], o: { integrationId: string; userId: string; turnId: string | null }): void {
  if (!urls.length) return
  try {
    db.transaction(() => {
      const ins = db.query(`INSERT INTO chat_connection_urls (chat_id, url, integration_id, user_id, turn_id, echo) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (chat_id, url) DO UPDATE SET echo = MAX(echo, excluded.echo)`)
      for (const u of urls) ins.run(chatId, u, o.integrationId, o.userId, o.turnId, isEcho(db, chatId, u) ? 1 : 0)
    })()
  } catch { /* a chat or connection deleted meanwhile */ }
}

/**
 * The redirect check of save_url and web_fetch: a redirect to an address that echoes what the AI sent in this chat (a
 * link shortener, a service's "/out?to=<the AI's address>") asks the person first, whatever opened the first address;
 * where nobody can be asked it is not followed. What the asked-for address itself carries does not count for a hop on
 * its own site (its own input left those marks: http -> https of the same path is no echo), nor what a hop the person
 * allowed carries, on that hop's site. A hop to another site is checked in full: what went to one site is not passed on
 * to another without the person (a page's own link excused by webEcho, /url?q=<the AI's address>, cannot redirect
 * there either). Returns the check to call with each next address before it is requested, and whether the person
 * allowed a hop.
 */
export function redirectGuard(db: Database, chatId: string | null, start: string, person: TurnPerson | null, words: {
  /** the card's question, {url} for the address */
  ask: Record<Locale, string>
  /** for the AI: nobody could be asked / the person said no */
  unattended: string
  declined: string
}): { check: (next: string) => Promise<void>; confirmed: () => boolean } {
  // the marks that do not count, by the site they went to
  const own = new Map<string, Set<string>>()
  const excuse = (url: string) => {
    const k = siteKey(url) ?? ''
    const set = own.get(k) ?? new Set<string>()
    for (const m of urlMarks(url) ?? []) set.add(m.toString('hex'))
    own.set(k, set)
  }
  excuse(normUrl(start) ?? start)
  let confirmed = false
  return {
    confirmed: () => confirmed,
    async check(next) {
      const u = normUrl(next)
      if (!chatId || !u || !isEcho(db, chatId, u, own.get(siteKey(u) ?? ''))) return
      if (!person || person.unattended) throw new ToolError(words.unattended)
      const L = person.locale
      const question = words.ask[L].replace('{url}', () => u.length > 2000 ? u.slice(0, 2000) + '…' : u)
      if (!(await person.confirm(question, GATE_TEXT.allow[L], GATE_TEXT.deny[L]))) throw new ToolError(words.declined)
      excuse(u)
      confirmed = true
    },
  }
}
