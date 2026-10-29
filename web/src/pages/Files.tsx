// The team folder explorer: only what the person may see (folders shown for navigation only are greyed out),
// upload (drag and drop; chunked and resumable when large), download, new folder, rename / move, trash, version
// history with restore, conflict copies marked, "start a chat with this file". Refreshes on files.changed.
// Several items at once: a checkbox per row (Shift+click: a range; the header one: every row listed; Esc: none), then
// move / share / trash for all of them from the bar that replaces the breadcrumbs (lib/bulkFiles.ts).
import clsx from 'clsx'
import { ArchiveRestore, BookmarkPlus, ChevronRight, Copy, Download, Eye, File as FileIcon, FileImage, FileSpreadsheet, FileText, Folder, FolderInput, FolderPlus, History, Home, Loader2, Lock, MessageSquarePlus, MoreHorizontal, Paperclip, Pencil, Presentation, Search, Sparkles, RefreshCw, Trash2, Upload, X, FileCode, FileArchive, FileAudio, FileVideo } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { FileEntry, FileHistoryEvent, FileVersion, HistoryResponse, TrashItem, TreeResponse } from '@mycel/shared/api'
import { api, API, errorText, fileUrl, isApiError, startDownload, versionDownloadUrl } from '../lib/api'
import { canChange, canShare, clickSelect, failureList, moveMany, selectable, selectionState, shareMany, toggleAll, trashMany, type Outcome } from '../lib/bulkFiles'
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
import { contentQueryReady, FileContentResults } from '../components/FileContentSearch'
import FolderPicker from '../components/FolderPicker'
import SuggestSkillDialog from '../components/SuggestSkillDialog'
import { SkillIssues } from '../components/SkillIssues'
import { isSkillsPath } from '../lib/skillIssues'
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
  /** file content search (R2-ETC-02): the query is in the URL, so the ⌘K dialog can open the file screen with it */
  const q = params.get('q') ?? ''
  const searching = contentQueryReady(q)
  const setQuery = (v: string) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev)
        if (v) n.set('q', v)
        else n.delete('q')
        n.delete('select')
        return n
      },
      { replace: true },
    )
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
  // several items at once: the checked rows (paths), the row clicked last (Shift+click selects from it), the folder
  // picker open for them and the action running
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const [bulkPick, setBulkPick] = useState<'move' | 'share' | null>(null)
  const [running, setRunning] = useState<'move' | 'share' | 'delete' | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const go = useCallback((p: string, sel?: string) => setParams(sel ? { path: p, select: sel } : p ? { path: p } : {}), [setParams])

  /** the folder the table last showed: a not_found for it means access changed while it was open (tab 5 "권한 회수") */
  const shown = useRef<string | null>(null)
  /** only the latest listing request may set the table: an older answer arriving last (the first listing of a slow
   * folder, after the reload an upload asked for) showed the folder without the new file */
  const loads = useRef(0)
  const load = useCallback(async () => {
    const mine = ++loads.current
    setError(null)
    try {
      const r = await api.call(API.tree, { query: { path, limit: 200 } })
      if (mine !== loads.current) return
      setTree(r)
      shown.current = path
    } catch (e) {
      if (mine !== loads.current) return
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
  const errText = (e: unknown) => errorText(e, locale, t('error.network'))
  const fail = (e: unknown) => toast({ level: 'error', text: errText(e) })

  // ---------------- selection ----------------
  // another folder or the trash: nothing stays selected
  useEffect(() => {
    setChecked((c) => (c.size ? new Set() : c))
    anchor.current = null
  }, [path, view])
  /** the rows that can be selected, as listed */
  const order = useMemo(() => tree?.entries.filter(selectable).map((e) => e.path) ?? [], [tree])
  // the listing changed (moved away, deleted by someone else): only rows still listed stay selected
  useEffect(() => {
    const here = new Set(order)
    setChecked((c) => ([...c].every((p) => here.has(p)) ? c : new Set([...c].filter((p) => here.has(p)))))
  }, [order])
  const chosen = useMemo(() => tree?.entries.filter((e) => checked.has(e.path)) ?? [], [tree, checked])
  const movable = chosen.filter(canChange)
  const shareable = chosen.filter(canShare)
  const allState = selectionState(checked, order)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = allState === 'some'
  })
  const check = (p: string, shift: boolean) => {
    const from = anchor.current
    setChecked((c) => clickSelect(c, order, p, from, shift))
    anchor.current = p
  }
  const clearChecked = () => {
    setChecked(new Set())
    anchor.current = null
  }
  // Esc clears the selection (before the side panel: the next Esc closes that); a dialog or a text field keeps its Esc
  const anyChecked = chosen.length > 0
  useEffect(() => {
    if (!anyChecked) return
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"]')) return
      if (e.target instanceof Element && e.target.closest('textarea, select, [contenteditable="true"], input:not([type="checkbox"])')) return
      e.stopPropagation()
      clearChecked()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [anyChecked])
  // the bar went away under the focus (cleared, or its action done): focus goes to the header checkbox, not the page
  const hadChecked = useRef(false)
  useEffect(() => {
    if (hadChecked.current && !anyChecked && (!document.activeElement || document.activeElement === document.body)) selectAllRef.current?.focus()
    hadChecked.current = anyChecked
  }, [anyChecked])

  /** One toast for a batch: what was done, what was skipped, the first few failures. What failed or what the person
   * said no to stays selected, to try again or take elsewhere. */
  const reportBatch = (r: Outcome, words: { done: (n: number) => string; failed: (n: number, list: string) => string; skipped?: string | null; okLevel?: 'success' | 'info' }, action?: { label: string; run: () => void }) => {
    if (r.done.length || r.failed.length) {
      const parts = [r.done.length ? words.done(r.done.length) : null, words.skipped ?? null, r.failed.length ? words.failed(r.failed.length, failureList(r.failed, errText, (n) => t('files.bulk.more', { n }))) : null]
      toast({
        level: r.failed.length ? (r.done.length ? 'warn' : 'error') : words.skipped ? 'warn' : words.okLevel ?? 'success',
        text: parts.filter(Boolean).join(' '),
        action: r.done.length ? action : undefined,
      })
    }
    setChecked(new Set([...r.failed.map((f) => f.entry.path), ...r.declined.map((e) => e.path)]))
    anchor.current = null
  }

  /** Move the selection: one folder for all; one question when some of them would be hidden from other people. */
  const bulkMove = async (folder: string) => {
    setBulkPick(null)
    const skipped = chosen.length - movable.length
    setRunning('move')
    try {
      const r = await moveMany(movable, folder, {
        move: (body) => api.call(API.move, { body }),
        confirmNarrow: (count, n) => confirmDialog({ title: t('files.narrowTitle'), body: t('files.bulk.narrowBody', { count, n }), confirm: t('files.moveAnyway'), danger: true }),
      })
      reportBatch(r, {
        done: (n) => t('files.bulk.moved', { n, path: folder || t('files.root') }),
        failed: (n, list) => t('files.bulk.moveFailed', { n, list }),
        skipped: skipped ? t('files.bulk.skipReadOnly', { n: skipped }) : null,
      })
    } finally {
      setRunning(null)
      void load()
    }
  }

  /** Share the selected files by copying them into one team folder; one question about who else will see them. */
  const bulkShare = async (folder: string) => {
    setBulkPick(null)
    const skipped = chosen.length - shareable.length
    setRunning('share')
    try {
      const r = await shareMany(shareable, folder, {
        copy: (body) => api.call(API.copy, { body }),
        confirmShare: (count, n) => confirmDialog({ title: t('files.bulk.shareConfirm', { n: count }), body: t('files.bulk.shareBody', { count, n }), confirm: t('files.shareCopy') }),
      })
      reportBatch(r, {
        done: (n) => t('files.bulk.shared', { n, path: folder || t('files.root') }),
        failed: (n, list) => t('files.bulk.shareFailed', { n, list }),
        skipped: skipped ? t('files.bulk.skipFolders', { n: skipped }) : null,
      })
    } finally {
      setRunning(null)
      void load()
    }
  }

  /** Trash the selection after one question; "Undo" brings all of them back. */
  const bulkDelete = async () => {
    const items = movable
    if (!items.length) return
    const skipped = chosen.length - items.length
    const body = skipped ? `${t('files.deleteBody')} ${t('files.bulk.readOnlyLeft', { n: skipped })}` : t('files.deleteBody')
    if (!(await confirmDialog({ title: t('files.bulk.deleteTitle', { n: items.length }), body, confirm: t('files.moveToTrash'), danger: true }))) return
    setRunning('delete')
    try {
      const r = await trashMany(items, { remove: (p) => api.call(API.remove, { query: { path: p } }) })
      const undo = async () => {
        try {
          for (const id of r.trashIds) await api.call(API.restoreTrash, { params: { id } })
        } catch (err) {
          fail(err)
        }
        void load()
      }
      reportBatch(r, { done: (n) => t('files.bulk.trashed', { n }), failed: (n, list) => t('files.bulk.deleteFailed', { n, list }), okLevel: 'info' }, { label: t('common.undo'), run: () => void undo() })
    } finally {
      setRunning(null)
      void load()
    }
  }

  const startUploads = (list: File[]) => {
    if (!list.length) return
    // only a folder known to be read-only refuses here; while its listing is still loading (a file dropped or picked
    // right after opening the folder) the server decides, and a refusal shows on the upload row. Refusing then said
    // "read-only folder" for a folder the person can write and dropped the file (e2e mobile upload on a slow server).
    if (tree && !canWrite) return toast({ level: 'warn', text: t('files.readOnlyFolder') })
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
            <label className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 focus-within:ring-2 focus-within:ring-accent">
              <Search size={14} className="shrink-0 text-faint" aria-hidden />
              <span className="sr-only">{t('files.search.label')}</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && q) {
                    e.preventDefault()
                    setQuery('')
                  }
                }}
                placeholder={t('files.search.placeholder')}
                maxLength={200}
                className="w-28 min-w-0 bg-transparent text-sm outline-none placeholder:text-faint sm:w-48"
                data-testid="content-search-input"
              />
              {q && (
                <button type="button" className="text-faint hover:text-ink" onClick={() => setQuery('')} aria-label={t('files.search.clear')} title={t('files.search.clear')}>
                  <X size={14} aria-hidden />
                </button>
              )}
            </label>
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
          {anyChecked ? (
            <BulkBar
              count={chosen.length}
              readOnly={chosen.length - movable.length}
              canMove={movable.length > 0}
              canShare={shareable.length > 0}
              running={running}
              onMove={() => setBulkPick('move')}
              onShare={() => setBulkPick('share')}
              onDelete={() => void bulkDelete()}
              onClear={clearChecked}
            />
          ) : (
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
          )}
          {isSkillsPath(path) && <SkillIssues folder={path} className="mx-4 mb-2 sm:mx-6" />}
          {uploads.length > 0 && <UploadList items={uploads} onDismiss={(id) => setUploads((u) => u.filter((x) => x.id !== id))} />}
          <div className={clsx('scroll-thin relative min-h-0 flex-1 overflow-y-auto px-2 pb-6 sm:px-4', drag && 'bg-accent-soft/40 ring-2 ring-accent ring-inset')}>
            {searching ? (
              <FileContentResults q={q} path={path} folderLabel={path || t('files.root')} />
            ) : (
              <>
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
                    {/* on phones too: the header checkbox selects every row listed */}
                    <thead>
                      <tr className="text-left text-xs text-faint">
                        <th className="w-0 py-1 pr-0 pl-1">
                          <CheckBox
                            inputRef={selectAllRef}
                            checked={allState === 'all'}
                            disabled={!order.length}
                            label={t('files.selectAll')}
                            onCheck={() => {
                              setChecked((c) => toggleAll(c, order))
                              anchor.current = null
                            }}
                            testId="select-all"
                          />
                        </th>
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
                          checked={checked.has(e.path)}
                          onCheck={(shift) => check(e.path, shift)}
                          // A file without a viewer opens the panel too: it shows the "can't be previewed" notice and a download button.
                          onOpen={() => (e.type === 'folder' ? go(e.path) : openTeamFile(e.path))}
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
              </>
            )}
          </div>
        </>
      )}
      <FolderPicker open={!!sharing} title={t('files.shareTitle', { name: sharing?.name ?? '' })} confirmLabel={t('files.shareHere')} initial="shared" onPick={shareTo} onClose={() => setSharing(null)} />
      <FolderPicker open={!!moving} title={t('files.moveTitle', { name: moving?.name ?? '' })} confirmLabel={t('files.moveHere')} initial={path} onPick={moveTo} onClose={() => setMoving(null)} />
      <FolderPicker
        open={bulkPick !== null}
        title={bulkPick === 'share' ? t('files.bulk.shareTitle', { n: shareable.length }) : t('files.bulk.moveTitle', { n: movable.length })}
        confirmLabel={t(bulkPick === 'share' ? 'files.shareHere' : 'files.moveHere')}
        initial={bulkPick === 'share' ? 'shared' : path}
        onPick={(folder) => void (bulkPick === 'share' ? bulkShare(folder) : bulkMove(folder))}
        onClose={() => setBulkPick(null)}
      />
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

