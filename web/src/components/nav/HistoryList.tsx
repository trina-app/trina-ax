// Trina history as one list, filtered and sorted (the Trina panel and the phone's 트리나 tab show it while the filter in
// their header is not at its default; panels/TrinaList.tsx otherwise): my pins first, then the chats by project, by date
// or in one list, and "더 보기" for the next page. What the list holds and why: docs/DECISIONS.md "Trina history by
// project", "Pinned chats", "Session markers". The filter's menu (RecentsMenu) and its state (useRecentsView) are here too.
import clsx from 'clsx'
import { Check, ChevronRight, ListFilter, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Chat } from '@mycel/shared/api'
import { dateBucket, type DateBucket } from '../../lib/format'
import { useT, type MessageKey } from '../../i18n'
import { waitingOrRunning, type MarkerView } from '../../lib/sessionMarkers'
import { useChats } from '../../store/chats'
import { useMe } from '../../store/session'
import { loadChatList } from '../../lib/chatListLoad'
import { cardChats, useSessionMarkers } from '../../store/sessionMarkers'
import { useProjects } from '../../store/projects'
import { MoveToProjectDialog } from '../chat/ChatProject'
import { isUnused } from '../chat/ChatState'
import { HistoryGroups, useHistoryGroups, useSeesProject } from '../history/HistoryGroups'
import { MenuButton, menuBoxCls, menuRowCls, menuSpot, MENU_EDGE } from '../rooms/MenuButton'
import { useMediaQuery } from '../ui'
import { LoadError } from '../LoadError'
import { Tooltip } from '../Tooltip'
import { ChatItem, type ChatPeek } from './ChatItem'
import { foldRuns, newestRunsOnly } from './TaskRunsRow'
import { useLocation } from 'react-router-dom'

const BUCKET_LABEL: Record<DateBucket, MessageKey> = { today: 'sidebar.today', yesterday: 'sidebar.yesterday', week: 'sidebar.week', month: 'sidebar.month', older: 'sidebar.older' }

/** How the Trina history is filtered, grouped and sorted, like Claude's: only what the chat list itself knows. Status "Active" is
 * every chat in the list (deleted ones are under the 트리나 panel's 삭제한 기록); "Waiting": a spinner or a "?" row
 * (an answer runs or waits its turn, a card waits for the person, an answer failed or paused and was not seen; not a new
 * answer: docs/DECISIONS.md "Session markers"). */
const VIEW = {
  status: { label: 'sidebar.view.status', options: { all: 'sidebar.status.all', waiting: 'sidebar.filter.active', project: 'sidebar.filter.project', noProject: 'sidebar.filter.noProject', confidential: 'sidebar.filter.confidential' } },
  activity: { label: 'sidebar.view.activity', options: { all: 'sidebar.activity.all', today: 'sidebar.today', week: 'sidebar.week', month: 'sidebar.month' } },
  group: { label: 'sidebar.view.group', options: { none: 'sidebar.group.none', date: 'sidebar.group.date', project: 'sidebar.group.project' } },
  sort: { label: 'sidebar.view.sort', options: { updated: 'sidebar.sort.updated', created: 'sidebar.sort.created', title: 'sidebar.sort.title' } },
} as const satisfies Record<string, { label: MessageKey; options: Record<string, MessageKey> }>
type ViewKey = keyof typeof VIEW
export type RecentsView = { [K in ViewKey]: keyof (typeof VIEW)[K]['options'] }
/** Group by: None (the owner, 2026-11-14: the Trina list is the flat 트리나 기록, so its menu says so; docs/DECISIONS.md
 * "Trina history: Group by defaults to None") */
const DEFAULT_VIEW: RecentsView = { status: 'all', activity: 'all', group: 'none', sort: 'updated' }
/** what differs from the default only, so a later default reaches everyone who did not choose otherwise */
const VIEW_KEY = 'mycel.sidebar.historyView.v2'
/** 2026-11-12 to 11-14 the default was Group by: Project, so what this key kept never held a grouping (the default was
 * left out): its other choices are kept, and the grouping is the new default (a "project" here was never chosen) */
