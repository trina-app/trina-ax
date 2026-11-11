// The team folder explorer: only what the person may see (folders shown for navigation only are greyed out),
// upload (drag and drop; chunked and resumable when large), download, new folder, rename / move, trash, version
// history with restore, conflict copies marked, "start a chat with this file". Refreshes on files.changed.
// Several items at once: a checkbox per row (Shift+click: a range; the header one: every row listed; Esc: none), then
// move / share / trash for all of them from the bar that replaces the breadcrumbs (lib/bulkFiles.ts). Phones (below
// 768 px) leave out the checkboxes and the header row: a long press on a row selects it, the checkboxes come back while
// something is selected, and a tap on a row then adds or takes it away instead of opening it. Phones also leave out
// refresh, and new folder / upload where the folder takes no new files.
// Drag and drop, like a file manager: a row dragged onto a folder row or a breadcrumb moves there (the selection when
// that row is selected), with the selection's "move" rules and toast; computer files dropped on a folder row are
// uploaded into it. The "move" action stays the keyboard way to do the same.
// A whole folder goes up from the picker or a drop, with its subfolders (lib/folderUpload.ts, components/FolderUploads.tsx).
// A project is a folder with instructions: a folder's menu opens its project (lib/projectFolders.ts). New projects are made
// on the Projects page, in a new projects/<name> (docs/DECISIONS.md "Projects live only in projects/"): the projects
// folder itself offers no new folder or upload. A project's folder is its members' (docs/DECISIONS.md "Project contents
// only for members"): the owner or an admin who manages a project without being a member, sent to its folder, goes to
// the project's page instead (there they can add themselves), not to "folder not found".
import clsx from 'clsx'
import { ArchiveRestore, BookmarkPlus, ChevronRight, Copy, Download, Eye, File as FileIcon, FileImage, FileSpreadsheet, FileText, Folder, FolderInput, FolderKanban, FolderPlus, FolderUp, History, Home, Lock, MessageSquarePlus, MoreHorizontal, Paperclip, Pencil, Presentation, Search, Signpost, Sparkles, RefreshCw, Trash2, Upload, Users, X, FileCode, FileArchive, FileAudio, FileVideo } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { type Access, type FileEntry, type FileHistoryEvent, type FileVersion, type HistoryResponse, type Project, type TrashItem, type TreeResponse } from '@mycel/shared/api'
import { api, API, errorText, fileUrl, isApiError, startDownload, versionDownloadUrl } from '../lib/api'
import { canChange, canShare, chatDraggable, clickSelect, dragPayload, dragSet, dropRefusal, failureList, FILES_MOVE_DRAG_TYPE, moveMany, projectSkillsOn, selectable, widenedBy, selectionState, shareMany, toggleAll, trashMany, type DropRefusal, type Outcome } from '../lib/bulkFiles'
import { formatDateTime, formatSize } from '../lib/format'
import { folderGeneration } from '../lib/folderRuns'
import { topFoldersFirst, useFolderWords } from '../lib/folderLabels'
import { droppedEntries, planFromEntries, planFromInput, type FolderPlan } from '../lib/folderUpload'
import { baseName, crumbs, isConflictCopy, isInside, joinPath, nameProblem, parentPath } from '../lib/paths'
import { iconKind, previewKind, type FileIconKind } from '../lib/preview'
import { folderProjectAction, isProjectsFolder, isProjectsTop, projectFolderOf, projectsByFolder, type FolderProjectAction } from '../lib/projectFolders'
import { openTeamFile, panelExpandedNow, useSidePanel } from '../lib/sidePanel'
import { useTeamAttach } from '../lib/useTeamAttach'
import { cancelUpload, uploadFile } from '../lib/upload'
import { addFileUpload, dropFileUpload, patchFileUpload } from '../lib/fileUploads'
import { SIGNED_OUT } from '../lib/localData'
import { markBusy } from '../lib/busy'
import { useLocale, useT } from '../i18n'
import { accessChanged, filesChanged, reloadAsked } from '../store/live'
import { toast } from '../store/ui'
import { contentQueryReady, FileContentResults } from '../components/FileContentSearch'
import FileUploads from '../components/FileUploads'
import FolderPicker from '../components/FolderPicker'
import { FolderAccessChip, FolderAccessPanel, offersFolderAccess } from '../components/FolderAccess'
import FolderUploads, { startFolderUpload, useFolderUploadsSettled } from '../components/FolderUploads'
import { TeamFilesEntry } from '../components/onboarding/TeamFilesStep'
import SuggestSkillDialog from '../components/SuggestSkillDialog'
import { SkillIssues } from '../components/SkillIssues'
import { isSkillsPath } from '../lib/skillIssues'
import { isAdmin, useMeStrict } from '../store/session'
import { Badge, Button, EmptyState, ErrorNote, IconButton, Modal, Skeleton, TabPanel, Tabs, confirmDialog, promptDialog, useMediaQuery } from '../components/ui'
import { LoadError } from '../components/LoadError'
import { Tooltip } from '../components/Tooltip'

const ICONS: Record<FileIconKind, typeof FileIcon> = { folder: Folder, image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, audio: FileAudio, video: FileVideo, code: FileCode, archive: FileArchive, text: FileText, other: FileIcon }

/** how long a finger stays on a row to select it (phones), and how far it may move meanwhile (more is a scroll) */
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10

/** phones have no folder picker (the attribute can be there and do nothing); the button also hides on a small screen */
const canPickFolder = typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype

/** The folder (row or breadcrumb) under a drag: what a drop there would do, or why it would not. busy: a move is
 * still running. */
interface DropOver {
  path: string
  kind: 'move' | 'upload'
  refusal: DropRefusal | 'busy' | null
}
type DropHandlers = Pick<React.DOMAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>
/** the screen's two tabs: the team folder, or 휴지통 (its address is lib/nav.ts FILES_TRASH) */
type FilesView = 'files' | 'trash'
const viewOf = (q: URLSearchParams): FilesView => (q.get('view') === 'trash' ? 'trash' : 'files')
/** The tab the address shows now. Read from the address itself, as Admin › Folder permissions does: the router shows a
 * change in a transition, and a callback made earlier (the listing's `load`, kept while the folder stays) holds the
 * address of the render that made it. */
const viewNow = () => viewOf(new URLSearchParams(window.location.search))

