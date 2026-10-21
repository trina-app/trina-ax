// "Add from team files": pick files of the team folder to attach to a message. It lists only what the person can
// read — the file screen's own listing (GET /api/files/tree), a name search and recent files that the server filters
// with the same permission function — with folder navigation, breadcrumbs, multi-select up to the message's limit.
// Picked files are attached as references by the composer (POST /api/attachments/team-file).
import clsx from 'clsx'
import { ChevronRight, File, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Home, Presentation, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, TreeResponse } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { crumbs } from '../../lib/paths'
import { useLocale, useT } from '../../i18n'
import { useMe } from '../../store/session'
import { Button, ErrorNote, Modal, Skeleton, inputCls } from '../ui'

const ext = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '')
/** A team path as the person reads it: their own users/<id> is "My folder". */
export function friendlyPath(p: string, myId: string | undefined, mine: string): string {
  if (!myId) return p
  const own = `users/${myId}`
  return p === own ? mine : p.startsWith(own + '/') ? mine + p.slice(own.length) : p
}

export function FileKindIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const e = ext(name)
  const cls = clsx('shrink-0', className ?? 'text-muted')
  if (/^(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/.test(e)) return <FileImage size={size} className={cls} aria-hidden />
  if (/^(xlsx?|ods|csv|tsv|numbers)$/.test(e)) return <FileSpreadsheet size={size} className={cls} aria-hidden />
  if (/^(pptx?|odp|key)$/.test(e)) return <Presentation size={size} className={cls} aria-hidden />
  if (/^(mp3|m4a|wav|ogg|flac|aac|opus)$/.test(e)) return <FileAudio size={size} className={cls} aria-hidden />
  if (/^(mp4|mov|webm|mkv|avi|m4v)$/.test(e)) return <FileVideo size={size} className={cls} aria-hidden />
  if (/^(pdf|docx?|odt|rtf|hwpx?|pages|txt|md|markdown|json|html?)$/.test(e)) return <FileText size={size} className={cls} aria-hidden />
  return <File size={size} className={cls} aria-hidden />
}