const PROJECT_DEFAULT_KEY = 'mycel.sidebar.historyView'
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
export const rememberedView = (key = VIEW_KEY, base: RecentsView = DEFAULT_VIEW): RecentsView => {
  try {
    const kept = localStorage.getItem(key)
    const between = kept === null && key === VIEW_KEY ? localStorage.getItem(PROJECT_DEFAULT_KEY) : null
    const v = JSON.parse(kept ?? between ?? (key === VIEW_KEY ? localStorage.getItem(OLD_VIEW_KEY) : null) ?? '{}') as Partial<RecentsView>
    // an older key's grouping is the default it had then, never a choice: the new default takes its place
    if (kept === null && key === VIEW_KEY && (between !== null ? v.group === 'project' : v.group === 'date')) delete v.group
    const out = { ...base }
    for (const k of Object.keys(VIEW) as ViewKey[]) if (v[k] && v[k] in VIEW[k].options) (out as Record<string, string>)[k] = v[k] as string
    return out
  } catch {
    return base
  }
}

/** Status "Confidential" means something only where chats are marked: while Safe operations 1A is on for this server
 * (Me.server.allChatsConfidential, every chat) or where a 1A workflow worked in a chat (server/src/safe-ops/confidential.ts
 * markConfidentialTurn; nobody marks one by hand). Elsewhere it was an option that always showed nothing (TC-1031). */
export const showsConfidential = (o: { safeOps: boolean; chats: readonly Pick<Chat, 'confidential'>[] }) => o.safeOps || o.chats.some((c) => c.confidential)
function useConfidentialOption() {
  const safeOps = !!useMe()?.server.allChatsConfidential
  const chats = useChats((s) => s.chats)
  return showsConfidential({ safeOps, chats })
}
/** a menu's choices, without "Confidential" where it means nothing (`confidential` false) */
export const viewOptions = (k: ViewKey, confidential: boolean): [string, MessageKey][] =>
  Object.entries(VIEW[k].options as Record<string, MessageKey>).filter(([id]) => confidential || k !== 'status' || id !== 'confidential')
/** the view in use: a kept "Confidential" whose option is not shown is "Active" (kept as it was in this browser: it is
 * back when the option is, and a list still loading does not lose it) */
export const shownView = (v: RecentsView, confidential: boolean): RecentsView => (!confidential && v.status === 'confidential' ? { ...v, status: 'all' } : v)

const remember = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* not kept */
  }
}
/** my pinned chats, the most recently pinned first (docs/DECISIONS.md "Pinned chats") */
const pinnedFirst = (list: Chat[]) => list.filter((c) => c.pinnedAt).sort((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!))

/** The history's filter and sort (four menus), remembered in this browser as what differs from the default. `o`: a list
 * with a default of its own (the phone's ☰ drawer: by date, as before the navigation redesign) and its own key. */
export function useRecentsView(o: { key?: string; base?: Partial<RecentsView> } = {}) {
  const key = o.key ?? VIEW_KEY
  const base = useMemo(() => ({ ...DEFAULT_VIEW, ...o.base }), [o.base?.group, o.base?.sort, o.base?.status, o.base?.activity]) // eslint-disable-line react-hooks/exhaustive-deps
  const [kept, setViewState] = useState<RecentsView>(() => rememberedView(key, base))
  const confidential = useConfidentialOption()
  const view = useMemo(() => shownView(kept, confidential), [kept, confidential])
  const setView = useCallback((v: RecentsView) => {
    setViewState(v)
    remember(key, JSON.stringify(Object.fromEntries((Object.keys(VIEW) as ViewKey[]).filter((k) => v[k] !== base[k]).map((k) => [k, v[k]]))))
  }, [key, base])
  const changed = (Object.keys(VIEW) as ViewKey[]).filter((k) => view[k] !== base[k])
  return { view, setView, changed, base }
}
export type RecentsViewState = ReturnType<typeof useRecentsView>
/** the choices that differ from the default, in words ("Waiting, Title") */
export const viewWords = (s: RecentsViewState, t: ReturnType<typeof useT>) => s.changed.map((k) => t((VIEW[k].options as Record<string, MessageKey>)[s.view[k]])).join(', ')
export const DEFAULT_RECENTS_VIEW = DEFAULT_VIEW

/**
 * The whole history as the filter and sort in the panel's header choose it (`viewState`; the list has no title row of
 * its own). `peek` is the hover quick view of the column it sits in.
 */
/** `caps`: the Trina panel's grouped view (by hand, "Group by: Project"): at most five projects and three rows each,
 * "N more" and "Show all projects" (docs/DECISIONS.md "Trina history by project"); none: every project, every row (the
 * phone's drawer) */
