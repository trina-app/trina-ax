// Admin › Folder permissions › By folder: the team folder as a tree, read from the top. Each row is one folder with who
// can open it and where that comes from (GET /api/admin/access/tree, put into words by lib/access-view.ts); folders
// without rules of their own are dimmed as inherited. Choosing a folder shows its rules and every person's access and
// the reason (GET /api/admin/access/folder, the stage 2 answer, with the stage 3 reasons). "규칙 바꾸기" turns that part
// into the edit panel (AccessEdit.tsx, stage 5: the basic access first, the people and groups named, and what saving
// would change, from the server); on a phone the panel is the whole screen. "Rule folders only" shows just the folders
// with rules and the way to them. Rows of folders that are not in the tree (gone from disk, inside users/, a name the
// tree never shows) are folded under it to edit or clean up; an empty rule row that no project uses can go too. Nothing
// here decides access.
//
// The keyboard follows the WAI-ARIA tree pattern: one Tab stop (the row last focused, else the chosen one), Up and Down
// move, Right opens a folder or goes into it, Left closes it or goes to the folder above, Home and End, typing jumps to
// a name, Enter or Space chooses (choosing asks the server, so moving alone does not). "N more" and "Try again" are
// rows of the tree too. The chosen folder is in the address (`?folder=`); a folder there is looked up, page by page,
// and said when it is not there. By person opens a folder's panel here (`?edit=<path>&back=<its address>`): the folder
// is chosen and its panel opened, and closing or saving that panel goes back to the person. The Files page's "Who can
// see it" panel opens it the same way (`?edit=<path>&from=files`, the fixed word only): closing or saving goes back to
// that folder in Files with its panel open again (`/files?path=<path>&access=1`).
// A team project's folder in projects/ is one row with no folders under it: "멤버만" and its count, never "팀장과
// 관리자만", and no rules to change here: its panel links to the project's members ("멤버 관리", /projects/:id?members=1;
// docs/DECISIONS.md "Project contents only for members"). The server refuses changes there (409 project_members_only),
// which the edit panel shows in its words if one is opened by its address.
import clsx from 'clsx'
import { ArrowLeft, Briefcase, Cable, ChevronRight, Folder as FolderIcon, FolderSearch, FolderTree, Info, Loader2, Lock, Plus, RotateCw, SlidersHorizontal, Sparkles, Trash2, TriangleAlert, UserRound, UsersRound, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { AccessTreeNode, AccessTreeResponse, Folder, Group } from '@mycel/shared/api'
import { api, API, isApiError } from '../../lib/api'
import { ancestorsOf, isPersonalPath, isRestricted, kindText, manageMembersLink, membersOnlyFolder, membersOnlyText, nodeName, parentOf, riskTexts, skillEditorsText, skillManagersOf, skillsLockedText, sourceSaysSomething, sourceText, whoSeesText, type Names } from '../../lib/access-view'
import { useLocale, useT } from '../../i18n'
import { Badge, Button, ErrorNote, Skeleton, Switch } from '../../components/ui'
import FolderPicker from '../../components/FolderPicker'
import { accessErrorText } from './AccessResults'
import { People, useFolderAnswer } from './FolderPeople'
import { RemoveRulesButton, isSkillsFolder, useRemoveRules } from './Folders'
import AccessEdit from './AccessEdit'
import { useFolderPeople } from './SkillManagers'
import { useFocusAfterRemove, useLoad } from './common'
import { InFolderHeader } from './folder-slots'
import { Tooltip } from '../../components/Tooltip'

/** One level as loaded so far: its children's paths in the server's order. */
interface Level { children: string[]; total: number; nextCursor: string | null }
/** "Rule folders only": the rule folders loaded so far, in the tree's order. */
interface Ruled { paths: string[]; total: number; nextCursor: string | null }
interface TreeData { nodes: Map<string, AccessTreeNode>; levels: Map<string, Level>; people: number; members: number; ruled: Ruled | null }

/** rows asked for when a level opens; after a change, as many as were shown come again */
const PAGE = 200
const MAX_PAGE = 500
/** the busy / failed key of the "rule folders only" list (no folder path can be it) */
const RULED = '\u0000ruled'
/** `back` of a panel opened from the Files page (`?from=files`): never an address (no query can be it) */
const FROM_FILES = '\u0000files'
const within = (p: string, top: string) => top === '' || p === top || p.startsWith(top + '/')

/** The tree's data: levels by the folder they are in, nodes by path. Every answer also brings the folder asked for
 * itself (`self`), so a level asked for again renews its own row too. */
function useTreeData() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = useState<TreeData | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** levels being asked for (opening, more, again) and those that failed, with the words */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map())
  /** the last change whose folders did not come again (said with a way to try again) */
  const [stale, setStale] = useState<string | null>(null)
  // the data the next step of a lookup reads (a page-through loop runs between renders): every change goes through
  // apply(), which renews it at once
  const dataRef = useRef(data)
  const apply = (fn: (d: TreeData | null) => TreeData | null) => {
    const next = fn(dataRef.current)
    dataRef.current = next
    setData(next)
  }
  /** the same, at once (a page-through loop asks again before the next render) */
  const busyNow = useRef(new Set<string>())

  const ask = (path: string, q: { cursor?: string; limit?: number; open?: boolean; rules?: boolean } = {}) =>
    api.call(API.explainAccessTree, {
      query: { path, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), ...(q.limit ? { limit: q.limit } : {}), ...(q.open ? { open: '1' as const } : {}), ...(q.rules ? { rules: '1' as const } : {}) },
    })
  /** nodes of an answer (the folder asked for, its children, the folders above a rule-folder page) */
  const putNodes = (nodes: Map<string, AccessTreeNode>, r: AccessTreeResponse) => {
    nodes.set(r.self.path, r.self)
    for (const l of r.levels) for (const c of l.children) nodes.set(c.path, c)
    for (const a of r.above ?? []) nodes.set(a.path, a)
  }
  const merge = (answers: AccessTreeResponse[], append?: string) =>
    apply((d) => {
      const nodes = new Map(d?.nodes)
      const levels = new Map(d?.levels)
      let counts = d ? { people: d.people, members: d.members } : { people: 0, members: 0 }
      for (const r of answers) {
        putNodes(nodes, r)
        counts = { people: r.people, members: r.members }
        for (const l of r.levels) {
          const before = levels.get(l.path)
          const paths = l.children.map((c) => c.path)
          const children = append === l.path && before ? [...before.children, ...paths.filter((p) => !before.children.includes(p))] : paths
          levels.set(l.path, { children, total: l.total, nextCursor: l.nextCursor })
        }
      }
      return { nodes, levels, ...counts, ruled: d?.ruled ?? null }
    })
  const mark = (path: string, on: boolean, err?: string) => {
    if (on) busyNow.current.add(path)
    else busyNow.current.delete(path)
    setBusy((b) => {
      const n = new Set(b)
      if (on) n.add(path)
      else n.delete(path)
      return n
    })
    setFailed((f) => {
      const n = new Map(f)
      if (err) n.set(path, err)
      else n.delete(path)
      return n
    })
  }
  const failText = (e: unknown) => accessErrorText(e, locale, t)

  /** the root with the way down to rule, group, project and connected folders opened: the paths opened */
  const loadRoot = useCallback(async (): Promise<string[] | null> => {
    setError(null)
    try {
      const r = await ask('', { open: true })
      apply(() => null)
      merge([r])
      return r.levels.map((l) => l.path)
    } catch (e) {
      setError(failText(e))
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])

  /** the first page of a folder's level (nothing when it is there already) */
  /** One request per level at a time: a second caller (a lookup while "N more" is on its way, or the other way round)
   * waits for the one in flight and shares its answer, instead of finding the level busy. */
  const inflight = useRef(new Map<string, Promise<unknown>>())
  const shared = <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    const known = inflight.current.get(key)
    if (known) return known as Promise<T>
    const p = run().finally(() => inflight.current.delete(key))
    inflight.current.set(key, p)
    return p
  }

  const openLevel = (path: string): Promise<boolean> =>
    dataRef.current?.levels.has(path)
      ? Promise.resolve(true)
      : shared(`open\u0000${path}`, async () => {
          if (dataRef.current?.levels.has(path)) return true
          mark(path, true)
          try {
            merge([await ask(path, { limit: PAGE })])
            mark(path, false)
            return true
          } catch (e) {
            mark(path, false, failText(e))
            return false
          }
        })

  /** the next page of a level: the paths it brought ([] when there is none; null: it could not be asked for) */
  const nextPage = (path: string, limit: number): Promise<string[] | null> =>
    shared(`page\u0000${path}`, async () => {
      const l = dataRef.current?.levels.get(path)
      if (!l?.nextCursor) return []
      mark(path, true)
      try {
        const r = await ask(path, { cursor: l.nextCursor, limit })
        merge([r], path)
        mark(path, false)
        return r.levels[0]!.children.map((c) => c.path)
      } catch (e) {
        mark(path, false, failText(e))
        return null
      }
    })
  const more = async (path: string): Promise<string[]> => (await nextPage(path, PAGE)) ?? []

  /** Open `parent` and page through it until `child` is there (a folder past the first page, one just made):
   * found, absent (every page came and it is not there), failed (a page could not be asked for) or stopped (`alive`
   * said a later lookup replaced this one: it asks for nothing more). */
  const loadUntil = async (parent: string, child: string, alive: () => boolean): Promise<'found' | 'absent' | 'failed' | 'stopped'> => {
    if (!(await openLevel(parent))) return 'failed'
    for (;;) {
      if (!alive()) return 'stopped'
      const l = dataRef.current?.levels.get(parent)
      if (!l) return 'failed'
      if (l.children.includes(child)) return 'found'
      if (!l.nextCursor) return 'absent'
      const cursor = l.nextCursor
      if ((await nextPage(parent, MAX_PAGE)) === null) return 'failed'
      // a page that moved nothing on (it should not happen): stop rather than ask again and again
      if (dataRef.current?.levels.get(parent)?.nextCursor === cursor) return 'failed'
    }
  }

  /** The folder at `path` as the server finds it (its names on disk, whether it is there); its own row is kept.
   * `refused`: no team folder path (the server said so); `error`: it could not be asked. */
  const resolve = async (path: string): Promise<{ r: AccessTreeResponse } | { refused: true } | { error: string }> => {
    try {
      const r = await ask(path, { limit: 1 })
      apply((d) => {
        if (!d) return d
        const nodes = new Map(d.nodes)
        if (r.exists) nodes.set(r.self.path, r.self)
        return { ...d, nodes }
      })
      return { r }
    } catch (e) {
      return isApiError(e, 'validation') || isApiError(e, 'not_found') ? { refused: true } : { error: failText(e) }
    }
  }

  /** "Rule folders only": the first page, or the next */
  const ruledPage = async (next: boolean): Promise<string[]> => {
    const before = dataRef.current?.ruled
    if (next && !before?.nextCursor) return []
    if (busyNow.current.has(RULED)) return []
    mark(RULED, true)
    try {
      const r = await ask('', { rules: true, limit: PAGE, ...(next ? { cursor: before!.nextCursor! } : {}) })
      const paths = r.levels[0]!.children.map((c) => c.path)
      apply((d) => {
        if (!d) return d
        const nodes = new Map(d.nodes)
        putNodes(nodes, r)
        const kept = next && d.ruled ? d.ruled.paths : []
        return { ...d, nodes, ruled: { paths: [...kept, ...paths.filter((p) => !kept.includes(p))], total: r.levels[0]!.total, nextCursor: r.levels[0]!.nextCursor } }
      })
      mark(RULED, false)
      return paths
    } catch (e) {
      mark(RULED, false, failText(e))
      return []
    }
  }

  /** After rules changed at `changed`: its own row (in the level above, or the root) and every level shown at or below
   * it come again, as many rows as were shown (access below a folder follows its rules); the rule folders list too. */
  const refresh = async (changed: string) => {
    const d = dataRef.current
    if (!d) return
    const above = parentOf(changed)
    const targets = [...d.levels.keys()].filter((p) => p === above || within(p, changed))
    const pages = async (want: number, get: (cursor?: string, limit?: number) => Promise<AccessTreeResponse>) => {
      const out: AccessTreeResponse[] = []
      let cursor: string | undefined
      let got = 0
      do {
        const r = await get(cursor, Math.min(MAX_PAGE, Math.max(PAGE, want - got)))
        out.push(r)
        got += r.levels[0]!.children.length
        cursor = r.levels[0]!.nextCursor ?? undefined
      } while (cursor && got < want)
      return out
    }
    const results = await Promise.allSettled(targets.map((path) => pages(d.levels.get(path)?.children.length ?? 0, (cursor, limit) => ask(path, { cursor, limit }))))
    const ruled = d.ruled ? await pages(d.ruled.paths.length, (cursor, limit) => ask('', { rules: true, cursor, limit })).then((x) => x, () => null) : undefined
    setStale(results.some((r) => r.status === 'rejected') || ruled === null ? changed : null)
    // each level that came again: its pages in order replace what it showed (a level that failed stays as it was)
    apply((x) => {
      if (!x) return x
      const nodes = new Map(x.nodes)
      const levels = new Map(x.levels)
      let counts = { people: x.people, members: x.members }
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value.length) continue
        const children: string[] = []
        for (const pg of r.value) {
          putNodes(nodes, pg)
          counts = { people: pg.people, members: pg.members }
          for (const c of pg.levels[0]!.children) if (!children.includes(c.path)) children.push(c.path)
        }
        const last = r.value[r.value.length - 1]!.levels[0]!
        levels.set(last.path, { children, total: last.total, nextCursor: last.nextCursor })
      }
      let ruledNext = x.ruled
      if (ruled) {
        const paths: string[] = []
        for (const pg of ruled) {
          putNodes(nodes, pg)
          for (const c of pg.levels[0]!.children) if (!paths.includes(c.path)) paths.push(c.path)
        }
        const last = ruled[ruled.length - 1]!.levels[0]!
        ruledNext = { paths, total: last.total, nextCursor: last.nextCursor }
      }
      return { nodes, levels, ...counts, ruled: ruledNext }
    })
  }

  return { data, error, busy, failed, stale, loadRoot, openLevel, more, loadUntil, resolve, ruledPage, refresh, mark }
}

