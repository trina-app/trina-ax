// File content search on the file screen (R2-ETC-02): GET /api/files/search. The server shows only files the person
// can open, the same check as the AI's grep. Two parts, in this order:
// - documents the knowledge graph found (FileContentHits.documents, absent when its documents part is off): one row per
//   document with a short passage, the query's words highlighted, and its place (page, sheet, slide or section). A
//   click opens the file there.
// - the exact-line matches, grouped by file: a line shows its number and a short snippet with the match highlighted.
//   A click opens the file in the side panel.
// Requests are debounced, and an older answer never replaces a newer one. A short rate-limit wait (fast typing) is
// waited out once, without a message.
import { FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileContentDocument, FileContentHit, FileContentHits } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { highlightParts, type TextPart } from '../lib/highlight'
import { openTeamFile } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { locChip } from './chat/SourcesList'
import { EmptyState, ErrorNote, Skeleton } from './ui'

/** the wait after the last key press before a search starts */
export const CONTENT_SEARCH_DEBOUNCE_MS = 300
const LIMIT = 100

/** True when the query is long enough to search: 2 characters, or 1 non-ASCII character (a Korean word can be one). */
export function contentQueryReady(q: string): boolean {
  const s = q.trim()
  return s.length >= 2 || (s.length === 1 && s.charCodeAt(0) > 0x7f)
}

/** The words of a query that a document passage highlights (a passage need not hold the whole query), longest first. */
export function queryWords(q: string): string[] {
  return [...new Set(q.trim().normalize('NFC').split(/\s+/).filter(contentQueryReady))].sort((a, b) => b.length - a.length)
}

/** highlightParts for each word in turn, on the parts no earlier word matched */
export function wordParts(text: string, words: readonly string[]): TextPart[] {
  let parts: TextPart[] = [{ text: text.normalize('NFC'), match: false }]
  for (const w of words) parts = parts.flatMap((p) => (p.match ? [p] : highlightParts(p.text, w)))
  return parts
}

/** `query`: the whole query as one literal text (a line match); `words`: each word on its own (a document passage; no
 * side padding there, so a marked word and the Korean particle after it still read as one word) */
