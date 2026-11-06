// "참고한 파일 5개" under an answer (docs/DECISIONS.md "Sources under each answer"): the team files the AI read, or saw
// passages of in search and grep results, while it wrote the answer, as the server recorded them (not the AI's own
// claim). Collapsed by default. Opening it asks the server for the list each time, checked against the viewer's access
// now: a file they cannot open any more shows only in "볼 수 없는 파일 N개", without its name. A place chip (page,
// sheet, slide, section) opens the preview there; the file name opens it at the first place.
import { ChevronDown, ChevronRight, FileSearch, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MessageSourceFile, MessageSources, SourceLoc } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { openTeamFile } from '../../lib/sidePanel'
import { parentPath } from '../../lib/paths'
import { useLocale, useT } from '../../i18n'
import { Button } from '../ui'

type T = ReturnType<typeof useT>

/** files shown before "N개 더" */
export const SOURCES_SHOWN = 20

export function locChip(t: T, l: SourceLoc): string {
  switch (l.kind) {
    case 'page': return t('sources.page', { page: l.page })
    case 'slide': return t('sources.slide', { slide: l.slide })
    case 'sheet': return l.range ? t('sources.sheetRange', { sheet: l.sheet, range: l.range }) : t('sources.sheet', { sheet: l.sheet })
    case 'heading': return t('sources.heading', { heading: l.heading })
  }
}

// defaultOpen / initial: tests render the open list without a click or a server. `load`: where the list comes from
// when it is not a chat answer's (an AI answer in a room: GET /api/rooms/:id/messages/:messageId/sources)
export default function SourcesList({ chatId, messageId, count, defaultOpen = false, initial, load }: { chatId: string; messageId: string; count: number; defaultOpen?: boolean; initial?: MessageSources; load?: (signal: AbortSignal) => Promise<MessageSources> }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(defaultOpen)
  const [data, setData] = useState<MessageSources | null>(initial ?? null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [rev, setRev] = useState(0)
  useEffect(() => {
    if (!open || initial) return
    const ctrl = new AbortController()
    setError(null)
    setData(null)
    ;(load ? load(ctrl.signal) : api.call(API.messageSources, { params: { id: chatId, messageId }, signal: ctrl.signal })).then(
      (r) => { if (!ctrl.signal.aborted) setData(r) },
      (e: unknown) => { if (!ctrl.signal.aborted) setError(errorText(e, locale, t('error.network'))) },
    )
    return () => ctrl.abort()
    // the list is asked for again every time it opens: access may have changed since
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chatId, messageId, rev])
  if (count <= 0) return null
  const files = data?.files ?? []
  const shown = all ? files : files.slice(0, SOURCES_SHOWN)
  return (
    <div className="mt-3 text-sm" data-testid="answer-sources">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink">
        <FileSearch size={14} aria-hidden />
        <span>{t('sources.title', { n: count })}</span>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
      </button>
      {open && (
        <div className="mt-1.5 rounded-xl border border-line bg-surface px-3 py-2" data-testid="answer-sources-list">
          <p className="mb-1.5 text-xs text-faint">{t('sources.caption')}</p>
          {error ? (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
              {error}
              <Button size="sm" variant="secondary" onClick={() => setRev((n) => n + 1)}>{t('common.retry')}</Button>
            </p>
          ) : !data ? (
            <p className="flex items-center gap-2 text-xs text-faint" role="status">
              <Loader2 size={13} className="animate-spin" aria-hidden /> {t('common.loading')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {shown.map((f) => <SourceRow key={f.path} f={f} t={t} />)}
              {files.length > SOURCES_SHOWN && !all && (
                <li>
                  <button type="button" className="text-xs text-accent-text hover:underline" onClick={() => setAll(true)} data-testid="answer-sources-more">
                    {t('sources.more', { n: files.length - SOURCES_SHOWN })}
                  </button>
                </li>
              )}
              {data.unavailable > 0 && (
                <li className="text-xs text-faint" data-testid="answer-sources-unavailable">{t('sources.unavailable', { n: data.unavailable })}</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function SourceRow({ f, t }: { f: MessageSourceFile; t: T }) {
  const folder = parentPath(f.path)
  const onlyPassages = !f.via.includes('read')
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="answer-source" data-path={f.path}>
      <button type="button" className="min-w-0 max-w-full truncate text-left text-accent-text hover:underline" title={f.path} onClick={() => openTeamFile(f.path, f.locs[0])}>
        {f.name}
      </button>
      {folder && <span className="min-w-0 max-w-[40%] truncate text-xs text-faint" title={f.path}>{folder}/</span>}
      {f.locs.map((l, i) => (
        <button key={i} type="button" onClick={() => openTeamFile(f.path, l)} className="max-w-[16rem] truncate rounded-md border border-line bg-subtle px-1.5 py-0.5 text-micro text-muted hover:bg-hover hover:text-ink" data-testid="answer-source-loc">
          {locChip(t, l)}
        </button>
      ))}
      {onlyPassages && <span className="text-micro text-faint">{t('sources.passagesOnly')}</span>}
      {f.subagent && <span className="text-micro text-faint">{t('sources.subagent')}</span>}
    </li>
  )
}
