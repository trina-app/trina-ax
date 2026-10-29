// File content search on the file screen (R2-ETC-02): GET /api/files/search. The server shows only lines of files
// the person can open, the same check as the AI's grep. Results are grouped by file; a line shows its number and a
// short snippet with the match highlighted. A click opens the file in the side panel. Requests are debounced, and an
// older answer never replaces a newer one. A short rate-limit wait (fast typing) is waited out once, without a message.
import { FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileContentHit, FileContentHits } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { highlightParts } from '../lib/highlight'
import { openTeamFile } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { EmptyState, ErrorNote, Skeleton } from './ui'

/** the wait after the last key press before a search starts */
export const CONTENT_SEARCH_DEBOUNCE_MS = 300
const LIMIT = 100

/** True when the query is long enough to search: 2 characters, or 1 non-ASCII character (a Korean word can be one). */
export function contentQueryReady(q: string): boolean {
  const s = q.trim()
  return s.length >= 2 || (s.length === 1 && s.charCodeAt(0) > 0x7f)
}

export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
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

  const groups: [string, FileContentHit[]][] = []
  for (const h of res?.items ?? []) {
    const last = groups[groups.length - 1]
    if (last && last[0] === h.path) last[1].push(h)
    else groups.push([h.path, [h]])
  }

  return (
    <div className="px-2 py-2" data-testid="content-search">
      <p className="px-2 pb-2 text-xs text-faint">{t('files.search.scope', { q: query, folder: folderLabel })}</p>
      {error && <ErrorNote onRetry={() => setTick((n) => n + 1)}>{error}</ErrorNote>}
      {!res && !error && <Skeleton lines={6} className="p-2" />}
      {res && !res.items.length && !res.timedOut && !res.officePending && <EmptyState icon={<FileText size={28} />} title={t('files.search.none')} />}
      {res && (res.truncated || res.timedOut || res.officePending > 0) && (
        <div className="mx-2 mb-2 space-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted" role="status">
          {res.truncated && <p>{t('files.search.truncated', { n: res.items.length })}</p>}
          {res.timedOut && <p>{t('files.search.timedOut')}</p>}
          {res.officePending > 0 && <p>{t('files.search.officePending', { n: res.officePending })}</p>}
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
    </div>
  )
}
