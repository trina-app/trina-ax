// Trina history as one section (its title, the filter and sort menu, the list), moved out of Sidebar.tsx with no
// change in what it shows (navigation redesign, docs/AGENTS/plan/20261112-1839-nav-rail.md, phase P0b) so the rail's
// Trina panel can draw the same list. The caps are the caller's (`caps`): the computer's sidebar passes
// SIDEBAR_HISTORY_CAPS (beside the rooms: my pins, the five latest or the five latest projects with three rows each,
// "모두 보기" for the rest), the phone's drawer `null` (the whole history). What the list holds and why is in
// Sidebar.tsx's head comment and docs/DECISIONS.md "Trina history by project", "Pinned chats", "Session markers".
import clsx from 'clsx'
import { Check, ChevronRight, ListFilter, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { dateBucket, type DateBucket } from '../../lib/format'
import { aiName } from '../../lib/tabs'
import { useT, type MessageKey } from '../../i18n'
import { markerOf, needsMe, waitingOrRunning, type MarkerView } from '../../lib/sessionMarkers'
import { useChats } from '../../store/chats'
import { cardChats, useSessionMarkers } from '../../store/sessionMarkers'
import { useProjects } from '../../store/projects'
import { MoveToProjectDialog } from '../chat/ChatProject'
import { isUnused } from '../chat/ChatState'
import { HistoryGroups, useHistoryGroups, useSeesProject } from '../history/HistoryGroups'
import { MenuButton } from '../rooms/MenuButton'
import { SidebarSectionTitle, useMediaQuery } from '../ui'
import { LoadError } from '../LoadError'
import { Tooltip } from '../Tooltip'
import { ChatItem, type ChatPeek } from './ChatItem'

const BUCKET_LABEL: Record<DateBucket, MessageKey> = { today: 'sidebar.today', yesterday: 'sidebar.yesterday', week: 'sidebar.week', month: 'sidebar.month', older: 'sidebar.older' }


/** How Recents is filtered, grouped and sorted, like Claude's: only what the chat list itself knows. Status "Active" is
 * every chat in the list (deleted ones are under the account menu's Deleted chats); "Waiting": a spinner or a "?" row
 * (an answer runs or waits its turn, a card waits for the person, an answer failed or paused and was not seen; not a new
 * answer: docs/DECISIONS.md "Session markers"). */
const VIEW = {
  status: { label: 'sidebar.view.status', options: { all: 'sidebar.status.all', waiting: 'sidebar.filter.active', project: 'sidebar.filter.project', noProject: 'sidebar.filter.noProject', confidential: 'sidebar.filter.confidential' } },
  activity: { label: 'sidebar.view.activity', options: { all: 'sidebar.activity.all', today: 'sidebar.today', week: 'sidebar.week', month: 'sidebar.month' } },
  group: { label: 'sidebar.view.group', options: { none: 'sidebar.group.none', date: 'sidebar.group.date', project: 'sidebar.group.project' } },
  sort: { label: 'sidebar.view.sort', options: { updated: 'sidebar.sort.updated', created: 'sidebar.sort.created', title: 'sidebar.sort.title' } },
} as const satisfies Record<string, { label: MessageKey; options: Record<string, MessageKey> }>
type ViewKey = keyof typeof VIEW
type RecentsView = { [K in ViewKey]: keyof (typeof VIEW)[K]['options'] }
const DEFAULT_VIEW: RecentsView = { status: 'all', activity: 'all', group: 'project', sort: 'updated' }
/** what differs from the default only, so a later default reaches everyone who did not choose otherwise */
const VIEW_KEY = 'mycel.sidebar.historyView'
/** before 2026-11-12 (docs/DECISIONS.md "Trina history by project") the whole view was kept, its grouping the old
 * default "by date" for everyone who ever touched the menu: its other choices are kept, a grouping by date is not */
const OLD_VIEW_KEY = 'mycel.sidebar.recentsView'
const DAY = 86_400_000
/** `inProject`: the chat is in a project the person sees (one they no longer see counts as none, as its header and the
 * chat page say: docs/DECISIONS.md "Trina history by project") */
const passes = (v: RecentsView, c: Chat, seen: MarkerView, now: number, inProject: (c: Chat) => boolean) => {
  const s = v.status
  const ok = s === 'waiting' ? waitingOrRunning(c, seen) : s === 'project' ? inProject(c) : s === 'noProject' ? !inProject(c) : s === 'confidential' ? !!c.confidential : true
  const age = now - new Date(c.updatedAt).getTime()
  const fresh = v.activity === 'today' ? dateBucket(c.updatedAt) === 'today' : v.activity === 'week' ? age <= 7 * DAY : v.activity === 'month' ? age <= 30 * DAY : true
  return ok && fresh
}
const rememberedView = (): RecentsView => {
  try {
    const kept = localStorage.getItem(VIEW_KEY)
    const v = JSON.parse(kept ?? localStorage.getItem(OLD_VIEW_KEY) ?? '{}') as Partial<RecentsView>
    if (kept === null && v.group === 'date') delete v.group
    const out = { ...DEFAULT_VIEW }
    for (const k of Object.keys(VIEW) as ViewKey[]) if (v[k] && v[k] in VIEW[k].options) (out as Record<string, string>)[k] = v[k] as string
    return out
  } catch {
    return DEFAULT_VIEW
  }
}

/** This browser remembers whether Recents is open and how it is shown (a private window may refuse: it just forgets). */
const remembered = <T extends string>(key: string, ok: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(key) as T | null
    return v && ok.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}
const remember = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* not kept */
  }
}
const OPEN_KEY = 'mycel.sidebar.recents'
const ALL_KEY = 'mycel.sidebar.recentsAll'
/** a computer: AI chats shown before "모두 보기" (no chat in a project) */
const LATEST = 5
/** a computer, the history by project beside the rooms: the latest projects in sight (and the other chats), and the
 * rows of each before its "N more" (docs/DECISIONS.md "Trina history by project") */
