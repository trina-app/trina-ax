// Content search for people (the file screen, R2-ETC-02). It uses the AI's grep (files/search.ts grepFiles), so it
// has the same permission checks: allowedRoots() picks the folders ripgrep may enter and visiblePath() checks every
// hit again. A person never finds a line in a file that they cannot open. Office documents are searched through the
// same text cache as the AI's grep, but only their fresh text: the content search extracts nothing itself. A stale or
// new office document goes to the one background queue of the server (low priority, each person in turn, at most
// OFFICE_QUEUE_PER_OWNER files of one person) and is counted in `indexing`; a file that the queue did not take is
// counted in `notQueued`. Thus a person's search never takes the extraction slots that the AI grep of another person
// needs, and one person's files do not delay the files of other people. The query is literal text (ripgrep -F, any case), so a query cannot be a slow or
// bad regular expression. Limits: results (FileContentHits.items), lines per file, time (office extraction included),
// file size (RG_BASE), line length (RG_MAX_RECORD_CHARS) and a rate limit per person. A line of an HTML file is shown
// as its text, not its markup (QA TC-260); the screen finds files by name with GET /api/files/find (team-files/find.ts).
import type { FileContentHits } from '@mycel/shared/api'
import { grepFiles } from '../files/search'
import { decodeEntities, htmlToText } from '../tools/web-fetch'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import type { TeamFiles } from './service'

/** searches one person may start in RATE_WINDOW_MS */
export const CONTENT_SEARCH_RATE_MAX = 60
const RATE_WINDOW_MS = 60_000
/** searches one person may have running at the same time; a newer search stops the oldest one (typing) */
export const CONTENT_SEARCH_PARALLEL_MAX = 2
/** the longest time one search may take, office extraction included (the AI's grep may take cfg.grepTimeoutMs) */
export const CONTENT_SEARCH_TIMEOUT_MS = 10_000
/** matching lines shown from one file, so that one big file cannot fill the list */
export const CONTENT_SEARCH_PER_FILE = 5
/** characters of a line shown around the first match */
export const SNIPPET_CHARS = 160
const SNIPPET_BEFORE = 50

const started = new Map<string, number[]>()
/** the searches that run now, per person, oldest first */
const running = new Map<string, AbortController[]>()

/**
 * Record one search for `userId`, or throw rate_limited when the person started too many in the last minute. When
 * the person already runs CONTENT_SEARCH_PARALLEL_MAX searches, the oldest one is stopped (its answer is not needed:
 * the screen shows only the newest), so typing never gets a 429. Returns the search's signal and the function that
 * marks it as done.
 */
export function admitContentSearch(userId: string): { signal: AbortSignal; done: () => void } {
  const now = Date.now()
  const times = (started.get(userId) ?? []).filter((t) => t > now - RATE_WINDOW_MS)
  if (times.length >= CONTENT_SEARCH_RATE_MAX) {
    started.set(userId, times)
    throw new HttpError('rate_limited', undefined, { retryAfter: Math.max(1, Math.ceil((times[0]! + RATE_WINDOW_MS - now) / 1000)) })
  }
  times.push(now)
  started.set(userId, times)
  const mine = running.get(userId) ?? []
  while (mine.length >= CONTENT_SEARCH_PARALLEL_MAX) mine.shift()!.abort()
  const ctrl = new AbortController()
  mine.push(ctrl)
  running.set(userId, mine)
  return {
    signal: ctrl.signal,
    done: () => {
      const i = mine.indexOf(ctrl)
      if (i >= 0) mine.splice(i, 1)
      if (!mine.length && running.get(userId) === mine) running.delete(userId)
    },
  }
}

/** for tests: forget all rate-limit state */
export function resetContentSearchLimits() { started.clear(); running.clear() }

/** A short part of `line` around the first match of `q` (any case). "…" marks text that was cut. */
export function snippetOf(line: string, q: string): string {
  const text = line.normalize('NFC')
  if (text.length <= SNIPPET_CHARS) return text
  const low = text.toLowerCase()
  // toLowerCase can change the length of some characters; then the index is not used
  let at = low.length === text.length ? low.indexOf(q.toLowerCase()) : -1
  if (at < 0) at = 0
  let start = Math.max(0, Math.min(at - SNIPPET_BEFORE, text.length - SNIPPET_CHARS))
  let end = Math.min(text.length, start + SNIPPET_CHARS)
  // do not cut a surrogate pair in two
  const low16 = (i: number) => { const c = text.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff }
  if (start > 0 && low16(start)) start++
  if (end < text.length && low16(end)) end--
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** files whose lines are shown as their readable text, not their markup (QA TC-260) */
const HTML_FILE = /\.(?:html?|xhtml)$/i
const NO_BASE = new URL('file:///')
const folded = (s: string) => s.normalize('NFC').toLowerCase()

/** a query as htmlLineText compares it: runs of white space are one space, as in the line's text */
export const htmlQuery = (q: string) => q.replace(/\s+/g, ' ').trim()

const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13)
/** The text of one line with only the markup taken out: tags (attribute values read as HTML reads them, so an
 * unquoted `alt=it's` does not start a quoted value), comments, <!doctype>/<?…?>, and the content of <script> and
 * <style>. Everything else stays, also text a page hides or keeps out of its body (<title>, `hidden`, <textarea>).
 * One forward pass; an unfinished tag or comment ends the line. */
