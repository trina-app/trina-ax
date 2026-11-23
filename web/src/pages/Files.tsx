// The team folder explorer: only what the person may see (folders shown for navigation only are greyed out),
// upload (drag and drop; chunked and resumable when large), download, new folder, rename / move, trash, version
// history with restore, conflict copies marked, "start a chat with this file". Refreshes on files.changed.
// Several items at once: a checkbox per row (Shift+click: a range; the header one: every row listed; Esc: none), then
// move / share / trash for all of them from the bar that replaces the breadcrumbs (lib/bulkFiles.ts). Phones (below
// 768 px) leave out the checkboxes and the header row: a long press on a row selects it, the checkboxes come back while
// something is selected, and a tap on a row then adds or takes it away instead of opening it. Phones also leave out
// refresh, and new folder / upload where the folder takes no new files.
// Phones also get one app bar in place of the title, the Team folder / Trash pills, the toolbar and the breadcrumbs: ‹ to
// the folder above (named), the folder's name, and ⊕ as a sheet: New folder and the device rows (사진 보관함, 사진 찍기, 파일; components/DevicePick.tsx, never iOS's raw menu), as an empty folder's 올리기 has them. The search box and the
// folder's notes are the top of the list (they scroll away), rows have two lines (name; date · size), the trash is a
// place (a row at the end of the team folder), and the selection's actions sit at the bottom, above the tab bar. Each
// row's ⋯ is the app's menu (rooms/MenuButton.tsx: a sheet on phones), with "Select" on phones.
// Drag and drop, like a file manager: a row dragged onto a folder row or a breadcrumb moves there (the selection when
// that row is selected), with the selection's "move" rules and toast; computer files dropped on a folder row are
// uploaded into it. The "move" action stays the keyboard way to do the same.
// A whole folder goes up from the picker or a drop, with its subfolders (lib/folderUpload.ts, components/FolderUploads.tsx).
// A project is a folder with instructions: a folder's menu opens its project (lib/projectFolders.ts). New projects are made
// on the Projects page, in a new projects/<name> (docs/DECISIONS.md "Projects live only in projects/"): the projects
// folder itself offers no new folder or upload. A project's folder is its members' (docs/DECISIONS.md "Project contents
// only for members"): the owner or an admin who manages a project without being a member, sent to its folder, goes to
// the project's page instead (there they can add themselves), not to "folder not found".
// A rename, a move (one, the selection, a drag), the trash and its Undo, a new folder and a restore from the trash show
// at once and go back with a toast when the server refuses (store/fileChanges.ts; docs/DECISIONS.md "Optimistic
// projects and files"); a question the server asks (who would lose or gain sight of it) is asked with the row already
// moved, and a no puts it back.
import clsx from 'clsx'
import { ArchiveRestore, BookmarkPlus, ImageIcon, Link2, ChevronDown, ChevronRight, Copy, Download, Eye, File as FileIcon, FileImage, FileSpreadsheet, FileText, Folder, FolderInput, FolderKanban, FolderPlus, FolderUp, History, Home, Lock, MessageSquarePlus, Paperclip, Pencil, Plus, Presentation, Search, Signpost, SquareCheck, RefreshCw, Trash2, Upload, UserPlus, Users, X, FileCode, FileArchive, FileAudio, FileVideo } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { type Access, type FileEntry, type FileHistoryEvent, type FileVersion, type HistoryResponse, type TrashItem, type TreeResponse } from '@mycel/shared/api'
import { api, API, errorText, fileUrl, isApiError, startDownload, versionDownloadUrl } from '../lib/api'
import { canChange, canShare, chatDraggable, clickSelect, dragPayload, dragSet, dropRefusal, failureList, FILES_MOVE_DRAG_TYPE, isFixed, moveMany, projectSkillsOn, selectable, sendWidening, widenedBy, selectionState, shareMany, toggleAll, trashMany, type DropRefusal, type Outcome } from '../lib/bulkFiles'
import { formatDateTime, formatShortDateTime, formatSize, intlTag } from '../lib/format'
import { groupTrash, mergePage, placeWords, purgeIn, retentionDays, sameNamedProjects, showWhoSwitch, trashPlace, type PlaceWords } from '../lib/trashList'
import { ListRow } from '../components/list/List'
import { useGoBack } from '../lib/back'
import { useBackLabel } from '../lib/backStack'
import { useScreenName } from '../lib/screens'
import { folderGeneration } from '../lib/folderRuns'
import { topFoldersFirst, useFolderName, useFolderWords } from '../lib/folderLabels'
import { droppedEntries, planFromEntries, planFromInput, type FolderPlan } from '../lib/folderUpload'
import { baseName, crumbs, isConflictCopy, isInside, joinPath, nameProblem, parentPath } from '../lib/paths'
import { iconKind, previewKind, serverPreview, type FileIconKind } from '../lib/preview'
import { isMenuKey, teamFileLink } from '../lib/fileMenu'
import { canCopyImage } from '../lib/copyImage'
import { copyImageFrom, useCopyFileLink } from '../components/FileMenu'
import { folderProjectAction, isProjectsFolder, isProjectsTop, projectFolderOf, projectsByFolder, type FolderProjectAction } from '../lib/projectFolders'
import { openTeamFile, panelExpandedNow, useSidePanel } from '../lib/sidePanel'
import { useTeamAttach } from '../lib/useTeamAttach'
import { cancelUpload, uploadFile } from '../lib/upload'
import { addFileUpload, dropFileUpload, patchFileUpload } from '../lib/fileUploads'
import { SIGNED_OUT } from '../lib/localData'
import { markBusy } from '../lib/busy'
import { useLocale, useT } from '../i18n'
import { aiName } from '../lib/tabs'
import { accessChanged, fileSharesChanged, filesChanged, reloadAsked } from '../store/live'
import { readManagedList, readProjectList, useProjects } from '../store/projects'
import { useDeleteProject } from '../components/projectActions'
import { dropFolders, FOLDER_PAGE, folderKey, keptFolder, readFolder } from '../store/teamFiles'
import { DECLINED, fileChangeKey, fileChangePending, fileEdits, later, madeEntry, onListingEdit, placeEntry } from '../store/fileChanges'
import { optimistic } from '../lib/optimistic'
import { toast } from '../store/ui'
import { contentQueryReady, FileContentResults, FileNameResults } from '../components/FileContentSearch'
import FileUploads from '../components/FileUploads'
import FolderPicker from '../components/FolderPicker'
import { FolderAccessChip, FolderAccessPanel, offersFolderAccess } from '../components/FolderAccess'
import { openFileShare, useCopyTeamFileLink } from '../components/FileShareDialog'
import { isOwnPath, offersFolderShare, useOwnFolderShare } from '../lib/folder-share'
import { uploadPlans, type UploadClash, type UploadPlan } from '../lib/uploadPlans'
import FolderUploads, { startFolderUpload, useFolderUploadsSettled } from '../components/FolderUploads'
import { TeamFilesEntry } from '../components/onboarding/TeamFilesStep'
import { useFindWorkFilesEntry } from '../components/onboarding/FindWorkFiles'
import { OpenAppLine } from '../components/onboarding/OpenAppLine'
import SuggestSkillDialog from '../components/SuggestSkillDialog'
import { SkillIssues } from '../components/SkillIssues'
import { isSkillsPath } from '../lib/skillIssues'
import { nameList, restoreDropouts } from '../lib/restoreDropouts'
import { chatItemKey } from '../lib/appWording'
import { isAdmin, useMeStrict } from '../store/session'
import { Badge, Button, buttonClass, EmptyState, ErrorNote, IconButton, Modal, Skeleton, TabPanel, Tabs, choiceDialog, confirmDialog, promptDialog, useMediaQuery } from '../components/ui'
import { MenuButton, type MenuItem } from '../components/rooms/MenuButton'
import { PhonePickButton, useDevicePick } from '../components/DevicePick'
import { AiMark } from '../components/rooms/AiFace'
import { PhonePageBar } from '../components/phone/PhonePageBar'
import { LoadError } from '../components/LoadError'
import { Tooltip } from '../components/Tooltip'
import { newChatPath } from '../lib/newChat'
import { PhoneFilesHome, TEAM_ROOT_ON_PHONE } from '../components/panels/FilesPanel'
import { stackNow } from '../lib/screenHistory'
import RecentFiles from './RecentFiles'
import SharedFiles from './SharedFiles'
import { storagePlansAction, storagePlansUrl } from '../components/StoragePlansLink'

const ICONS: Record<FileIconKind, typeof FileIcon> = { folder: Folder, image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, audio: FileAudio, video: FileVideo, code: FileCode, archive: FileArchive, text: FileText, other: FileIcon }

/** how long a finger stays on a row to select it (phones), and how far it may move meanwhile (more is a scroll) */
const LONG_PRESS_MS = 500
/** the projects list is read again when the Files screen opens, at most this often (a project made or renamed here is in
 * the projects store at once) */
const PROJECTS_AGE_MS = 15_000
const LONG_PRESS_SLOP = 10

/** phones have no folder picker (the attribute can be there and do nothing): 올리기 is then the plain file button, no menu */
const canPickFolder = typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype

/** POST /api/files/move's and a trash restore's answer: the item as the server has it now */
type MoveResult = { entry: FileEntry }

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

/** /files: the team folder explorer; also 파일's "최근 파일" (`?view=recent`, pages/RecentFiles.tsx) and "Shared with me"
 * (`?view=shared`, pages/SharedFiles.tsx), rows of the list
 * beside the rail; on a phone /files itself is the 파일 tab's places (components/panels/FilesPanel.tsx PhoneFilesHome) and a folder is a place's screen. */