/** The rows on the screen, in order: a folder, "N more" after a level's last loaded child, "try again" for a level
 * that failed to open. */
type Row =
  | { kind: 'node'; key: string; path: string; level: number; pos?: number; size?: number; shows?: boolean }
  | { kind: 'more'; key: string; parent: string; level: number; left: number }
  | { kind: 'failed'; key: string; parent: string; level: number }

function flatten(data: TreeData, open: ReadonlySet<string>, failed: ReadonlyMap<string, string>): Row[] {
  const out: Row[] = []
  const visit = (path: string, level: number, pos: number, size: number) => {
    out.push({ kind: 'node', key: `n:${path}`, path, level, pos, size })
    if (!open.has(path)) return
    const l = data.levels.get(path)
    if (!l) {
      if (failed.has(path)) out.push({ kind: 'failed', key: `f:${path}`, parent: path, level: level + 1 })
      return
    }
    // the set's size is how many folders the level has (the server's total), not how many are loaded
    l.children.forEach((c, i) => data.nodes.has(c) && visit(c, level + 1, i + 1, l.total))
    if (l.nextCursor) out.push({ kind: 'more', key: `m:${path}`, parent: path, level: level + 1, left: Math.max(0, l.total - l.children.length) })
  }
  if (data.nodes.has('')) visit('', 1, 1, 1)
  return out
}

/** "Rule folders only": the root, then each rule folder after the folders on the way to it that have not shown yet,
 * everything open; "N more" for the next page. */