/** The picture under the pointer while several rows are dragged ("4 items"), instead of the one row grabbed. */
function dragBadge(dt: DataTransfer, text: string) {
  const el = document.createElement('div')
  el.textContent = text
  el.className = 'fixed top-0 -left-[9999px] rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink shadow-lg'
  document.body.append(el)
  dt.setDragImage(el, -12, -12)
  // the browser took its picture when dragstart returned
  setTimeout(() => el.remove(), 0)
}

export default function Files() {
  const t = useT()
  const locale = useLocale()
  // the top folders and the person's own folder in words (전사 공유, 부서, 내 폴더 …): what is shown, never the paths used
  const words = useFolderWords()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const path = params.get('path') ?? ''
  const select = params.get('select')
  // the team file open in the side panel: its row is marked
  const panel = useSidePanel()
  const openPath = panel?.kind === 'file' && panel.file.source === 'team' ? panel.file.path : null
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
  // the trash has its own address (`?view=trash`, like Admin › Folder permissions' `?view=people`): a deleted team
  // skill's link opens it, and Back and a reload keep the tab. The folder and the search stay in the address, so the
  // files tab comes back to them
  const view = viewOf(params)
  const setView = (v: FilesView) => {
    // the tab already on screen: no second Back step to the same address
    if (v === viewNow()) return
    const n = new URLSearchParams(window.location.search)
    if (v === 'trash') n.set('view', 'trash')
    else n.delete('view')
    setParams(n)
  }
  const viewTabs = useId()
  const [tree, setTree] = useState<TreeResponse | null>(null)
  /** the listing that failed (kept until a listing works: the notice stays while it reads again, components/LoadError.tsx) */
  const [error, setError] = useState<unknown>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [drag, setDrag] = useState(false)
  // phones (below 768 px, like the tab bar): rows are selected by a long press, not by a checkbox; a touch phone does
  // not drag rows (a long press there is the selection, and a row cannot be dropped anywhere useful on that screen)
  const phone = useMediaQuery('(max-width: 767.98px)')
  const touchPhone = useMediaQuery('(max-width: 767.98px) and (pointer: coarse)')
  const [history, setHistory] = useState<string | null>(params.get('history'))
  const [suggesting, setSuggesting] = useState<string | null>(null)
  // "Who can see it" (components/FolderAccess.tsx): the folder whose panel is open, from the chip or a row's ⋯
  const [accessFor, setAccessFor] = useState<{ path: string; access: Access } | null>(null)
  const me = useMeStrict()
  // "버전 기록 보기" from a banner while this screen is open: the address changes, the history opens
  const historyParam = params.get('history')
  useEffect(() => {
    if (historyParam) setHistory(historyParam)
  }, [historyParam])
  const [moving, setMoving] = useState<FileEntry | null>(null)
  const [sharing, setSharing] = useState<FileEntry | null>(null)
  // the projects the person can see, by folder: a folder's menu opens its project or makes it one
  const [projects, setProjects] = useState<Project[]>([])
  const loadProjects = useCallback(() => api.call(API.listProjects).then((r) => setProjects(r.items), () => {}), [])
  useEffect(() => {
    void loadProjects()
    return accessChanged.on(() => void loadProjects())
  }, [loadProjects])
  const byFolder = useMemo(() => projectsByFolder(projects), [projects])
  // back from Admin's edit panel opened from "Who can see it" (AccessTree's from=files): the folder's panel opens again
  // once the folder is here, where the chip would show; the address loses `access` (a reload does not open it again)
  const accessParam = params.get('access')
  useEffect(() => {
    if (accessParam !== '1' || !tree || tree.path.normalize('NFC') !== path.normalize('NFC')) return
    if (offersFolderAccess(tree.path, tree.access, me.user.id, byFolder.get(tree.path.normalize('NFC')) ?? null)) setAccessFor({ path: tree.path, access: tree.access })
    setParams((prev) => {
      const n = new URLSearchParams(prev)
      n.delete('access')
      return n
    }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessParam, tree])
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  // several items at once: the checked rows (paths), the row clicked last (Shift+click selects from it), the folder
  // picker open for them and the action running
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const [bulkPick, setBulkPick] = useState<'move' | 'share' | null>(null)
  const [running, setRunning] = useState<'move' | 'share' | 'delete' | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  // dragging rows onto a folder: the rows of the drag under way (null: none, or a drag from elsewhere: another tab's
  // rows are not this listing's), the same paths for drawing (set a tick after the drag starts), the folder under the
  // pointer, and the access of the breadcrumbs' folders (asked when a drag starts; unknown: the server decides)
  const dragged = useRef<{ items: FileEntry[]; selection: boolean; data: string } | null>(null)
  const [dragPaths, setDragPaths] = useState<ReadonlySet<string> | null>(null)
  const [over, setOver] = useState<DropOver | null>(null)
  const crumbAccess = useRef(new Map<string, FileEntry['access']>())

  const go = useCallback((p: string, sel?: string) => setParams(sel ? { path: p, select: sel } : p ? { path: p } : {}), [setParams])

  /** A folder at or under projects/<name> that the owner or an admin cannot open: the project they manage there
   * without being a member (GET /api/projects?manage=1, by its folder), whose page they go to instead (true then). */
  const toProjectPage = async (at: string): Promise<boolean> => {
    const folder = projectFolderOf(at)
    if (!folder || !isAdmin(me)) return false
    const key = (p: string) => p.normalize('NFC').toLowerCase()
    try {
      const p = (await api.call(API.listProjects, { query: { manage: '1' } })).items.find((x) => key(x.folderPath) === key(folder) && x.member === false)
      if (!p) return false
      navigate(`/projects/${p.id}`, { replace: true })
      return true
    } catch {
      return false
    }
  }

  /** the folder the table last showed: a not_found for it means access changed while it was open (tab 5 "권한 회수") */
  const shown = useRef<string | null>(null)
  /** only the latest listing request may set the table: an older answer arriving last (the first listing of a slow
   * folder, after the reload an upload asked for) showed the folder without the new file */
  const loads = useRef(0)
  const load = useCallback(async () => {
    const mine = ++loads.current
    try {
      const r = await api.call(API.tree, { query: { path, limit: 200 } })
      if (mine !== loads.current) return
      setTree(r)
      setError(null)
      shown.current = path
    } catch (e) {
      if (mine !== loads.current) return
      if (isApiError(e, 'not_found') && path) {
        // a project's folder (or a folder in it) the owner or an admin manages without being a member: its page
        if (await toProjectPage(path)) return
        if (mine !== loads.current) return
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
        // (the tab on screen stays: the trash one too)
        setParams({ ...(up ? { path: up } : {}), ...(viewNow() === 'trash' ? { view: 'trash' } : {}) }, { replace: true })
        return
      }
      setError(e ?? new Error('failed'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  useEffect(() => {
    setTree(null)
    setError(null)
    void load()
  }, [load])

  /** the folder on screen and its listing: an upload that ends may have started in another folder, or on another visit */
  const onScreen = useRef<{ path: string; load: () => Promise<void> } | null>(null)
  useEffect(() => {
    onScreen.current = { path, load }
    return () => { onScreen.current = null }
  }, [path, load])

  useEffect(() => {
    const offA = filesChanged.on((changes) => {
      if (changes.some((c) => parentPath(c.path) === path || (c.from && parentPath(c.from) === path) || isInside(path, c.path))) void load()
      // a moved folder takes its project with it (the server rewrites the project's folder)
      if (changes.some((c) => c.from)) void loadProjects()
    })
    const offB = reloadAsked.on(() => void load())
    const offC = accessChanged.on(() => void load())
    return () => {
      offA()
      offB()
      offC()
    }
  }, [path, load, loadProjects])

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
  // the projects folder itself: its folders are projects, made on the Projects page (the server refuses anything else
  // there, 409 projects_root): no new folder or upload
  const projectsTop = isProjectsTop(path)
  const canAdd = canWrite && !projectsTop
  // Personal (users/), where a member sees only their own folder
  const personal = tree?.path === 'users'
  const errText = (e: unknown) => errorText(e, locale, t('error.network'))
  const fail = (e: unknown) => toast({ level: 'error', text: errText(e) })

  // ---------------- selection ----------------
  // another folder or the trash: nothing stays selected
  useEffect(() => {
    setChecked((c) => (c.size ? new Set() : c))
    anchor.current = null
  }, [path, view])
  /** the rows as listed: at the team root 전사 공유, 부서, 프로젝트, 팀 스킬, 개인 first (display only) */
  const rows = useMemo(() => (tree ? topFoldersFirst(tree.entries, path) : []), [tree, path])
  /** the rows that can be selected, as listed */
  const order = useMemo(() => rows.filter(selectable).map((e) => e.path), [rows])
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
  // Esc clears the selection (before the side panel: the next Esc closes that); a dialog or a text field keeps its Esc,
  // and a big side panel goes back side by side first (the list is hidden behind it: components/Layout.tsx)
  const anyChecked = chosen.length > 0
  useEffect(() => {
    if (!anyChecked) return
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"]') || panelExpandedNow()) return
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
   * said no to stays selected, to try again or take elsewhere (`select` false: a row dragged on its own, outside the
   * selection, which stays as it was). */
  const reportBatch = (r: Outcome, words: { done: (n: number) => string; failed: (n: number, list: string) => string; skipped?: string | null; okLevel?: 'success' | 'info' }, action?: { label: string; run: () => void }, select = true) => {
    if (r.done.length || r.failed.length) {
      const parts = [r.done.length ? words.done(r.done.length) : null, words.skipped ?? null, r.failed.length ? words.failed(r.failed.length, failureList(r.failed, errText, (n) => t('files.bulk.more', { n }))) : null]
      toast({
        level: r.failed.length ? (r.done.length ? 'warn' : 'error') : words.skipped ? 'warn' : words.okLevel ?? 'success',
        text: parts.filter(Boolean).join(' '),
        action: r.done.length ? action : undefined,
      })
    }
    if (!select) return
    setChecked(new Set([...r.failed.map((f) => f.entry.path), ...r.declined.map((e) => e.path)]))
    anchor.current = null
  }

  /** Move items into one folder: the selection's "move", and rows dropped on a folder or a breadcrumb. Only those the
   * person may change (the rest are skipped and counted); one question when some of them would be hidden from other
   * people; one toast. `select`: as reportBatch. */
  const moveItems = async (items: readonly FileEntry[], folder: string, select = true) => {
    const ok = items.filter(canChange)
    const skipped = items.length - ok.length
    setRunning('move')
    try {
      const r = await moveMany(ok, folder, {
        move: (body) => api.call(API.move, { body }),
        confirmNarrow: (count, n) => confirmDialog({ title: t('files.narrowTitle'), body: t('files.bulk.narrowBody', { count, n }), confirm: t('files.moveAnyway'), danger: true }),
        confirmWiden: (count, n) => confirmDialog({ title: t('files.widenTitle'), body: t('files.bulk.widenBody', { count, n }), confirm: t('files.moveAnyway') }),
        confirmSkills: confirmSkillsOn,
      })
      reportBatch(
        r,
        {
          done: (n) => t('files.bulk.moved', { n, path: words.path(folder) || t('files.root') }),
          failed: (n, list) => t('files.bulk.moveFailed', { n, list }),
          skipped: skipped ? t('files.bulk.skipReadOnly', { n: skipped }) : null,
        },
        undefined,
        select,
      )
    } finally {
      setRunning(null)
      void load()
    }
  }

  /** Move the selection: one folder for all. */
  const bulkMove = (folder: string) => {
    setBulkPick(null)
    return moveItems(chosen, folder)
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
        done: (n) => t('files.bulk.shared', { n, path: words.path(folder) || t('files.root') }),
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

  /** Upload into this folder, or into `into` (a folder row the files were dropped on; the person may write there). */
  const startUploads = (list: File[], into?: string) => {
    if (!list.length) return
    // only a folder known to be read-only refuses here; while its listing is still loading (a file dropped or picked
    // right after opening the folder) the server decides, and a refusal shows on the upload row. Refusing then said
    // "read-only folder" for a folder the person can write and dropped the file (e2e mobile upload on a slow server).
    if (into === undefined && tree && !canWrite) return toast({ level: 'warn', text: t('files.readOnlyFolder') })
    const folder = into ?? path
    for (const file of list) {
      const item = addFileUpload(file.name, folder)
      const target = { kind: 'path', path: joinPath(folder, file.name), onExists: 'rename' } as const
      // a reload would lose the upload (the picked file is gone after it): the page does not reload by itself meanwhile
      const release = markBusy('upload')
      uploadFile(file, target, { client: api, signal: item.abort.signal, onProgress: (progress) => patchFileUpload(item.id, { progress }) }).finally(release).then(
        () => {
          patchFileUpload(item.id, { status: 'done' })
          setTimeout(() => dropFileUpload(item.id), 4000)
          if (onScreen.current?.path === folder) void onScreen.current.load()
        },
        (e) => {
          if (item.abort.signal.aborted) {
            // cancelled: drop the server's half-received session too (it holds disk space and counts against the
            // person's open uploads for a day otherwise)
            if (item.abort.signal.reason !== SIGNED_OUT) void cancelUpload(file, target, api)
            return dropFileUpload(item.id)
          }
          patchFileUpload(item.id, { status: 'failed', error: errorText(e, locale, t('error.network')) })
        },
      )
    }
  }

  /** Upload a read folder into this folder, or into `into`, with the same check for write access as for a file. */
  const startFolder = (plan: FolderPlan, into?: string) => {
    if (into === undefined && tree && !canWrite) return toast({ level: 'warn', text: t('files.readOnlyFolder') })
    if (!plan.files.length && !plan.folders.length && !plan.unreadable.length) return toast({ level: 'info', text: t('files.folderUpload.empty') })
    startFolderUpload(plan, into ?? path, (view) => toast({ level: 'error', text: `${errText(view.refusal)} ${t('files.folderUpload.stopped', { n: view.waiting })}` }))
  }

  /** Computer files or folders dropped here. Only a folder takes the folder path: files go up one by one, as always. */
  const dropUpload = (dt: DataTransfer, into?: string) => {
    // read now: the browser empties both lists when the drop event ends. A folder is also in `files`, as a false file.
    const entries = droppedEntries(dt)
    const files = Array.from(dt.files)
    if (!entries.some((e) => e.isDirectory)) return startUploads(files, into)
    const release = markBusy('upload')
    const generation = folderGeneration()
    planFromEntries(entries).then((plan) => { if (generation === folderGeneration()) startFolder(plan, into) }, fail).finally(release)
  }
  // a folder upload ended (also one started before this page opened): the new files are listed
  const folderUploadsSettled = useFolderUploadsSettled()
  useEffect(() => {
    if (folderUploadsSettled) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderUploadsSettled])

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

  /** A project's folder moved to projects/<name>: the skills in it start to count in that project's chats (named). */
  const confirmSkillsOn = (skills: string[]) =>
    confirmDialog({ title: t('files.skillsOnTitle'), body: t('files.skillsOnBody', { n: skills.length, names: skills.join(', ') }), confirm: t('files.moveAnyway') })

  /** POST /api/files/move; when other people would lose sight of the item (into users/<me>/), or more people would see
   * it (out of a personal folder; QA TC-115), ask first, then confirm.
   * A project's folder moved to projects/<name> turns its skills on in that project's chats: that is asked first too. */
  const moveConfirmed = async (body: { from: string; to: string; onExists: 'fail' | 'rename'; skillsOk?: boolean; askWiden?: boolean }): Promise<boolean> => {
    // out of my personal folder to where more people see it: asked first as well (QA TC-115)
    body = { ...body, askWiden: true }
    try {
      await api.call(API.move, { body })
      return true
    } catch (err) {
      const skills = projectSkillsOn(err)
      if (skills) {
        if (!(await confirmSkillsOn(skills))) return false
        return moveConfirmed({ ...body, skillsOk: true })
      }
      const added = widenedBy(err)
      if (added !== null) {
        if (!(await confirmDialog({ title: t('files.widenTitle'), body: t('files.widenBody', { n: added }), confirm: t('files.moveAnyway') }))) return false
        await api.call(API.move, { body: { ...body, confirm: true } })
        return true
      }
      if (!(isApiError(err, 'conflict') && err.body.params?.reason === 'audience_narrowed')) throw err
      const n = Number(err.body.params.lostViewers ?? 0)
      if (!(await confirmDialog({ title: t('files.narrowTitle'), body: t('files.narrowBody', { n }), confirm: t('files.moveAnyway'), danger: true }))) return false
      await api.call(API.move, { body: { ...body, confirm: true } })
      return true
    }
  }

  const rename = async (e: FileEntry) => {
    // a file's name starts selected without its extension (".bashrc" and a folder: all of it)
    const dot = e.type === 'folder' ? -1 : e.name.lastIndexOf('.')
    const name = await promptDialog({ title: t('files.rename'), label: t('files.newName'), initial: e.name, select: dot > 0 ? dot : e.name.length, confirm: t('common.save'), validate: (v) => (nameProblem(v) ? t(`files.name.${nameProblem(v)!}`) : null) })
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
      toast({ level: 'success', text: t('files.moved', { path: words.path(folder) || t('files.root') }) })
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
      if ('path' in r) toast({ level: 'success', text: t('files.shared', { path: words.path(r.path) }) })
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

  // ---------------- drag and drop ----------------
  /** A row grabbed: the selection when that row is selected, else the row alone (lib/bulkFiles.ts dragSet). */
  const startDrag = (row: FileEntry, ev: React.DragEvent) => {
    const items = dragSet(tree?.entries ?? [], checked, row)
    const payload = dragPayload(items, row)
    if (!payload) return ev.preventDefault()
    for (const [type, value] of payload.data) ev.dataTransfer.setData(type, value)
    ev.dataTransfer.effectAllowed = payload.effectAllowed
    // a file the person may only read: into a chat's message box only
    const data = payload.data.find(([type]) => type === FILES_MOVE_DRAG_TYPE)?.[1]
    if (data === undefined) return
    const drag = { items, selection: checked.has(row.path), data }
    dragged.current = drag
    if (items.length > 1) dragBadge(ev.dataTransfer, t('files.drag.count', { n: items.length }))
    // a tick later (the DOM changed during dragstart can end the drag in Chromium): the dragged rows dim and the
    // breadcrumbs come back in place of the selection bar, to take a drop too
    setTimeout(() => dragged.current === drag && setDragPaths(new Set(items.map((e) => e.path))), 0)
    // the breadcrumbs' folders: whether the person may write there (one small listing each, once per folder shown)
    const ancestors = path ? ['', ...crumbs(path).slice(0, -1).map((c) => c.path)] : []
    for (const p of ancestors) {
      if (crumbAccess.current.has(p)) continue
      api.call(API.tree, { query: { path: p, limit: 1 } }).then((r) => crumbAccess.current.set(p, r.access), () => {})
    }
  }
  const endDrag = () => {
    dragged.current = null
    setDragPaths(null)
    setOver(null)
  }
  // another folder: the breadcrumbs are other folders (and access may have changed since)
  useEffect(() => {
    crumbAccess.current.clear()
  }, [path])
  // a drag whose row left the list before it ended (the listing changed under it) sends no dragend here: the next
  // pointer move with no button down ends it (no pointer events reach the page while a drag is under way)
  const dragging = dragPaths !== null
  useEffect(() => {
    if (!dragging) return
    const h = (ev: PointerEvent) => ev.buttons === 0 && endDrag()
    window.addEventListener('pointermove', h)
    return () => window.removeEventListener('pointermove', h)
  }, [dragging])

  /**
   * A folder row or a breadcrumb as a drop target. It takes rows dragged from this list (moved there, as the
   * selection's "move") and, on a folder row (`upload`), files from the computer (uploaded there). Anything else (a
   * file dragged from a chat or the preview, another tab's rows) is not taken here.
   */
  const dropTarget = (target: { path: string; access: FileEntry['access'] | null }, upload: boolean): DropHandlers => {
    const judge = (dt: DataTransfer): DropOver | null => {
      const types = [...dt.types]
      if (types.includes(FILES_MOVE_DRAG_TYPE)) {
        const d = dragged.current
        if (!d) return null
        return { path: target.path, kind: 'move', refusal: running ? 'busy' : dropRefusal(d.items, target) }
      }
      if (upload && types.includes('Files')) return { path: target.path, kind: 'upload', refusal: target.access === 'write' ? null : 'readOnly' }
      return null
    }
    // dragenter too: on entering an element the browser decides from it (dragover only follows with the next move)
    const enterOrOver = (ev: React.DragEvent) => {
      const v = judge(ev.dataTransfer)
      if (!v) return
      // taken here even when refused ("none"): a refused folder must not pass the drop on to the list (an upload into
      // this folder) or to the browser, which opens a dropped file in place of the app
      ev.preventDefault()
      ev.stopPropagation()
      ev.dataTransfer.dropEffect = v.refusal ? 'none' : v.kind === 'move' ? 'move' : 'copy'
      setOver((cur) => (cur && cur.path === v.path && cur.kind === v.kind && cur.refusal === v.refusal ? cur : v))
    }
    return {
      onDragEnter: enterOrOver,
      onDragOver: enterOrOver,
      onDragLeave: (ev) => {
        if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return
        setOver((cur) => (cur?.path === target.path ? null : cur))
        // the drag ended over a refused folder (or left the window): the list's upload frame goes too
        if (!ev.relatedTarget) setDrag(false)
      },
      onDrop: (ev) => {
        const v = judge(ev.dataTransfer)
        if (!v) return
        ev.preventDefault()
        ev.stopPropagation()
        setOver(null)
        setDrag(false)
        if (v.refusal) return
        if (v.kind === 'upload') return dropUpload(ev.dataTransfer, target.path)
        const d = dragged.current
        endDrag()
        // the rows moved are this screen's own (the ref), never paths read from the drop. The drop must also carry
        // this drag's data: a drag from another tab or app with the same type is not taken, even when a drag from
        // here was left without its dragend (the server checks every move in any case)
        if (d && ev.dataTransfer.getData(FILES_MOVE_DRAG_TYPE) === d.data) void moveItems(d.items, target.path, d.selection)
      },
    }
  }
  /** a breadcrumb's folder: this one's access is known; the folders above it once asked (startDrag) */
  const crumbTarget = (p: string) => dropTarget({ path: p, access: p === path ? tree?.access ?? null : crumbAccess.current.get(p) ?? null }, false)
  const crumbDrop = (p: string) => (over?.path === p && over.kind === 'move' ? (over.refusal ? 'no' : 'ok') : undefined)
  const selectionMovable = movable.length > 0

  return (
    // @container: the toolbar and the columns follow the page's own width, which an open file panel makes narrow on a
    // desktop screen too (the sm: breakpoints only know the window)
    <div
      className="@container flex h-full flex-col"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        // the trash takes no files: "none", not passed on to the browser (which opens a dropped file in the tab)
        if (view !== 'files') {
          e.dataTransfer.dropEffect = 'none'
          return
        }
        setDrag(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDrag(false)
      }}
      onDrop={(e) => {
        // by type, not by the file list: the list of a dropped folder may be empty in some browsers
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setDrag(false)
        if (view === 'files') dropUpload(e.dataTransfer)
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-6">
        <h1 className="mr-2 text-lg font-semibold">{t('files.title')}</h1>
        <Tabs value={view} onChange={setView} label={t('files.title')} panels={viewTabs} items={[{ id: 'files', label: t('files.all') }, { id: 'trash', label: t('files.trash') }]} />
        {view === 'files' && (
          // a narrow page (a phone, or a desktop with the file panel open): the toolbar has its own line, the buttons show
          // only their icons, and the search box takes the width they leave
          <div className="ml-auto flex items-center gap-1 @max-2xl:w-full">
            <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg @max-2xl:flex-1 border border-field-border bg-surface px-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
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
                className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-faint @2xl:w-48"
                data-testid="content-search-input"
                data-own-clear
              />
              {q && (
                <Tooltip label={t('files.search.clear')}>
                  <button type="button" className="text-faint hover:text-ink" onClick={() => setQuery('')} aria-label={t('files.search.clear')}>
                    <X size={14} aria-hidden />
                  </button>
                </Tooltip>
              )}
            </label>
            {/* phones: no refresh (the list follows changes on its own), and no new folder / upload where they are off */}
            <IconButton label={t('common.refresh')} className="max-md:hidden" onClick={() => void load()}>
              <RefreshCw size={16} />
            </IconButton>
            {!projectsTop && (
            <Tooltip label={t('files.newFolder')}>
              <Button size="sm" variant="ghost" className={clsx(tree && !canWrite && 'max-md:hidden')} onClick={mkdir} disabled={!canWrite} aria-label={t('files.newFolder')} data-testid="new-folder-button">
                <FolderPlus size={15} aria-hidden /> <span className="@max-2xl:hidden">{t('files.newFolder')}</span>
              </Button>
            </Tooltip>
            )}
            {canPickFolder && !projectsTop && (
              <>
                <Tooltip label={t('files.uploadFolder')}>
                  <Button size="sm" variant="ghost" className="max-sm:hidden" onClick={() => folderInput.current?.click()} disabled={!canWrite} aria-label={t('files.uploadFolder')} data-testid="folder-upload-button">
                    <FolderUp size={15} aria-hidden /> <span className="@max-2xl:hidden">{t('files.uploadFolder')}</span>
                  </Button>
                </Tooltip>
                <input
                  ref={folderInput}
                  type="file"
                  hidden
                  // not in React's types
                  {...{ webkitdirectory: '' }}
                  data-testid="folder-input"
                  onChange={(e) => {
                    startFolder(planFromInput(Array.from(e.target.files ?? [])))
                    e.target.value = ''
                  }}
                />
              </>
            )}
            {!projectsTop && (
            <Tooltip label={t('files.upload')}>
              <Button size="sm" variant="primary" className={clsx(tree && !canWrite && 'max-md:hidden')} onClick={() => fileInput.current?.click()} disabled={!canWrite} aria-label={t('files.upload')} data-testid="upload-button">
                <Upload size={15} aria-hidden /> <span className="@max-2xl:hidden">{t('files.upload')}</span>
              </Button>
            </Tooltip>
            )}
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

      {/* the chosen tab's content: a flex column like the page, so the list below still fills and scrolls */}
      <TabPanel base={viewTabs} value={view} className="flex min-h-0 flex-1 flex-col">
      {view === 'trash' ? (
        <TrashView />
      ) : (
        <>
          {/* while rows are dragged the breadcrumbs come back: a drop there moves them up */}
          {anyChecked && !dragging ? (
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
            // phones at the top folder: no lone "팀 폴더" under the tab of the same name (only a read-only note, if any)
            <nav aria-label={t('files.breadcrumb')} className={clsx('flex flex-wrap items-center gap-1 px-4 py-2 text-sm sm:px-6', !path && (!tree || tree.access === 'write') && 'max-md:hidden')}>
              <button type="button" className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover', !path && 'max-md:hidden', crumbDrop('') === 'ok' && 'bg-accent-soft ring-2 ring-accent')} onClick={() => go('')} {...crumbTarget('')} data-drop={crumbDrop('')} data-testid="crumb">
                <Home size={14} aria-hidden /> {t('files.root')}
              </button>
              {crumbs(path).map((c) => (
                <span key={c.path} className="inline-flex items-center gap-1">
                  <ChevronRight size={13} className="text-faint" aria-hidden />
                  <button type="button" className={clsx('rounded px-1.5 py-0.5 hover:bg-hover', crumbDrop(c.path) === 'ok' && 'bg-accent-soft ring-2 ring-accent')} onClick={() => go(c.path)} aria-current={c.path === path ? 'page' : undefined} {...crumbTarget(c.path)} data-drop={crumbDrop(c.path)} data-testid="crumb">
                    {words.name(c.path, c.name)}
                  </button>
                </span>
              ))}
              {/* who else sees this folder: a count where a member can write, their own folder, a project's folder;
                  everything for admins (nothing at the top folders and the root) */}
              {tree && <FolderAccessChip key={tree.path} path={tree.path} access={tree.access} project={byFolder.get(tree.path.normalize('NFC')) ?? null} onOpen={() => setAccessFor({ path: tree.path, access: tree.access })} />}
              {/* Personal (users/): what a member can do there is open their own folder inside, so it is not called
                  read-only (docs/DECISIONS.md "A welcome for invited people") */}
              {tree && tree.access !== 'write' && (personal ? (
                <Badge className="ml-2" data-testid="files-personal-badge">{t('files.personalInside')}</Badge>
              ) : (
                <Badge tone="warn" className={clsx('ml-2', !path && 'max-md:ml-0')}>
                  <Lock size={11} aria-hidden /> {t(tree.access === 'read' ? 'files.readOnlyFolder' : 'files.navigationOnly')}
                </Badge>
              ))}
              {/* why New folder and Upload are off here (computers: phones hide them) */}
              {tree && !canWrite && (
                <span className="ml-2 text-xs text-muted max-md:hidden" data-testid="files-cannot-add">{t(personal ? 'files.addInMyFolder' : 'files.addHere')}</span>
              )}
            </nav>
          )}
          {isSkillsPath(path) && <SkillIssues folder={path} className="mx-4 mb-2 sm:mx-6" />}
          <FileUploads here={path} />
          <FolderUploads here={path} />
          <TeamFilesEntry here={path} />
          {/* computer files over the list go to this folder; over a folder row, into that folder (the row shows it) */}
          <div className={clsx('scroll-thin relative min-h-0 flex-1 overflow-y-auto px-2 pb-6 sm:px-4', drag && !over && 'bg-accent-soft/40 ring-2 ring-accent ring-inset')}>
            {searching ? (
              <FileContentResults q={q} path={path} folderLabel={words.path(path) || t('files.root')} />
            ) : (
              <>
                {!!error && (
                  <div className="p-4">
                    <LoadError error={error} onRetry={load} what="files" />
                  </div>
                )}
                {!tree && !error && <Skeleton lines={8} className="p-4" />}
                {tree && !tree.entries.length && (
                  <EmptyState icon={<Upload size={28} />} title={canAdd ? t('files.emptyDrop') : t('files.emptyReadOnly')}>
                    {canAdd && (
                      <Button size="sm" className="mt-2" onClick={() => fileInput.current?.click()}>
                        {t('files.upload')}
                      </Button>
                    )}
                  </EmptyState>
                )}
                {tree && tree.entries.length > 0 && (
                  <table className="w-full text-sm" data-testid="file-table">
                    {/* phones: no "이름" line over the rows (rows are selected by a long press), until something is
                        selected: then its box selects all */}
                    <thead className={clsx(!anyChecked && 'max-md:hidden')}>
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
                        {/* Modified only on a wide page: next to an open file panel the name keeps the room */}
                        <th className="hidden whitespace-nowrap px-2 py-2 font-medium @xl:table-cell">{t('files.modified')}</th>
                        <th className="hidden whitespace-nowrap px-2 py-2 text-right font-medium sm:table-cell">{t('files.size')}</th>
                        <th className="w-10 px-2 py-2">
                          <span className="sr-only">{t('files.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((e) => (
                        <FileRow
                          key={e.path}
                          e={e}
                          // ?select= holds the full path (links from Search, team skills and the server); a bare name also works
                          selected={select === e.path || select === e.name}
                          open={openPath === e.path}
                          checked={checked.has(e.path)}
                          onCheck={(shift) => check(e.path, shift)}
                          pressSelect={phone}
                          selecting={phone && anyChecked}
                          draggable={!touchPhone && (canChange(e) || chatDraggable(e) || (checked.has(e.path) && selectionMovable))}
                          onDragStart={(ev) => startDrag(e, ev)}
                          onDragEnd={endDrag}
                          dragged={dragPaths?.has(e.path) ?? false}
                          dropTarget={e.type === 'folder' ? dropTarget(e, true) : null}
                          drop={over?.path === e.path ? over : null}
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
                          project={folderProjectAction(e, byFolder)}
                          // a team project's folder the owner or an admin is not a member of: a click opens its page
                          // (toProjectPage), so it says "Members only", as Folder permissions does, not "pass-through"
                          membersOnly={e.type === 'folder' && e.access === 'none' && isAdmin(me) && isProjectsFolder(e.path)}
                          onProject={(a) => navigate(`/projects/${a.project.id}`)}
                          onSuggest={e.type === 'file' && e.path.startsWith(`users/${me.user.id}/`) && /\.(md|txt)$/i.test(e.name) ? () => setSuggesting(e.path) : null}
                          onAccess={e.type === 'folder' && offersFolderAccess(e.path, e.access, me.user.id, byFolder.get(e.path.normalize('NFC')) ?? null) ? () => setAccessFor({ path: e.path, access: e.access }) : null}
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
      </TabPanel>
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
      <FolderAccessPanel target={accessFor} project={accessFor ? (byFolder.get(accessFor.path.normalize('NFC')) ?? null) : null} projectOf={(p) => byFolder.get(p.normalize('NFC')) ?? null} onClose={() => setAccessFor(null)} />
      {suggesting && <SuggestSkillDialog source={{ kind: 'file', path: suggesting }} initialName={baseName(suggesting).replace(/\.(md|txt)$/i, '')} onClose={() => setSuggesting(null)} />}
    </div>
  )
}

/** The selection's actions, in place of the breadcrumbs while something is selected. */
function BulkBar({ count, readOnly, canMove, canShare, running, onMove, onShare, onDelete, onClear }: { count: number; readOnly: number; canMove: boolean; canShare: boolean; running: 'move' | 'share' | 'delete' | null; onMove: () => void; onShare: () => void; onDelete: () => void; onClear: () => void }) {
  const t = useT()
  return (
    // a narrow page (a phone, or a desktop with the file panel open): line 1 has the count, the read-only badge and ×,
    // line 2 has the buttons. Only CSS `order` moves × to the end of line 1, so the tab order stays count, buttons, ×.
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
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5 @max-2xl:order-last @max-2xl:ml-0 @max-2xl:basis-full @max-2xl:justify-start">
        <Button size="sm" onClick={onMove} disabled={!canMove || !!running} busy={running === 'move'} data-testid="bulk-move">
          <FolderInput size={14} aria-hidden /> {t('files.move')}
        </Button>
        <Button size="sm" onClick={onShare} disabled={!canShare || !!running} busy={running === 'share'} title={canShare ? undefined : t('files.bulk.noFiles')} data-testid="bulk-share">
          <Copy size={14} aria-hidden /> {t('files.share')}
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete} disabled={!canMove || !!running} busy={running === 'delete'} data-testid="bulk-delete">
          <Trash2 size={14} aria-hidden /> {t('files.moveToTrash')}
        </Button>
      </div>
      <IconButton label={t('files.bulk.clear')} onClick={onClear} disabled={!!running} className="@max-2xl:ml-auto" data-testid="bulk-clear">
        <X size={16} />
      </IconButton>
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

function FileRow({ e, selected, open, checked, onCheck, pressSelect, selecting, draggable, onDragStart, onDragEnd, dragged, dropTarget, drop, onOpen, onChat, onAddToChat, chatTitle, onRename, onMove, onShare, onDelete, onHistory, project, membersOnly = false, onProject, onSuggest, onAccess }: { e: FileEntry; selected: boolean; open: boolean; checked: boolean; onCheck: (shift: boolean) => void; pressSelect: boolean; selecting: boolean; draggable: boolean; onDragStart: (ev: React.DragEvent) => void; onDragEnd: () => void; dragged: boolean; dropTarget: DropHandlers | null; drop: DropOver | null; onOpen: () => void; onChat: () => void; onAddToChat: (() => void) | null; chatTitle: string; onRename: () => void; onMove: () => void; onShare: () => void; onDelete: () => void; onHistory: () => void; project: FolderProjectAction; membersOnly?: boolean; onProject: (a: NonNullable<FolderProjectAction>) => void; onSuggest: (() => void) | null; onAccess: (() => void) | null }) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLTableRowElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const folder = e.type === 'folder'
  // a folder that is a project the person can see shows the project icon (and says so to screen readers)
  const Icon = project?.kind === 'open' ? FolderKanban : ICONS[iconKind(e.name, folder)]
  const dim = e.access === 'none'
  // what a dimmed row says: "Members only" on a team project's folder that opens its page, else that it is only passed
  // through
  const dimTitle = membersOnly ? t('projects.membersOnly') : t('files.navigationOnly')
  const writable = e.access === 'write'
  const menuId = useId()
  // phones (`pressSelect`): a long press selects the row (or takes it out of the selection), and the click that ends it
  // does not open it; while something is selected (`selecting`) a tap does the same instead of opening
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const pressed = useRef(false)
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => endPress, [])
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
  // a download-only (quarantined) file: the AI cannot read it, so "Ask AI" and "add to chat" could only fail; they stay
  // in the menu, turned off, with the reason (like the file panel)
  const aiOff = !folder && !!e.downloadOnly
  // a drag over this folder: taken (moved or uploaded here) or refused with the reason; nothing over the dragged
  // folder itself or while a move is still running
  const dropOk = !!drop && !drop.refusal
  const dropNo = !!drop && !!drop.refusal && drop.refusal !== 'self' && drop.refusal !== 'busy'
  return (
    <tr
      ref={ref}
      // the file open in the side panel: a full accent background and a bar on the left edge (stronger than a
      // selected or checked row, which has the light background only)
      className={clsx('group border-b border-line last:border-0', dropOk ? 'bg-accent-soft outline-2 -outline-offset-2 outline-accent' : open ? 'bg-accent-soft shadow-[inset_3px_0_0_var(--c-accent)]' : (selected || checked) && 'bg-accent-soft/60', dim && 'text-muted', dragged && 'opacity-50')}
      data-open={open || undefined}
      {...dropTarget}
      data-drop={dropOk ? 'ok' : dropNo ? 'no' : undefined}
      data-testid="file-row"
    >
      {/* phones: seen only while something is selected (a long press starts it); until then the box is still there for
          a screen reader, and shows when the keyboard reaches it */}
      <td className={clsx('w-0 py-1 pr-0 pl-1', !selecting && 'max-md:sr-only max-md:focus-within:not-sr-only')}>
        <CheckBox checked={checked} disabled={dim} label={t('files.select', { name: e.name })} title={dim ? dimTitle : undefined} onCheck={onCheck} testId="file-check" />
      </td>
      {/* w-full + max-w-0: the name column takes the room that is left and a long name ends in "…" instead of
          pushing the table wider than the screen (phones) or the space beside an open file panel */}
      <td className="w-full max-w-0 px-2 py-1.5 max-md:py-0">
        <button
          type="button"
          onClick={(ev) => {
            // the click a long press ends with selected the row already; a keyboard's click (detail 0) never is one
            const long = pressed.current
            pressed.current = false
            if (long && ev.detail !== 0) return
            if (selecting && !dim) onCheck(false)
            else onOpen()
          }}
          onPointerDown={(ev) => {
            pressed.current = false
            if (!pressSelect || dim || ev.button !== 0) return
            endPress()
            const timer = window.setTimeout(() => {
              press.current = null
              pressed.current = true
              onCheck(false)
            }, LONG_PRESS_MS)
            press.current = { timer, x: ev.clientX, y: ev.clientY }
          }}
          onPointerMove={(ev) => {
            const p = press.current
            if (p && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > LONG_PRESS_SLOP) endPress()
          }}
          onPointerUp={endPress}
          onPointerCancel={endPress}
          onPointerLeave={endPress}
          // a phone's own long-press menu (Android) does not open over the selection
          onContextMenu={(ev) => (press.current || pressed.current) && ev.preventDefault()}
          // phones: a 44px row to tap, and a long press selects the row, not its text
          className="flex w-full min-w-0 items-center gap-2.5 rounded py-1 text-left hover:underline max-md:min-h-11 max-md:select-none max-md:[-webkit-touch-callout:none]"
          title={dim ? dimTitle : undefined}
          aria-current={open ? 'true' : undefined}
          // dragged onto a folder row or a breadcrumb: moved there (with the selection when this row is selected); a
          // file the AI may read can also be dragged into a chat's message box (attached as a team file)
          draggable={draggable}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <Icon size={17} className={clsx('shrink-0', folder ? 'text-accent-text' : 'text-muted', dim && 'opacity-60')} aria-hidden />
          {project?.kind === 'open' && <span className="sr-only">({t('files.isProject', { name: project.project.name })})</span>}
          <span className="min-w-0 truncate" title={e.name}>
            {words.name(e.path, e.name)}
          </span>
          {/* a folder the person can only pass through: a visible badge (a hover title alone does not reach phones);
              screen readers get the full sentence in place of the short badge text. Phones show the row greyed out
              only (next to the folder's own "이동만" badge it read as the same thing twice); inside, that badge says it */}
          {dim && !membersOnly && (
            <span className="shrink-0 max-md:sr-only" data-testid="pass-through">
              <Badge>
                <Signpost size={11} aria-hidden /> <span aria-hidden>{t('files.passThroughShort')}</span>
                <span className="sr-only">{t('files.navigationOnly')}</span>
              </Badge>
            </span>
          )}
          {/* a team project's folder the owner or an admin is not a member of: the words of Folder permissions, on
              phones too (there is no other sign that it opens the project's page) */}
          {dim && membersOnly && (
            <span className="shrink-0" data-testid="members-only">
              <Badge>{t('accessTree.membersOnly')}</Badge>
            </span>
          )}
          {!folder && isConflictCopy(e.name) && <Badge tone="warn">{t('files.conflictCopy')}</Badge>}
          {aiOff && <span className="shrink-0" data-testid="file-download-only"><Badge>{t('files.downloadOnly')}</Badge></span>}
          {/* not on Personal: the person's own folder inside is theirs to change */}
          {e.access === 'read' && e.path !== 'users' && (
            <Tooltip label={t('files.readOnlyTip')} description>
              <Lock size={12} className="shrink-0 text-faint" aria-label={t('files.readOnly')} />
            </Tooltip>
          )}
          {/* only while something is dragged over it (the pointer's job; the toast says what happened) */}
          {(dropOk || dropNo) && (
            <span className="ml-auto shrink-0" aria-hidden data-testid="drop-hint">
              {dropOk ? (
                <Badge tone="accent">{t(drop!.kind === 'upload' ? 'files.drop.uploadHere' : 'files.moveHere')}</Badge>
              ) : (
                <Badge tone="warn">
                  <Lock size={11} aria-hidden /> {t(drop!.kind === 'upload' ? 'files.drop.cannotUpload' : 'files.drop.cannot')}
                </Badge>
              )}
            </span>
          )}
        </button>
      </td>
      <td className="hidden px-2 py-1.5 text-xs whitespace-nowrap text-muted @xl:table-cell">{formatDateTime(e.mtime, locale)}</td>
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
            <button role="menuitem" type="button" className={item} onClick={onChat} disabled={aiOff} aria-describedby={aiOff ? `${menuId}-ai-off` : undefined} data-testid="chat-with-file">
              {folder ? <MessageSquarePlus size={14} aria-hidden /> : <Sparkles size={14} aria-hidden />} {t(folder ? 'files.chatWith' : 'files.askAi')}
            </button>
            {!folder && onAddToChat && (
              <button role="menuitem" type="button" className={item} onClick={onAddToChat} disabled={aiOff} aria-describedby={aiOff ? `${menuId}-ai-off` : undefined} data-testid="add-to-chat">
                <Paperclip size={14} aria-hidden /> <span className="min-w-0 truncate">{t('files.addToChatNamed', { title: chatTitle })}</span>
              </button>
            )}
            {aiOff && <p id={`${menuId}-ai-off`} className="px-2 pb-1.5 text-xs text-muted" data-testid="file-ai-off-reason">{t('files.askAiDownloadOnly')}</p>}
            {project && (
              <button role="menuitem" type="button" className={item} onClick={() => onProject(project)} data-testid="open-project">
                <FolderKanban size={14} aria-hidden /> <span className="min-w-0 truncate">{t('files.openProject')}</span>
              </button>
            )}
            {onAccess && (
              <button role="menuitem" type="button" className={item} onClick={onAccess} data-testid="folder-access-menu">
                <Users size={14} aria-hidden /> <span className="min-w-0 truncate">{t('folderAccess.menu')}</span>
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
