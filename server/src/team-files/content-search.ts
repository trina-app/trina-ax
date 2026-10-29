// Content search for people (the file screen, R2-ETC-02). It uses the AI's grep (files/search.ts grepFiles), so it
// has the same permission checks: allowedRoots() picks the folders ripgrep may enter and visiblePath() checks every
// hit again. A person never finds a line in a file that they cannot open. Office documents are searched through the
// same text cache as the AI's grep. The query is literal text (ripgrep -F, any case), so a query cannot be a slow or
// bad regular expression. Limits: results (FileContentHits.items), lines per file, time (office extraction included),
// file size (RG_BASE), line length (RG_MAX_RECORD_CHARS) and a rate limit per person.
import type { FileContentHits } from '@mycel/shared/api'
import { grepFiles } from '../files/search'
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
/** office files extracted before the answer; the rest are extracted in the background (officePending) */
export const CONTENT_SEARCH_OFFICE_BUDGET = 8
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
        strictTime: true, officeBudget: CONTENT_SEARCH_OFFICE_BUDGET, signal },
    )
    const items = res.hits
      .map((h) => ({ path: h.path, name: h.path.slice(h.path.lastIndexOf('/') + 1), line: h.line, snippet: snippetOf(h.text, query) }))
      .sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line)
    return { items, truncated: res.truncated && !res.timedOut, timedOut: res.timedOut, officePending: res.stats.officePending }
  } finally { done() }
}