function flattenRuled(data: TreeData, failed: ReadonlyMap<string, string>): Row[] {
  const out: Row[] = []
  if (!data.nodes.has('')) return out
  out.push({ kind: 'node', key: 'n:', path: '', level: 1, pos: 1, size: 1 })
  const ruled = data.ruled
  if (!ruled) {
    if (failed.has(RULED)) out.push({ kind: 'failed', key: `f:${RULED}`, parent: RULED, level: 2 })
    return out
  }
  const shown = new Set([''])
  for (const p of ruled.paths) {
    for (const a of [...ancestorsOf(p).slice(1), p]) {
      if (shown.has(a) || !data.nodes.has(a)) continue
      shown.add(a)
      out.push({ kind: 'node', key: `n:${a}`, path: a, level: a.split('/').length + 1 })
    }
  }
  if (ruled.nextCursor) out.push({ kind: 'more', key: `m:${RULED}`, parent: RULED, level: 2, left: Math.max(0, ruled.total - ruled.paths.length) })
  // a row with rows inside it below shows them (all open here)
  for (let i = 0; i < out.length; i++) {
    const r = out[i]!
    if (r.kind === 'node') r.shows = !!out[i + 1] && out[i + 1]!.level > r.level && out[i + 1]!.kind === 'node'
  }
  return out
}

const KIND_ICON = (n: AccessTreeNode): LucideIcon =>
  n.path === '' ? FolderTree : n.kinds.includes('personal') ? UserRound : n.kinds.includes('group') ? UsersRound : n.kinds.includes('project') ? Briefcase : n.kinds.includes('connected') ? Cable : isSkillsFolder(n.path) ? Sparkles : FolderIcon

