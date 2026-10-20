// The team folder explorer: only what the person may see (folders shown for navigation only are greyed out),
// upload (drag and drop; chunked and resumable when large), download, new folder, rename / move, trash, version
// history with restore, conflict copies marked, "start a chat with this file". Refreshes on files.changed.
import clsx from 'clsx'
import { ArchiveRestore, ChevronRight, Download, Eye, File as FileIcon, FileImage, FileSpreadsheet, FileText, Folder, FolderInput, FolderPlus, History, Home, Loader2, Lock, MessageSquarePlus, MoreHorizontal, Pencil, Presentation, RefreshCw, Trash2, Upload, X, FileCode, FileArchive, FileAudio, FileVideo } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { FileEntry, FileVersion, TrashItem, TreeResponse } from '@mycel/shared/api'
import { api, API, errorText, fileUrl, isApiError, startDownload, versionDownloadUrl } from '../lib/api'
import { formatDateTime, formatSize } from '../lib/format'
import { baseName, crumbs, isConflictCopy, isInside, joinPath, nameProblem, parentPath } from '../lib/paths'
import { iconKind, previewKind, type FileIconKind } from '../lib/preview'
import { openTeamFile } from '../lib/sidePanel'
import { uploadFile, type UploadProgress } from '../lib/upload'
import { useLocale, useT } from '../i18n'
import { filesChanged, reloadAsked } from '../store/live'
import { toast } from '../store/ui'
import FolderPicker from '../components/FolderPicker'
import { Badge, Button, EmptyState, ErrorNote, IconButton, Modal, Skeleton, Tabs, confirmDialog, promptDialog } from '../components/ui'

const ICONS: Record<FileIconKind, typeof FileIcon> = { folder: Folder, image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, audio: FileAudio, video: FileVideo, code: FileCode, archive: FileArchive, text: FileText, other: FileIcon }

interface UploadItem {
  id: number
  name: string
  folder: string
  progress: UploadProgress | null
  status: 'uploading' | 'done' | 'failed'
  error?: string
  abort: AbortController
}

let uploadSeq = 0