const PROJECTS_SHOWN = 5
const ROWS_SHOWN = 3
/** a computer: pinned chats shown above them (the rest are first in "모두 보기") */
const PINS_SHOWN = 10
/** my pinned chats, the most recently pinned first (docs/DECISIONS.md "Pinned chats") */
const pinnedFirst = (list: Chat[]) => list.filter((c) => c.pinnedAt).sort((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!))


/** The caps of the history where it shares a column with the rooms (a computer's sidebar): my pins, then the latest
 * chats (no chat in a project) or the latest projects and a few rows of each, the rest behind "모두 보기". */
export interface HistoryCaps {
  pins: number
  latest: number
  projects: number
  rows: number
}
/** today's sidebar beside the rooms (docs/DECISIONS.md "Desktop sidebar: rooms first", "Trina history by project") */
export const SIDEBAR_HISTORY_CAPS: HistoryCaps = { pins: PINS_SHOWN, latest: LATEST, projects: PROJECTS_SHOWN, rows: ROWS_SHOWN }

/**
 * The AI's history as one section: its title (it folds), the filter, and the list. `caps`: beside the rooms (a
 * computer's sidebar) the capped list with "모두 보기"; `null`, the whole of it (the phone's drawer). `peek` is the
 * hover quick view of the column it sits in (its scroll hides it).
 */
/** The history's filter and sort (four menus), remembered in this browser as what differs from the default. */
export function useRecentsView() {
  const [view, setViewState] = useState<RecentsView>(rememberedView)
  const setView = useCallback((v: RecentsView) => {
    setViewState(v)
    remember(VIEW_KEY, JSON.stringify(Object.fromEntries((Object.keys(VIEW) as ViewKey[]).filter((k) => v[k] !== DEFAULT_VIEW[k]).map((k) => [k, v[k]]))))
  }, [])
  const changed = (Object.keys(VIEW) as ViewKey[]).filter((k) => view[k] !== DEFAULT_VIEW[k])
  return { view, setView, changed }
}
export type RecentsViewState = ReturnType<typeof useRecentsView>
/** the choices that differ from the default, in words ("Waiting, Title") */
export const viewWords = (s: RecentsViewState, t: ReturnType<typeof useT>) => s.changed.map((k) => t((VIEW[k].options as Record<string, MessageKey>)[s.view[k]])).join(', ')
export const DEFAULT_RECENTS_VIEW = DEFAULT_VIEW

