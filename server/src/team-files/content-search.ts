// Content search for people (the file screen, R2-ETC-02). It uses the AI's grep (files/search.ts grepFiles), so it
// has the same permission checks: allowedRoots() picks the folders ripgrep may enter and visiblePath() checks every
// hit again. A person never finds a line in a file that they cannot open. Office documents are searched through the
// same text cache as the AI's grep, but only their fresh text: the content search extracts nothing itself. A stale or
// new office document goes to the one background queue of the server (low priority, each person in turn, at most
// OFFICE_QUEUE_PER_OWNER files of one person) and is counted in `indexing`; a file that the queue did not take is
// counted in `notQueued`. Thus a person's search never takes the extraction slots that the AI grep of another person
// needs, and one person's files do not delay the files of other people. The query is literal text (ripgrep -F, any case), so a query cannot be a slow or
// bad regular expression. Limits: results (FileContentHits.items), lines per file, time (office extraction included),
// file size (RG_BASE), line length (RG_MAX_RECORD_CHARS) and a rate limit per person.
// The same search also asks the knowledge graph (KnowledgeGraph.lookup, docs/KNOWLEDGE-GRAPH.md) for documents, in
// parallel with grep and within CONTENT_SEARCH_DOCS_DEADLINE_MS: one row per document with its best passage
// (FileContentHits.documents). The lookup runs as the person (every file passes authorize(read) for them now), under
// the folder searched; each document is then checked again with grep's own check (visiblePath), so a document row never
// names a file that the line search could not show. It only adds rows: the line matches stay as they were.
import { SourceLoc, type FileContentDocument, type FileContentHits } from '@mycel/shared/api'
import { grepFiles } from '../files/search'
import { HttpError } from '../http/errors'
import { knowledgeGraphOf } from '../knowledge-graph/service'
import { authorize, visiblePath } from '../policy/authorize'
import type { Principal, RuleSet } from '../policy/access'
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

/** passages asked of the knowledge graph for one search; the rows are one per document, so there can be fewer */
export const CONTENT_SEARCH_DOCS = 20
/** the knowledge graph answers within this time with what it has; a lookup that is still not back after twice this time
 * is left out of the answer (the line matches never wait longer than that for it) */
export const CONTENT_SEARCH_DOCS_DEADLINE_MS = 500

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

/** The words of a query a passage is cut around: 2 characters or more, or 1 that is not ASCII (a Korean word). */
export function queryWords(q: string): string[] {
  return [...new Set(q.normalize('NFC').split(/\s+/).filter((w) => w.length >= 2 || (w.length === 1 && w.charCodeAt(0) > 0x7f)))]
}

/** A short part of a passage (one line, spaces squeezed) around the first query word in it, or its start. */
export function passageSnippet(text: string, words: readonly string[]): string {
  const flat = text.normalize('NFC').replace(/\s+/g, ' ').trim()
  const low = flat.toLowerCase()
  let first: string | undefined
  let at = Infinity
  for (const w of words) {
    const i = low.indexOf(w.toLowerCase())
    if (i >= 0 && i < at) { at = i; first = w }
  }
  return snippetOf(flat, first ?? '')
}

const under = (p: string, root: string) => !root || p === root || p.startsWith(root + '/')

/**
 * The knowledge graph's documents for one search: undefined when its documents part is off, else one row per document
 * (best passage first). Only files under `base` that pass grep's own check for this person now. A lookup that fails,
 * or is not back in time, gives no rows: the line search answers as it always did.
 */
async function documentMatches(files: TeamFiles, user: Principal, rules: RuleSet, query: string, base: string, signal: AbortSignal): Promise<FileContentDocument[] | undefined> {
  const kg = knowledgeGraphOf(files.ctx)
  if (!kg.docsOn()) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CONTENT_SEARCH_DOCS_DEADLINE_MS * 2)
      signal.addEventListener('abort', () => resolve(null), { once: true })
    })
    const r = await Promise.race([kg.lookup(user, [query], { base: base || undefined, long: 0, short: CONTENT_SEARCH_DOCS, deadlineMs: CONTENT_SEARCH_DOCS_DEADLINE_MS }), late])
    if (!r) return []
    const words = queryWords(query)
    const out: FileContentDocument[] = []
    const seen = new Set<string>()
    for (const x of r.passages) {
      if (seen.has(x.path)) continue
      seen.add(x.path)
      if (!under(x.path, base) || !visiblePath(files.fx, rules, user, x.path)) continue
      const loc = x.loc ? (SourceLoc.safeParse(x.loc).data ?? null) : null
      out.push({ path: x.path, name: x.path.slice(x.path.lastIndexOf('/') + 1), loc, snippet: passageSnippet(x.text, words) })
    }
    return out
  } catch (e) {
    files.ctx.log.warn('file search: the knowledge graph lookup failed', { err: String(e).slice(0, 200) })
    return []
  } finally { clearTimeout(timer) }
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
    // the knowledge graph's part runs while ripgrep does (it never throws)
    const docs = documentMatches(files, user, rules, query, b.rel, signal)
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
      .map((h) => ({ path: h.path, name: h.path.slice(h.path.lastIndexOf('/') + 1), line: h.line, snippet: snippetOf(h.text, query) }))
      .sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line)
    const documents = await docs
    if (mine.aborted) throw new HttpError('rate_limited', undefined, { retryAfter: 1 })
    return { items, ...(documents ? { documents } : {}), truncated: res.truncated && !res.timedOut, timedOut: res.timedOut, indexing: res.stats.officePending, notQueued: res.stats.officeNotQueued, retryLater: res.stats.officeRetryLater, longSkipped: res.stats.longSkipped }
  } finally { done() }
}