function markupStripped(line: string): string {
  const out: string[] = []
  const low = line.toLowerCase()
  const n = line.length
  let i = 0
  while (i < n) {
    const lt = line.indexOf('<', i)
    if (lt < 0) { out.push(line.slice(i)); break }
    out.push(line.slice(i, lt))
    i = lt
    if (line.startsWith('<!--', i)) { const e = line.indexOf('-->', i + 4); if (e < 0) break; i = e + 3; out.push(' '); continue }
    const c1 = line.charCodeAt(i + 1)
    if (c1 === 33 /* ! */ || c1 === 63 /* ? */) { const e = line.indexOf('>', i); if (e < 0) break; i = e + 1; continue }
    const closing = c1 === 47 /* / */
    let j = i + (closing ? 2 : 1)
    const first = line.charCodeAt(j) | 0x20
    if (!(first >= 97 && first <= 122)) { out.push('<'); i++; continue } // "<" not followed by a letter is text
    const ns = j
    while (j < n && !isSpace(line.charCodeAt(j)) && line[j] !== '/' && line[j] !== '>') j++
    const name = low.slice(ns, j)
    // attributes: name, then = and a value; only a quote right after "=" starts a quoted value
    let gt = -1
    while (j < n) {
      const ch = line.charCodeAt(j)
      if (ch === 62 /* > */) { gt = j; break }
      if (ch !== 61 /* = */) { j++; continue }
      j++
      while (j < n && isSpace(line.charCodeAt(j))) j++
      const qc = line.charCodeAt(j)
      if (qc === 34 || qc === 39) { const e = line.indexOf(qc === 34 ? '"' : "'", j + 1); if (e < 0) { j = n; break } j = e + 1; continue }
      while (j < n && !isSpace(line.charCodeAt(j)) && line.charCodeAt(j) !== 62) j++
    }
    if (gt < 0) break // unfinished tag: the rest of the line is inside it
    i = gt + 1
    out.push(' ')
    if (!closing && (name === 'script' || name === 'style') && line[gt - 1] !== '/') {
      // the end tag: "</script" then a space, "/" or ">" ("</scripts>" is text of the script)
      let e = low.indexOf('</' + name, i)
      while (e >= 0) {
        const after = line.charCodeAt(e + 2 + name.length)
        if (isSpace(after) || after === 47 || after === 62) break
        e = low.indexOf('</' + name, e + 2)
      }
      if (e < 0) break
      i = e
    }
  }
  return out.join('')
}

/** The text of one line of an HTML file as a reader sees it: tags, scripts and styles out, entities decoded, white
 * space as one space (web_fetch's htmlToText: one forward pass, no backtracking). When that text lacks the query
 * (htmlToText also leaves out the <title> and text a page hides: `hidden`, aria-hidden, display:none, <textarea>,
 * <noscript>, <svg>), the line with only its markup taken out is tried. Null only when the query is in the markup
 * alone (a tag name, an attribute, a comment, a script or style): that line has nothing to show. A line inside a
 * multi-line <script> or <style> has no tag to see and stays as written. ripgrep's per-file cap counts lines before
 * this check, so a file whose first matching lines match only in its markup can show fewer lines (or none). */
export function htmlLineText(line: string, q: string): string | null {
  const want = folded(htmlQuery(q))
  const text = htmlToText(line, NO_BASE, { plain: true }).text.replace(/\s+/g, ' ').trim()
  if (folded(text).includes(want)) return text
  const bare = decodeEntities(markupStripped(line)).replace(/\s+/g, ' ').trim()
  return folded(bare).includes(want) ? bare : null
}

export async function searchFileContents(files: TeamFiles, userId: string, q: string, base: string, limit: number, clientSignal?: AbortSignal): Promise<FileContentHits> {
  const user = files.principal(userId)
  const rules = files.rules()
  // the same base check as the name search: a folder the person cannot list is "not found"
  const b = authorize(files.fx, rules, user, base, 'list')
  if (!b.st!.isDirectory()) throw new ToolError(`'${b.rel}' is a file`, 'not_folder')
  const query = q.trim().normalize('NFC')
  const { signal: mine, done } = admitContentSearch(userId)
  // the search stops when a newer search of the same person starts, or when the client goes away
  const signal = clientSignal ? AbortSignal.any([mine, clientSignal]) : mine
  try {
    const cfg = files.ctx.files.cfg
    const res = await grepFiles(
      { fx: files.fx, rules, user, rg: cfg.rg, timeoutMs: Math.min(cfg.grepTimeoutMs, CONTENT_SEARCH_TIMEOUT_MS), office: files.ctx.files.office },
      b.segs, false,
      { pattern: query, fixed: true, ignoreCase: true, mode: 'content', lineNumbers: true, before: 0, after: 0, limit, maxPerFile: CONTENT_SEARCH_PER_FILE,
        strictTime: true, officeBudget: 0, officeOwner: userId, signal },
    )
    // a newer search of the same person stopped this one: its list is not complete, so it is not sent as an answer
    // (a client that still waits, e.g. in a second tab, tries again after retryAfter)
    if (mine.aborted) throw new HttpError('rate_limited', undefined, { retryAfter: 1 })
    const items = res.hits
      .flatMap((h) => {
        const name = h.path.slice(h.path.lastIndexOf('/') + 1)
        if (!HTML_FILE.test(name)) return [{ path: h.path, name, line: h.line, snippet: snippetOf(h.text, query) }]
        const text = htmlLineText(h.text, query)
        return text === null ? [] : [{ path: h.path, name, line: h.line, snippet: snippetOf(text, htmlQuery(query)) }]
      })
      .sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line)
    return { items, truncated: res.truncated && !res.timedOut, timedOut: res.timedOut, indexing: res.stats.officePending, notQueued: res.stats.officeNotQueued, retryLater: res.stats.officeRetryLater, longSkipped: res.stats.longSkipped }
  } finally { done() }
}