export function HistoryList({ onNavigate, peek, viewState, caps }: { onNavigate: () => void; peek: ChatPeek; viewState: RecentsViewState; caps?: { projects: number; rows: number } }) {
  const t = useT()
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
  // the first read is shared with the rail's marks (lib/chatListLoad.ts)
  const readChats = useCallback(() => loadChatList().then(() => setChatsError(null), (e: unknown) => setChatsError(e ?? new Error('failed'))), [])
  useEffect(() => {
    if (!loaded) void readChats()
  }, [loaded, readChats])

  const { view } = viewState
  const requests = useChats((s) => s.requests)
  // session markers as this window sees them: the chats with a card open here, the chat on screen in a visible window
  const cards = useMemo(() => cardChats(requests), [requests])
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  // the whole history as the filter and sort choose it: a chat made only to hold attachments (a file attached, nothing
  // sent yet) is not a conversation yet; pinned chats come first, without a header (`pinnedRows`), the rest follow by
  // project, by date or in one list
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
  // the history by project (docs/DECISIONS.md "Trina history by project"); without a chat in a project there are no
  // headers: the plain list, by date or in one list
  // capped, a task's runs count as one row (its newest run stands for them)
  const openChat = /^\/c\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null
  const groupRows = useMemo(() => (caps ? newestRunsOnly(filtered) : filtered), [caps, filtered])
  const groupCaps = useMemo(() => (caps ? { ...caps, open: openChat } : {}), [caps?.projects, caps?.rows, openChat]) // eslint-disable-line react-hooks/exhaustive-deps
  const byProject = useHistoryGroups(groupRows, groupCaps)
  const grouped = byProject.grouped && view.group === 'project'
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
  const row = (c: Chat) => <ChatItem key={c.id} chat={c} onNavigate={onNavigate} peek={peek} onMove={setMoving} />

  return (
    <>
      <div ref={listRef} data-testid="recents-list">
        {/* the chats, and the projects the person sees for their headers (one read): no flat list first */}
        {(!loaded || !byProject.ready) && !chatsError && <Loader2 size={16} className="mx-auto mt-4 animate-spin text-faint" aria-label={t('common.loading')} />}
        {!loaded && !!chatsError && <LoadError error={chatsError} onRetry={readChats} what="chats" minor className="mx-1 mt-2" />}
        {loaded && !chats.some((c) => !isUnused(c)) && <p className="px-3 py-2 text-sm text-faint">{t('sidebar.noChats')}</p>}
        {loaded && chats.some((c) => !isUnused(c)) && !filtered.length && !pinnedRows.length && (
          <p className="px-3 py-2 text-sm text-faint" data-testid="recents-no-match">
            {t('sidebar.filter.none')}
          </p>
        )}
        {byProject.ready && pinnedRows.length > 0 && (
          <ul className="mb-2" data-testid="ai-chats-pinned">
            {pinnedRows.map(row)}
          </ul>
        )}
        {byProject.ready && grouped && <HistoryGroups state={byProject} row={row} pool={filtered} onNavigate={onNavigate} menuSpace />}
        {byProject.ready && !grouped && dateGroups.map(([key, { label, items }]) => {
          // a date whose chats were all runs of a task whose newest run is in a later date: no empty header
          const rows = foldRuns(items, row, { pool: filtered, menuSpace: true })
          return rows.length > 0 && (
            <div key={key || 'all'} className="mb-2">
              {label && <h3 className="px-3 pt-2 pb-1 text-meta font-medium text-faint">{label}</h3>}
              <ul>{rows}</ul>
            </div>
          )
        })}
        {cursor && (
          <button
            type="button"
            className="w-full rounded-lg px-3 py-1.5 text-left text-meta text-muted hover:bg-hover"
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

/** Filter and sort in the Trina list's header, like Claude's: a square button (a dot when something is not at its default) that
 * opens a menu of four rows (Status, Last activity | Group by, Sort by), each with its current value and a submenu of
 * choices. Keyboard: Enter opens it, arrows move, → or Enter opens a submenu, ← or Esc goes back, Esc closes. The
 * menus sit in <body> (the list scrolls and would clip them); on a narrow screen a submenu takes the menu's
 * place with a way back. A phone (below 768px): bottom sheets instead (RecentsSheet). */
export function RecentsMenu(props: { view: RecentsView; onChange: (v: RecentsView) => void; changed: boolean }) {
  const phone = useMediaQuery('(max-width: 767.98px)')
  const confidential = useConfidentialOption()
  return phone ? <RecentsSheet {...props} confidential={confidential} /> : <RecentsDropdown {...props} confidential={confidential} />
}
type MenuProps = { view: RecentsView; onChange: (v: RecentsView) => void; changed: boolean; confidential: boolean }

/** A phone: the same four rows as a bottom sheet (rooms/MenuButton.tsx), each with its value; a row opens
 * its choices as a second sheet, the chosen one ticked, instead of a menu beside the menu. */
function RecentsSheet({ view, onChange, changed, confidential }: MenuProps) {
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
          items={viewOptions(sub, confidential).map(([id, label]) => ({
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

function RecentsDropdown({ view, onChange, changed, confidential }: MenuProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<ViewKey | null>(null)
  /** the submenu does not fit beside the menu (a narrow window): it takes the menu's place, with a way back */
  const [narrow, setNarrow] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const subMenu = useRef<HTMLDivElement>(null)
  const close = (focus: boolean) => {
    setOpen(false)
    setSub(null)
    setNarrow(false)
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
  /** The boxes put in their places, measured as they are drawn (they are as wide as their longest choice: the app's
   * menu box, rooms/MenuButton.tsx menuBoxCls): the menu under the button as every menu (menuSpot), its submenu beside
   * the row it belongs to (right of the menu, else left of it), kept inside the window; where it fits on neither side it
   * takes the menu's place. */
  const place = () => {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight
    const at = (el: HTMLElement, x: number, y: number) => {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
    const size = (el: HTMLElement) => {
      at(el, 0, 0)
      return el.getBoundingClientRect()
    }
    const b = button.current?.getBoundingClientRect()
    const m = menu.current, s = subMenu.current
    if (!b) return
    if (m) {
      const { x, y } = menuSpot(b, size(m), { width: vw, height: vh })
      at(m, x, y)
    }
    if (!s || !sub) return
    const o = size(s)
    if (!m) {
      const { x, y } = menuSpot(b, o, { width: vw, height: vh })
      return at(s, x, y)
    }
    const r = m.getBoundingClientRect()
    const right = r.right + 4, left = r.left - 4 - o.width
    const x = right + o.width <= vw - MENU_EDGE ? right : left >= MENU_EDGE ? left : null
    if (x === null) return setNarrow(true)
    // its first choice level with the row (the box's padding and border above it)
    const rowTop = m.querySelector<HTMLElement>(`[data-view="${sub}"]`)?.getBoundingClientRect().top ?? r.top
    at(s, x, Math.max(MENU_EDGE, Math.min(rowTop - 5, vh - o.height - MENU_EDGE)))
  }
  useLayoutEffect(() => {
    if (open) place()
  })
  useEffect(() => {
    if (!open) return
    const resized = () => {
      setNarrow(false)
      place()
    }
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sub])
  const back = () => {
    const k = sub
    setSub(null)
    setNarrow(false)
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
  // the app's menu box and row (rooms/MenuButton.tsx): as wide as the longest choice, rows that grow with their words
  const row = clsx(menuRowCls, 'hover:bg-hover focus-visible:-outline-offset-2')
  const panel = clsx('fixed z-50', menuBoxCls)
  return (
    <div className="ml-auto" onKeyDown={onKey}>
      <Tooltip label={t('sidebar.filter')}>
        <button
          ref={button}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('sidebar.filter')}
          onClick={() => (open ? close(false) : setOpen(true))}
          className={clsx('relative flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink', open && 'bg-hover text-ink')}
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
            {(!narrow || !sub) && (
              <div ref={menu} role="menu" aria-label={t('sidebar.filter')} className={panel} data-testid="recents-filter-menu">
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
                      className={clsx(row, 'text-ink', sub === k && 'bg-hover')}
                      data-testid={`recents-view-${k}`}
                    >
                      <span>{t(VIEW[k].label)}</span>
                      <span className="ml-auto pl-2 text-xs text-faint">{t((VIEW[k].options as Record<string, MessageKey>)[view[k]])}</span>
                      <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {sub && (
              <div ref={subMenu} role="menu" aria-label={t(VIEW[sub].label)} className={panel} data-testid="recents-submenu">
                {narrow && (
                  <button type="button" role="menuitem" onClick={back} className={clsx(row, 'text-faint')}>
                    <ChevronRight size={14} className="shrink-0 rotate-180" aria-hidden /> {t(VIEW[sub].label)}
                  </button>
                )}
                {viewOptions(sub, confidential).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={view[sub] === id}
                    onClick={() => {
                      onChange({ ...view, [sub]: id })
                      back()
                    }}
                    className={clsx(row, 'text-ink')}
                    data-testid={`recents-${sub}-${id}`}
                  >
                    <span className="min-w-0 flex-1">{t(label)}</span>
                    <Check size={14} className={clsx('shrink-0 text-accent-text', view[sub] !== id && 'invisible')} aria-hidden />
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
