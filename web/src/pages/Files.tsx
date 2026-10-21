// The team folder explorer: only what the person may see (folders shown for navigation only are greyed out),
// upload (drag and drop; chunked and resumable when large), download, new folder, rename / move, trash, version
// history with restore, conflict copies marked, "start a chat with this file". Refreshes on files.changed.
import clsx from 'clsx'
import { ArchiveRestore, BookmarkPlus, ChevronRight, Copy, Download, Eye, File as FileIcon, FileImage, FileSpreadsheet, FileText, Folder, FolderInput, FolderPlus, History, Home, Loader2, Lock, MessageSquarePlus, MoreHorizontal, Paperclip, Pencil, Presentation, Sparkles, RefreshCw, Trash2, Upload, X, FileCode, FileArchive, FileAudio, FileVideo } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { FileEntry, FileVersion, TrashItem, TreeResponse } from '@mycel/shared/api'
import { api, API, errorText, fileUrl, isApiError, startDownload, versionDownloadUrl } from '../lib/api'
import { formatDateTime, formatSize } from '../lib/format'
import { baseName, crumbs, isConflictCopy, isInside, joinPath, nameProblem, parentPath } from '../lib/paths'
import { iconKind, previewKind, type FileIconKind } from '../lib/preview'
import { openTeamFile } from '../lib/sidePanel'
import { TEAM_FILE_DRAG_TYPE } from '../lib/teamAttach'
import { useTeamAttach } from '../lib/useTeamAttach'
import { cancelUpload, uploadFile, type UploadProgress } from '../lib/upload'
import { useLocale, useT } from '../i18n'
import { accessChanged, filesChanged, reloadAsked } from '../store/live'
import { toast } from '../store/ui'
import FolderPicker from '../components/FolderPicker'
import SuggestSkillDialog from '../components/SuggestSkillDialog'
import { useMeStrict } from '../store/session'
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
  const [history, setHistory] = useState<string | null>(params.get('history'))
  const [suggesting, setSuggesting] = useState<string | null>(null)
  const me = useMeStrict()
  // "버전 기록 보기" from a banner while this screen is open: the address changes, the history opens
  const historyParam = params.get('history')
  useEffect(() => {
    if (historyParam) setHistory(historyParam)
  }, [historyParam])
  const [moving, setMoving] = useState<FileEntry | null>(null)
  const [sharing, setSharing] = useState<FileEntry | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const go = useCallback((p: string, sel?: string) => setParams(sel ? { path: p, select: sel } : p ? { path: p } : {}), [setParams])

  /** the folder the table last showed: a not_found for it means access changed while it was open (tab 5 "권한 회수") */
  const shown = useRef<string | null>(null)
  const load = useCallback(async () => {
    setError(null)
    try {
      setTree(await api.call(API.tree, { query: { path, limit: 200 } }))
      shown.current = path
    } catch (e) {
      if (isApiError(e, 'not_found') && path) {
        // gone or not visible: climb to the nearest folder we can see, then say so once (not once per level)
        const wasShown = shown.current === path
        let up = parentPath(path)
        while (up) {
          try {
            await api.call(API.tree, { query: { path: up, limit: 1 } })
            break
          } catch (e2) {
            if (!isApiError(e2, 'not_found')) break
            up = parentPath(up)
          }
        }
        toast({ level: 'warn', text: t(wasShown ? 'files.accessChanged' : 'files.folderNotFound') })
        setParams(up ? { path: up } : {}, { replace: true })
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
    const offC = accessChanged.on(() => void load())
    return () => {
      offA()
      offB()
      offC()
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
      const target = { kind: 'path', path: joinPath(folder, file.name), onExists: 'rename' } as const
      uploadFile(file, target, { client: api, signal: item.abort.signal, onProgress: (progress) => patch({ progress }) }).then(
        () => {
          patch({ status: 'done' })
          setTimeout(() => setUploads((u) => u.filter((x) => x.id !== item.id)), 4000)
          if (folder === path) void load()
        },
        (e) => {
          if (item.abort.signal.aborted) {
            // cancelled: drop the server's half-received session too (it holds disk space and counts against the
            // person's open uploads for a day otherwise)
            void cancelUpload(file, target, api)
            return setUploads((u) => u.filter((x) => x.id !== item.id))
          }
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

  /** POST /api/files/move; when other people would lose sight of the item (into users/<me>/), ask first, then confirm. */
  const moveConfirmed = async (body: { from: string; to: string; onExists: 'fail' | 'rename' }): Promise<boolean> => {
    try {
      await api.call(API.move, { body })
      return true
    } catch (err) {
      if (!(isApiError(err, 'conflict') && err.body.params?.reason === 'audience_narrowed')) throw err
      const n = Number(err.body.params.lostViewers ?? 0)
      if (!(await confirmDialog({ title: t('files.narrowTitle'), body: t('files.narrowBody', { n }), confirm: t('files.moveAnyway'), danger: true }))) return false
      await api.call(API.move, { body: { ...body, confirm: true } })
      return true
    }
  }

  const rename = async (e: FileEntry) => {
    const name = await promptDialog({ title: t('files.rename'), label: t('files.newName'), initial: e.name, confirm: t('common.save'), validate: (v) => (nameProblem(v) ? t(`files.name.${nameProblem(v)!}`) : null) })
    if (!name || name === e.name) return
    try {
      if (await moveConfirmed({ from: e.path, to: joinPath(parentPath(e.path), name), onExists: 'fail' })) void load()
    } catch (err) {
      fail(err)
    }
  }

  const moveTo = async (folder: string) => {
    const e = moving
    setMoving(null)
    if (!e) return
    try {
      if (!(await moveConfirmed({ from: e.path, to: joinPath(folder, e.name), onExists: 'rename' }))) return
      toast({ level: 'success', text: t('files.moved', { path: folder || t('files.root') }) })
      void load()
    } catch (err) {
      fail(err)
    }
  }

  /** '공유' (design tab 2 rule 3): copy the file into a team folder; first say how many more people will see it. */
  const shareTo = async (folder: string) => {
    const e = sharing
    setSharing(null)
    if (!e) return
    const body = { from: e.path, to: joinPath(folder, e.name), onExists: 'rename' as const }
    try {
      const dry = await api.call(API.copy, { body: { ...body, dryRun: true } })
      const n = 'viewersAdded' in dry ? dry.viewersAdded : 0
      if (n > 0 && !(await confirmDialog({ title: t('files.shareTitle', { name: e.name }), body: t('files.shareBody', { n }), confirm: t('files.shareCopy') }))) return
      const r = await api.call(API.copy, { body })
      if ('path' in r) toast({ level: 'success', text: t('files.shared', { path: r.path }) })
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

  // a file goes into a new chat as an attachment (a team-file reference); a folder is named in the prompt
  const chatAttach = useTeamAttach()
  const chatWith = (e: FileEntry) => (e.type === 'file' ? chatAttach.askAi([e.path]) : navigate(`/?prompt=${encodeURIComponent(t('files.chatPrompt', { path: e.path }))}`))
  const addToChat = (e: FileEntry) => chatAttach.addToChat([e.path])

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
                      onAddToChat={chatAttach.target ? () => addToChat(e) : null}
                      chatTitle={chatAttach.target?.title ?? ''}
                      onRename={() => void rename(e)}
                      onMove={() => setMoving(e)}
                      onShare={() => setSharing(e)}
                      onDelete={() => void remove(e)}
                      onHistory={() => setHistory(e.path)}
                      onSuggest={e.type === 'file' && e.path.startsWith(`users/${me.user.id}/`) && /\.(md|txt)$/i.test(e.name) ? () => setSuggesting(e.path) : null}
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
      <FolderPicker open={!!sharing} title={t('files.shareTitle', { name: sharing?.name ?? '' })} confirmLabel={t('files.shareHere')} initial="shared" onPick={shareTo} onClose={() => setSharing(null)} />
      <FolderPicker open={!!moving} title={t('files.moveTitle', { name: moving?.name ?? '' })} confirmLabel={t('files.moveHere')} initial={path} onPick={moveTo} onClose={() => setMoving(null)} />
      {history && (
        <HistoryModal
          path={history}
          onClose={() => {
            setHistory(null)
            // opened from a link (a team skill changed: "버전 기록 보기"): the address no longer asks for it
            if (params.get('history')) setParams(select ? { path, select } : path ? { path } : {}, { replace: true })
          }}
          onRestored={() => void load()}
        />
      )}
      {suggesting && <SuggestSkillDialog source={{ kind: 'file', path: suggesting }} initialName={baseName(suggesting).replace(/\.(md|txt)$/i, '')} onClose={() => setSuggesting(null)} />}
    </div>
  )
}

function FileRow({ e, selected, onOpen, onChat, onAddToChat, chatTitle, onRename, onMove, onShare, onDelete, onHistory, onSuggest }: { e: FileEntry; selected: boolean; onOpen: () => void; onChat: () => void; onAddToChat: (() => void) | null; chatTitle: string; onRename: () => void; onMove: () => void; onShare: () => void; onDelete: () => void; onHistory: () => void; onSuggest: (() => void) | null }) {
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
      {/* w-full + max-w-0: the name column takes the room that is left and a long name ends in "…" instead of
          pushing the table wider than the screen (phones) or the space beside an open file panel */}
      <td className="w-full max-w-0 px-2 py-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-center gap-2.5 rounded py-1 text-left hover:underline"
          title={dim ? t('files.navigationOnly') : undefined}
          // a file can be dragged into a chat's message box (attached as a team file)
          draggable={!folder}
          onDragStart={(ev) => {
            if (folder) return
            ev.dataTransfer.setData(TEAM_FILE_DRAG_TYPE, e.path)
            ev.dataTransfer.setData('text/plain', e.path)
            ev.dataTransfer.effectAllowed = 'copy'
          }}
        >
          <Icon size={17} className={clsx('shrink-0', folder ? 'text-accent-text' : 'text-muted', dim && 'opacity-60')} aria-hidden />
          <span className="min-w-0 truncate" title={e.name}>
            {e.name}
          </span>
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
              {folder ? <MessageSquarePlus size={14} aria-hidden /> : <Sparkles size={14} aria-hidden />} {t(folder ? 'files.chatWith' : 'files.askAi')}
            </button>
            {!folder && onAddToChat && (
              <button role="menuitem" type="button" className={item} onClick={onAddToChat} data-testid="add-to-chat">
                <Paperclip size={14} aria-hidden /> <span className="min-w-0 truncate">{t('files.addToChatNamed', { title: chatTitle })}</span>
              </button>
            )}
            {!folder && (
              <button role="menuitem" type="button" className={item} onClick={onHistory}>
                <History size={14} aria-hidden /> {t('files.history')}
              </button>
            )}
            {onSuggest && (
              <button role="menuitem" type="button" className={item} onClick={onSuggest} data-testid="suggest-skill-file">
                <BookmarkPlus size={14} aria-hidden /> {t('suggest.button')}
              </button>
            )}
            {!folder && (
              <button role="menuitem" type="button" className={item} onClick={onShare} data-testid="share-file">
                <Copy size={14} aria-hidden /> {t('files.share')}
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
  // every stored version is an earlier content of the file (the newest one is what it was before the last change),
  // so each can be restored by whoever may write the file; only one identical to the file as it is now is not offered
  const [current, setCurrent] = useState<{ sha256: string | null; canRestore: boolean }>({ sha256: null, canRestore: true })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.history, { query: { path } }).then(
      (r) => {
        if (!live) return
        setItems([...r.items].sort((a, b) => b.version - a.version))
        setCurrent({ sha256: r.currentSha256 ?? null, canRestore: r.canRestore ?? true })
      },
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
          {items.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm" data-version={v.version}>
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
              {current.sha256 === v.sha256 ? (
                <Badge tone="neutral">{t('files.sameAsNow')}</Badge>
              ) : (
                current.canRestore && (
                  <Button size="sm" busy={busy === v.id} onClick={() => restore(v)}>
                    <ArchiveRestore size={14} aria-hidden /> {t('common.restore')}
                  </Button>
                )
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
