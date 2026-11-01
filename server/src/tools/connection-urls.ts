// Web addresses that came back from an external-service connection, and the echo check (docs/DECISIONS.md "Outbound
// web channels", "save_url"; migration 325).
//
// What a connection returns (an MCP tool's text or resource link, an api_request answer) can name files at the
// service's own CDN: a generated image's signed URL. save_url may open such an address without a card, as a learned
// link within the link budget (tools/url-gate.ts), like a search result: its content is the service's, and which one
// the AI picks is bounded by the budget. Unless it is an echo: a service may repeat what it was sent, and then the
// "service's address" is one the AI chose (https://attacker.example/?d=<data>). So every tool input of a chat leaves
// marks (chat_sent_marks), and an address that comes back carrying one is recorded as an echo (always a card):
//   - the address itself, or its query string (8+ characters), was in an input;
//   - a 20-character window of a long random-looking part of it (opaqueParts) was in one.
// Marks are the first 16 bytes of a SHA-256: no input text is kept. Addresses that came from the services themselves
// leave no marks when the AI sends them on (an image-to-image call with the last result's URL), so a chain of edits
// does not ask every time. What is not caught: a service that keeps what it was sent and gives it back later in pieces
// shorter than the marks; the query-length card (MAX_UNCONFIRMED_QUERY) and the budget still apply to those.
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { extractUrls, normUrl, opaqueParts } from './url-gate'

/** the window length of a random-looking part (the same as opaqueParts' minimum) */
export const MARK_WINDOW = 20
/** a query this long counts as data when it comes back */
export const MARK_QUERY_MIN = 8
/** the part of one input looked at */
export const MARK_INPUT_CHARS = 64 * 1024
/** windows kept of one long part (longer parts are sampled evenly) and marks of one input */
const PART_WINDOWS = 64
const INPUT_MARKS = 2000
/** marks of one chat; past that, every address that comes back is treated as an echo (fail closed) */
export const MAX_CHAT_MARKS = 50_000
/** addresses remembered from one answer of a connection */
export const MAX_URLS_PER_ANSWER = 200

const digest = (kind: string, v: string) => crypto.createHash('sha256').update(kind).update('\0').update(v).digest().subarray(0, 16)
const FULL = digest('full', '')
const decoded = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

/** Windows of the long random-looking parts of `text` (as written and %-decoded), `every`: all of them (an address
 * that came back) or an even sample of PART_WINDOWS per part (an input). */
function windows(text: string, every: boolean): string[] {
  const out = new Set<string>()
  for (const form of new Set([text, decoded(text)])) {
    for (const p of opaqueParts(form, 200)) {
      const count = p.length - MARK_WINDOW + 1
      const step = every || count <= PART_WINDOWS ? 1 : count / PART_WINDOWS
      for (let i = 0; i < count; i += step) out.add(p.slice(Math.floor(i), Math.floor(i) + MARK_WINDOW))
    }
  }
  return [...out]
}

/** The marks an address carries when it comes back: itself, its query, every window of its random-looking parts. */
export function urlMarks(url: string): Buffer[] {
  const u = new URL(url)
  const q = u.search.slice(1)
  return [digest('url', url), ...(q.length >= MARK_QUERY_MIN ? [digest('query', q)] : []), ...windows(url.replace(/^https?:\/\//i, ''), true).map((w) => digest('w', w))]
}

/** The marks a tool input leaves; `known` addresses (the services' own) leave none. */
export function inputMarks(text: string, known: (url: string) => boolean = () => false): Buffer[] {
  const t = text.length > MARK_INPUT_CHARS ? text.slice(0, MARK_INPUT_CHARS) : text
  const out = new Map<string, Buffer>()
  const add = (b: Buffer) => { if (out.size < INPUT_MARKS) out.set(b.toString('hex'), b) }
  const skip = new Set<string>()
  for (const u of extractUrls(t, 500)) {
    if (known(u)) { for (const w of windows(u.replace(/^https?:\/\//i, ''), true)) skip.add(w); continue }
    add(digest('url', u))
    const q = new URL(u).search.slice(1)
    if (q.length >= MARK_QUERY_MIN) add(digest('query', q))
  }
  for (const w of windows(t, false)) if (!skip.has(w)) add(digest('w', w))
  return [...out.values()]
}

const textOf = (input: unknown): string => {
  if (typeof input === 'string') return input
  try { return JSON.stringify(input) ?? '' } catch { return '' }
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
  if (!text) return
  const marks = inputMarks(text, knownUrls(db, chatId))
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

/** Is this address (as it came back) an echo of what the AI sent in this chat? */
export function isEcho(db: Database, chatId: string, url: string): boolean {
  const has = db.query('SELECT 1 FROM chat_sent_marks WHERE chat_id = ? AND mark = ?')
  if (has.get(chatId, FULL)) return true
  return urlMarks(url).some((m) => !!has.get(chatId, m))
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