/** The selection's actions, in place of the breadcrumbs while something is selected. */
function BulkBar({ count, readOnly, canMove, canShare, running, onMove, onShare, onDelete, onClear }: { count: number; readOnly: number; canMove: boolean; canShare: boolean; running: 'move' | 'share' | 'delete' | null; onMove: () => void; onShare: () => void; onDelete: () => void; onClear: () => void }) {
  const t = useT()
  return (
    <div role="region" aria-label={t('files.bulk.label')} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-1 sm:px-6" data-testid="bulk-bar">
      <span className="text-sm font-medium" aria-live="polite" data-testid="bulk-count">
        {t('files.bulk.count', { n: count })}
      </span>
      {/* why move and trash leave some out (or are off): the row menu offers them only where the person may write */}
      {readOnly > 0 && (
        <Badge tone="warn">
          <Lock size={11} aria-hidden /> {t('files.bulk.readOnlyIn', { n: readOnly })}
        </Badge>
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <Button size="sm" onClick={onMove} disabled={!canMove || !!running} busy={running === 'move'} data-testid="bulk-move">
          <FolderInput size={14} aria-hidden /> {t('files.move')}
        </Button>
        <Button size="sm" onClick={onShare} disabled={!canShare || !!running} busy={running === 'share'} title={canShare ? undefined : t('files.bulk.noFiles')} data-testid="bulk-share">
          <Copy size={14} aria-hidden /> {t('files.share')}
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete} disabled={!canMove || !!running} busy={running === 'delete'} data-testid="bulk-delete">
          <Trash2 size={14} aria-hidden /> {t('files.moveToTrash')}
        </Button>
        <IconButton label={t('files.bulk.clear')} onClick={onClear} disabled={!!running} data-testid="bulk-clear">
          <X size={16} />
        </IconButton>
      </div>
    </div>
  )
}

/** A row's (or the header's) checkbox. The padding around it takes the click too (a bigger target on phones); Shift
 * with a click or Space selects a range, and does not select page text. */
function CheckBox({ checked, disabled, label, title, onCheck, inputRef, testId }: { checked: boolean; disabled?: boolean; label: string; title?: string; onCheck: (shift: boolean) => void; inputRef?: React.Ref<HTMLInputElement>; testId: string }) {
  return (
    <label
      className={clsx('flex items-center justify-center rounded p-1.5 max-sm:p-2.5', disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-hover')}
      title={title}
      onMouseDown={(ev) => {
        if (!ev.shiftKey) return
        ev.preventDefault() // no text selected from the last click to here; the checkbox still takes the focus
        ev.currentTarget.querySelector('input')?.focus()
      }}
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="h-4 w-4 accent-[var(--c-accent)] disabled:opacity-40 dark:[color-scheme:dark]"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(ev) => onCheck((ev.nativeEvent as MouseEvent).shiftKey === true)}
        data-testid={testId}
      />
    </label>
  )
}

function FileRow({ e, selected, checked, onCheck, onOpen, onChat, onAddToChat, chatTitle, onRename, onMove, onShare, onDelete, onHistory, onSuggest }: { e: FileEntry; selected: boolean; checked: boolean; onCheck: (shift: boolean) => void; onOpen: () => void; onChat: () => void; onAddToChat: (() => void) | null; chatTitle: string; onRename: () => void; onMove: () => void; onShare: () => void; onDelete: () => void; onHistory: () => void; onSuggest: (() => void) | null }) {
  const t = useT()
  const locale = useLocale()
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLTableRowElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
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
    <tr ref={ref} className={clsx('group border-b border-line last:border-0', (selected || checked) && 'bg-accent-soft/60', dim && 'text-muted')} data-testid="file-row">
      <td className="w-0 py-1 pr-0 pl-1">
        <CheckBox checked={checked} disabled={dim} label={t('files.select', { name: e.name })} title={dim ? t('files.navigationOnly') : undefined} onCheck={onCheck} testId="file-check" />
      </td>
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
          <IconButton label={t('files.actionsFor', { name: e.name })} aria-expanded={menu} onClick={(ev) => { menuTrigger.current = ev.currentTarget; setMenu((v) => !v) }} className="sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" data-testid="file-menu">
            <MoreHorizontal size={16} />
          </IconButton>
        )}
        {menu && (
          <div role="menu" className="absolute top-9 right-2 z-30 w-56 rounded-lg border border-line bg-surface p-1 text-left shadow-lg"
            // Anchor dialog return focus before the item's handler runs and this menu unmounts.
            onClickCapture={() => menuTrigger.current?.focus()} onClick={() => setMenu(false)}>
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
  // the content as it is now with the person who saved it, and the changes (created / edited / moved / ...)
  const [now, setNow] = useState<NonNullable<HistoryResponse['current']> | null>(null)
  const [events, setEvents] = useState<FileHistoryEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.history, { query: { path } }).then(
      (r) => {
        if (!live) return
        setItems([...r.items].sort((a, b) => b.version - a.version))
        setCurrent({ sha256: r.currentSha256 ?? null, canRestore: r.canRestore ?? true })
        setNow(r.current ?? null)
        setEvents(r.events ?? [])
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
      {items && !items.length && !now && !events.length && <p className="text-sm text-muted">{t('files.noHistory')}</p>}
      {items && (items.length > 0 || now) && (
        <ul className="divide-y divide-line" data-testid="history-list">
          {now && (
            <li className="flex flex-wrap items-center gap-2 py-2.5 text-sm" data-current data-version={now.version}>
              <span className="w-10 font-medium tabular-nums">v{now.version}</span>
              <span className="min-w-0 flex-1">
                <span className="block">{now.author?.name ?? t('files.unknownAuthor')}</span>
                <span className="block text-xs text-faint">
                  {now.at ? `${formatDateTime(now.at, locale)} · ` : ''}{formatSize(now.size, locale)}
                  {now.turnId && ` · ${t('files.byAiTurn')}`}
                </span>
              </span>
              <Badge tone="neutral">{t('files.currentVersion')}</Badge>
            </li>
          )}
          {items.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm" data-version={v.version}>
              <span className="w-10 font-medium tabular-nums">v{v.version}</span>
              <span className="min-w-0 flex-1">
                {/* the person whose save made this content; for versions stored before that was recorded only the
                    person who replaced it is known, and the line says so */}
                <span className="block">{v.savedBy ? v.savedBy.name : t('files.replacedBy', { name: v.author?.name ?? t('files.byAi') })}</span>
                <span className="block text-xs text-faint">
                  {formatDateTime(v.createdAt, locale)} · {formatSize(v.size, locale)}
                  {v.savedBy ? v.savedTurnId && ` · ${t('files.byAiTurn')}` : v.turnId && ` · ${t('files.replacedDuringAi')}`}
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
      {events.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-1 text-xs font-medium text-muted">{t('files.activity')}</h3>
          <ul className="divide-y divide-line" data-testid="history-events">
            {events.map((e) => (
              <li key={e.id} className="py-2 text-sm" data-kind={e.kind}>
                <span className="block">{eventText(e, t)}</span>
                <span className="block text-xs text-faint">
                  {e.by?.name ?? t('files.unknownAuthor')} · {formatDateTime(e.at, locale)}
                  {e.turnId && ` · ${t('files.ev.duringAi')}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  )
}

/** One line of the file's changes: what happened, with the earlier path when the caller may see it. */
function eventText(e: FileHistoryEvent, t: ReturnType<typeof useT>): string {
  switch (e.kind) {
    case 'created': return t('files.ev.created')
    case 'edited': return t('files.ev.edited')
    case 'uploaded': return t('files.ev.uploaded')
    case 'restored': return e.from ? t('files.ev.restoredFrom', { from: e.from }) : t('files.ev.restored')
    case 'moved': return e.from ? t('files.ev.movedFrom', { from: e.from }) : t('files.ev.moved')
    case 'renamed': return e.from ? t('files.ev.renamedFrom', { from: baseName(e.from) }) : t('files.ev.renamed')
    case 'copied': return e.from ? t('files.ev.copiedFrom', { from: e.from }) : t('files.ev.copied')
    case 'conflict': return t('files.ev.conflict')
  }
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