export default function TeamFilePicker({ open, onClose, onPick, room, max, attached }: {
  open: boolean
  onClose: () => void
  onPick: (files: FileEntry[]) => void
  /** how many more files this message can take */
  room: number
  /** the message limit, for the note */
  max: number
  /** team paths already attached to this message (shown as attached, not picked again) */
  attached: ReadonlySet<string>
}) {
  const t = useT()
  const locale = useLocale()
  const myId = useMe()?.user.id
  const [path, setPath] = useState('')
  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [recent, setRecent] = useState<FileEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ q: string; path: string; items: FileEntry[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rev, setRev] = useState(0)
  const [picked, setPicked] = useState<Map<string, FileEntry>>(new Map())
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fine = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches
  const mine = t('home.myFolder')
  const shown = (p: string) => friendlyPath(p, myId, mine)

  useEffect(() => {
    if (!open) return
    setPath('')
    setQuery('')
    setFound(null)
    setPicked(new Map())
    let live = true
    api.call(API.recentFiles, { query: { limit: 5 } }).then((r) => live && setRecent(r.items), () => live && setRecent([]))
    return () => {
      live = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let live = true
    setTree(null)
    setError(null)
    api.call(API.tree, { query: { path, limit: 200 } }).then(
      (r) => live && setTree(r),
      (e) => live && setError(errorText(e, locale, t('error.network'))),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path, rev])

  // name search inside the folder on screen (the whole team folder at the top), a moment after typing stops
  const q = query.trim()
  useEffect(() => {
    if (!open || !q) return setFound(null)
    let live = true
    const timer = setTimeout(() => {
      api.call(API.findFiles, { query: { q, path, limit: 50 } }).then(
        (r) => live && setFound({ q, path, items: r.items, truncated: r.truncated }),
        (e) => live && setError(errorText(e, locale, t('error.network'))),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, path])

  const toggle = (f: FileEntry) =>
    setPicked((cur) => {
      const next = new Map(cur)
      if (next.has(f.path)) next.delete(f.path)
      else if (next.size < room) next.set(f.path, f)
      return next
    })
  const full = picked.size >= room

  const folders = useMemo(() => tree?.entries.filter((e) => e.type === 'folder') ?? [], [tree])
  const files = useMemo(() => tree?.entries.filter((e) => e.type === 'file') ?? [], [tree])

  // arrow keys move through the rows (checkboxes and folders) of the list
  const items = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-picker-item]') ?? [])].filter((x) => !(x as HTMLInputElement).disabled)
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const all = items()
    if (!all.length) return
    e.preventDefault()
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Home') all[0]!.focus()
    else if (e.key === 'End') all[all.length - 1]!.focus()
    else if (e.key === 'ArrowDown') all[Math.min(all.length - 1, i + 1)]!.focus()
    else if (i <= 0) searchRef.current?.focus()
    else all[i - 1]!.focus()
  }

  const fileRow = (f: FileEntry, showPath: boolean) => {
    const already = attached.has(f.path)
    const on = already || picked.has(f.path)
    const off = !on && full
    return (
      <li key={f.path}>
        <label className={clsx('flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2.5 text-sm last:border-0 hover:bg-hover sm:py-2', picked.has(f.path) && 'bg-accent-soft', (off || already) && 'cursor-not-allowed', off && 'opacity-60')} title={shown(f.path)} data-testid="picker-file">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-[var(--c-accent)]"
            checked={on}
            disabled={off || already}
            onChange={() => toggle(f)}
            aria-label={t('picker.select', { name: f.name })}
            data-picker-item
          />
          <FileKindIcon name={f.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{f.name}</span>
            {showPath && <span className="block truncate text-xs text-faint">{shown(f.path.slice(0, f.path.lastIndexOf('/'))) || t('files.root')}</span>}
          </span>
          {already ? (
            <span className="shrink-0 text-xs text-accent-text" data-testid="picker-attached">{t('picker.attached')}</span>
          ) : (
            f.size !== null && <span className="shrink-0 text-xs text-faint tabular-nums">{formatSize(f.size, locale)}</span>
          )}
        </label>
      </li>
    )
  }

  const folderName = (p: string) => (p === '' ? t('files.root') : shown(p) === p ? p.slice(p.lastIndexOf('/') + 1) : shown(p).split('/').pop()!)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('picker.title')}
      width={600}
      footer={
        <>
          <span className="mr-auto text-xs text-muted" role="status">
            {picked.size > 0 ? t('picker.selected', { n: String(picked.size) }) : room > 0 ? t('picker.limit', { n: String(room) }) : t('picker.full', { n: String(max) })}
          </span>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!picked.size} onClick={() => onPick([...picked.values()])} data-testid="picker-attach">
            {t('picker.attach')}
            {picked.size > 0 ? ` (${picked.size})` : ''}
          </Button>
        </>
      }
    >
      <div className="relative mb-2">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter / arrow down: on to the first result
            if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'ArrowDown') {
              const first = items()[0]
              if (first) {
                e.preventDefault()
                first.focus()
              }
            }
          }}
          placeholder={path ? t('picker.searchIn', { folder: folderName(path) }) : t('picker.search')}
          aria-label={path ? t('picker.searchIn', { folder: folderName(path) }) : t('picker.search')}
          className={clsx(inputCls, 'pr-9 pl-9')}
          data-testid="picker-search"
          // the dialog puts focus here when it opens (mouse and keyboard; phones would open the keyboard over the list)
          data-autofocus={fine ? '' : undefined}
        />
        {query && (
          <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-faint hover:bg-hover" aria-label={t('picker.clearSearch')} onClick={() => { setQuery(''); searchRef.current?.focus() }}>
            <X size={14} />
          </button>
        )}
      </div>
      <p className="mb-2 text-xs text-muted">{t('picker.hint')}</p>
      <nav aria-label={t('files.breadcrumb')} className="mb-2 flex flex-wrap items-center gap-1 text-sm">
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-hover" onClick={() => setPath('')} data-testid="picker-crumb-root">
          <Home size={14} aria-hidden /> {t('files.root')}
        </button>
        {crumbs(path).map((c) => (
          <span key={c.path} className="inline-flex items-center gap-1">
            <ChevronRight size={13} className="text-faint" aria-hidden />
            <button type="button" className="rounded px-1.5 py-1 hover:bg-hover" onClick={() => setPath(c.path)}>
              {folderName(c.path)}
            </button>
          </span>
        ))}
      </nav>
      {error && <ErrorNote onRetry={() => setRev((r) => r + 1)}>{error}</ErrorNote>}

      {/* one fixed-height area for recent files, the folder and search results: the search box never jumps */}
      <div ref={listRef} onKeyDown={onListKey} className="scroll-thin h-[min(50dvh,22rem)] overflow-y-auto rounded-lg border border-line" data-testid="picker-list">
        {q ? (
          !found || found.q !== q || found.path !== path ? (
            <div className="p-3">
              <Skeleton lines={4} />
            </div>
          ) : found.items.length ? (
            <>
              <ul aria-label={t('picker.results')}>{found.items.map((f) => fileRow(f, true))}</ul>
              {found.truncated && <p className="px-3 py-2 text-xs text-faint">{t('picker.truncated')}</p>}
            </>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-faint">{t('picker.noResults', { q })}</p>
          )
        ) : (
          <>
            {path === '' && recent && recent.length > 0 && (
              <section aria-labelledby="picker-recent" className="border-b border-line">
                <h3 id="picker-recent" className="bg-subtle px-3 py-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
                  {t('picker.recent')}
                </h3>
                <ul data-testid="picker-recent">{recent.map((f) => fileRow(f, true))}</ul>
              </section>
            )}
            {path === '' && recent && recent.length > 0 && <h3 className="bg-subtle px-3 py-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{t('picker.folders')}</h3>}
            {!tree && !error && (
              <div className="p-3">
                <Skeleton lines={4} />
              </div>
            )}
            {tree && (
              <ul>
                {!folders.length && !files.length && <li className="px-3 py-8 text-center text-sm text-faint">{t('picker.empty')}</li>}
                {folders.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left text-sm last:border-0 hover:bg-hover sm:py-2"
                      onClick={() => setPath(f.path)}
                      aria-label={t('picker.open', { name: folderName(f.path) })}
                      data-testid="picker-folder"
                      data-picker-item
                    >
                      <Folder size={16} className="shrink-0 text-accent-text" aria-hidden />
                      <span className={clsx('min-w-0 flex-1 truncate', f.access === 'none' && 'text-muted')}>{folderName(f.path)}</span>
                      <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />
                    </button>
                  </li>
                ))}
                {files.map((f) => fileRow(f, false))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