export default function FilesRoute() {
  const [params] = useSearchParams()
  const phone = useMediaQuery('(max-width: 767.98px)')
  if (params.get('view') === 'recent') return <RecentFiles />
  if (params.get('view') === 'shared') return <SharedFiles />
  // (the team folder's own top is /files?team=1 there: FilesPanel.tsx TEAM_ROOT_ON_PHONE)
  if (phone && !params.get('path') && !params.get('view') && !params.get('q') && !params.get('select') && !params.has('team')) return <PhoneFilesHome />
  return <Files />
}

function Files() {
  const t = useT()
  const locale = useLocale()
  // the top folders and the person's own folder in words (전사 공유, 부서, 내 폴더 …): what is shown, never the paths used
  const words = useFolderWords()
  /** a folder's own name ("leads", 부서), for the phone's bar and its ‹ */
  const folderName = useFolderName()
  // the phone's ‹ at the team folder: 파일's places, the tab's root (lib/screens.ts), which the top folders, a project's
  // folder and my own folder are under (their ‹ says 파일), or what is under it in its stack
  const upFromTeamFolder = useGoBack('/files')
  // (its ‹ names where it goes: 파일's places, or the screen under it in its stack; useBackLabel leaves a ‹ alone when that
  // is the same pathname, /files, but the places are another screen)
  const screenName = useScreenName()
  const teamFolderBackLabel = useBackLabel('/files', () => null) ?? screenName(stackNow()?.below?.p ?? '/files')
  const rootName = t('sidebar.files')
  /** the folder ‹ goes to: the one above, or 파일's places for a place's own folder (phones) */
  const upOf = (p: string) => {
    const up = parentPath(p)
    return up === 'projects' || up === 'users' ? '' : up
  }
  // a top folder opened from the team folder's own top (파일 › 팀 폴더): ‹ goes back there, not to the places
  const fromTeamTop = stackNow()?.below?.p === TEAM_ROOT_ON_PHONE
  const upTo = (p: string) => (upOf(p) === '' && fromTeamTop ? navigate(TEAM_ROOT_ON_PHONE) : go(upOf(p)))
  const upName = (p: string) => (upOf(p) ? folderName(upOf(p)) : fromTeamTop ? t('files.root') : rootName)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const path = params.get('path') ?? ''
  const select = params.get('select')
  // Find work files on this computer: its button in the computer toolbar, its dialog below both headers (it stays open
  // when the window is made phone-narrow: QA TC-3504)
  const findWork = useFindWorkFilesEntry(path)
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
  // a folder seen a moment ago shows as it was at once and is read again behind it (store/teamFiles.ts)
  const [tree, setTree] = useState<TreeResponse | null>(() => keptFolder(path))
  /** the listing on screen now (a read that lands checks it) */
  const tree0 = useRef(tree)
  tree0.current = tree
  // a change made here shows in the listing on screen at once (store/fileChanges.ts)
  useEffect(() => onListingEdit((folder, f) => setTree((cur) => (cur && folderKey(cur.path) === folder ? f(cur) : cur))), [])
  /** the listing that failed (kept until a listing works: the notice stays while it reads again, components/LoadError.tsx) */
  const [error, setError] = useState<unknown>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [drag, setDrag] = useState(false)
  // phones (below 768 px, like the tab bar): rows are selected by a long press, not by a checkbox; a touch phone does
  // not drag rows (a long press there is the selection, and a row cannot be dropped anywhere useful on that screen)
  const phone = useMediaQuery('(max-width: 767.98px)')
  const touchPhone = useMediaQuery('(max-width: 767.98px) and (pointer: coarse)')
  // a touch-only screen (an iPad): no 폴더 올리기 in the 올리기 menu (WebKit's folder window is unreliable), so 올리기 is
  // the plain button; drop still takes folders
  const coarse = useMediaQuery('(pointer: coarse)')
  const anyFine = useMediaQuery('(any-pointer: fine)')
  const menuFolder = canPickFolder && !(coarse && !anyFine)
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
  // (the projects store's list, the one the 트리나 panel and Trina history read: read again when this screen opens, at
  // most every PROJECTS_AGE_MS, and after an access change or a moved folder; never a second request at once)
  const listed = useProjects((s) => s.listed)
  const projectsById = useProjects((s) => s.byId)
  const projects = useMemo(() => (listed ? [...listed].flatMap((id) => projectsById[id] ?? []) : []), [listed, projectsById])
  // after an event a read on its way may be from before it (the store joins it): once more after it
  const loadProjects = useCallback((fresh = true) => (fresh ? readProjectList().finally(() => readProjectList()) : readProjectList({ minAgeMs: PROJECTS_AGE_MS })), [])
  useEffect(() => {
    void loadProjects(false)
    return accessChanged.on(() => void loadProjects())
  }, [loadProjects])
  const byFolder = useMemo(() => projectsByFolder(projects), [projects])
  // folder sharing (open on this server): the folder on screen, if it is one of mine that can be shared
  const ownShare = useOwnFolderShare(path, me.user.id)
  // back from Admin's Share dialog opened with from=files (AccessTree): the folder's Share dialog opens again
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
  /** `shown`: the folder just opened, which joins a read of it on its way (a project's page may have started one); any
   * other load follows a change or an event, so it reads again */
  /** the listing on its way, and the last one set: 더 보기 pressed while a folder shown from a moment ago is read again
   * waits for it, so its first page never comes after (and over) the next one */
  const pendingLoad = useRef<Promise<void> | null>(null)
  const lastListed = useRef<TreeResponse | null>(null)
  const load = useCallback((o?: { shown?: boolean }) => {
    const p = listFolder(o)
    pendingLoad.current = p
    const off = () => {
      if (pendingLoad.current === p) pendingLoad.current = null
    }
    p.then(off, off)
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  const listFolder = async (o?: { shown?: boolean }) => {
    const mine = ++loads.current
    const edits = fileEdits()
    try {
      const r = await readFolder(path, { fresh: o?.shown !== true })
      if (mine !== loads.current) return
      // a rename, move, trash or new folder made here while it was read, or still unanswered: this answer may be from
      // before it and would undo it on screen; once nothing is on its way, read again (each change reads at its end)
      if (tree0.current && folderKey(tree0.current.path) === folderKey(path) && (edits !== fileEdits() || fileChangePending())) {
        if (!fileChangePending()) void onScreen.current?.load()
        return
      }
      lastListed.current = r
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
  }

  useEffect(() => {
    const kept = keptFolder(path)
    setTree(kept)
    // shown before: a not_found now says "access changed", as for a folder that goes while it is open
    if (kept) shown.current = path
    setError(null)
    void load({ shown: true })
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
    // folder sharing: the Shared marks of my own files change with any share (file_shares_changed, or my dialog)
    const offD = fileSharesChanged.on(() => { if (isOwnPath(path, me.user.id)) void load() })
    return () => {
      offA()
      offB()
      offC()
      offD()
    }
  }, [path, load, loadProjects])

  // 더 보기 belongs to the listing on screen when it was pressed: another folder opened (or a reload) before the next
  // page came back, that page is dropped. Added anyway, a subfolder showed its own files plus the parent's next 200
  // (QA TC-240), and those rows pointed at another folder
  const mores = useRef(0)
  useEffect(() => {
    mores.current++
    setLoadingMore(false)
  }, [path])
  const more = async () => {
    if (!tree?.nextCursor) return
    const ask = ++mores.current
    const from = tree.path
    let cursor: string | null = tree.nextCursor
    setLoadingMore(true)
    const waiting = pendingLoad.current
    if (waiting) {
      await waiting
      // (another folder or a reload meanwhile: this press is not theirs)
      if (ask !== mores.current) return
      const now = lastListed.current
      cursor = now && now.path === from ? now.nextCursor : null
      if (!cursor) return setLoadingMore(false)
    }
    const listing = loads.current
    const current = () => listing === loads.current
    try {
      const r = await api.call(API.tree, { query: { path, limit: FOLDER_PAGE, cursor } })
      if (!current()) return
      setTree((cur) => (cur && cur.path === from ? { ...cur, entries: [...cur.entries, ...r.entries], nextCursor: r.nextCursor } : cur))
    } catch (e) {
      if (current()) toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      if (ask === mores.current) setLoadingMore(false)
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
  // the bulk Move picker's suggested and recent folders, for the selection
  const movableSuggest = movable.map((e) => e.path)
  /** selected folders the person may write but not move or trash (a group's folder for a member, QA TC-224) */
  const fixedChosen = chosen.filter(isFixed).length
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

  /** A batch's rows leave the listing at once, each as its own change (store/fileChanges.ts) answered by the batch's
   * outcome: done stays done, a failure or a no puts the row back (the batch's one toast says why: no toast per row). */
  const leaveAtOnce = (items: readonly FileEntry[]) => {
    const answers = new Map(items.map((e) => {
      const answer = later<void>()
      void placeEntry({ key: fileChangeKey(e.path), from: e, to: null, send: () => answer.promise, failText: false })
      return [e.path, answer] as const
    }))
    return {
      settle: (r: Outcome) => {
        for (const e of r.done) answers.get(e.path)?.resolve()
        for (const f of r.failed) answers.get(f.entry.path)?.reject(f.error)
        for (const e of r.declined) answers.get(e.path)?.reject(DECLINED)
        // (none left: every item is in one of the three)
        for (const a of answers.values()) a.reject(DECLINED)
      },
      fail: (err: unknown) => {
        for (const a of answers.values()) a.reject(err)
      },
    }
  }

  /** Move items into one folder: the selection's "move", and rows dropped on a folder or a breadcrumb. Only those the
   * person may change (the rest are skipped and counted); one question when some of them would be hidden from other
   * people; one toast. `select`: as reportBatch. */
  const moveItems = async (items: readonly FileEntry[], folder: string, select = true) => {
    const ok = items.filter(canChange)
    const fixed = items.filter(isFixed).length
    const skipped = items.length - ok.length - fixed
    const skipWords = [skipped ? t('files.bulk.skipReadOnly', { n: skipped }) : null, fixed ? t('files.bulk.skipFixed', { n: fixed }) : null].filter(Boolean).join(' ')
    // the destination's kept listing does not have them yet: read when it opens
    dropFolders([folderKey(folder)])
    // they leave the listing at once (store/fileChanges.ts); the batch's outcome answers each one (one toast for all)
    const each = leaveAtOnce(ok)
    setRunning('move')
    try {
      const r = await moveMany(ok, folder, {
        move: (body) => api.call(API.move, { body }),
        // into my personal folder: the toast's Undo moves them back, so no question first; only when people lose files
        // they have by link (removed by the move, not put back by Undo) it still asks (docs/decisions/20261123-do-then-undo.md)
        confirmNarrow: async (count, n, linked) => !linked || confirmDialog({ title: t('files.narrowTitle'), body: <><p>{t('files.bulk.narrowBody', { count, n })}</p><p className="mt-2" data-testid="move-link-people">{t('files.narrowLinkPeople', { n: linked })}</p></>, confirm: t('files.moveAnyway'), danger: true }),
        // into a folder of my own: only a folder share there adds people (its own sentence); else out of my personal folder
        confirmWiden: (count, n) => confirmDialog({ title: t('files.widenTitle'), body: t(isOwnPath(folder, me.user.id) ? 'files.bulk.widenSharedBody' : ok.every((e) => isOwnPath(e.path, me.user.id)) ? 'files.bulk.widenBody' : 'files.bulk.widenBodyAny', { count, n }), confirm: t('files.moveAnyway') }),
        confirmSkills: confirmSkillsOn,
      })
      each.settle(r)
      reportBatch(
        r,
        {
          done: (n) => t('files.bulk.moved', { n, path: words.path(folder) || t('files.root') }),
          failed: (n, list) => t('files.bulk.moveFailed', { n, list }),
          skipped: skipWords || null,
        },
        // made private without a question: Undo moves those back where they were
        r.narrowed.length ? { label: t('common.undo'), run: () => void moveBack(r.narrowed) } : undefined,
        select,
      )
    } catch (err) {
      // rows back, and why
      each.fail(err)
      fail(err)
    } finally {
      setRunning(null)
      // (the folder on screen now: another one may have opened meanwhile)
      void onScreen.current?.load()
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
      void onScreen.current?.load()
    }
  }

  /** Trash the selection at once: the trash keeps them (and their shares) and the toast's "Undo" brings all of them
   * back, so there is no question first (Drive's way; docs/decisions/20261123-do-then-undo.md). */
  const bulkDelete = async () => {
    const items = movable
    if (!items.length) return
    const skipped = chosen.length - items.length - fixedChosen
    const left = [skipped ? t('files.bulk.readOnlyLeft', { n: skipped }) : null, fixedChosen ? t('files.bulk.fixedLeft', { n: fixedChosen }) : null].filter(Boolean).join(' ')
    const each = leaveAtOnce(items)
    setRunning('delete')
    try {
      const r = await trashMany(items, { remove: (p) => api.call(API.remove, { query: { path: p } }) })
      each.settle(r)
      // trashIds are in the order of r.done
      const undo = () => untrash(r.done.map((entry, i) => ({ entry, trashId: r.trashIds[i]! })))
      reportBatch(r, { done: (n) => t('files.bulk.trashed', { n }), failed: (n, list) => t('files.bulk.deleteFailed', { n, list }), skipped: left || null, okLevel: 'info' }, { label: t('common.undo'), run: () => void undo() })
    } catch (err) {
      // rows back, and why
      each.fail(err)
      fail(err)
    } finally {
      setRunning(null)
      // (the folder on screen now: another one may have opened meanwhile)
      void onScreen.current?.load()
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
    void (async () => {
      // a name the folder holds already: asked first, Replace (the old one becomes a version) or Keep both (QA TC-7241)
      const plans = await uploadPlans(list, {
        taken: (names) => api.call(API.namesTaken, { body: { folder, names } }),
        ask: askUploadClash,
      })
      for (const pl of plans) sendFile(pl.file, folder, addFileUpload(pl.name, folder), pl)
    })()
  }
  /** "A file named X is already here.": Replace (keeps the old one as a version) or Keep both; a folder of that name
   * cannot be replaced, so only Keep both is offered and the message says why. */
  const askUploadClash = (c: UploadClash) =>
    choiceDialog({
      title: t(c.type === 'folder' ? 'files.uploadClash.folderTitle' : 'files.uploadClash.title', { name: c.existing }),
      body: t(c.type === 'folder' ? 'files.uploadClash.folderBody' : 'files.uploadClash.body'),
      choices: [
        { value: 'keep', label: t('files.uploadClash.keepBoth'), testId: 'upload-clash-keep' },
        ...(c.type === 'file' ? [{ value: 'replace', label: t('files.uploadClash.replace'), testId: 'upload-clash-replace' }] : []),
      ],
    }) as Promise<'keep' | 'replace' | null>
  /** One file of startUploads, and its 다시 시도 after a failure: the same file to the same name (a large one goes on
   * from the chunks the server has; a small one that did arrive is kept by the server, no "(2)"; QA TC-223). */
  const sendFile = (file: File, folder: string, item: { id: number; abort: AbortController }, plan: Pick<UploadPlan, 'name' | 'onExists'> = { name: file.name, onExists: 'rename' }) => {
    // (a Replace sends the name on disk, so the very file it showed is the one replaced)
    const target = { kind: 'path', path: joinPath(folder, plan.name), onExists: plan.onExists } as const
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
        const retry = () => {
          const again = { id: item.id, abort: new AbortController() }
          patchFileUpload(item.id, { status: 'uploading', error: undefined, plans: undefined, progress: null, abort: again.abort, retry: undefined })
          sendFile(file, folder, again, plan)
        }
        patchFileUpload(item.id, { status: 'failed', error: errorText(e, locale, t('error.network')), plans: storagePlansUrl(e), retry })
      },
    )
  }

  /** Upload a read folder into this folder, or into `into`, with the same check for write access as for a file. */
  const startFolder = (plan: FolderPlan, into?: string) => {
    if (into === undefined && tree && !canWrite) return toast({ level: 'warn', text: t('files.readOnlyFolder') })
    if (!plan.files.length && !plan.folders.length && !plan.unreadable.length) return toast({ level: 'info', text: t('files.folderUpload.empty') })
    startFolderUpload(plan, into ?? path, (view) => toast({ level: 'error', text: `${errText(view.refusal)} ${t('files.folderUpload.stopped', { n: view.waiting })}`, ...storagePlansAction(view.refusal) }))
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
  // a phone's ⊕ and an empty folder's 올리기: our sheet's device rows (사진 보관함, 사진 찍기, 파일), never iOS's raw menu
  // of a file input with no type (components/DevicePick.tsx)
  const device = useDevicePick({ onFiles: (list) => startUploads(list), testIds: 'files-add', filesTestId: 'files-add-files-input' })
  // a folder upload ended (also one started before this page opened): the new files are listed
  const folderUploadsSettled = useFolderUploadsSettled()
  useEffect(() => {
    if (folderUploadsSettled) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderUploadsSettled])

  const mkdir = async () => {
    const name = await promptDialog({ title: t('files.newFolder'), label: t('files.folderName'), confirm: t('common.create'), validate: (v) => (nameProblem(v) ? t(`files.name.${nameProblem(v)!}`) : null) })
    if (!name) return
    // in the listing at once, in its place among the folders; the server's copy (its own time, its rights) settles it
    const at = joinPath(path, name)
    const made = madeEntry({ name, path: at, type: 'folder', size: null, mtime: new Date().toISOString(), mime: null, access: 'write' })
    await placeEntry({ key: fileChangeKey(at), from: null, to: made, send: () => api.call(API.mkdir, { body: { path: at } }), confirmed: (r) => r })
    void onScreen.current?.load()
  }

  /** A project's folder moved to projects/<name>: the skills in it start to count in that project's chats. Nothing to
   * choose there (the person moved it), so it is said in one line, with their names, and the move goes ahead
   * (docs/decisions/20261123-do-then-undo.md). */
  const confirmSkillsOn = (skills: string[]) => {
    toast({ level: 'info', text: t('files.skillsOnBody', { n: skills.length, names: skills.join(', '), ai: aiName(t) }) })
    return Promise.resolve(true)
  }

  /** Undo of a move into my personal folder: each item back where it was, confirmed (the same people see it again; the
   * place it left is its own, so nothing new widens), then the listing read again. */
  const moveBack = async (items: readonly { entry: FileEntry; path: string }[]) => {
    const failed: string[] = []
    for (const { entry, path: at } of items) {
      try { await api.call(API.move, { body: { from: at, to: entry.path, onExists: 'fail', confirm: true } }) } catch { failed.push(entry.name) }
    }
    dropFolders([folderKey(parentPath(items[0]?.entry.path ?? ''))])
    void onScreen.current?.load()
    if (failed.length) toast({ level: 'error', text: t('files.undoMoveFailed', { list: failed.join(', ') }) })
  }

  /** POST /api/files/move; when other people would lose sight of the item (into users/<me>/), or more people would see
   * it (out of a personal folder; QA TC-115), ask first, then confirm.
   * A project's folder moved to projects/<name> turns its skills on in that project's chats: that is asked first too. */
  const moveConfirmed = async (body: { from: string; to: string; onExists: 'fail' | 'rename'; skillsOk?: boolean; askWiden?: boolean }): Promise<(MoveResult & { narrowed?: true }) | null> => {
    // out of my personal folder to where more people see it: asked first as well (QA TC-115)
    body = { ...body, askWiden: true }
    try {
      return await api.call(API.move, { body })
    } catch (err) {
      const skills = projectSkillsOn(err)
      if (skills) {
        if (!(await confirmSkillsOn(skills))) return null
        return moveConfirmed({ ...body, skillsOk: true })
      }
      const added = widenedBy(err)
      if (added !== null) {
        // into a folder of my own (a move or a rename): only a folder share there adds people
        // out of my personal folder, or (QA TC-r2b-02) out of a project or group folder into a wider one
        const widen = isOwnPath(body.to, me.user.id) ? 'files.widenSharedBody' : isOwnPath(body.from, me.user.id) ? 'files.widenBody' : 'files.widenBodyAny'
        if (!(await confirmDialog({ title: t('files.widenTitle'), body: t(widen, { n: added }), confirm: t('files.moveAnyway') }))) return null
        return await api.call(API.move, { body: { ...body, confirm: true } })
      }
      if (!(isApiError(err, 'conflict') && err.body.params?.reason === 'audience_narrowed')) throw err
      const n = Number(err.body.params.lostViewers ?? 0)
      // people who have a file there by its link lose it too (files/shares.ts linkPeopleUnder; QA TC-3093)
      const linked = Number(err.body.params.linkPeople ?? 0)
      const folder = tree0.current?.entries.find((x) => x.path === body.from)?.type === 'folder'
      // into my personal folder: the toast's Undo moves it back (narrowed), so no question first; only when people lose
      // files they have by link (the move removes those links, Undo does not bring them back) it still asks
      // (docs/decisions/20261123-do-then-undo.md)
      if (linked > 0 && !(await confirmDialog({ title: t('files.narrowTitle'), body: <><p>{t('files.narrowBody', { n })}</p><p className="mt-2" data-testid="move-link-people">{t(folder ? 'files.narrowLinkPeopleFolder' : 'files.narrowLinkPeople', { n: linked })}</p></>, confirm: t('files.moveAnyway'), danger: true }))) return null
      return { ...(await api.call(API.move, { body: { ...body, confirm: true } })), ...(linked > 0 ? {} : { narrowed: true as const }) }
    }
  }

  /** A move or rename at once (store/fileChanges.ts): the row leaves its place (`to`: where it shows instead; null: it
   * leaves this listing for another folder, read there when it opens), the server's questions are asked meanwhile, a
   * no or a refusal puts it back (a refusal with one toast). */
  const moveEntry = (e: FileEntry, dest: string, onExists: 'fail' | 'rename', to: FileEntry | null) =>
    placeEntry<MoveResult & { narrowed?: true }>({
      key: fileChangeKey(e.path),
      from: e,
      to,
      send: async () => {
        const r = await moveConfirmed({ from: e.path, to: dest, onExists })
        if (!r) throw DECLINED
        return r
      },
      confirmed: to ? (r) => r.entry : undefined,
    }).then((r) => {
      // the listing as the server has it now (its order, a name it changed)
      void onScreen.current?.load()
      return r
    })

  const rename = async (e: FileEntry) => {
    // a file's name starts selected without its extension (".bashrc" and a folder: all of it)
    const dot = e.type === 'folder' ? -1 : e.name.lastIndexOf('.')
    const name = await promptDialog({ title: t('files.rename'), label: t('files.newName'), initial: e.name, select: dot > 0 ? dot : e.name.length, confirm: t('common.save'), validate: (v) => (nameProblem(v) ? t(`files.name.${nameProblem(v)!}`) : null) })
    if (!name || name === e.name) return
    const dest = joinPath(parentPath(e.path), name)
    // the new name in its place in the folder at once
    await moveEntry(e, dest, 'fail', madeEntry({ ...e, name, path: dest }))
  }

  const moveTo = async (folder: string) => {
    const e = moving
    setMoving(null)
    if (!e) return
    // the destination's kept listing does not have it yet: read when it opens
    dropFolders([folderKey(folder)])
    const r = await moveEntry(e, joinPath(folder, e.name), 'rename', null)
    // made private without a question (moveConfirmed): Undo moves it back
    if (r.ok && r.newest) toast({ level: 'success', text: t('files.moved', { path: words.path(folder) || t('files.root') }), ...(r.reply.narrowed ? { action: { label: t('common.undo'), run: () => void moveBack([{ entry: e, path: r.reply.entry.path }]) } } : {}) })
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
      const r = await api.call(API.copy, { body: n > 0 ? { ...body, confirm: true } : body })
      if ('path' in r) toast({ level: 'success', text: t('files.shared', { path: words.path(r.path) }) })
      void load()
    } catch (err) {
      fail(err)
    }
  }

  /** A restore into a folder its owner shares now (409 audience_widened): asked once per item, then sent confirmed. */
  const askRestoreWiden = (n: number) => confirmDialog({ title: t('files.widenTitle'), body: t('files.restoreWidenBody', { n }), confirm: t('common.restore') })
  /** Undo of the trash: the rows back at once (the server's copy, " (restored)" when the name was taken meanwhile). */
  const untrash = (items: readonly { entry: FileEntry; trashId: string }[]) =>
    Promise.all(
      items.map(({ entry, trashId }) =>
        placeEntry<MoveResult>({ key: fileChangeKey(entry.path), from: null, to: madeEntry(entry), send: () => sendWidening((confirm) => api.call(API.restoreTrash, { params: { id: trashId }, ...(confirm ? { query: { confirm: '1' as const } } : {}) }), askRestoreWiden), confirmed: (r) => r.entry }),
      ),
    ).then(() => void onScreen.current?.load())

  /** To the trash at once: the toast's Undo brings it back with its shares (docs/decisions/20261123-do-then-undo.md). */
  const remove = async (e: FileEntry) => {
    // out of the listing at once; "moved to the trash" with its Undo comes with the server's answer
    const r = await placeEntry({ key: fileChangeKey(e.path), from: e, to: null, send: () => api.call(API.remove, { query: { path: e.path } }) })
    void onScreen.current?.load()
    if (!r.ok || !r.newest) return
    toast({ level: 'info', text: t('files.trashed', { name: e.name }), action: { label: t('common.undo'), run: () => void untrash([{ entry: e, trashId: r.reply.trashId }]) } })
  }

  // a file goes into a new chat as an attachment (a team-file reference); a folder is named in the prompt
  const chatAttach = useTeamAttach()
  const chatWith = (e: FileEntry) => (e.type === 'file' ? chatAttach.askAi([e.path]) : navigate(newChatPath({ prompt: t('files.chatPrompt', { path: e.path }) })))
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

  /** file content search: in the toolbar on a computer; on a phone the top of the list, so it scrolls away (44 px tall,
   * 16 px text: iOS zooms into a smaller field) */
  const searchField = (
    <label className={clsx('flex min-w-0 items-center gap-1.5 rounded-lg border border-field-border bg-surface focus-within:border-accent focus-within:ring-1 focus-within:ring-accent', phone ? 'mx-1 mt-2 mb-1 h-11 px-3' : 'h-8 @max-2xl:flex-1 px-2')}>
      <Search size={phone ? 16 : 14} className="shrink-0 text-faint" aria-hidden />
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
        className={clsx('w-full min-w-0 bg-transparent outline-none placeholder:text-faint', phone ? 'text-base' : 'text-sm @2xl:w-48')}
        data-testid="content-search-input"
        data-own-clear
      />
      {q && (
        <Tooltip label={t('files.search.clear')}>
          <button type="button" className="touch-hit text-faint hover:text-ink max-md:-mr-2 max-md:inline-flex max-md:w-11 max-md:justify-center max-md:self-stretch max-md:items-center" onClick={() => setQuery('')} aria-label={t('files.search.clear')}>
            <X size={14} aria-hidden />
          </button>
        </Tooltip>
      )}
    </label>
  )
  /** who else sees this folder and what the person may do in it: after the breadcrumbs on a computer, under the search
   * on a phone */
  const folderNotes = tree && (
    <>
      {/* who else sees this folder: a count where a member can write, their own folder, a project's folder;
          everything for admins (nothing at the top folders and the root) */}
      <FolderAccessChip key={tree.path} path={tree.path} access={tree.access} project={byFolder.get(tree.path.normalize('NFC')) ?? null} onOpen={() => setAccessFor({ path: tree.path, access: tree.access })} own={ownShare} />
      {/* Personal (users/): what a member can do there is open their own folder inside, so it is not called
          read-only (docs/DECISIONS.md "A welcome for invited people") */}
      {tree.access !== 'write' && (personal ? (
        <Badge className={clsx(!phone && 'ml-2')} data-testid="files-personal-badge">{t('files.personalInside')}</Badge>
      ) : (
        <Badge tone="warn" className={clsx(!phone && 'ml-2')}>
          <Lock size={11} aria-hidden /> {t(tree.access === 'read' ? 'files.readOnlyFolder' : 'files.navigationOnly')}
        </Badge>
      ))}
    </>
  )

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
      {phone ? (
        // phones: one bar, as on the app's other pages. ‹ goes to the folder above (go(): Back to it, lib/screenHistory.ts),
        // from the trash to the folder it was opened from, from the team folder to 프로젝트 (the tab it is under, QA TC-255:
        // Back in its stack, named after where it goes); ⊕ only where the folder takes new files. The team folder is
        // named as its row on the projects list ("팀 폴더")
        <PhonePageBar
          onBack={view === 'trash' ? () => setView('files') : path ? () => upTo(path) : upFromTeamFolder}
          backLabel={view === 'trash' ? (path ? folderName(path) : params.has('team') ? t('files.root') : rootName) : path ? upName(path) : teamFolderBackLabel}
          title={view === 'trash' ? t('files.trash') : path ? folderName(path) : t('files.root')}
          heading
          action={
            view === 'files' && canAdd && !anyChecked ? (
              <MenuButton
                label={t('files.add')}
                icon={<Plus size={22} aria-hidden />}
                muted
                buttonClassName="size-11"
                testId="files-add"
                items={[
                  { label: t('files.newFolder'), icon: <FolderPlus size={18} className="shrink-0 text-muted" aria-hidden />, onSelect: () => void mkdir(), testId: 'files-add-folder' },
                  // the device rows, each one picker (no folder upload: a phone has no folder picker, the attribute
                  // can be there and do nothing)
                  ...device.items,
                ]}
              />
            ) : null
          }
          backTestId="files-back"
          titleTestId="files-title"
        />
      ) : (
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-6">
        {/* the trash is a row of 파일's list beside the rail, so no tabs here; the list says 파일 already, the breadcrumbs
            where this is: the title is for screen readers */}
        <h1 className={clsx('mr-2 text-title font-semibold', view !== 'trash' && 'sr-only')}>{view === 'trash' ? t('files.trash') : t('files.title')}</h1>
        {view === 'files' && (
          // a narrow page (a phone, or a desktop with the file panel open): the toolbar has its own line, the buttons show
          // only their icons, and the search box takes the width they leave
          <div className="ml-auto flex items-center gap-1 @max-2xl:w-full">
            {searchField}
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
            {!projectsTop && findWork.button}
            {/* 올리기: one button for files and folders (owner 11-20, docs/decisions/20261118-our-file-picker-everywhere.md):
                a small menu (파일 올리기 / 폴더 올리기) where the folder can be written and the browser picks folders, as
                Drive and Dropbox do (one window cannot pick both); else today's plain button, to the file window at once
                (off in a read-only folder; a touch-only tablet: WebKit's folder window is unreliable there) */}
            {!projectsTop && (canWrite && menuFolder ? (
              <MenuButton
                bare
                label={t('files.upload')}
                testId="upload-button"
                buttonClassName={buttonClass({ variant: 'primary', size: 'sm' })}
                icon={
                  <>
                    <Upload size={15} aria-hidden /> <span className="@max-2xl:hidden">{t('files.upload')}</span>
                    <ChevronDown size={14} className="-mr-0.5 -ml-0.5" aria-hidden data-testid="upload-button-caret" />
                  </>
                }
                items={[
                  { label: t('files.uploadFiles'), icon: <Upload size={16} className="shrink-0 text-muted" aria-hidden />, onSelect: () => fileInput.current?.click(), testId: 'upload-files' },
                  { label: t('files.uploadFolder'), icon: <FolderUp size={16} className="shrink-0 text-muted" aria-hidden />, onSelect: () => folderInput.current?.click(), testId: 'folder-upload-button' },
                ]}
              />
            ) : (
            <Tooltip label={t('files.upload')}>
              <Button size="sm" variant="primary" className={clsx(tree && !canWrite && 'max-md:hidden')} onClick={() => fileInput.current?.click()} disabled={!canWrite} aria-label={t('files.upload')} data-testid="upload-button">
                <Upload size={15} aria-hidden /> <span className="@max-2xl:hidden">{t('files.upload')}</span>
              </Button>
            </Tooltip>
            ))}
          </div>
        )}
      </div>
      )}
      {findWork.dialog}
      {/* a phone's ⊕ sheet and its empty folder's 올리기: the device rows' pickers (one set for both) */}
      {phone && device.inputs}
      {/* the pickers New folder / Upload open on a computer (its toolbar, an empty folder's button) */}
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
      {canPickFolder && (
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
      )}

      {/* the chosen tab's content: a flex column like the page, so the list below still fills and scrolls */}
      <TabPanel base={null} value={view} className="flex min-h-0 flex-1 flex-col">
      {view === 'trash' ? (
        <TrashView projects={projects} />
      ) : (
        <>
          {/* while rows are dragged the breadcrumbs come back: a drop there moves them up. Phones: the bar above says
              where this is, and the selection's actions are at the bottom */}
          {phone ? null : anyChecked && !dragging ? (
            <BulkBar
              count={chosen.length}
              readOnly={chosen.length - movable.length - fixedChosen}
              fixed={fixedChosen}
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
            <nav aria-label={t('files.breadcrumb')} className={clsx('flex flex-wrap items-center gap-1 px-4 py-2 text-sm max-md:gap-y-2.5 max-md:pt-0 max-md:pb-2.5 sm:px-6', !path && (!tree || tree.access === 'write') && 'max-md:hidden')}>
              <button type="button" className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover max-md:min-h-11', !path && 'max-md:hidden', crumbDrop('') === 'ok' && 'bg-accent-soft ring-2 ring-accent')} onClick={() => go('')} {...crumbTarget('')} data-drop={crumbDrop('')} data-testid="crumb">
                {/* the team folder's top, named as the rail names 파일 (one name per place) */}
                <Home size={14} aria-hidden /> {t('sidebar.files')}
              </button>
              {words.crumbs(path).map((c) => (
                <span key={c.path} className="inline-flex items-center gap-1">
                  <ChevronRight size={13} className="text-faint" aria-hidden />
                  <button type="button" className={clsx('rounded px-1.5 py-0.5 hover:bg-hover max-md:min-h-11', crumbDrop(c.path) === 'ok' && 'bg-accent-soft ring-2 ring-accent')} onClick={() => go(c.path)} aria-current={c.path === path ? 'page' : undefined} {...crumbTarget(c.path)} data-drop={crumbDrop(c.path)} data-testid="crumb">
                    {c.name}
                  </button>
                </span>
              ))}
              {folderNotes}
              {/* why New folder and Upload are off here (computers: phones hide them) */}
              {tree && !canWrite && (
                <span className="ml-2 text-xs text-muted max-md:hidden" data-testid="files-cannot-add">{t(personal ? ('files.addInMyFolderFiles') : 'files.addHere')}</span>
              )}
            </nav>
          )}
          {isSkillsPath(path) && <SkillIssues folder={path} className="mx-4 mb-2 sm:mx-6" />}
          <FileUploads here={path} />
          <FolderUploads here={path} />
          <TeamFilesEntry here={path} />
          {/* My files in a Mac or Windows browser: where the app's "Find work files on this computer" would be, one quiet
              line that the app does that (components/onboarding/OpenAppLine.tsx; never a guest, a phone or inside the apps) */}
          {path === `users/${me.user.id}` && <OpenAppLine className="mx-4 mb-2 px-1.5 max-md:mt-3 sm:mx-6" />}
          {/* computer files over the list go to this folder; over a folder row, into that folder (the row shows it) */}
          <div className={clsx('scroll-thin relative min-h-0 flex-1 overflow-y-auto px-2 pb-6 sm:px-4', drag && !over && 'bg-accent-soft/40 ring-2 ring-accent ring-inset')}>
            {phone && (
              <>
                {searchField}
                <div className="flex flex-wrap items-center gap-2 px-1 py-1 empty:hidden" data-testid="files-notes">
                  {folderNotes}
                </div>
              </>
            )}
            {searching ? (
              // files by name first (QA TC-260), then the lines that contain the text
              <>
                <FileNameResults q={q} path={path} onFolder={(p) => go(p)} />
                <FileContentResults q={q} path={path} folderLabel={words.path(path) || t('files.root')} />
              </>
            ) : (
              <>
                {!!error && (
                  <div className="p-4">
                    <LoadError error={error} onRetry={load} what="files" />
                  </div>
                )}
                {!tree && !error && <Skeleton lines={8} className="p-4" />}
                {tree && !tree.entries.length && (
                  <EmptyState screen icon={<Upload size={28} />} title={canAdd ? t(touchPhone ? 'files.emptyTap' : 'files.emptyDrop') : t('files.emptyReadOnly')}>
                    {canAdd && (phone ? (
                      <PhonePickButton pick={device} label={t('files.upload')} className={buttonClass({ size: 'sm', className: 'mt-2' })} inputs={false} testId="files-empty-upload">
                        {t('files.upload')}
                      </PhonePickButton>
                    ) : (
                      <Button size="sm" className="mt-2" onClick={() => fileInput.current?.click()} data-testid="files-empty-upload">
                        {t('files.upload')}
                      </Button>
                    ))}
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
                        {/* Modified only on a wide page: next to an open file panel the name keeps the room. Phones: both
                            under the name instead (FileRow) */}
                        <th className="hidden whitespace-nowrap px-2 py-2 font-medium md:@xl:table-cell">{t('files.modified')}</th>
                        <th className="hidden whitespace-nowrap px-2 py-2 text-right font-medium md:table-cell">{t('files.size')}</th>
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
                          chatTitle={chatAttach.target?.title ?? null}
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
                          onSuggest={me.user.role !== 'guest' && e.type === 'file' && e.path.startsWith(`users/${me.user.id}/`) && /\.(md|txt)$/i.test(e.name) ? () => setSuggesting(e.path) : null}
                          onAccess={e.type !== 'folder' ? null
                            // a folder in my own files is shared in the file Share dialog, and my personal folder
                            // itself and the places Trina keeps there offer no Share at all
                            : isOwnPath(e.path, me.user.id) ? (offersFolderShare(e.path, me.user.id) ? () => openFileShare(e.path) : null)
                            : offersFolderAccess(e.path, e.access, me.user.id, byFolder.get(e.path.normalize('NFC')) ?? null) ? () => setAccessFor({ path: e.path, access: e.access }) : null}
                          sharedThrough={ownShare?.through ?? null}
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
                {/* phones: the trash is a place, after the team folder's own folders (the computer's is a tab) */}
                {phone && !path && tree && (
                  <button type="button" onClick={() => setView('trash')} className="mt-1 flex min-h-12 w-full items-center gap-2.5 border-t border-line px-3 text-left text-sm" data-testid="files-open-trash">
                    <Trash2 size={17} className="shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{t('files.trash')}</span>
                    <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
                  </button>
                )}
              </>
            )}
          </div>
          {/* phones: what to do with the selection, at the bottom where the thumb is (above the tab bar) */}
          {phone && anyChecked && (
            <BulkBar
              count={chosen.length}
              readOnly={chosen.length - movable.length - fixedChosen}
              fixed={fixedChosen}
              canMove={movable.length > 0}
              canShare={shareable.length > 0}
              running={running}
              onMove={() => setBulkPick('move')}
              onShare={() => setBulkPick('share')}
              onDelete={() => void bulkDelete()}
              onClear={clearChecked}
              bottom
            />
          )}
        </>
      )}
      </TabPanel>
      <FolderPicker open={!!sharing} title={t('files.shareTitle', { name: sharing?.name ?? '' })} confirmLabel={t('files.shareHere')} initial="shared" onPick={shareTo} onClose={() => setSharing(null)} />
      <FolderPicker open={!!moving} title={t('files.moveTitle', { name: moving?.name ?? '' })} confirmLabel={t('files.moveHere')} initial={path} suggestFor={moving ? [moving.path] : undefined} onPick={moveTo} onClose={() => setMoving(null)} />
      <FolderPicker
        open={bulkPick !== null}
        title={bulkPick === 'share' ? t('files.bulk.shareTitle', { n: shareable.length }) : t('files.bulk.moveTitle', { n: movable.length })}
        confirmLabel={t(bulkPick === 'share' ? 'files.shareHere' : 'files.moveHere')}
        initial={bulkPick === 'share' ? 'shared' : path}
        suggestFor={bulkPick === 'move' ? movableSuggest : undefined}
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

/** The selection's actions, in place of the breadcrumbs while something is selected; `bottom`: a phone's, under the
 * list (above the tab bar). */
function BulkBar({ count, readOnly, fixed, canMove, canShare, running, onMove, onShare, onDelete, onClear, bottom }: { count: number; readOnly: number; fixed: number; canMove: boolean; canShare: boolean; running: 'move' | 'share' | 'delete' | null; onMove: () => void; onShare: () => void; onDelete: () => void; onClear: () => void; bottom?: boolean }) {
  const t = useT()
  return (
    // a narrow page (a phone, or a desktop with the file panel open): line 1 has the count, the read-only badge and ×,
    // line 2 has the buttons. Only CSS `order` moves × to the end of line 1, so the tab order stays count, buttons, ×.
    <div role="region" aria-label={t('files.bulk.label')} className={clsx('flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 sm:px-6', bottom ? 'shrink-0 border-t border-line bg-surface py-2' : 'py-1')} data-testid="bulk-bar">
      <span className="text-sm font-medium" aria-live="polite" data-testid="bulk-count">
        {t('files.bulk.count', { n: count })}
      </span>
      {/* why move and trash leave some out (or are off): the row menu offers them only where the person may write */}
      {readOnly > 0 && (
        <Badge tone="warn">
          <Lock size={11} aria-hidden /> {t('files.bulk.readOnlyIn', { n: readOnly })}
        </Badge>
      )}
      {/* writable folders that only an admin (or nobody) may move: a group's or a project's folder (QA TC-224) */}
      {fixed > 0 && (
        <Badge tone="warn">
          <Lock size={11} aria-hidden /> {t('files.bulk.fixedIn', { n: fixed })}
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
      className={clsx('touch-hit max-md:isolate flex items-center justify-center rounded p-1.5 max-sm:p-2.5', disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-hover')}
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
        // above the label's 44 px tap box (touch-hit's ::after), so a tap on the box itself lands on it
        className="h-4 w-4 accent-[var(--c-accent)] disabled:opacity-40 dark:[color-scheme:dark] max-md:relative max-md:z-10"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(ev) => onCheck((ev.nativeEvent as MouseEvent).shiftKey === true)}
        data-testid={testId}
      />
    </label>
  )
}

/** A row's name and badges; on a phone with `meta` (date · size) on a second line. On a computer the children as they
 * are (one line, the columns beside it). */
function TwoLines({ phone, meta, children }: { phone: boolean; meta: string; children: React.ReactNode }) {
  if (!phone) return <>{children}</>
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2 text-row">{children}</span>
      {meta && <span className="truncate text-meta text-muted" data-testid="file-row-meta">{meta}</span>}
    </span>
  )
}

function FileRow({ e, selected, open, checked, onCheck, pressSelect, selecting, draggable, onDragStart, onDragEnd, dragged, dropTarget, drop, onOpen, onChat, onAddToChat, chatTitle, onRename, onMove, onShare, onDelete, onHistory, project, membersOnly = false, onProject, onSuggest, onAccess, sharedThrough = null }: { e: FileEntry; selected: boolean; open: boolean; checked: boolean; onCheck: (shift: boolean) => void; pressSelect: boolean; selecting: boolean; draggable: boolean; onDragStart: (ev: React.DragEvent) => void; onDragEnd: () => void; dragged: boolean; dropTarget: DropHandlers | null; drop: DropOver | null; onOpen: () => void; onChat: () => void; onAddToChat: (() => void) | null; chatTitle: string | null; onRename: () => void; onMove: () => void; onShare: () => void; onDelete: () => void; onHistory: () => void; project: FolderProjectAction; membersOnly?: boolean; onProject: (a: NonNullable<FolderProjectAction>) => void; onSuggest: (() => void) | null; onAccess: (() => void) | null; sharedThrough?: string | null }) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const ref = useRef<HTMLTableRowElement>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const folder = e.type === 'folder'
  // a folder that is a project the person can see shows the project icon (and says so to screen readers)
  const Icon = project?.kind === 'open' ? FolderKanban : ICONS[iconKind(e.name, folder)]
  const dim = e.access === 'none'
  // what a dimmed row says: "Members only" on a team project's folder that opens its page, else that it is only passed
  // through
  const dimTitle = membersOnly ? t('projects.membersOnly') : t('files.navigationOnly')
  const writable = e.access === 'write'
  // rename, move and trash: off on a folder the server marks fixed, with the reason under them (QA TC-224: a member
  // pressed them on their group's folder only to read "only an admin can")
  const changeable = writable && !e.fixed
  const menuId = useId()
  // a right-click on the row (the menu key, Shift+F10): its ⋯ menu at the pointer; Shift keeps the browser's own
  const [menuRequest, setMenuRequest] = useState(0)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const openMenuAt = (at: { x: number; y: number }) => {
    setMenuAt(at)
    setMenuRequest((n) => n + 1)
  }
  // phones (`pressSelect`): a long press selects the row (or takes it out of the selection), and the click that ends it
  // does not open it; while something is selected (`selecting`) a tap does the same instead of opening. Phones also show
  // the row in two lines (the name; date · size) and offer "Select" in its ⋯
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
  // a download-only (quarantined) file: the AI cannot read it, so "Ask AI" and "add to chat" could only fail; they stay
  // in the menu, turned off, with the reason (like the file panel)
  const aiOff = !folder && !!e.downloadOnly
  // the ⋯ menu (rooms/MenuButton.tsx: arrow keys, Esc; a bottom sheet on phones, so it never runs under the tab bar). An
  // item gives the keyboard to ⋯ before it runs, so a dialog it opens hands it back there (the menu is gone by then)
  const run = (f: () => void) => () => {
    menuTrigger.current?.focus()
    f()
  }
  const icon = (I: typeof FileIcon) => <I size={14} className="shrink-0" aria-hidden />
  const fixedWhy = writable && e.fixed ? `${menuId}-fixed` : undefined
  const aiWhy = aiOff ? `${menuId}-ai-off` : undefined
  // the right-click menu's own items (components/FileMenu.tsx, as on a room's picture): 이미지 복사 for a picture, read
  // through the file's own address (a HEIC photo as the server's JPEG), and 링크 복사, the app's address of the file or
  // folder (only people who may open it can)
  const copyLink = useCopyFileLink()
  const copyFileLink = useCopyTeamFileLink()
  const picture = !folder && previewKind(e.name) === 'image' && canCopyImage() ? { src: serverPreview(e.name) ? api.url(API.preview, { query: { path: e.path } }) : fileUrl(e.path, 'inline'), thumb: false } : null
  const items: MenuItem[] = [
    ...(pressSelect && !selecting && !dim ? [{ label: t('files.selectRow'), icon: icon(SquareCheck), onSelect: () => onCheck(false), testId: 'file-select' }] : []),
    ...(!folder && previewKind(e.name) ? [{ label: t('common.preview'), icon: icon(Eye), onSelect: run(onOpen), testId: 'file-preview' }] : []),
    ...(picture ? [{ label: t('fileMenu.copyImage'), icon: icon(ImageIcon), onSelect: run(() => copyImageFrom(picture, t)), testId: 'file-copy-image' }] : []),
    // a file: its /f/<id> link (QA TC-3093); a folder keeps its Files address
    { label: t('rooms.menu.copyLink'), icon: icon(Link2), onSelect: run(() => void (folder ? copyLink(teamFileLink(e.path)) : copyFileLink(e.path))), testId: 'file-copy-link' },
    ...(!folder ? [{ label: t('common.download'), icon: icon(Download), onSelect: run(() => startDownload(fileUrl(e.path), e.name)), testId: 'file-download' }] : []),
    { label: t(chatItemKey(folder), { name: aiName(t) }), icon: folder ? icon(MessageSquarePlus) : <AiMark place="menu" />, onSelect: run(onChat), disabled: aiOff, describedBy: aiWhy, testId: 'chat-with-file' },
    ...(!folder && onAddToChat ? [{ label: chatTitle ? t('files.addToChatNamed', { title: chatTitle }) : t('files.addToCurrentChat'), icon: icon(Paperclip), onSelect: run(onAddToChat), disabled: aiOff, describedBy: aiWhy, testId: 'add-to-chat' }] : []),
    ...(project ? [{ label: t('files.openProject'), icon: icon(FolderKanban), onSelect: run(() => onProject(project)), testId: 'open-project' }] : []),
    ...(onAccess ? [{ label: t('folderAccess.menu'), icon: icon(UserPlus), onSelect: run(onAccess), testId: 'folder-access-menu' }] : []),
    // a file shared with chosen people (QA TC-3093): the dialog says who may change it
    ...(!folder ? [{ label: t('folderAccess.menu'), icon: icon(UserPlus), onSelect: run(() => openFileShare(e.path)), testId: 'file-share' }] : []),
    ...(!folder ? [{ label: t('files.history'), icon: icon(History), onSelect: run(onHistory), testId: 'file-history' }] : []),
    ...(onSuggest ? [{ label: t('suggest.button'), icon: icon(BookmarkPlus), onSelect: run(onSuggest), testId: 'suggest-skill-file' }] : []),
    ...(!folder ? [{ label: t('files.share'), icon: icon(Copy), onSelect: run(onShare), testId: 'share-file' }] : []),
    // rename, move and trash: off on a fixed folder, with the reason under the items (QA TC-224)
    { label: t('files.rename'), icon: icon(Pencil), onSelect: run(onRename), disabled: !changeable, describedBy: fixedWhy, testId: 'file-rename' },
    { label: t('files.move'), icon: icon(FolderInput), onSelect: run(onMove), disabled: !changeable, describedBy: fixedWhy, testId: 'file-move' },
    { label: t('files.moveToTrash'), icon: icon(Trash2), onSelect: run(onDelete), danger: true, disabled: !changeable, describedBy: fixedWhy, testId: 'file-trash' },
  ]
  const why = 'px-2 pt-1 pb-1.5 text-xs text-muted max-md:px-3'
  const footer = (aiWhy || fixedWhy) && (
    <>
      {aiWhy && <p id={aiWhy} className={why} data-testid="file-ai-off-reason">{t('files.askAiDownloadOnly', { name: aiName(t) })}</p>}
      {fixedWhy && <p id={fixedWhy} className={why} data-testid="file-fixed-reason">{t(e.fixed === 'admin' ? 'files.fixedAdmin' : 'files.fixedAlways')}</p>}
    </>
  )
  // phones: the second line of the row
  const meta = [formatDateTime(e.mtime, locale), folder ? null : formatSize(e.size, locale)].filter(Boolean).join(' · ')
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
          onContextMenu={(ev) => {
            if (press.current || pressed.current) return ev.preventDefault()
            if (dim || ev.shiftKey) return
            ev.preventDefault()
            const r = ev.currentTarget.getBoundingClientRect()
            openMenuAt(ev.button === 2 || ev.clientX || ev.clientY ? { x: ev.clientX, y: ev.clientY } : { x: r.left, y: r.bottom })
          }}
          onKeyDown={(ev) => {
            if (dim || !isMenuKey(ev)) return
            ev.preventDefault()
            const r = ev.currentTarget.getBoundingClientRect()
            openMenuAt({ x: r.left, y: r.bottom })
          }}
          // phones: a row of 48px or more to tap, and a long press selects the row, not its text
          className="flex w-full min-w-0 items-center gap-2.5 rounded py-1 text-left hover:underline max-md:min-h-12 max-md:gap-3 max-md:py-1.5 max-md:select-none max-md:hover:no-underline max-md:[-webkit-touch-callout:none]"
          title={dim ? dimTitle : undefined}
          aria-current={open ? 'true' : undefined}
          // dragged onto a folder row or a breadcrumb: moved there (with the selection when this row is selected); a
          // file the AI may read can also be dragged into a chat's message box (attached as a team file)
          draggable={draggable}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <Icon size={pressSelect ? 20 : 17} className={clsx('shrink-0', folder ? 'text-accent-text' : 'text-muted', dim && 'opacity-60')} aria-hidden />
          {project?.kind === 'open' && <span className="sr-only">({t('files.isProject', { name: project.project.name })})</span>}
          {/* phones: the name and its badges on line 1, date · size on line 2 */}
          <TwoLines phone={pressSelect} meta={meta}>
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
          {/* folder sharing: people of its own on it, or a shared folder above it (my own files only; a hidden name is
              never shown to the people on the folder, so it is not marked) */}
          {e.shared && !(e.shared === 'through' && e.name.startsWith('.')) && (
            <span className="shrink-0" data-testid="file-shared" data-shared={e.shared}>
              {e.shared === 'through' && sharedThrough ? (
                <Tooltip label={t('files.sharedThrough', { folder: sharedThrough })}>
                  <span tabIndex={0} className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-accent">
                    <Badge><Users size={11} aria-hidden /> <span aria-hidden>{t('files.sharedBadge')}</span><span className="sr-only">{t('files.sharedThrough', { folder: sharedThrough })}</span></Badge>
                  </span>
                </Tooltip>
              ) : (
                <Badge><Users size={11} aria-hidden /> {t('files.sharedBadge')}</Badge>
              )}
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
          </TwoLines>
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
      <td className="hidden px-2 py-1.5 text-xs whitespace-nowrap text-muted md:@xl:table-cell">{formatDateTime(e.mtime, locale)}</td>
      <td className="hidden px-2 py-1.5 text-right text-xs whitespace-nowrap text-muted md:table-cell">{folder ? '' : formatSize(e.size, locale)}</td>
      <td className="relative px-2 py-1.5 text-right max-md:py-0 max-md:pr-0 max-md:pl-1">
        {/* where a pointer can hover, ⋯ shows on the row's hover or focus; a touch screen (a phone, a tablet) always shows
            it (FILES-21: from 640 px a tablet never saw it). 44 px on phones */}
        {!dim && (
          <MenuButton
            label={t('files.actionsFor', { name: e.name })}
            items={items}
            footer={footer}
            muted
            buttonRef={menuTrigger}
            openRequest={menuRequest}
            at={menuAt}
            buttonClassName="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:size-11"
            sheetTitle={words.name(e.path, e.name)}
            testId="file-menu"
          />
        )}
      </td>
    </tr>
  )
}

function HistoryModal({ path, onClose, onRestored }: { path: string; onClose: () => void; onRestored: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const [items, setItems] = useState<FileVersion[] | null>(null)
  // every stored version is an earlier content of the file (the newest one is what it was before the last change),
  // so each can be restored by whoever may write the file; only one identical to the file as it is now is not offered
  const [current, setCurrent] = useState<{ sha256: string | null; canRestore: boolean }>({ sha256: null, canRestore: true })
  // why there is no 되돌리기: the file's folder is in the trash (it comes back first; QA TC-229)
  const [blocked, setBlocked] = useState<HistoryResponse['restoreBlocked']>(null)
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
        setBlocked(r.restoreBlocked ?? null)
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
    // the people whose later versions drop out of the latest content are named (QA TC-7246); nobody else: today's words
    const dropouts = restoreDropouts(items ?? [], now, v.version, me.user.id)
    const body = dropouts.length ? t('files.restoreBodyNames', { names: nameList(locale, dropouts) }) : t('files.restoreBody')
    if (!(await confirmDialog({ title: t('files.restoreTitle', { version: v.version }), body, confirm: t('common.restore') }))) return
    setBusy(v.id)
    try {
      await sendWidening((confirm) => api.call(API.restoreVersion, { body: { path, versionId: v.id, ...(confirm ? { confirm: true } : {}) } }), (n) => confirmDialog({ title: t('files.widenTitle'), body: t('files.restoreWidenBody', { n }), confirm: t('common.restore') }))
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
      {blocked === 'folderInTrash' && (
        <p className="mb-2 flex items-start gap-2 rounded-md bg-subtle px-3 py-2 text-sm text-muted" data-testid="history-folder-in-trash">
          <Trash2 size={14} className="mt-0.5 shrink-0" aria-hidden />
          {t('files.versionsFolderInTrash')}
        </p>
      )}
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
                  {now.chatId && <OpenSavingChat chatId={now.chatId} onOpen={onClose} />}
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
                  {v.savedBy && v.savedTurnId && v.savedChatId && <OpenSavingChat chatId={v.savedChatId} onOpen={onClose} />}
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

/** "Open the chat" after "saved during an AI answer": the AI chat that saved this version. The server names it only when
 * the person may open that chat now (server/src/chat/version-chats.ts); otherwise the line says no more than before. */
function OpenSavingChat({ chatId, onOpen }: { chatId: string; onOpen: () => void }) {
  const t = useT()
  return (
    <>
      {' · '}
      <Link to={`/c/${chatId}`} onClick={onOpen} className="whitespace-nowrap text-accent-text underline underline-offset-2" data-testid="history-open-chat">
        {t('files.openChat')}
      </Link>
    </>
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

/** The trash (docs/AGENTS/plan/20261113-1557-trash-ui-tc1040.md, QA TC-1040): each item by its name and the place it
 * was in, in the Files sidebar's words (lib/trashList.ts; never a storage path), who deleted it and when it goes for
 * good ("in 18 days", the date in its tooltip). The same original path deleted more than once is one row with its
 * copies: the row's Restore brings back the latest, and the row opens to each copy with its own Restore. One line on
 * top says how long items stay. Someone whose list has other people's deletes can show only their own ("Deleted by
 * me", GET /api/files/trash?mine=1). What is listed and who may restore it is the server's, unchanged. */
function TrashView({ projects }: { projects: readonly { name: string; folderPath: string }[] }) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const meNow = useMeStrict()
  const me = meNow.user.id
  const phone = useMediaQuery('(max-width: 767.98px)')
  const tabs = useId()
  const deleteProject = useDeleteProject()
  const [who, setWho] = useState<'all' | 'mine'>('all')
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the switch stays once the Everyone list has shown someone else's delete (it is also how one gets back to Everyone)
  const [others, setOthers] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  // a page asked for before a switch that is not shown when it comes
  const asked = useRef(0)
  const load = useCallback(async (more: boolean, whose: 'all' | 'mine') => {
    const n = ++asked.current
    try {
      const r = await api.call(API.trash, { query: { limit: 100, ...(whose === 'mine' ? { mine: '1' as const } : {}), cursor: more ? cursor ?? undefined : undefined } })
      if (n !== asked.current) return
      // a later page: its copies join the rows already there (lib/trashList.ts groupTrash over every loaded page)
      setItems((cur) => (more && cur ? mergePage(cur, r.items) : r.items))
      setCursor(r.nextCursor)
      setError(null)
      if (whose === 'all' && showWhoSwitch(r.items, me)) setOthers(true)
    } catch (e) {
      if (n === asked.current) setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, me])
  useEffect(() => {
    void load(false, who)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [who])
  const place: PlaceWords = useMemo(
    () => ({ words, me, projects, root: t('files.root'), myProjects: t('projectsPanel.mine'), personal: words.name('users', 'users') }),
    [words, me, projects, t],
  )
  // Restore: the copy leaves the trash at once (lib/optimistic.ts); a refusal puts it back in its place with the
  // server's words; "restored to …" (the place in words) comes with the answer
  const restore = async (it: TrashItem) => {
    const at = items?.findIndex((x) => x.id === it.id) ?? -1
    const r = await optimistic({
      key: `filetrash:${it.id}:restore`,
      from: false,
      to: true,
      show: (out: boolean) =>
        setItems((cur) => {
          if (!cur) return cur
          const rest = cur.filter((x) => x.id !== it.id)
          return out ? rest : [...rest.slice(0, Math.max(0, at)), it, ...rest.slice(Math.max(0, at))]
        }),
      send: () => sendWidening((confirm) => api.call(API.restoreTrash, { params: { id: it.id }, ...(confirm ? { query: { confirm: '1' as const } } : {}) }), (n) => confirmDialog({ title: t('files.widenTitle'), body: t('files.restoreWidenBody', { n }), confirm: t('common.restore') })),
    })
    if (r.ok && r.newest) toast({ level: 'success', text: t('files.restoredTo', { path: placeWords(parentPath(r.reply.entry.path), place) }) })
    // a project came back with its folder: the project lists read it again (its card, its members' too)
    if (r.ok && it.project) {
      void readProjectList().catch(() => {})
      void readManagedList({ fresh: true }).catch(() => {})
    }
  }
  // a team project in the trash, deleted for good from here (the owner and admins): the project's own delete, with its
  // confirm (pages/Projects.tsx useDeleteProject: its files, and where its shared chats go; QA TC-1061, TC-1063)
  const forGood = async (it: TrashItem) => {
    if (!it.project) return
    const d = await deleteProject({ id: it.project.id, name: it.project.name, folderPath: it.originalPath, instructions: '', createdBy: null, createdAt: it.deletedAt, canEdit: false, inTrash: true })
    if (d === 'gone') setItems((cur) => cur && cur.filter((x) => x.id !== it.id))
  }
  const groups = useMemo(() => groupTrash(items ?? []), [items])
  const days = useMemo(() => retentionDays(items ?? []), [items])
  const sameNamed = useMemo(() => sameNamedProjects(groups), [groups])
  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(key)) next.add(key)
      return next
    })
  // phones: the day only, so a copy's line fits beside Restore
  const deleted = (it: TrashItem) => t('files.deletedBy', { who: it.deletedBy?.name ?? t('files.byAi'), date: phone ? new Intl.DateTimeFormat(intlTag(locale), { month: 'short', day: 'numeric' }).format(new Date(it.deletedAt)) : formatShortDateTime(it.deletedAt, locale) })
  const goes = (it: TrashItem) => (
    <span title={t('files.purgeAt', { date: formatDateTime(it.purgeAt, locale) })} data-testid="trash-purge">
      {t('files.purgeIn', { when: purgeIn(it.purgeAt, locale) })}
    </span>
  )
  const restoreButton = (it: TrashItem, label: string | undefined, testId: string) => (
    <Button size="sm" onClick={() => void restore(it)} aria-label={label} data-testid={testId}>
      {!phone && <ArchiveRestore size={14} aria-hidden />} {t('common.restore')}
    </Button>
  )
  const list = (
    // a page's main list (ListRow scale="page", docs/DECISIONS.md "Page lists: page density"): 48px rows, the icons
    // flush with the line above, the fill reaching out past them
    <ul data-testid="trash-list">
      {groups.map((g) => {
        const latest = g.items[0]!
        const p = trashPlace(latest, place, sameNamed.has(g.key))
        const Icon = p.kind === 'project' ? FolderKanban : ICONS[iconKind(p.name, p.kind === 'folder')]
        const many = g.items.length > 1
        const opened = many && open.has(g.key)
        const meta = (
          <>
            <span data-testid="trash-where">{p.where}</span>
            {/* phones: the place first; who and when are on each copy, the date in the tooltip */}
            {!phone && <> · {deleted(latest)}</>} · {goes(latest)}
          </>
        )
        return (
          <Fragment key={g.key}>
            <ListRow
              scale="page"
              icon={<Icon />}
              name={p.name}
              nameTitle={p.name}
              nameTestId="trash-name"
              meta={meta}
              tag={many ? t('files.trashCopies', { n: g.items.length }) : undefined}
              tagTestId="trash-copies"
              strong
              onClick={many ? () => toggle(g.key) : undefined}
              expanded={many ? opened : undefined}
              testId={many ? 'trash-copies-toggle' : undefined}
              end={many ? <ChevronRight size={14} className={clsx('shrink-0 self-center text-faint transition-transform motion-reduce:transition-none', opened && 'rotate-90')} aria-hidden /> : undefined}
              // a project: its row opens its page (who moved it there, Restore, Delete for good), and on a computer the
              // owner and admins delete it for good here too
              to={p.kind === 'project' && latest.project && !many ? `/projects/${latest.project.id}` : undefined}
              actions={
                p.kind === 'project' && latest.project && isAdmin(meNow) && !phone ? (
                  <span className="flex items-center gap-1">
                    <Button size="sm" variant="ghost-danger" onClick={() => void forGood(latest)} data-testid="trash-project-delete">
                      {t('projects.deleteForGood')}
                    </Button>
                    {restoreButton(latest, undefined, 'trash-restore')}
                  </span>
                ) : restoreButton(latest, undefined, 'trash-restore')
              }
              li={{ 'data-testid': 'trash-item', 'data-path': latest.originalPath, ...(p.kind === 'project' ? { 'data-kind': 'project' } : {}) }}
            />
            {opened &&
              g.items.map((it) => (
                <ListRow
                  key={it.id}
                  scale="page"
                  icon={<History />}
                  name={deleted(it)}
                  meta={<>{formatSize(it.size, locale)} · {goes(it)}</>}
                  actions={restoreButton(it, t('files.trashRestoreCopy', { date: formatShortDateTime(it.deletedAt, locale) }), 'trash-copy-restore')}
                  li={{ className: 'pl-row-indent', 'data-testid': 'trash-copy', 'data-id': it.id }}
                />
              ))}
          </Fragment>
        )
      })}
    </ul>
  )
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6" data-testid="trash-view">
      {others && (
        <div className="mb-3 flex">
          <Tabs
            segmented
            label={t('files.trashWho')}
            panels={tabs}
            value={who}
            onChange={(v) => {
              setItems(null)
              setCursor(null)
              setOpen(new Set())
              setWho(v)
            }}
            items={[
              { id: 'all', label: t('files.trashEveryone') },
              { id: 'mine', label: t('files.trashMine') },
            ]}
          />
        </div>
      )}
      <TabPanel base={others ? tabs : null} value={who}>
        {days !== null && <p className="mb-2 text-meta text-faint" data-testid="trash-note">{t('files.trashNoteDays', { days })}</p>}
        {error && <ErrorNote onRetry={() => void load(false, who)}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={5} />}
        {items && !items.length && <EmptyState screen icon={<Trash2 size={28} />} title={t(who === 'mine' ? 'files.trashMineEmpty' : 'files.trashEmpty')} />}
        {list}
        {cursor && (
          <div className="py-3 text-center">
            <Button size="sm" onClick={() => void load(true, who)} data-testid="trash-more">
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </TabPanel>
    </div>
  )
}