export function Highlighted({ text, query, words }: { text: string; query?: string; words?: readonly string[] }) {
  return (
    <>
      {(words ? wordParts(text, words) : highlightParts(text, query ?? '')).map((p, i) =>
        p.match ? (
          <mark key={i} className={words ? 'rounded-sm bg-accent-soft text-inherit' : 'rounded-sm bg-accent-soft px-0.5 text-inherit'}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

function DocumentRow({ d, words }: { d: FileContentDocument; words: readonly string[] }) {
  const t = useT()
  const place = d.loc ? locChip(t, d.loc) : null
  return (
    <li>
      <button type="button" className="flex w-full gap-2 rounded-lg px-3 py-2 text-left hover:bg-hover" onClick={() => openTeamFile(d.path, d.loc)} title={d.path} data-testid="content-doc">
        <FileText size={15} className="mt-0.5 shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 text-sm">
            <span className="min-w-0 truncate font-medium">{d.name}</span>
            {place && <span className="max-w-[45%] shrink-0 truncate text-xs text-faint" data-testid="content-doc-place">{place}</span>}
          </span>
          <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed break-words break-keep text-muted">
            <Highlighted text={d.snippet} words={words} />
          </span>
        </span>
      </button>
    </li>
  )
}

/** One search's answer: the document rows, then the line matches (today's list, unchanged). */
export function FileContentList({ res, query, folderLabel }: { res: FileContentHits; query: string; folderLabel: string }) {
  const t = useT()
  const documents = res.documents ?? []
  const words = queryWords(query)
  const groups: [string, FileContentHit[]][] = []
  for (const h of res.items) {
    const last = groups[groups.length - 1]
    if (last && last[0] === h.path) last[1].push(h)
    else groups.push([h.path, [h]])
  }
  const notes = res.truncated || res.timedOut || res.indexing > 0 || res.notQueued > 0 || res.retryLater > 0 || res.longSkipped > 0
  // with document rows and no line at all, the line part says nothing more (no second "nothing found")
  const lines = res.items.length > 0 || !documents.length
  return (
    <>
      {documents.length > 0 && (
        <section className="pb-3" data-testid="content-documents">
          <p className="px-2 pb-1 text-xs text-faint" id="content-documents-label">{t('files.search.documents')}</p>
          <ul aria-labelledby="content-documents-label">
            {documents.map((d) => <DocumentRow key={d.path} d={d} words={words} />)}
          </ul>
        </section>
      )}
      {lines && <p className="px-2 pb-2 text-xs text-faint">{t('files.search.scope', { q: query, folder: folderLabel })}</p>}
      {!res.items.length && !documents.length && !notes && <EmptyState icon={<FileText size={28} />} title={t('files.search.none')} />}
      {notes && (
        <div className="mx-2 mb-2 space-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted" role="status">
          {res.truncated && <p>{t('files.search.truncated', { n: res.items.length })}</p>}
          {res.timedOut && <p>{t('files.search.timedOut')}</p>}
          {res.indexing > 0 && <p>{t('files.search.indexing', { n: res.indexing })}</p>}
          {res.notQueued > 0 && <p>{t('files.search.notQueued', { n: res.notQueued })}</p>}
          {res.retryLater > 0 && <p>{t('files.search.retryLater', { n: res.retryLater })}</p>}
          {res.longSkipped > 0 && <p>{t('files.search.longSkipped', { n: res.longSkipped })}</p>}
        </div>
      )}
      {groups.length > 0 && (
        <ul className="space-y-2" aria-label={t('files.search.label')}>
          {groups.map(([p, hits]) => (
            <li key={p} className="rounded-lg border border-line">
              <button type="button" className="flex w-full items-center gap-2 rounded-t-lg px-3 py-2 text-left text-sm hover:bg-hover" onClick={() => openTeamFile(p)} data-testid="content-hit-file">
                <FileText size={15} className="shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{hits[0]!.name}</span>
                <span className="min-w-0 shrink truncate text-xs text-faint max-sm:hidden">{p}</span>
              </button>
              <ul className="border-t border-line">
                {hits.map((h) => (
                  <li key={h.line}>
                    <button type="button" className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-xs hover:bg-hover" onClick={() => openTeamFile(p)} title={t('files.search.line', { n: h.line })} data-testid="content-hit">
                      <span className="w-10 shrink-0 text-right font-mono text-faint tabular-nums">{h.line}</span>
                      <span className="min-w-0 flex-1 font-mono break-words whitespace-pre-wrap">
                        <Highlighted text={h.snippet} query={query} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export function FileContentResults({ q, path, folderLabel }: { q: string; path: string; folderLabel: string }) {
  const t = useT()
  const locale = useLocale()
  const [res, setRes] = useState<FileContentHits | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const query = q.trim()

  useEffect(() => {
    let live = true
    const ctrl = new AbortController()
    setRes(null)
    setError(null)
    let retry: ReturnType<typeof setTimeout> | undefined
    const run = async (again: boolean) => {
      try {
        const r = await api.call(API.searchFileContents, { query: { q: query, path, limit: LIMIT }, signal: ctrl.signal })
        if (live) setRes(r)
      } catch (e) {
        if (!live || ctrl.signal.aborted) return
        const wait = isApiError(e, 'rate_limited') ? (e.body.retryAfter ?? 1) : null
        if (again && wait !== null && wait <= 5) retry = setTimeout(() => void run(false), wait * 1000)
        else setError(errorText(e, locale, t('error.network')))
      }
    }
    const timer = setTimeout(() => void run(true), CONTENT_SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
      clearTimeout(retry)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, path, tick])

  return (
    <div className="px-2 py-2" data-testid="content-search">
      {!res && <p className="px-2 pb-2 text-xs text-faint">{t('files.search.scope', { q: query, folder: folderLabel })}</p>}
      {error && <ErrorNote onRetry={() => setTick((n) => n + 1)}>{error}</ErrorNote>}
      {!res && !error && <Skeleton lines={6} className="p-2" />}
      {res && <FileContentList res={res} query={query} folderLabel={folderLabel} />}
    </div>
  )
}
