// File content search on the file screen (R2-ETC-02): GET /api/files/search. The server shows only lines of files
// the person can open, the same check as the AI's grep. Results are grouped by file; a line shows its number and a
// short snippet with the match highlighted. A click opens the file in the side panel. A word that no line has says
// "nothing found". Requests are debounced, and an older answer never replaces a newer one. A short rate-limit wait (fast
// typing) is waited out once, without a message.
// Files whose name holds the words come first (QA TC-260: "로고" finds 로고.png): FileNameResults asks the ⌘K name
// search (GET /api/files/find, folders too) under the same folder; the server checks each one as the file tree does.
import { File as FileIcon, FileText, Folder } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileContentHit, FileContentHits, FileEntry } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { highlightParts } from '../lib/highlight'
import { openTeamFile } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { useFolderWords } from '../lib/folderLabels'
import { EmptyState, ErrorNote, Skeleton } from './ui'

/** the wait after the last key press before a search starts */
export const CONTENT_SEARCH_DEBOUNCE_MS = 300
const LIMIT = 100
/** files and folders found by name, at most (the ⌘K dialog asks for 30) */
export const NAME_LIMIT = 30

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

/** One search's answer: the line matches, grouped by file, or "nothing found". */
export function FileContentList({ res, query, folderLabel }: { res: FileContentHits; query: string; folderLabel: string }) {
  const t = useT()
  const folderWords = useFolderWords()
  const groups: [string, FileContentHit[]][] = []
  for (const h of res.items) {
    const last = groups[groups.length - 1]
    if (last && last[0] === h.path) last[1].push(h)
    else groups.push([h.path, [h]])
  }
  const notes = res.truncated || res.timedOut || res.indexing > 0 || res.notQueued > 0 || res.retryLater > 0 || res.longSkipped > 0
  return (
    <>
      <p className="px-2 pb-2 text-xs text-faint">{t('files.search.scope', { q: query, folder: folderLabel })}</p>
      {!res.items.length && !notes && <EmptyState icon={<FileText size={28} />} title={t('files.search.none')} />}
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
        <ul className="space-y-2" aria-label={t('files.search.scope', { q: query, folder: folderLabel })}>
          {groups.map(([p, hits]) => (
            <li key={p} className="rounded-lg border border-line">
              <button type="button" className="flex w-full items-center gap-2 rounded-t-lg px-3 py-2 text-left text-sm hover:bg-hover" onClick={() => openTeamFile(p)} data-testid="content-hit-file">
                <FileText size={15} className="shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{hits[0]!.name}</span>
                <span className="min-w-0 shrink truncate text-xs text-faint max-sm:hidden" title={p}>{folderWords.path(p)}</span>
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

/** The files and folders whose name holds the words, newest first (folders first). Nothing is shown before the answer
 * or when no name matches: the line matches below say "nothing found". A file opens in the side panel; a folder opens
 * in the list (`onFolder`). */
export function FileNameList({ items, truncated, query, onFolder }: { items: FileEntry[]; truncated: boolean; query: string; onFolder: (path: string) => void }) {
  const t = useT()
  const folderWords = useFolderWords()
  if (!items.length) return null
  return (
    <section className="mb-3" data-testid="name-search">
      <p className="px-2 pb-2 text-xs text-faint">{t('files.search.names', { q: query })}</p>
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('files.search.names', { q: query })}>
        {items.map((f) => {
          const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
          const Icon = f.type === 'folder' ? Folder : FileIcon
          return (
            <li key={f.path}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover"
                onClick={() => (f.type === 'folder' ? onFolder(f.path) : openTeamFile(f.path))}
                data-testid="name-hit"
              >
                <Icon size={15} className="shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">
                  <Highlighted text={f.name} query={query} />
                </span>
                {parent && <span className="min-w-0 shrink truncate text-xs text-faint max-sm:max-w-[40%]" title={f.path}>{folderWords.path(parent)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {truncated && <p className="px-2 pt-1 text-xs text-faint">{t('files.search.namesTruncated', { n: items.length })}</p>}
    </section>
  )
}

export function FileNameResults({ q, path, onFolder }: { q: string; path: string; onFolder: (path: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const [res, setRes] = useState<{ items: FileEntry[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const query = q.trim()

  useEffect(() => {
    let live = true
    const ctrl = new AbortController()
    setRes(null)
    setError(null)
    const timer = setTimeout(() => {
      api.call(API.findFiles, { query: { q: query, path, limit: NAME_LIMIT, folders: '1' }, signal: ctrl.signal }).then(
        (r) => live && setRes(r),
        (e) => live && !ctrl.signal.aborted && setError(errorText(e, locale, t('error.network'))),
      )
    }, CONTENT_SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, path, tick])

  if (error) return <div className="px-2 pt-2"><ErrorNote onRetry={() => setTick((n) => n + 1)}>{error}</ErrorNote></div>
  if (!res) return null
  return <div className="px-2 pt-2"><FileNameList items={res.items} truncated={res.truncated} query={query} onFolder={onFolder} /></div>
}