export default function Files() {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const path = params.get('path') ?? ''
  const select = params.get('select')
  const [view, setView] = useState<'files' | 'trash'>('files')
  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [drag, setDrag] = useState(false)
  const [history, setHistory] = useState<string | null>(null)
  const [moving, setMoving] = useState<FileEntry | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const go = useCallback((p: string, sel?: string) => setParams(sel ? { path: p, select: sel } : p ? { path: p } : {}), [setParams])

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await api.call(API.tree, { query: { path, limit: 200 } })
      setTree(r)
    } catch (e) {
      if (isApiError(e, 'not_found') && path) {
        // gone or no longer visible: the nearest folder we can still see
        toast({ level: 'warn', text: t('files.accessChanged') })
        go(parentPath(path))
        return
      }
      setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  useEffect(() => {
    setTree(null)
    void load()
  }, [load])

  useEffect(() => {
    const offA = filesChanged.on((changes) => {
      if (changes.some((c) => parentPath(c.path) === path || (c.from && parentPath(c.from) === path) || isInside(path, c.path))) void load()
    })
    const offB = reloadAsked.on(() => void load())
    return () => {
      offA()
      offB()
    }
  }, [path, load])

  const more = async () => {
    if (!tree?.nextCursor) return
    setLoadingMore(true)
    try {
      const r = await api.call(API.tree, { query: { path, limit: 200, cursor: tree.nextCursor } })
      setTree((cur) => (cur ? { ...cur, entries: [...cur.entries, ...r.entries], nextCursor: r.nextCursor } : r))
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setLoadingMore(false)
    }
  }

  const canWrite = tree?.access === 'write'
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })

  const startUploads = (list: File[]) => {
    if (!list.length) return
    if (!canWrite) return toast({ level: 'warn', text: t('files.readOnlyFolder') })
    const folder = path
    for (const file of list) {
      const item: UploadItem = { id: ++uploadSeq, name: file.name, folder, progress: null, status: 'uploading', abort: new AbortController() }
      setUploads((u) => [...u, item])
      const patch = (p: Partial<UploadItem>) => setUploads((u) => u.map((x) => (x.id === item.id ? { ...x, ...p } : x)))
      uploadFile(file, { kind: 'path', path: joinPath(folder, file.name), onExists: 'rename' }, { client: api, signal: item.abort.signal, onProgress: (progress) => patch({ progress }) }).then(
        () => {
          patch({ status: 'done' })
          setTimeout(() => setUploads((u) => u.filter((x) => x.id !== item.id)), 4000)
          if (folder === path) void load()
        },
        (e) => {
          if (item.abort.signal.aborted) return setUploads((u) => u.filter((x) => x.id !== item.id))
          patch({ status: 'failed', error: errorText(e, locale, t('error.network')) })
        },
      )
    }
  }

  const mkdir = async () => {
    const name = await promptDialog({ title: t('files.newFolder'), label: t('files.folderName'), confirm: t('common.create'), validate: (v) => (nameProblem(v) ? t(`files.name.${nameProblem(v)!}`) : null) })
    if (!name) return
    try {
      await api.call(API.mkdir, { body: { path: joinPath(path, name) } })
      void load()
    } catch (e) {
      fail(e)
    }
  }

  const rename = async (e: FileEntry) => {
    const name = await promptDialog({ title: t('files.rename'), label: t('files.newName'), initial: e.name, confirm: t('common.save'), validate: (v) => (nameProblem(v) ? t(`files.name.${nameProblem(v)!}`) : null) })
    if (!name || name === e.name) return
    try {
      await api.call(API.move, { body: { from: e.path, to: joinPath(parentPath(e.path), name), onExists: 'fail' } })
      void load()
    } catch (err) {
      fail(err)
    }
  }

  const moveTo = async (folder: string) => {
    const e = moving
    setMoving(null)
    if (!e) return
    try {
      await api.call(API.move, { body: { from: e.path, to: joinPath(folder, e.name), onExists: 'rename' } })
      toast({ level: 'success', text: t('files.moved', { path: folder || t('files.root') }) })
      void load()
    } catch (err) {
      fail(err)
    }
  }

  const remove = async (e: FileEntry) => {
    if (!(await confirmDialog({ title: t('files.deleteTitle', { name: e.name }), body: t('files.deleteBody'), confirm: t('files.moveToTrash'), danger: true }))) return
    try {
      const r = await api.call(API.remove, { query: { path: e.path } })
      toast({
        level: 'info',
        text: t('files.trashed', { name: e.name }),
        action: { label: t('common.undo'), run: () => void api.call(API.restoreTrash, { params: { id: r.trashId } }).then(() => load(), fail) },
      })
      void load()
    } catch (err) {
      fail(err)
    }
  }

  const chatWith = (e: FileEntry) => navigate(`/?prompt=${encodeURIComponent(t('files.chatPrompt', { path: e.path }))}`)

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if (view !== 'files' || ![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDrag(false)
        startUploads(Array.from(e.dataTransfer.files))
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-6">
        <h1 className="mr-2 text-lg font-semibold">{t('files.title')}</h1>
        <Tabs value={view} onChange={setView} label={t('files.title')} items={[{ id: 'files', label: t('files.all') }, { id: 'trash', label: t('files.trash') }]} />
        {view === 'files' && (
          <div className="ml-auto flex items-center gap-1">
            <IconButton label={t('common.refresh')} onClick={() => void load()}>
              <RefreshCw size={16} />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={mkdir} disabled={!canWrite} aria-label={t('files.newFolder')} title={t('files.newFolder')}>
              <FolderPlus size={15} aria-hidden /> <span className="max-sm:hidden">{t('files.newFolder')}</span>
            </Button>
            <Button size="sm" variant="primary" onClick={() => fileInput.current?.click()} disabled={!canWrite} data-testid="upload-button">
              <Upload size={15} aria-hidden /> {t('files.upload')}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="files-input"
              onChange={(e) => {
                startUploads(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
          </div>
        )}
      </div>

      {view === 'trash' ? (
        <TrashView />
      ) : (
        <>
          <nav aria-label={t('files.breadcrumb')} className="flex flex-wrap items-center gap-1 px-4 py-2 text-sm sm:px-6">
            <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => go('')}>
              <Home size={14} aria-hidden /> {t('files.root')}
            </button>
            {crumbs(path).map((c) => (
              <span key={c.path} className="inline-flex items-center gap-1">
                <ChevronRight size={13} className="text-faint" aria-hidden />
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => go(c.path)} aria-current={c.path === path ? 'page' : undefined}>
                  {c.name}
                </button>
              </span>
            ))}
            {tree && tree.access !== 'write' && (
              <Badge tone="warn" className="ml-2">
                <Lock size={11} aria-hidden /> {t(tree.access === 'read' ? 'files.readOnlyFolder' : 'files.navigationOnly')}
              </Badge>
            )}
          </nav>
          {uploads.length > 0 && <UploadList items={uploads} onDismiss={(id) => setUploads((u) => u.filter((x) => x.id !== id))} />}
          <div className={clsx('scroll-thin relative min-h-0 flex-1 overflow-y-auto px-2 pb-6 sm:px-4', drag && 'bg-accent-soft/40 ring-2 ring-accent ring-inset')}>
            {error && (
              <div className="p-4">
                <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
              </div>
            )}
            {!tree && !error && <Skeleton lines={8} className="p-4" />}
            {tree && !tree.entries.length && (
              <EmptyState icon={<Upload size={28} />} title={canWrite ? t('files.emptyDrop') : t('files.emptyReadOnly')}>
                {canWrite && (
                  <Button size="sm" className="mt-2" onClick={() => fileInput.current?.click()}>
                    {t('files.upload')}
                  </Button>
                )}
              </EmptyState>
            )}
            {tree && tree.entries.length > 0 && (
              <table className="w-full text-sm" data-testid="file-table">
                <thead className="sr-only sm:not-sr-only">
                  <tr className="text-left text-xs text-faint">
                    <th className="px-2 py-2 font-medium">{t('files.name')}</th>
                    <th className="hidden px-2 py-2 font-medium sm:table-cell">{t('files.modified')}</th>
                    <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">{t('files.size')}</th>
                    <th className="w-10 px-2 py-2">
                      <span className="sr-only">{t('files.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tree.entries.map((e) => (
                    <FileRow
                      key={e.path}
                      e={e}
                      selected={select === e.name}
                      onOpen={() => (e.type === 'folder' ? go(e.path) : previewKind(e.name) ? openTeamFile(e.path) : startDownload(fileUrl(e.path), e.name))}
                      onChat={() => chatWith(e)}
                      onRename={() => void rename(e)}
                      onMove={() => setMoving(e)}
                      onDelete={() => void remove(e)}
                      onHistory={() => setHistory(e.path)}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {tree?.nextCursor && (
              <div className="py-3 text-center">
                <Button size="sm" busy={loadingMore} onClick={more}>
                  {t('common.loadMore')}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      <FolderPicker open={!!moving} title={t('files.moveTitle', { name: moving?.name ?? '' })} confirmLabel={t('files.moveHere')} initial={path} onPick={moveTo} onClose={() => setMoving(null)} />
      {history && <HistoryModal path={history} onClose={() => setHistory(null)} onRestored={() => void load()} />}
    </div>
  )
}

function FileRow({ e, selected, onOpen, onChat, onRename, onMove, onDelete, onHistory }: { e: FileEntry; selected: boolean; onOpen: () => void; onChat: () => void; onRename: () => void; onMove: () => void; onDelete: () => void; onHistory: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLTableRowElement>(null)
  const folder = e.type === 'folder'
  const Icon = ICONS[iconKind(e.name, folder)]
  const dim = e.access === 'none'
  const writable = e.access === 'write'
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'center' })
  }, [selected])
  useEffect(() => {
    if (!menu) return
    const h = (ev: MouseEvent) => !ref.current?.contains(ev.target as Node) && setMenu(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [menu])
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-40'
  return (
    <tr ref={ref} className={clsx('group border-b border-line last:border-0', selected && 'bg-accent-soft/60', dim && 'text-muted')} data-testid="file-row">
      <td className="px-2 py-1.5">
        <button type="button" onClick={onOpen} className="flex w-full min-w-0 items-center gap-2.5 rounded py-1 text-left hover:underline" title={dim ? t('files.navigationOnly') : undefined}>
          <Icon size={17} className={clsx('shrink-0', folder ? 'text-accent-text' : 'text-muted', dim && 'opacity-60')} aria-hidden />
          <span className="min-w-0 truncate">{e.name}</span>
          {dim && <span className="sr-only">({t('files.navigationOnly')})</span>}
          {!folder && isConflictCopy(e.name) && <Badge tone="warn">{t('files.conflictCopy')}</Badge>}
          {e.access === 'read' && <Lock size={12} className="shrink-0 text-faint" aria-label={t('files.readOnly')} />}
        </button>
      </td>
      <td className="hidden px-2 py-1.5 text-xs whitespace-nowrap text-muted sm:table-cell">{formatDateTime(e.mtime, locale)}</td>
      <td className="hidden px-2 py-1.5 text-right text-xs whitespace-nowrap text-muted sm:table-cell">{folder ? '' : formatSize(e.size, locale)}</td>
      <td className="relative px-2 py-1.5 text-right">
        {!dim && (
          <IconButton label={t('files.actionsFor', { name: e.name })} aria-expanded={menu} onClick={() => setMenu((v) => !v)} className="sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" data-testid="file-menu">
            <MoreHorizontal size={16} />
          </IconButton>
        )}
        {menu && (
          <div role="menu" className="absolute top-9 right-2 z-30 w-56 rounded-lg border border-line bg-surface p-1 text-left shadow-lg" onClick={() => setMenu(false)}>
            {!folder && previewKind(e.name) && (
              <button role="menuitem" type="button" className={item} onClick={onOpen}>
                <Eye size={14} aria-hidden /> {t('common.preview')}
              </button>
            )}
            {!folder && (
              <button role="menuitem" type="button" className={item} onClick={() => startDownload(fileUrl(e.path), e.name)}>
                <Download size={14} aria-hidden /> {t('common.download')}
              </button>
            )}
            <button role="menuitem" type="button" className={item} onClick={onChat} data-testid="chat-with-file">
              <MessageSquarePlus size={14} aria-hidden /> {t('files.chatWith')}
            </button>
            {!folder && (
              <button role="menuitem" type="button" className={item} onClick={onHistory}>
                <History size={14} aria-hidden /> {t('files.history')}
              </button>
            )}
            <button role="menuitem" type="button" className={item} disabled={!writable} onClick={onRename}>
              <Pencil size={14} aria-hidden /> {t('files.rename')}
            </button>
            <button role="menuitem" type="button" className={item} disabled={!writable} onClick={onMove}>
              <FolderInput size={14} aria-hidden /> {t('files.move')}
            </button>
            <button role="menuitem" type="button" className={clsx(item, 'text-danger')} disabled={!writable} onClick={onDelete}>
              <Trash2 size={14} aria-hidden /> {t('files.moveToTrash')}
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

function UploadList({ items, onDismiss }: { items: UploadItem[]; onDismiss: (id: number) => void }) {
  const t = useT()
  const locale = useLocale()
  return (
    <ul className="mx-4 mb-2 space-y-1 rounded-xl border border-line bg-surface p-2 sm:mx-6" aria-label={t('files.uploads')} data-testid="upload-list">
      {items.map((u) => {
        const pct = u.progress && u.progress.total ? Math.round((u.progress.loaded / u.progress.total) * 100) : 0
        return (
          <li key={u.id} className="flex items-center gap-2 text-xs">
            {u.status === 'uploading' ? <Loader2 size={13} className="shrink-0 animate-spin text-accent-text" aria-hidden /> : u.status === 'done' ? <span className="text-ok">✓</span> : <span className="text-danger">!</span>}
            <span className="min-w-0 flex-1 truncate">{u.name}</span>
            {u.status === 'uploading' && (
              <span className="shrink-0 text-faint">
                {u.progress?.phase === 'hashing' ? t('files.preparing') : u.progress?.phase === 'finishing' ? t('files.finishing') : `${pct}%`}
                {u.progress && ` · ${formatSize(u.progress.total, locale)}`}
              </span>
            )}
            {u.status === 'failed' && <span className="max-w-[50%] truncate text-danger">{u.error}</span>}
            {u.status === 'uploading' && (
              <div className="h-1 w-20 shrink-0 overflow-hidden rounded bg-subtle" aria-hidden>
                <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            )}
            <IconButton label={u.status === 'uploading' ? t('common.cancel') : t('common.close')} onClick={() => (u.status === 'uploading' ? u.abort.abort() : onDismiss(u.id))}>
              <X size={13} />
            </IconButton>
          </li>
        )
      })}
    </ul>
  )
}

function HistoryModal({ path, onClose, onRestored }: { path: string; onClose: () => void; onRestored: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<FileVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.history, { query: { path } }).then(
      (r) => live && setItems([...r.items].sort((a, b) => b.version - a.version)),
      (e) => live && setError(errorText(e, locale, t('error.network'))),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  const restore = async (v: FileVersion) => {
    if (!(await confirmDialog({ title: t('files.restoreTitle', { version: v.version }), body: t('files.restoreBody'), confirm: t('common.restore') }))) return
    setBusy(v.id)
    try {
      await api.call(API.restoreVersion, { body: { path, versionId: v.id } })
      toast({ level: 'success', text: t('files.restored', { version: v.version }) })
      onRestored()
      onClose()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('files.historyOf', { name: baseName(path) })} width={600}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={4} />}
      {items && !items.length && <p className="text-sm text-muted">{t('files.noHistory')}</p>}
      {items && items.length > 0 && (
        <ul className="divide-y divide-line" data-testid="history-list">
          {items.map((v, i) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <span className="w-10 font-medium tabular-nums">v{v.version}</span>
              <span className="min-w-0 flex-1">
                <span className="block">{v.author?.name ?? t('files.byAi')}</span>
                <span className="block text-xs text-faint">
                  {formatDateTime(v.createdAt, locale)} · {formatSize(v.size, locale)}
                  {v.turnId && ` · ${t('files.byAiTurn')}`}
                </span>
                {v.kind === 'conflict_copy' && v.conflictPath && (
                  <button type="button" className="block text-xs text-warn underline" onClick={() => openTeamFile(v.conflictPath!)}>
                    {t('files.conflictSaved', { path: v.conflictPath })}
                  </button>
                )}
                {v.kind === 'restore' && <span className="block text-xs text-faint">{t('files.restoredVersion')}</span>}
              </span>
              <IconButton label={t('common.download')} onClick={() => startDownload(versionDownloadUrl(v.id), `${baseName(path)}`)}>
                <Download size={15} />
              </IconButton>
              {i > 0 && (
                <Button size="sm" busy={busy === v.id} onClick={() => restore(v)}>
                  <ArchiveRestore size={14} aria-hidden /> {t('common.restore')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

function TrashView() {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(async (more = false) => {
    try {
      const r = await api.call(API.trash, { query: { limit: 100, cursor: more ? cursor ?? undefined : undefined } })
      setItems((cur) => (more && cur ? [...cur, ...r.items] : r.items))
      setCursor(r.nextCursor)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor])
  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const restore = async (it: TrashItem) => {
    setBusy(it.id)
    try {
      const r = await api.call(API.restoreTrash, { params: { id: it.id } })
      toast({ level: 'success', text: t('files.restoredTo', { path: r.entry.path }) })
      setItems((cur) => cur?.filter((x) => x.id !== it.id) ?? null)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }
  const sorted = useMemo(() => items ?? [], [items])
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
      <p className="mb-3 text-xs text-faint">{t('files.trashNote')}</p>
      {error && <ErrorNote onRetry={() => void load(false)}>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={5} />}
      {items && !items.length && <EmptyState icon={<Trash2 size={28} />} title={t('files.trashEmpty')} />}
      <ul className="divide-y divide-line" data-testid="trash-list">
        {sorted.map((it) => (
          <li key={it.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{it.originalPath}</span>
              <span className="block text-xs text-faint">
                {t('files.deletedBy', { who: it.deletedBy?.name ?? t('files.byAi'), date: formatDateTime(it.deletedAt, locale) })} · {t('files.purgeAt', { date: formatDateTime(it.purgeAt, locale) })}
              </span>
            </span>
            <Button size="sm" busy={busy === it.id} onClick={() => restore(it)}>
              <ArchiveRestore size={14} aria-hidden /> {t('common.restore')}
            </Button>
          </li>
        ))}
      </ul>
      {cursor && (
        <div className="py-3 text-center">
          <Button size="sm" onClick={() => void load(true)}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