/**
 * `viewState` and `bare` (the rail's Trina panel, docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): the filter lives in
 * the panel's header, so the list takes its view from there and shows no title row of its own.
 */
export function HistoryList({ caps, onNavigate, peek, viewState, bare }: { caps: HistoryCaps | null; onNavigate: () => void; peek: ChatPeek; viewState?: RecentsViewState; bare?: boolean }) {
  const t = useT()
  const capped = !!caps
  // the whole history opened ("모두 보기"), remembered in this browser like the fold
  const [allChats, setAllChatsState] = useState(() => remembered(ALL_KEY, ['yes', 'no'] as const, 'no') === 'yes')
  const setAllChats = (v: boolean) => (remember(ALL_KEY, v ? 'yes' : 'no'), setAllChatsState(v))
  const chats = useChats((s) => s.chats)
  // the move dialog of a row's "…" (ChatItem): kept here, not in the row, so that it stays open when the moved chat's row
  // goes to another group (a date, a project) and is made again, as the share right after the move needs
  // (components/chat/ChatProject.tsx, the switch "프로젝트 멤버와 공유")
  const [moving, setMoving] = useState<Chat | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const loaded = useChats((s) => s.chatsLoaded)
  const cursor = useChats((s) => s.chatsCursor)
  const loadChats = useChats((s) => s.loadChats)
  const [more, setMore] = useState(false)
  // a first read that failed: the calm notice in place of the list, which reads again by itself (components/LoadError.tsx);
  // it spun forever before. The error stays until a read works, so the notice stays while it reads again
  const [chatsError, setChatsError] = useState<unknown>(null)
  const readChats = useCallback(() => loadChats(true).then(() => setChatsError(null), (e: unknown) => setChatsError(e ?? new Error('failed'))), [loadChats])
  useEffect(() => {
    if (!loaded) void readChats()
  }, [loaded, readChats])

  const [openState, setRecentsOpen] = useState(() => remembered(OPEN_KEY, ['open', 'closed'] as const, 'open') === 'open')
  const recentsOpen = bare || openState
  const own = useRecentsView()
  const { view, setView, changed } = viewState ?? own
  const requests = useChats((s) => s.requests)
  // session markers as this window sees them: the chats with a card open here, the chat on screen in a visible window
  const cards = useMemo(() => cardChats(requests), [requests])
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  // the whole history as the filter and sort choose it (the drawer, "모두 보기"): a chat made only to hold attachments (a
  // file attached, nothing sent yet) is not a conversation yet; pinned chats come first, without a header
  // (`pinnedRows`), the rest follow by project, by date or in one list
  // before the first read of the project list, a chat with a project counts as in one (the read then sorts it out)
  const listed = useProjects((s) => s.listed)
  const seesProject = useSeesProject()
  const inProject = useCallback((c: Chat) => !!c.projectId && (!listed || seesProject(c.projectId)), [listed, seesProject])
  const filtered = useMemo(() => {
    const now = Date.now()
    const shown = chats.filter((c) => !isUnused(c) && !c.pinnedAt && passes(view, c, { card: cards.has(c.id), here: c.id === here }, now, inProject))
    const when = (c: Chat) => (view.sort === 'created' ? c.createdAt : c.updatedAt)
    return shown.sort((a, b) => (view.sort === 'title' ? (a.title || '').localeCompare(b.title || '') : when(b).localeCompare(when(a))))
  }, [chats, view, cards, here, inProject])
  const pinnedRows = useMemo(() => {
    const now = Date.now()
    return pinnedFirst(chats.filter((c) => !isUnused(c) && passes(view, c, { card: cards.has(c.id), here: c.id === here }, now, inProject)))
  }, [chats, view, cards, here, inProject])
  const listId = useId()
  // a computer: my pinned chats (at most ten), then the five latest of the others and the chat on screen, unless the
  // whole history is open (or filtered)
  const used = useMemo(() => chats.filter((c) => !isUnused(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [chats])
  const openChat = /^\/c\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null
  const pins = useMemo(() => pinnedFirst(used).filter((c, i) => i < (caps?.pins ?? Infinity) || c.id === openChat), [used, openChat, caps?.pins])
  const unpinned = useMemo(() => used.filter((c) => !c.pinnedAt), [used])
  const latest = useMemo(() => [...pins, ...unpinned.filter((c, i) => i < (caps?.latest ?? Infinity) || c.id === openChat)], [unpinned, pins, openChat, caps?.latest])
  const full = !caps || allChats || changed.length > 0
  // the history by project (docs/DECISIONS.md "Trina history by project"): beside the rooms the latest projects, a few
  // rows each; the whole of it in the drawer and in "모두 보기". Without a chat in a project there are no headers: the
  // plain list (by date in the whole history), as before
  const byProject = useHistoryGroups(full ? filtered : unpinned, !caps || full ? { open: openChat } : { projects: caps.projects, rows: caps.rows, open: openChat })
  const grouped = byProject.grouped && (!full || view.group === 'project')
  const dateGroups = useMemo(() => {
    const by = view.group === 'none' ? 'none' : 'date'
    const g = new Map<string, { label: string | null; items: Chat[] }>()
    for (const c of filtered) {
      const key = by === 'date' ? dateBucket(view.sort === 'created' ? c.createdAt : c.updatedAt) : ''
      if (!g.has(key)) g.set(key, { label: by === 'date' ? t(BUCKET_LABEL[key as DateBucket]) : null, items: [] })
      g.get(key)!.items.push(c)
    }
    return [...g.entries()]
  }, [filtered, view.group, view.sort, t])
  // the hidden chats that need me, counted on "모두 보기" as their rows would show them (session markers: a "?" or a dot,
  // not a spinner: a chat that runs again shows the spinner); amber when one of them is a "?". By project: the chats of
  // the projects past the latest ones and the pins past ten (a folded group and a group's "N more" carry their own mark)
  const hiddenNeeds = useMemo(() => {
    const hidden = grouped ? [...used.filter((c) => c.pinnedAt && !pins.includes(c)), ...byProject.behind.flatMap((g) => g.chats)] : used.filter((c) => !latest.includes(c))
    const marks = hidden.map((c) => markerOf(c, { card: cards.has(c.id), here: c.id === here })).filter(needsMe)
    return { n: marks.length, waiting: marks.some((m) => m!.kind === 'ask') }
  }, [grouped, used, pins, byProject.behind, latest, cards, here])
  const row = (c: Chat) => <ChatItem key={c.id} chat={c} onNavigate={onNavigate} peek={peek} onMove={setMoving} />
  const toggleRecents = () => setRecentsOpen((v) => (remember(OPEN_KEY, v ? 'closed' : 'open'), !v))


  return (
    <>
      {!bare && <div className="group/recents flex items-center gap-1 pr-1 pl-3" data-testid="recents-head">
        <SidebarSectionTitle open={recentsOpen} onToggle={toggleRecents} controls={listId} testId="recents-toggle">
          {t('sidebar.aiChats', { name: aiName(t) })}
        </SidebarSectionTitle>
        {changed.length > 0 && (
          <span className="flex min-w-0 items-center gap-0.5 text-xs text-faint" data-testid="recents-filter-label">
            <span aria-hidden>·</span>
            <span className="truncate">{changed.map((k) => t((VIEW[k].options as Record<string, MessageKey>)[view[k]])).join(', ')}</span>
            <Tooltip label={t('sidebar.filter.clear')}>
              <button type="button" onClick={() => setView(DEFAULT_VIEW)} aria-label={t('sidebar.filter.clear')} className="shrink-0 rounded p-0.5 hover:bg-hover hover:text-ink" data-testid="recents-filter-clear">
                <X size={11} aria-hidden />
              </button>
            </Tooltip>
          </span>
        )}
        <RecentsMenu view={view} onChange={setView} changed={changed.length > 0} />
      </div>}
      <div ref={listRef} id={listId} hidden={!recentsOpen} data-testid="recents-list">
        {/* the chats, and the projects the person sees for their headers (one read): no flat list first */}
        {(!loaded || !byProject.ready) && !chatsError && <Loader2 size={16} className="mx-auto mt-4 animate-spin text-faint" aria-label={t('common.loading')} />}
        {!loaded && !!chatsError && <LoadError error={chatsError} onRetry={readChats} what="chats" minor className="mx-1 mt-2" />}
        {loaded && !chats.some((c) => !isUnused(c)) && <p className="px-3 py-2 text-sm text-faint">{t('sidebar.noChats')}</p>}
        {loaded && chats.some((c) => !isUnused(c)) && !filtered.length && !pinnedRows.length && (
          <p className="px-3 py-2 text-sm text-faint" data-testid="recents-no-match">
            {t('sidebar.filter.none')}
          </p>
        )}
        {loaded && byProject.ready && !full && !grouped && <ul data-testid="ai-chats-latest">{latest.map(row)}</ul>}
        {/* by project beside the rooms: my pins as before, then the latest projects (docs/DECISIONS.md "Trina history by project") */}
        {loaded && byProject.ready && !full && grouped && (
          <>
            {pins.length > 0 && (
              <ul className="mb-2" data-testid="ai-chats-pinned">
                {pins.map(row)}
              </ul>
            )}
            <HistoryGroups state={byProject} row={row} onNavigate={onNavigate} />
          </>
        )}
        {/* always there while there is a history (the owner, 2026-11-07), even when all of it is in sight: the whole
            history with its filters is behind it */}
        {!full && used.length > 0 && (
          <button type="button" onClick={() => setAllChats(true)} className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="ai-chats-all">
            <span className="truncate">{t('rooms.showAll')}</span>
            {/* what the hidden chats hold for me, so nothing that needs me is out of sight unannounced */}
            {hiddenNeeds.n > 0 && (
              <span className={clsx('ml-auto flex shrink-0 items-center gap-1.5 text-micro font-medium', hiddenNeeds.waiting ? 'text-warn' : 'text-ink')} data-testid="ai-chats-needs">
                <span className={clsx('size-1.5 rounded-full', hiddenNeeds.waiting ? 'bg-warn' : 'bg-accent')} aria-hidden />
                {t('sidebar.needsYou', { n: hiddenNeeds.n })}
              </span>
            )}
          </button>
        )}
        {full && byProject.ready && pinnedRows.length > 0 && (
          <ul className="mb-2" data-testid="ai-chats-pinned">
            {pinnedRows.map(row)}
          </ul>
        )}
        {full && byProject.ready && grouped && <HistoryGroups state={byProject} row={row} onNavigate={onNavigate} />}
        {full && byProject.ready && !grouped && dateGroups.map(([key, { label, items }]) => (
          <div key={key || 'all'} className="mb-2">
            {label && <h3 className="px-3 pt-2 pb-1 text-micro font-medium text-faint">{label}</h3>}
            <ul>{items.map(row)}</ul>
          </div>
        ))}
        {full && cursor && (
          <button
            type="button"
            className="w-full rounded-lg px-3 py-1.5 text-left text-xs text-muted hover:bg-hover"
            disabled={more}
            onClick={async () => {
              setMore(true)
              await loadChats(false).catch(() => {})
              setMore(false)
            }}
          >
            {more ? t('common.loading') : t('sidebar.more')}
          </button>
        )}
        {capped && allChats && (
          <button type="button" onClick={() => setAllChats(false)} className="flex h-8 w-full items-center rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="ai-chats-less">
            {t('common.less')}
          </button>
        )}
      </div>
      {moving && (
        <MoveToProjectDialog
          chat={moving}
          onClose={() => {
            const id = moving.id
            setMoving(null)
            // the moved row is a new row in its project's group (docs/DECISIONS.md "Trina history by project"): the
            // dialog's way back to the old "···" is gone, so the keyboard goes to the row's "···" where it is now
            requestAnimationFrame(() => {
              if (document.activeElement && document.activeElement !== document.body) return
              listRef.current?.querySelector(`a[href="/c/${id}"]`)?.closest('li')?.querySelector<HTMLElement>('[data-testid="chat-row-menu"]')?.focus()
            })
          }}
          onMoved={(c) => {
            useChats.getState().upsertChat(c)
            // the dialog read the project list a moment ago: the row goes to its project's group at once
            const p = c.projectId ? useProjects.getState().byId[c.projectId] : undefined
            if (p) byProject.projects.add(p)
          }}
        />
      )}
    </>
  )
}

/** Filter and sort beside "Recents", like Claude's: a square button (a dot when something is not at its default) that
 * opens a menu of four rows (Status, Last activity | Group by, Sort by), each with its current value and a submenu of
 * choices. Keyboard: Enter opens it, arrows move, → or Enter opens a submenu, ← or Esc goes back, Esc closes. The
 * menus sit in <body> (the Recents list scrolls and would clip them); on a narrow screen a submenu takes the menu's
 * place with a way back. A phone (below 768px, the drawer): bottom sheets instead (RecentsSheet). */
export function RecentsMenu(props: { view: RecentsView; onChange: (v: RecentsView) => void; changed: boolean; always?: boolean }) {
  const phone = useMediaQuery('(max-width: 767.98px)')
  return phone ? <RecentsSheet {...props} /> : <RecentsDropdown {...props} />
}

/** The phone's drawer: the same four rows as a bottom sheet (rooms/MenuButton.tsx), each with its value; a row opens
 * its choices as a second sheet, the chosen one ticked, instead of a menu beside the menu. */
function RecentsSheet({ view, onChange, changed }: { view: RecentsView; onChange: (v: RecentsView) => void; changed: boolean; always?: boolean }) {
  const t = useT()
  const [sub, setSub] = useState<ViewKey | null>(null)
  const [ask, setAsk] = useState(0)
  const button = useRef<HTMLButtonElement>(null)
  const value = (k: ViewKey) => t((VIEW[k].options as Record<string, MessageKey>)[view[k]])
  return (
    <div className="ml-auto">
      <MenuButton
        label={t('sidebar.filter')}
        heading={t('sidebar.filter')}
        icon={
          <span className="relative">
            <ListFilter size={18} aria-hidden />
            {changed && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" data-testid="recents-filter-dot" />}
          </span>
        }
        buttonClassName="touch-hit"
        buttonRef={button}
        testId="recents-filter"
        items={(Object.keys(VIEW) as ViewKey[]).map((k) => ({
          label: t(VIEW[k].label),
          hint: `· ${value(k)}`,
          onSelect: () => {
            setSub(k)
            setAsk((n) => n + 1)
          },
          testId: `recents-view-${k}`,
        }))}
      />
      {sub && (
        <MenuButton
          key={sub}
          label={t(VIEW[sub].label)}
          heading={t(VIEW[sub].label)}
          className="contents"
          buttonClassName="hidden!"
          openRequest={ask}
          focusBack={() => button.current?.focus()}
          items={Object.entries(VIEW[sub].options as Record<string, MessageKey>).map(([id, label]) => ({
            label: t(label),
            checked: view[sub] === id,
            onSelect: () => onChange({ ...view, [sub]: id }),
            testId: `recents-${sub}-${id}`,
          }))}
        />
      )}
    </div>
  )
}

function RecentsDropdown({ view, onChange, changed, always }: { view: RecentsView; onChange: (v: RecentsView) => void; changed: boolean; always?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<ViewKey | null>(null)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ top: 0, left: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const subMenu = useRef<HTMLDivElement>(null)
  const W = 224
  /** the menu's height: four rows of 32 px, a line and its padding */
  const MENU_H = 4 * 32 + 9 + 10
  const sideBySide = typeof window !== 'undefined' && pos.left + 2 * W + 8 < window.innerWidth
  const close = (focus: boolean) => {
    setOpen(false)
    setSub(null)
    if (focus) button.current?.focus()
  }
  const items = (box: HTMLElement | null) => [...(box?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
  useEffect(() => {
    if (!open) return
    if (!sub) items(menu.current)[0]?.focus()
    const h = (e: MouseEvent) => {
      const n = e.target as Node
      if (!menu.current?.contains(n) && !subMenu.current?.contains(n) && !button.current?.contains(n)) close(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open, sub])
  useEffect(() => {
    if (sub) (subMenu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? items(subMenu.current)[0])?.focus()
  }, [sub])
  const openMenu = () => {
    const r = button.current!.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8))
    // four rows and a line (about 160 px): above the button when they do not fit under it (its heading at the bottom)
    setPos(r.bottom + 4 + MENU_H > window.innerHeight ? { bottom: window.innerHeight - r.top + 4, left } : { top: r.bottom + 4, left })
    setOpen(true)
  }
  const back = () => {
    const k = sub
    setSub(null)
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>(`[data-view="${k}"]`)?.focus())
  }
  const onKey = (e: KeyboardEvent) => {
    const inSub = !!sub && subMenu.current?.contains(document.activeElement)
    const list = items(inSub ? subMenu.current : menu.current)
    const i = list.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      list[(n + list.length) % list.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(-1)
    else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && inSub)) {
      e.preventDefault()
      e.stopPropagation()
      if (inSub) back()
      else close(true)
    } else if (e.key === 'ArrowRight' && !inSub) {
      const k = (document.activeElement as HTMLElement)?.dataset.view as ViewKey | undefined
      if (k) {
        e.preventDefault()
        setSub(k)
      }
    } else if (e.key === 'Tab') close(false)
  }
  const row = 'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm hover:bg-hover focus-visible:-outline-offset-2'
  const panel = 'fixed z-50 w-56 rounded-xl border border-line bg-surface p-1 shadow-lg'
  // the submenu beside its row, kept inside the window (up to five choices and a back row)
  const subH = sub ? 8 + 32 * (Object.keys(VIEW[sub].options).length + (sideBySide ? 0 : 1)) : 0
  const subTop = sub ? Math.max(8, Math.min((menu.current?.querySelector<HTMLElement>(`[data-view="${sub}"]`)?.getBoundingClientRect().top ?? pos.top ?? 8) - 4, window.innerHeight - subH - 8)) : 0
  return (
    <div className="ml-auto" onKeyDown={onKey}>
      <Tooltip label={t('sidebar.filter')}>
        <button
          ref={button}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('sidebar.filter')}
          onClick={() => (open ? close(false) : openMenu())}
          className={clsx('relative flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink focus-visible:opacity-100 max-sm:opacity-100', open ? 'bg-hover text-ink opacity-100' : changed || always ? 'opacity-100' : 'opacity-0 group-hover/recents:opacity-100')}
          data-testid="recents-filter"
        >
          <ListFilter size={15} aria-hidden />
          {changed && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" data-testid="recents-filter-dot" />}
        </button>
      </Tooltip>
      {open &&
        createPortal(
          // its keys reach onKey through React (a portal's events bubble to the button's box)
          <div>
            {(sideBySide || !sub) && (
              <div ref={menu} role="menu" aria-label={t('sidebar.filter')} className={panel} style={pos} data-testid="recents-filter-menu">
                {(Object.keys(VIEW) as ViewKey[]).map((k, i) => (
                  <div key={k}>
                    {i === 2 && <div role="separator" className="mx-1 my-1 border-t border-line" />}
                    <button
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={sub === k}
                      data-view={k}
                      onClick={() => setSub(sub === k ? null : k)}
                      className={clsx(row, sub === k && 'bg-hover')}
                      data-testid={`recents-view-${k}`}
                    >
                      <span className="text-ink">{t(VIEW[k].label)}</span>
                      <span className="ml-auto truncate text-xs text-faint">{t((VIEW[k].options as Record<string, MessageKey>)[view[k]])}</span>
                      <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {sub && (
              <div ref={subMenu} role="menu" aria-label={t(VIEW[sub].label)} className={panel} style={sideBySide ? { top: subTop, left: pos.left + W + 4 } : pos} data-testid="recents-submenu">
                {!sideBySide && (
                  <button type="button" role="menuitem" onClick={back} className={clsx(row, 'text-faint')}>
                    <ChevronRight size={14} className="rotate-180" aria-hidden /> {t(VIEW[sub].label)}
                  </button>
                )}
                {Object.entries(VIEW[sub].options as Record<string, MessageKey>).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={view[sub] === id}
                    onClick={() => {
                      onChange({ ...view, [sub]: id })
                      back()
                    }}
                    className={row}
                    data-testid={`recents-${sub}-${id}`}
                  >
                    {t(label)}
                    {view[sub] === id && <Check size={14} className="ml-auto text-accent-text" aria-hidden />}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