export default function AccessTree() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const tree = useTreeData()
  const folders = useLoad(async () => (await api.call(API.listFolders)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** the folder in the address being looked up, or not found */
  const [lookup, setLookup] = useState<{ path: string; state: 'busy' | 'missing' | 'failed'; error?: string } | null>(null)
  /** below the width where the tree and the folder sit side by side: the folder replaces the tree until Back */
  const [showDetail, setShowDetail] = useState(false)
  const [ruledOnly, setRuledOnly] = useState(false)
  /** the folder whose rules are being changed (the edit panel replaces its part of the screen); `back`: opened from By
   * person, whose address closing it goes back to */
  const [editing, setEditing] = useState<{ path: string; back?: string } | null>(null)
  const [picking, setPicking] = useState(false)
  /** By person asked for a folder that the tree could not find (or ask for): its card offers the way back there */
  const [stranded, setStranded] = useState<{ path: string; back: string } | null>(null)
  /** the panel's: resolves true when it may close (nothing changed, or the admin dropped the changes) */
  const editGuard = useRef<() => Promise<boolean>>(async () => true)
  /** the folder picked with "Add folder" (or named by By person): its rules open once the tree has found and chosen it */
  const pendingEdit = useRef<string | null>(null)
  /** By person's address, for the panel pendingEdit opens */
  const pendingBack = useRef<string | undefined>(undefined)
  /** where the focus goes back when the panel closes (its opener, else the folder's rules button) */
  const editReturn = useRef<HTMLElement | null>(null)
  const focusAfterEdit = useRef(false)
  /** the folder of the panel open now (a save that ends after another panel opened leaves that one alone) */
  const editingPath = useRef<string | null>(null)
  editingPath.current = editing?.path ?? null
  /** asks the chosen folder's people again after a change */
  const [detailKey, setDetailKey] = useState(0)
  const treeBox = useRef<HTMLDivElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const cardHeading = useRef<HTMLHeadingElement>(null)
  /** "Try again" on a lookup that failed: where the focus goes once it is answered */
  const retrying = useRef(false)
  /** a lookup that a later choice or lookup replaced stops there */
  const lookupGen = useRef(0)
  const rootName = t('accessView.rootFolder')
  const removal = useRemoveRules(rootName)
  const wanted = params.get('folder')

  // the first answer opens the way down to rule, group, project and connected folders
  useEffect(() => {
    void tree.loadRoot().then((opened) => {
      if (!opened) return
      setOpen(new Set(['', ...opened]))
      setReady(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** the address names the chosen folder (replaced, not pushed: moving through the tree is no history of pages) */
  const address = (path: string | null) => {
    const q = new URLSearchParams(window.location.search)
    if (path === null) q.delete('folder')
    else q.set('folder', path)
    setParams(q, { replace: true })
  }
  const choose = (path: string) => {
    // a folder picked with "Add folder" whose rules were to open once found: another one chosen meanwhile drops it
    if (pendingEdit.current !== path) pendingEdit.current = null
    lookupGen.current++
    setLookup(null)
    setSelected(path)
    setShowDetail(true)
    address(path)
  }
  /** Open the edit panel for a folder (its row, if any, comes from the list of rule rows). */
  const startEdit = (path: string, back?: string) => {
    editReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEditing({ path, back })
  }
  /** back to By person after its panel (pushed: Back returns to the folder here); the focus goes to that folder's row;
   * or, opened from the Files page (FROM_FILES), back to that folder there with its "Who can see it" panel */
  const toPerson = (back: string, path: string) =>
    back === FROM_FILES ? navigate(`/files?path=${encodeURIComponent(path)}&access=1`) : setParams(new URLSearchParams(back), { state: { refocus: path } })
  /** the words of the way back: to By person, or to Files */
  const backLabel = (back: string) => t(back === FROM_FILES ? 'accessEdit.backToFiles' : 'accessEdit.backToPeople')
  /** Leave the edit panel, asking first when something was changed there: false when the admin stays. */
  const leaveEdit = async () => {
    if (!editing) return true
    if (!(await editGuard.current())) return false
    setEditing(null)
    focusAfterEdit.current = false
    return true
  }
  /** a folder chosen in the tree while the panel is open: the panel goes first (the same folder: it stays) */
  const chooseFromTree = async (path: string) => {
    if (editing?.path === path) return
    if (!(await leaveEdit())) return
    choose(path)
  }
  /** back to the tree with nothing chosen */
  const clear = () => {
    lookupGen.current++
    setLookup(null)
    setSelected(null)
    setShowDetail(false)
  }

  /** Look the folder up and open the way to it, page by page, then choose it; said when it is not there. */
  const reveal = async (want: string) => {
    const gen = ++lookupGen.current
    setSelected(want)
    setShowDetail(true)
    // users/: its one row (nothing in it is shown)
    if (isPersonalPath(want)) {
      setLookup(null)
      setSelected('users')
      return
    }
    setLookup({ path: want, state: 'busy' })
    const res = await tree.resolve(want)
    if (gen !== lookupGen.current) return
    // the server could not be asked: said, with a way to try again (not "not found")
    if ('error' in res) {
      setLookup({ path: want, state: 'failed', error: res.error })
      return
    }
    const path = 'r' in res && res.r.exists ? res.r.path : null
    let step: 'found' | 'absent' | 'failed' | 'stopped' = path === null ? 'absent' : 'found'
    if (path !== null) {
      const chain = [...ancestorsOf(path), path]
      // a later choice or lookup stops this one: it asks for no more pages (and holds no level)
      const alive = () => gen === lookupGen.current
      for (let i = 0; step === 'found' && i < chain.length - 1; i++) step = await tree.loadUntil(chain[i]!, chain[i + 1]!, alive)
      if (!alive()) return
    }
    if (step !== 'found' || path === null) {
      setLookup({ path: want, state: step === 'failed' ? 'failed' : 'missing' })
      return
    }
    setOpen((o) => new Set([...o, ...ancestorsOf(path)]))
    choose(path)
    scrollTo.current = path
  }

  // the address decides what is chosen: a folder there is looked up; none (the tab, the menu link, Back) is the tree
  useEffect(() => {
    if (!ready) return
    if (wanted === null) {
      if (selected !== null || lookup) clear()
      return
    }
    if (wanted === selected && !lookup) return
    void reveal(wanted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, ready])

  const scrollTo = useRef<string | null>(null)
  useLayoutEffect(() => {
    const path = scrollTo.current
    if (path === null) return
    const row = [...(treeBox.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find((r) => r.dataset.path === path)
    if (!row) return
    scrollTo.current = null
    row.scrollIntoView({ block: 'nearest' })
  })

  const ruleRows = folders.data
  const rowOf = (p: string) => ruleRows?.find((f) => f.path === p)
  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name
  const subject = (type: string, id: string | null) => {
    if (type === 'everyone') return t('rules.everyone')
    if (type === 'role') return t('rules.roleOf', { role: t(id === 'admin' ? 'role.admin' : 'role.member') })
    if (type === 'group') return t('rules.groupOf', { name: (id && groupName(id)) ?? '?' })
    return users.data?.find((u) => u.id === id)?.name ?? id ?? '?'
  }
  const ruleFolders = useMemo(() => (folders.data ? new Set(folders.data.filter((f) => f.rules.length).map((f) => f.path)) : undefined), [folders.data])
  const names: Names = { group: groupName, person: (id) => users.data?.find((u) => u.id === id)?.name, ruleFolders }

  /** after rules changed at `path`: the rule rows, the tree around it, the chosen folder's people */
  const changed = async (path: string) => {
    await Promise.all([folders.reload(), tree.refresh(path)])
    setDetailKey((n) => n + 1)
  }

  // rows of folders that are not in the tree: gone from disk, inside users/ (rules there never apply), or a name the
  // tree never shows (Folder.hidden)
  const outside = (ruleRows ?? []).filter((f) => f.path !== '' && (!f.exists || f.hidden || isPersonalPath(f.path))).sort((a, b) => a.path.localeCompare(b.path))
  const node = selected !== null ? tree.data?.nodes.get(selected) : undefined
  // narrow: the chosen folder, or the edit panel, takes the place of the tree
  const treeHidden = (showDetail && selected !== null) || editing !== null

  /** back from the folder to its row (narrow); from a folder that is not there, to the tree with nothing chosen. The
   * row takes the focus once the tree shows again (below). */
  const toRow = useRef(false)
  const back = () => {
    toRow.current = true
    if (!node || lookup) {
      address(null)
      clear()
    } else setShowDetail(false)
  }
  useLayoutEffect(() => {
    if (!toRow.current || treeHidden) return
    const row = treeBox.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
    if (!row) return
    toRow.current = false
    row.focus()
    row.scrollIntoView({ block: 'nearest' })
  })
  const backButton = (
    <button type="button" onClick={back} className="-mx-2 mb-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-label font-medium text-muted transition hover:bg-hover hover:text-ink max-sm:min-h-10 @2xl:hidden" data-testid="folder-detail-back">
      <ArrowLeft size={15} aria-hidden /> {t('accessTree.back')}
    </button>
  )

  // the folder By person asked for is not there (or could not be asked for): back to the person, from its card
  const strandedHere = stranded && lookup && lookup.state !== 'busy' && lookup.path === stranded.path ? stranded : null
  const toPeopleButton = strandedHere && (
    <Button size="sm" variant="ghost" className="-ml-2.5 mt-2 flex" onClick={() => toPerson(strandedHere.back, strandedHere.path)} data-testid="folder-detail-to-people">
      <ArrowLeft size={14} aria-hidden /> {backLabel(strandedHere.back)}
    </Button>
  )

  let detail: ReactNode
  if (selected === null) detail = <p className="py-6 text-sm text-faint @max-2xl:hidden">{t('accessTree.pick')}</p>
  else if (node && !lookup) {
    detail = (
      <FolderDetail
        key={node.path}
        node={node}
        members={tree.data?.members ?? 0}
        row={rowOf(node.path)}
        rowsReady={!!folders.data && !!users.data && !!groups.data}
        names={names}
        subject={subject}
        reloadKey={detailKey}
        headingRef={detailHeading}
        removal={removal}
        back={backButton}
        onEdit={() => startEdit(node.path)}
        onRemoved={async () => {
          await changed(node.path)
          // the delete button went with the empty row: the focus goes to the rules button, not to the page
          requestAnimationFrame(() => {
            const a = document.activeElement
            if (!a || a === document.body || !a.isConnected) document.querySelector<HTMLElement>('[data-testid="folder-detail-edit"]')?.focus()
          })
        }}
      />
    )
  } else if (lookup?.state === 'busy') {
    detail = (
      <div aria-busy data-testid="folder-detail-looking">
        {backButton}
        <Skeleton lines={5} />
      </div>
    )
  } else if (lookup?.state === 'failed') {
    const again = lookup.path
    detail = (
      <div data-testid="folder-detail-failed">
        {backButton}
        <ErrorNote
          onRetry={() => {
            // the card goes while it is asked again: the focus waits on the card's title, then goes to "Try again"
            // if it fails again (below)
            retrying.current = true
            cardHeading.current?.focus()
            void reveal(again)
          }}
        >
          {lookup.error ?? t('accessTree.failed')}
        </ErrorNote>
        {toPeopleButton}
      </div>
    )
  } else {
    // the address names a folder that is not there (moved, deleted, a typo): said, with the way back
    detail = (
      <section aria-labelledby="folder-detail-missing-title" data-testid="folder-detail-missing">
        {backButton}
        <div className="flex items-start gap-2.5 py-2">
          <FolderSearch size={18} className="mt-0.5 shrink-0 text-faint" aria-hidden />
          <div className="min-w-0">
            <h3 id="folder-detail-missing-title" ref={detailHeading} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
              {t('accessTree.notFound')}
            </h3>
            <p className="mt-1 text-xs [overflow-wrap:anywhere] text-muted">{t('accessTree.notFoundHint', { path: lookup?.path ?? selected })}</p>
            <Button size="sm" variant="ghost" className="-ml-2.5 mt-2 @max-2xl:hidden" onClick={back} data-testid="folder-detail-missing-close">
              {t('accessTree.back')}
            </Button>
            {toPeopleButton}
          </div>
        </div>
      </section>
    )
  }

  // the panel for the folder being changed takes the place of the folder's part (which stays, hidden, with what it
  // has loaded: it shows again at once, and a refresh that fails after a save keeps what was there)
  let panel: ReactNode = null
  if (editing) {
    const { path, back } = editing
    panel = (
      <AccessEdit
        key={path}
        path={path}
        folder={rowOf(path) ?? null}
        users={users.data ?? []}
        groups={groups.data ?? []}
        guard={editGuard}
        returnLabel={back !== undefined ? backLabel(back) : undefined}
        onClose={() => {
          if (editingPath.current !== path) return
          if (back !== undefined) return toPerson(back, path)
          setEditing(null)
          focusAfterEdit.current = true
        }}
        onSaved={async (saved) => {
          // the row as saved at once (opening the panel again before the list comes starts from it), then the tree row,
          // the folder's rules and every person's access there come again
          folders.setData((d) => (d ? (d.some((f) => f.id === saved.id) ? d.map((f) => (f.id === saved.id ? saved : f)) : [...d, saved]) : d))
          if (editingPath.current === path && back !== undefined) return toPerson(back, path)
          if (editingPath.current === path) {
            setEditing(null)
            focusAfterEdit.current = true
          }
          await changed(path)
        }}
        onStale={() => {
          void folders.reload()
          void tree.refresh(path)
          setDetailKey((n) => n + 1)
        }}
      />
    )
  }
  // the panel closed: the focus goes back where it came from (its opener, else the folder's rules button)
  useLayoutEffect(() => {
    if (!focusAfterEdit.current || editing) return
    focusAfterEdit.current = false
    const back = editReturn.current
    editReturn.current = null
    if (back?.isConnected && back.offsetParent !== null) back.focus()
    else document.querySelector<HTMLElement>('[data-testid="folder-detail-edit"]')?.focus()
  })
  // the address moved on while the panel was open (Back, a link): the panel goes with the folder it was for (the
  // browser gives no way to ask first; the panel's own ways out and the tree do ask)
  const lastWanted = useRef(wanted)
  useEffect(() => {
    if (lastWanted.current === wanted) return
    lastWanted.current = wanted
    if (editing) setEditing(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted])
  // "Add folder": once the folder is found and chosen in the tree, its rules open (a folder that is not there says so)
  useEffect(() => {
    const p = pendingEdit.current
    if (p === null) return
    if (lookup && lookup.state !== 'busy') {
      if (pendingBack.current !== undefined) setStranded({ path: p, back: pendingBack.current })
      pendingEdit.current = null
      pendingBack.current = undefined
    }
    if (selected !== p || lookup || !node) return
    pendingEdit.current = null
    startEdit(p, pendingBack.current)
    pendingBack.current = undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, lookup, node])
  // By person asks for a folder's panel (`?edit=<path>&back=<its address>`): once the tree and the lists are in, the
  // folder is chosen (looked up as any address is) and its panel opens; a rule row outside the tree opens at once. The
  // two leave the address (a reload does not open the panel again).
  const editWanted = params.get('edit')
  const lists = !!folders.data && !!users.data && !!groups.data
  useEffect(() => {
    if (!ready || editWanted === null || !lists) return
    const back = params.get('from') === 'files' ? FROM_FILES : new URLSearchParams(params.get('back') ?? '').get('view') === 'people' ? params.get('back')! : undefined
    const q = new URLSearchParams(window.location.search)
    q.delete('edit')
    q.delete('back')
    q.delete('from')
    const row = rowOf(editWanted)
    if (row && (!row.exists || row.hidden)) {
      setParams(q, { replace: true })
      startEdit(editWanted, back)
      return
    }
    pendingEdit.current = editWanted
    pendingBack.current = back
    q.set('folder', editWanted)
    setParams(q, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, editWanted, lists])

  // a folder chosen while the tree is hidden (narrow): the folder's heading takes the focus, not the page
  useLayoutEffect(() => {
    if (!treeHidden) return
    if (treeBox.current && treeBox.current.offsetParent === null) detailHeading.current?.focus()
  }, [treeHidden, selected, lookup?.state])
  // after "Try again" on a lookup: failed again, its "Try again" takes the focus back; found, the focus stays put
  useLayoutEffect(() => {
    if (!retrying.current || lookup?.state === 'busy') return
    retrying.current = false
    if (lookup?.state === 'failed') document.querySelector<HTMLElement>('[data-testid="folder-detail-failed"] [role="alert"] button')?.focus()
  }, [lookup?.state])

  let body: ReactNode
  if (tree.error) body = <ErrorNote onRetry={() => void tree.loadRoot().then((o) => { if (o) { setOpen(new Set(['', ...o])); setReady(true) } })}>{tree.error}</ErrorNote>
  else if (!tree.data) body = <Skeleton lines={8} />
  else {
    body = (
      <div className="@container">
        <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-start @2xl:gap-0">
          <div ref={treeBox} className={clsx('min-w-0 flex-1 @2xl:pr-4', treeHidden && '@max-2xl:hidden')}>
            {/* the switch sits in the page header's filter row, next to By folder / By person */}
            <InFolderHeader slot="filter">
              <span className="inline-flex h-9 items-center rounded-lg border border-line px-3 max-sm:min-h-10">
                <Switch
                  checked={ruledOnly}
                  onChange={(on) => {
                    setRuledOnly(on)
                    if (on && !tree.data?.ruled) void tree.ruledPage(false)
                    // back to the whole tree: the chosen folder is opened to again
                    if (!on && selected !== null && selected !== '' && node) void reveal(selected)
                  }}
                  label={t('accessTree.ruledOnly')}
                  testId="tree-ruled-only"
                />
              </span>
            </InFolderHeader>
            {/* how to read the tree: one small fold instead of a paragraph */}
            <details className="group mb-2 px-1.5 text-xs text-muted" data-testid="tree-how">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded py-1 text-faint hover:text-ink [&::-webkit-details-marker]:hidden">
                <Info size={13} aria-hidden /> {t('accessTree.how')}
              </summary>
              <p className="mt-1 max-w-prose leading-5">{t('accessTree.desc')}</p>
            </details>
            {tree.stale !== null && (
              <p role="status" className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-danger" data-testid="tree-stale">
                {t('accessTree.refreshFailed')}
                <button type="button" className="font-medium underline underline-offset-2" onClick={() => void tree.refresh(tree.stale!)}>
                  {t('common.retry')}
                </button>
              </p>
            )}
            <Tree
              data={tree.data}
              ruled={ruledOnly}
              open={open}
              busy={tree.busy}
              failed={tree.failed}
              selected={selected}
              onToggle={async (path, to) => {
                if (!to) {
                  setOpen((o) => new Set([...o].filter((p) => p !== path)))
                  return
                }
                setOpen((o) => new Set([...o, path]))
                await tree.openLevel(path)
              }}
              onMore={(parent) => (parent === RULED ? tree.ruledPage(true) : tree.more(parent))}
              onRetry={(parent) => {
                if (parent === RULED) void tree.ruledPage(false)
                else void tree.openLevel(parent)
              }}
              onChoose={(path) => void chooseFromTree(path)}
            />
            {ruledOnly && tree.data.ruled?.paths.length === 0 && <p className="px-1.5 py-3 text-sm text-faint">{t('accessTree.ruledEmpty')}</p>}
            <OutsideRules
              rows={outside}
              folders={folders.data}
              subject={subject}
              groups={groups.data ?? []}
              editable={!!users.data && !!groups.data}
              onEdit={(f) => void leaveEdit().then((ok) => ok && startEdit(f.path))}
              removal={removal}
              onRemoved={() => folders.reload()}
            />
          </div>
          <div
            className={clsx(
              // just under the page's sticky header (Folders.tsx passes its height)
              'min-w-0 @2xl:sticky @2xl:top-[calc(var(--folders-head,0px)+1rem)] @2xl:max-h-[calc(100dvh-var(--folders-head,0px)-2rem)] @2xl:shrink-0 @2xl:overflow-y-auto @2xl:border-l @2xl:border-line @2xl:pl-5 scroll-thin',
              // the edit panel takes a little more room beside the tree
              editing ? '@2xl:w-[22rem] @3xl:w-[26rem] @5xl:w-[30rem]' : '@2xl:w-80 @3xl:w-96',
              !treeHidden && '@max-2xl:hidden',
            )}
            data-testid="folder-detail-box"
          >
            <div hidden={editing !== null}>{detail}</div>
            {panel}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* no card: the tree and the chosen folder sit on the page, split by a hairline; Add folder is the header's button */}
      <InFolderHeader slot="actions">
        <Button size="sm" variant="primary" onClick={() => void leaveEdit().then((ok) => ok && setPicking(true))} data-testid="folder-rule-new">
          <Plus size={14} aria-hidden /> {t('rules.addFolder')}
        </Button>
      </InFolderHeader>
      <section aria-labelledby="access-tree-title" data-testid="access-tree">
        <h3 id="access-tree-title" ref={cardHeading} tabIndex={-1} className="sr-only">
          {t('accessTree.title')}
        </h3>
        {(folders.error || groups.error || users.error) && (
          <div className="mb-4" data-testid="access-side-error">
            <ErrorNote
              onRetry={() => {
                if (folders.error) void folders.reload()
                if (groups.error) void groups.reload()
                if (users.error) void users.reload()
              }}
            >
              {[folders.error && `${t('accessView.foldersFailed')} ${folders.error}`, groups.error && `${t('accessView.groupsFailed')} ${groups.error}`, users.error].filter(Boolean).join(' ')}
            </ErrorNote>
          </div>
        )}
        {body}
      </section>
      <FolderPicker
        open={picking}
        title={t('rules.addFolder')}
        confirmLabel={t('common.choose')}
        needWrite={false}
        onClose={() => setPicking(false)}
        onPick={(path) => {
          setPicking(false)
          // the folder is opened to and chosen in the tree (also past the first page of its level), then its rules open
          // there; inside users/ its one row says why rules do not apply
          if (isPersonalPath(path)) {
            address(path)
            return
          }
          if (selected === path && node && !lookup) {
            startEdit(path)
            return
          }
          pendingEdit.current = path
          pendingBack.current = undefined
          // the address names it already (it was not found, or its lookup failed): looked up again
          if (new URLSearchParams(window.location.search).get('folder') === path) void reveal(path)
          else address(path)
        }}
      />
    </>
  )
}

// ---------------- the tree ----------------

/** How long typed letters add up to one name to jump to. */
const TYPE_AHEAD_MS = 700

function Tree({ data, ruled, open, busy, failed, selected, onToggle, onMore, onRetry, onChoose }: {
  data: TreeData
  /** "rule folders only": everything open, nothing to open or close */
  ruled: boolean
  open: ReadonlySet<string>
  busy: ReadonlySet<string>
  failed: ReadonlyMap<string, string>
  selected: string | null
  onToggle: (path: string, open: boolean) => Promise<void> | void
  onMore: (parent: string) => Promise<string[]>
  onRetry: (parent: string) => void
  onChoose: (path: string) => void
}) {
  const t = useT()
  const rows = useMemo(() => (ruled ? flattenRuled(data, failed) : flatten(data, open, failed)), [data, open, failed, ruled])
  const [active, setActive] = useState<string>(selected !== null ? `n:${selected}` : 'n:')
  const els = useRef(new Map<string, HTMLElement>())
  /** the row to focus once it is on the screen (after opening, loading more, closing) */
  const focusNext = useRef<string | null>(null)
  const typed = useRef({ text: '', at: 0 })
  /** the chosen folder's row becomes the Tab stop once it is on the screen (chosen by the address, after "Add folder") */
  const follow = useRef<string | null>(null)
  useEffect(() => {
    if (selected !== null) follow.current = `n:${selected}`
  }, [selected])
  useLayoutEffect(() => {
    const k = follow.current
    if (k === null || !rows.some((r) => r.key === k)) return
    follow.current = null
    setActive(k)
  })

  // the Tab stop: the row last focused; if it went away (its folder closed), the nearest row above it that is there
  let tabStop = rows.find((r) => r.key === active)?.key
  if (!tabStop) {
    const path = active.slice(2)
    const up = [path, ...ancestorsOf(path).reverse()].find((p) => rows.some((r) => r.key === `n:${p}`))
    tabStop = up !== undefined ? `n:${up}` : rows[0]?.key
  }
  useLayoutEffect(() => {
    const k = focusNext.current
    if (k === null) return
    const el = els.current.get(k)
    if (!el) return
    focusNext.current = null
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
  })
  const go = (key: string | undefined) => {
    if (!key) return
    setActive(key)
    focusNext.current = key
    // already on the screen: focus now (the effect above runs only on a render)
    const el = els.current.get(key)
    if (el) {
      focusNext.current = null
      el.focus()
      el.scrollIntoView({ block: 'nearest' })
    }
  }
  /** the nearest row above `path` that is on the screen */
  const upTo = (path: string | null) => {
    if (path === null) return undefined
    return [path, ...ancestorsOf(path).reverse()].map((p) => `n:${p}`).find((k) => rows.some((r) => r.key === k))
  }

  const activate = async (r: Row) => {
    if (r.kind === 'node') onChoose(r.path)
    else if (r.kind === 'failed') {
      // the row goes while the level is asked for again: the focus waits on the folder it belongs to
      if (r.parent !== RULED) go(`n:${r.parent}`)
      else go('n:')
      onRetry(r.parent)
    } else {
      const got = await onMore(r.parent)
      // the first folder that came takes the focus (the "more" row moved below it, or went)
      if (got[0]) go(`n:${got[0]}`)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.key === tabStop)
    const r = rows[i]
    if (!r) return
    const n = r.kind === 'node' ? data.nodes.get(r.path) : undefined
    const next = rows[i + 1]
    switch (e.key) {
      case 'ArrowDown':
        go(next?.key)
        break
      case 'ArrowUp':
        go(rows[i - 1]?.key)
        break
      case 'Home':
        go(rows[0]?.key)
        break
      case 'End':
        go(rows[rows.length - 1]?.key)
        break
      case 'ArrowRight':
        if (r.kind !== 'node') break
        if (ruled) {
          if (next && next.level > r.level) go(next.key)
        } else if (n?.folders) {
          if (!open.has(r.path)) void onToggle(r.path, true)
          else if (next && next.level > r.level) go(next.key)
        }
        break
      case 'ArrowLeft':
        if (!ruled && r.kind === 'node' && n?.folders && open.has(r.path)) void onToggle(r.path, false)
        else go(upTo(r.kind === 'node' ? parentOf(r.path) : r.parent === RULED ? '' : r.parent))
        break
      case 'Enter':
      case ' ':
        void activate(r)
        break
      default: {
        // type to jump: the next folder whose name starts with what was typed
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
        const now = Date.now()
        const text = (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : '') + e.key.toLocaleLowerCase()
        typed.current = { text, at: now }
        const order = [...rows.slice(i + (text.length === 1 ? 1 : 0)), ...rows.slice(0, i + (text.length === 1 ? 1 : 0))]
        const hit = order.find((x) => x.kind === 'node' && nodeName(t, data.nodes.get(x.path)!).toLocaleLowerCase().startsWith(text))
        if (hit) go(hit.key)
        break
      }
    }
    e.preventDefault()
  }

  return (
    <div role="tree" aria-label={t('accessTree.label')} className="@container/tree -mx-1.5" onKeyDown={onKey} data-testid="folder-tree" data-mode={ruled ? 'ruled' : 'all'}>
      {rows.map((r) => {
        const ref = (el: HTMLElement | null) => {
          if (el) els.current.set(r.key, el)
          else els.current.delete(r.key)
        }
        const common = {
          ref,
          role: 'treeitem' as const,
          'aria-level': r.level,
          tabIndex: r.key === tabStop ? 0 : -1,
          onFocus: () => setActive(r.key),
          style: { '--d': r.level - 1 } as React.CSSProperties,
        }
        if (r.kind === 'node') {
          const n = data.nodes.get(r.path)!
          return (
            <TreeRow
              key={r.key}
              {...common}
              n={n}
              level={r.level}
              pos={r.pos}
              size={r.size}
              members={data.members}
              toggle={ruled ? (r.shows ? 'shown' : null) : n.folders ? (open.has(r.path) ? 'open' : 'closed') : null}
              busy={busy.has(r.path) && !data.levels.has(r.path)}
              selected={selected === r.path}
              onToggle={() => {
                setActive(r.key)
                if (!ruled) void onToggle(r.path, !open.has(r.path))
              }}
              onChoose={() => {
                setActive(r.key)
                onChoose(r.path)
              }}
            />
          )
        }
        const err = failed.get(r.parent)
        const loading = busy.has(r.parent)
        return (
          <div
            key={r.key}
            {...common}
            aria-busy={loading || undefined}
            onClick={() => {
              setActive(r.key)
              void activate(r)
            }}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg py-2 pr-2 text-label font-medium text-muted transition-[background-color,color] hover:bg-hover hover:text-ink focus-visible:-outline-offset-2 max-sm:min-h-10"
            data-testid={r.kind === 'more' ? 'tree-more' : 'tree-failed'}
          >
            <Indent />
            <span className="inline-flex size-6 shrink-0 items-center justify-center" aria-hidden>
              {loading ? <Loader2 size={14} className="animate-spin" /> : r.kind === 'more' ? <Plus size={14} /> : <RotateCw size={14} />}
            </span>
            <span className="min-w-0">
              {r.kind === 'more' ? t('accessTree.more', { n: r.left }) : <span className="text-danger">{t('accessTree.failed')}</span>}
              {/* what went wrong (the server's words), for a level that did not open or a page that did not come */}
              {err && <span className="block text-xs font-normal [overflow-wrap:anywhere] text-danger">{err}</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Room for the depth: 12px a level up to four on a narrow tree, 16px up to eight on a wide one. Deeper rows say so. */
/** Some rule that decides here sits on a parent folder (the row then says which); rules only of this folder do not. */
const inheritsRule = (n: AccessTreeNode) => sourceSaysSomething(n) && n.who.some((w) => w.reason === 'rule' && (w.folder ?? '') !== n.path)

function Indent() {
  return <span className="w-[calc(min(var(--d),4)*0.75rem)] shrink-0 @xl/tree:w-[calc(min(var(--d),8)*1rem)]" aria-hidden />
}

function TreeRow({ n, level, pos, size, members, toggle, busy, selected, onToggle, onChoose, ...item }: {
  n: AccessTreeNode
  level: number
  pos?: number
  size?: number
  members: number
  /** open / closed: it opens; shown: open with nothing to close ("rule folders only"); null: nothing inside */
  toggle: 'open' | 'closed' | 'shown' | null
  busy: boolean
  selected: boolean
  onToggle: () => void
  onChoose: () => void
  ref: (el: HTMLElement | null) => void
  role: 'treeitem'
  'aria-level': number
  tabIndex: number
  onFocus: () => void
  style: React.CSSProperties
}) {
  const t = useT()
  const personal = n.kinds.includes('personal')
  const own = n.rules > 0
  const Icon = KIND_ICON(n)
  const kind = kindText(t, n)
  const depth = level - 1
  const name = nodeName(t, n)
  const risks = riskTexts(t, n)
  const restricted = isRestricted(n)
  const opens = toggle === 'open' || toggle === 'closed'
  return (
    <div
      {...item}
      aria-posinset={pos}
      aria-setsize={size}
      aria-expanded={toggle === null ? undefined : toggle !== 'closed'}
      aria-selected={selected}
      aria-busy={busy || undefined}
      onClick={onChoose}
      title={n.path || name}
      // only the fill fades: a transition of the outline would draw the focus ring in ink before the accent
      className={clsx('flex cursor-pointer items-start gap-1.5 rounded-lg py-1.5 pr-2 transition-[background-color] focus-visible:-outline-offset-2', selected ? 'bg-accent-soft' : 'hover:bg-hover')}
      data-testid="tree-row"
      data-path={n.path}
      data-rules={n.rules}
    >
      <Indent />
      {/* the open / close target (the row itself chooses the folder); no Tab stop of its own, the arrow keys do it */}
      <span
        onClick={(e) => {
          e.stopPropagation()
          if (opens) onToggle()
        }}
        className={clsx('-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-faint max-sm:size-9', opens && 'hover:bg-hover hover:text-ink')}
        aria-hidden
        data-testid="tree-toggle"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : toggle && <ChevronRight size={15} className={clsx('transition', toggle !== 'closed' && 'rotate-90')} />}
      </span>
      <Icon size={16} className={clsx('mt-0.5 shrink-0', own || n.path === '' ? 'text-muted' : 'text-faint')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-x-2">
          {/* the name gives way last: the kind is cut first (shrinks a hundred times faster), then the name */}
          <span className={clsx('min-w-0 truncate text-sm', own || n.path === '' ? 'font-medium text-ink' : 'text-muted')} data-testid="tree-name">
            {/* deeper than the room for depth: said in front of the name; the whole path is the row's title */}
            {depth > 4 && <span className={clsx('text-faint', depth <= 8 && '@xl/tree:hidden')} aria-hidden>…/</span>}
            {name}
          </span>
          {kind && <span className="min-w-0 shrink-[100] truncate text-xs text-faint" data-testid="tree-kind">{personal ? t('accessTree.personal.count', { n: n.people ?? 0 }) : kind}</span>}
          {restricted && (
            <Tooltip label={t('accessTree.restricted')}>
              <span className="inline-flex shrink-0 self-center text-muted">
                <Lock size={12} aria-hidden />
                <span className="sr-only">{t('accessTree.restricted')}</span>
              </span>
            </Tooltip>
          )}
        </div>
        {personal ? (
          <p className="mt-0.5 text-label leading-5 text-muted">
            {t('accessTree.personal.who')} <span className="text-xs text-faint">· {t('accessTree.personal.fixed')}</span>
          </p>
        ) : (
          <p className="mt-0.5 text-label leading-5">
            <span className={own || n.path === '' ? 'text-ink' : 'text-muted'} data-testid="tree-who">
              {membersOnlyFolder(n) ? membersOnlyText(t, n) : whoSeesText(t, n, members)}
            </span>
            {/* where it comes from only when a parent's rule decides (a folder's own rules need no "this folder's rules"
                on every row; the lock says it has rules); a project's folder: its members, said already */}
            {inheritsRule(n) && !membersOnlyFolder(n) && (
              <>
                {' '}
                <span className="text-faint" data-testid="tree-source">
                  · {sourceText(t, n, members)}
                </span>
              </>
            )}
          </p>
        )}
        {risks.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {risks.map((r) => (
              <span key={r} className="inline-flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-micro font-medium text-warn" data-testid="tree-risk">
                <TriangleAlert size={11} className="shrink-0" aria-hidden />
                {r}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------- the chosen folder ----------------

function FolderDetail({ node: n, members, row, rowsReady, names, subject, reloadKey, headingRef, removal, back, onEdit, onRemoved }: {
  node: AccessTreeNode
  members: number
  /** the folder's rule row, if it has one (Admin › Folder permissions' list) */
  row: Folder | undefined
  rowsReady: boolean
  names: Names
  subject: (type: string, id: string | null) => string
  reloadKey: number
  headingRef: React.Ref<HTMLHeadingElement>
  removal: ReturnType<typeof useRemoveRules>
  back: ReactNode
  onEdit: () => void
  onRemoved: () => void | Promise<void>
}) {
  const t = useT()
  const id = useId()
  const personal = n.kinds.includes('personal')
  const answer = useFolderAnswer(personal ? null : n.path, reloadKey)
  const name = n.path === '' ? t('accessView.rootFolder') : n.path
  const kind = kindText(t, n)
  const rules = row?.rules ?? []
  const keep = row?.keep === 'team' ? t('rules.keepTeam') : row?.keep === 'group' ? t('rules.keepGroup', { name: names.group(row.groupId ?? '') ?? '?' }) : null
  const checking = row && removal.checking === row.id
  // "remove all rules" is for cleaning up only: a rule row left without rules that no project uses (a project's marker,
  // after its project went; a group's row after the group did). Rules are changed in the panel, and "follow the folder
  // above" is no rules saved there: removing a row would also cut a group's link or a project's mark.
  const emptyMarker = !!row && !keep && row.rules.length === 0 && !n.kinds.includes('project')
  const membersOnly = membersOnlyFolder(n)
  const manage = membersOnly ? manageMembersLink(n) : null
  // a folder inside skills/: who of skills/' managers cannot write here, person by person (both folders' answers)
  const inSkills = isSkillsFolder(n.path) && n.path.includes('/')
  const top = useFolderPeople(inSkills ? n.path.slice(0, n.path.indexOf('/')) : null, reloadKey)
  const here = useFolderPeople(inSkills ? n.path : null, reloadKey)
  const skillsLocked = top.data && here.data ? skillsLockedText(t, skillManagersOf(top.data.values()), (id) => here.data!.get(id)?.access) : null
  return (
    <section aria-labelledby={id} data-testid="folder-detail" data-path={n.path}>
      {back}
      <h3 id={id} ref={headingRef} tabIndex={-1} className="text-base font-semibold [overflow-wrap:anywhere] text-ink outline-none">
        {name}
      </h3>
      {kind && <p className="mt-0.5 text-xs [overflow-wrap:anywhere] text-muted">{personal ? `${kind} · ${t('accessTree.personal.count', { n: n.people ?? 0 })}` : kind}</p>}

      {personal ? (
        <div className="mt-3 space-y-2 text-sm text-muted" data-testid="folder-detail-personal">
          <p>{t('accessTree.personal.detail')}</p>
          <p>
            <Link to="/admin/folders?view=people" className="text-accent-text underline-offset-2 hover:underline">
              {t('accessTree.personal.byPerson')}
            </Link>
          </p>
        </div>
      ) : (
        <>
          {/* a team project's folder: members only, changed on the project's page (no edit panel here) */}
          {membersOnly && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span data-testid="folder-detail-members-only"><Badge>{t('accessTree.membersOnly')}</Badge></span>
              {manage && (
                <Link to={manage} className="text-sm text-accent-text underline-offset-2 hover:underline" data-testid="folder-detail-manage-members" data-row-focus>
                  {t('accessTree.manageMembers')}
                </Link>
              )}
            </div>
          )}
          {/* the rules: change them in the edit panel (rows the server keeps say why under the rules) */}
          {!membersOnly && <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onEdit} disabled={!rowsReady} data-testid="folder-detail-edit" data-row-focus>
              <SlidersHorizontal size={14} aria-hidden /> {rules.length ? t('accessTree.editRules') : t('accessTree.addRules')}
            </Button>
            {/* an empty row no project uses: removed with the server's preview (it changes nobody's access); the folder
                stays */}
            {emptyMarker && (
              <Button size="sm" variant="ghost-danger" onClick={() => void removal.remove(row, onRemoved)} aria-busy={checking || undefined} aria-describedby={`${id}-marker`} data-row-focus data-testid="folder-detail-delete">
                {checking ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />} {t('accessTree.removeMarker')}
              </Button>
            )}
            {keep && (
              <Tooltip label={keep}>
                <span className="inline-flex p-1.5 text-faint max-sm:p-2" aria-hidden>
                  <Lock size={15} />
                </span>
              </Tooltip>
            )}
          </div>}
          {emptyMarker && (
            <p id={`${id}-marker`} className="mt-1.5 text-xs text-muted" data-testid="folder-marker-hint">
              {t('accessTree.markerHint')}
            </p>
          )}
          {/* a team project's folder: no settings of its own here (they cannot be changed on this screen; its members
              are, on its page) */}
          {!membersOnly && <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted">{t('accessTree.ownRules')}</h4>
            {rules.length ? (
              <RuleBadges rules={rules} path={n.path} subject={subject} />
            ) : (
              <p className="mt-1 text-xs text-muted">{t('accessTree.noOwnRules')}</p>
            )}
            {isSkillsFolder(n.path) && (
              <>
                <p className="mt-1.5 text-xs text-ink" data-testid="folder-skill-editors">
                  {skillEditorsText(t, n.who, members)}
                </p>
                {skillsLocked && (
                  <p className="mt-0.5 text-xs text-muted" data-testid="folder-skill-locked">
                    {skillsLocked}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-muted">{t('skillMgr.folderHint')}</p>
              </>
            )}
            {keep && (
              <p className="mt-1.5 text-xs text-muted" data-testid="folder-keep-reason">
                {keep}
              </p>
            )}
          </div>}
          {riskTexts(t, n, true).map((r) => (
            <p key={r} role="note" className="mt-3 flex items-start gap-1.5 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="folder-detail-risk">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
              {r}
            </p>
          ))}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted">{t('accessTree.people')}</h4>
            <People answer={answer} path={n.path} names={names} />
          </div>
        </>
      )}
    </section>
  )
}

/** A folder's own rules, as the list showed them: who, the access, and on skills/ the team skill managers. Long names
 * wrap inside the panel. */
function RuleBadges({ rules, path, subject }: { rules: Folder['rules']; path: string; subject: (type: string, id: string | null) => string }) {
  const t = useT()
  return (
    <span className="mt-1.5 flex flex-wrap gap-1" data-testid="folder-rules">
      {rules.map((r) => (
        <Badge key={r.id} className="max-w-full whitespace-normal [overflow-wrap:anywhere]">
          <span>
            {subject(r.subjectType, r.subjectId)}: {t(`access.${r.access}`)}
            {isSkillsFolder(path) && r.access === 'write' && (r.subjectType === 'user' || r.subjectType === 'group') && <span data-testid="skill-manager-badge"> · {t('skillMgr.ruleBadge')}</span>}
          </span>
        </Badge>
      ))}
    </span>
  )
}

// ---------------- rules of folders not in the tree ----------------

/** Why a rule row is not in the tree: inside users/ (rules there never apply), a name the tree never shows, or gone
 * from disk (moved or deleted outside the app). */
const outsideWhy = (f: Folder): 'personal' | 'hidden' | 'missing' => (isPersonalPath(f.path) ? 'personal' : f.hidden ? 'hidden' : 'missing')

/** Rule rows whose folder is not in the tree. Folded; each can be edited or removed, as on the list before the tree. */
function OutsideRules({ rows, folders, subject, groups, editable, onEdit, removal, onRemoved }: {
  rows: Folder[]
  folders: Folder[] | null
  subject: (type: string, id: string | null) => string
  groups: Group[]
  /** the people and groups the edit panel names have come */
  editable: boolean
  onEdit: (f: Folder) => void
  removal: ReturnType<typeof useRemoveRules>
  onRemoved: () => Promise<void>
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const id = useId()
  const focus = useFocusAfterRemove(folders, () => document.querySelector<HTMLElement>('[data-testid="folder-rule-new"]'))
  if (!rows.length) return null
  const whys = new Set(rows.map(outsideWhy))
  const only = whys.size === 1 ? [...whys][0]! : null
  return (
    <div className="mt-5 border-t border-line pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-muted transition hover:bg-hover hover:text-ink max-sm:min-h-10"
        data-testid="folder-outside-toggle"
      >
        <ChevronRight size={15} className={clsx('shrink-0 transition', open && 'rotate-90')} aria-hidden />
        {t(only === 'missing' ? 'accessTree.outside' : 'accessTree.outsideMixed', { n: rows.length })}
      </button>
      <div id={id} hidden={!open} ref={focus.box} data-testid="folder-outside">
        <p className="mt-1 text-xs text-muted">{t(only === 'missing' ? 'accessTree.outsideHint' : only === 'personal' ? 'accessTree.outsideHintPersonal' : 'accessTree.outsideHintMixed')}</p>
        <ul className="divide-y divide-line" data-testid="folder-list">
          {rows.map((f, i) => {
            const keep = f.keep === 'team' ? t('rules.keepTeam') : f.keep === 'group' ? t('rules.keepGroup', { name: groups.find((g) => g.id === f.groupId)?.name ?? '?' }) : null
            const why = outsideWhy(f)
            return (
              <li key={f.id} className="flex flex-wrap items-start gap-3 py-3 text-sm" data-testid="folder-row" data-path={f.path}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium [overflow-wrap:anywhere] text-ink">{f.path}</span>
                  <span className="mt-0.5 block text-xs text-faint">{t(why === 'personal' ? 'accessTree.inPersonal' : why === 'hidden' ? 'accessTree.hiddenName' : 'rules.missingOnDisk')}</span>
                  <RuleBadges rules={f.rules} path={f.path} subject={subject} />
                  {keep && (
                    <span className="mt-1 block text-xs text-muted" data-testid="folder-keep-reason">
                      {keep}
                    </span>
                  )}
                </span>
                {/* inside users/ rules never apply (and the server refuses to change them): only removing them is offered */}
                {why !== 'personal' && (
                  <Button size="sm" variant="ghost" onClick={() => onEdit(f)} disabled={!editable} data-row-focus={keep ? true : undefined} data-testid="folder-outside-edit">
                    {t('common.edit')}
                  </Button>
                )}
                {keep ? (
                  <Tooltip label={keep}>
                    <span className="inline-flex p-1.5 text-faint max-sm:p-2" aria-hidden>
                      <Lock size={15} />
                    </span>
                  </Tooltip>
                ) : (
                  <RemoveRulesButton
                    f={f}
                    label={t('accessTree.removeRulesOf', { path: f.path })}
                    checking={removal.checking}
                    onClick={() =>
                      void removal.remove(f, async () => {
                        focus.removed(i)
                        await onRemoved()
                      })
                    }
                  />
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
