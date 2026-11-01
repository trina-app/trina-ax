// Web addresses that came back from an external-service connection, and the echo check (docs/DECISIONS.md "Outbound
// web channels", "save_url"; migration 325).
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
// The whole input is read, each string as the AI wrote it (not JSON-escaped). An input too large to mark completely
// (MARK_INPUT_CHARS, MAX_INPUT_URLS, MAX_INPUT_PARTS, INPUT_MARKS) marks the chat as a whole: every address that comes
// back afterwards is an echo (fail closed; before, the part past the limits left no marks, so 64 KB of padding or 500
// other addresses in front of an address hid it). save_url also checks each redirect against the marks.
// Marks are the first 16 bytes of a SHA-256: no input text is kept. Addresses that came from the services themselves
// leave no marks when the AI sends them on (an image-to-image call with the last result's URL), so a chain of edits
// does not ask every time. What is not caught: a service that keeps what it was sent and gives it back later in pieces
// shorter than the marks, or changed in other ways (re-encoded, shortened in another chat); the query-length card
// (MAX_UNCONFIRMED_QUERY) and the budget still apply to those.
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { extractUrls, normUrl, opaqueParts } from './url-gate'

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

/** The marks an address carries when it comes back: its own (addressMarks), those of every address written inside it
 * (also cut at its first "&": the outer address's next parameter), every window of its random-looking parts. null: too
 * many such parts to look at (taken as an echo). */
export function urlMarks(url: string): Buffer[] | null {
  const inner = new Set<string>()
  for (const u of extractUrls(decoded(url).slice(1), 50)) {
    inner.add(u)
    const cut = u.indexOf('&')
    const n = cut > 0 ? normUrl(u.slice(0, cut)) : null
    if (n) inner.add(n)
  }
  inner.delete(url)
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

/** The addresses that came back from connections in this chat (not echoes): left out of the marks. */
function knownUrls(db: Database, chatId: string): (url: string) => boolean {
  let set: Set<string> | null = null
  return (url) => (set ??= new Set((db.query('SELECT url FROM chat_connection_urls WHERE chat_id = ? AND echo = 0').all(chatId) as { url: string }[]).map((r) => r.url))).has(url)
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

/** Is this address (as it came back) an echo of what the AI sent in this chat? `except`: marks that do not count (hex;
 * save_url's redirect check: those of the address it was asked to save, which its own input left) */
export function isEcho(db: Database, chatId: string, url: string, except?: ReadonlySet<string>): boolean {
  const has = db.query('SELECT 1 FROM chat_sent_marks WHERE chat_id = ? AND mark = ?')
  if (has.get(chatId, FULL)) return true
  const marks = urlMarks(url)
  return marks === null || marks.some((m) => !except?.has(m.toString('hex')) && !!has.get(chatId, m))
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
