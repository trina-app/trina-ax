// Left sidebar, sized like Claude's (280 px, 14 px rows of 36 px, 16 px icons), people first (docs/DECISIONS.md "Desktop
// sidebar: rooms first"): the team's name on top, then one labeled row each (the owner, 2026-11-07: no icon row):
// "트리나에게 묻기" (a new AI chat, ⇧⌘O), 검색 (⌘K), 프로젝트, 예약 작업, 알림함 (its count on the row), 파일, 팀 스킬, and
// 관리자 for owners and admins; then one scroll with two strictly capped sections: "대화" (rooms/SidebarRooms.tsx: the
// five latest rooms and the room on screen, "더 보기 (N)" for the rest with what is unread there) and "트리나 기록" (the
// AI's history: the five latest and the chat on screen, "모두 보기" for the whole of it with its filters, with "답 필요 K"
// when hidden chats show a "?" or a dot; one session marker per row from the chat list itself, chat/ChatState.tsx: "?", a
// spinner or a dot), so the AI never sinks under many rooms. Onboarding's setup row (onboarding/SetupRow.tsx) has its
// own row between the two. People and the AI never share a word: no bare "채팅" here. Each folds, and each one's whole
// list stays open or closed, remembered in this browser. Then the account menu (the person's email or ID, Settings,
// Usage (their own, in Settings), Appearance, Deleted history, Sign out), which opens above the profile line. Below
// 768 px it is the 트리나 tab's drawer, the AI's history only (☰ in the phone's top bar on Home): the AI's name on top,
// 검색, 프로젝트, 예약 작업, 팀 스킬, 트리나 기록, and 삭제한 기록 at the bottom. A new AI chat is the 트리나 tab itself, the
// Inbox and Admin are in the 나 tab, 파일 is its own tab and the rooms are the 대화 tab; rows are 44 px there.
import clsx from 'clsx'
import { Bell, BookMarked, CalendarClock, Check, ChevronDown, ChevronRight, FolderKanban, FolderOpen, Gauge, ListFilter, Loader2, LogOut, MessageSquarePlus, MoreHorizontal, Palette, Pencil, Search, Settings, Shield, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import type { Chat, Theme } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { dateBucket, formatRelative, type DateBucket } from '../lib/format'
import { aiName } from '../lib/tabs'
import { useLogout } from '../lib/logout'
import { platform } from '../lib/pwa'
import { useLocale, useT, type MessageKey } from '../i18n'
import { markerOf, needsMe, waitingOrRunning, type MarkerView } from '../lib/sessionMarkers'
import { useChats } from '../store/chats'
import { useInboxUnread } from '../store/inbox'
import { cardChats, useSessionMarkers } from '../store/sessionMarkers'
import { isAdmin, useMeStrict, useSession } from '../store/session'
import { useUi } from '../store/ui'
import { Avatar } from './Avatar'
import { useChatActions } from './chat/chatActions'
import { isUnused, SessionMarker, useChatMarker } from './chat/ChatState'
import { SidebarRooms } from './rooms/SidebarRooms'
import { SetupRow } from './onboarding/SetupRow'
import { useMediaQuery } from './ui'
import { settingsOpenedFrom } from './settings/SettingsDialog'

/** shortcut hints in the keys of this computer (the handlers take ⌘ and Ctrl alike, Layout.tsx) */
const onMac = () => platform() === 'mac' || platform() === 'ios'

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
const DEFAULT_VIEW: RecentsView = { status: 'all', activity: 'all', group: 'date', sort: 'updated' }
const VIEW_KEY = 'mycel.sidebar.recentsView'
const DAY = 86_400_000
const passes = (v: RecentsView, c: Chat, seen: MarkerView, now: number) => {
  const s = v.status
  const ok = s === 'waiting' ? waitingOrRunning(c, seen) : s === 'project' ? !!c.projectId : s === 'noProject' ? !c.projectId : s === 'confidential' ? !!c.confidential : true
  const age = now - new Date(c.updatedAt).getTime()
  const fresh = v.activity === 'today' ? dateBucket(c.updatedAt) === 'today' : v.activity === 'week' ? age <= 7 * DAY : v.activity === 'month' ? age <= 30 * DAY : true
  return ok && fresh
}
const rememberedView = (): RecentsView => {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<RecentsView>
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
/** a computer: AI chats shown before "모두 보기" */
const LATEST = 5

export default function Sidebar() {
  const t = useT()
  // the column beside the page (a computer) or the phone's drawer: the drawer keeps the phone's own layout
  const wide = useMediaQuery('(min-width: 768px)')
  // the whole history opened ("모두 보기"), remembered in this browser like the fold
  const [allChats, setAllChatsState] = useState(() => remembered(ALL_KEY, ['yes', 'no'] as const, 'no') === 'yes')
  const setAllChats = (v: boolean) => (remember(ALL_KEY, v ? 'yes' : 'no'), setAllChatsState(v))
  const me = useMeStrict()
  const chats = useChats((s) => s.chats)
  const loaded = useChats((s) => s.chatsLoaded)
  const cursor = useChats((s) => s.chatsCursor)
  const loadChats = useChats((s) => s.loadChats)
  const setDrawer = useUi((s) => s.setDrawer)
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const navigate = useNavigate()
  const [more, setMore] = useState(false)

  useEffect(() => {
    if (!loaded) void loadChats(true).catch(() => {})
  }, [loaded, loadChats])

  const [recentsOpen, setRecentsOpen] = useState(() => remembered(OPEN_KEY, ['open', 'closed'] as const, 'open') === 'open')
  const [view, setViewState] = useState<RecentsView>(rememberedView)
  const setView = (v: RecentsView) => {
    setViewState(v)
    remember(VIEW_KEY, JSON.stringify(v))
  }
  const changed = (Object.keys(VIEW) as ViewKey[]).filter((k) => view[k] !== DEFAULT_VIEW[k])
  const requests = useChats((s) => s.requests)
  // session markers as this window sees them: the chats with a card open here, the chat on screen in a visible window
  const cards = useMemo(() => cardChats(requests), [requests])
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  // project names, only when Recents is grouped by project (one read, kept while the sidebar is there)
  const [projects, setProjects] = useState<Map<string, string> | null>(null)
  useEffect(() => {
    if (view.group !== 'project' || projects) return
    api.call(API.listProjects).then((r) => setProjects(new Map(r.items.map((p) => [p.id, p.name]))), () => setProjects(new Map()))
  }, [view.group, projects])
  const groups = useMemo(() => {
    const now = Date.now()
    // a chat made only to hold attachments (a file attached, nothing sent yet) is not a conversation yet
    const shown = chats.filter((c) => !isUnused(c) && passes(view, c, { card: cards.has(c.id), here: c.id === here }, now))
    const when = (c: Chat) => (view.sort === 'created' ? c.createdAt : c.updatedAt)
    shown.sort((a, b) => (view.sort === 'title' ? (a.title || '').localeCompare(b.title || '') : when(b).localeCompare(when(a))))
    const g = new Map<string, { label: string | null; items: Chat[] }>()
    for (const c of shown) {
      const key = view.group === 'date' ? dateBucket(when(c)) : view.group === 'project' ? (c.projectId ?? '') : ''
      const label = view.group === 'date' ? t(BUCKET_LABEL[key as DateBucket]) : view.group === 'project' ? (c.projectId ? (projects?.get(c.projectId) ?? '…') : t('sidebar.noProject')) : null
      if (!g.has(key)) g.set(key, { label, items: [] })
      g.get(key)!.items.push(c)
    }
    return [...g.entries()]
  }, [chats, view, cards, here, projects, t])
  const listId = useId()
  const peek = useChatPeek()
  // a computer: the five latest AI chats and the chat on screen, unless the whole history is open (or filtered)
  const used = useMemo(() => chats.filter((c) => !isUnused(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [chats])
  const openChat = /^\/c\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null
  const latest = useMemo(() => used.filter((c, i) => i < LATEST || c.id === openChat), [used, openChat])
  // the hidden chats that need me, counted on "모두 보기" as their rows would show them (session markers: a "?" or a dot,
  // not a spinner: a chat that runs again shows the spinner); amber when one of them is a "?"
  const hiddenNeeds = useMemo(() => {
    const marks = used.filter((c) => !latest.includes(c)).map((c) => markerOf(c, { card: cards.has(c.id), here: c.id === here })).filter(needsMe)
    return { n: marks.length, waiting: marks.some((m) => m!.kind === 'ask') }
  }, [used, latest, cards, here])
  const full = !wide || allChats || changed.length > 0
  const toggleRecents = () => setRecentsOpen((v) => (remember(OPEN_KEY, v ? 'closed' : 'open'), !v))

  const close = () => setDrawer(false)
  // unread inbox notifications: a count next to "Inbox" (the list itself is in Settings > Notifications)
  const unread = useInboxUnread()
  const nav = 'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-ink hover:bg-hover max-md:h-11'
  const active = ({ isActive }: { isActive: boolean }) => clsx(nav, isActive && 'bg-hover font-medium')

  return (
    <nav aria-label={t('sidebar.label')} className="flex h-full w-full flex-col bg-subtle">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <Link to="/" onClick={close} className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" aria-hidden className="size-5 rounded-md" />
          {/* the phone's drawer is the AI's history: the AI's one name there, as on its tab */}
          <span className="truncate max-md:hidden" data-testid="sidebar-team">{me.team.name}</span>
          <span className="md:hidden">{aiName(t)}</span>
        </Link>
      </div>
      {wide ? (
        <DesktopNav unread={unread} onNewChat={() => navigate('/')} onSearch={() => setSearchOpen(true)} />
      ) : (
        // the phone drawer: the AI's history only (파일, the Inbox and Admin are tabs or in the 나 tab there)
        <div className="space-y-0.5 px-2">
          <button type="button" className={clsx(nav, 'w-full')} onClick={() => setSearchOpen(true)}>
            <Search size={16} aria-hidden /> {t('sidebar.search')}
          </button>
          <NavLink to="/projects" className={active} onClick={close}>
            <FolderKanban size={16} aria-hidden /> {t('sidebar.projects')}
          </NavLink>
          <NavLink to="/scheduled" className={active} onClick={close} data-testid="nav-scheduled">
            <CalendarClock size={16} aria-hidden /> {t('sidebar.scheduled')}
          </NavLink>
          <NavLink to="/skills" className={active} onClick={close} data-testid="nav-skills">
            <BookMarked size={16} aria-hidden /> {t('sidebar.skills')}
          </NavLink>
        </div>
      )}

      {/* one scroll, like Slack's: 대화 (a computer) and 트리나 기록, each capped at five with the rest behind its button */}
      <div className="scroll-thin mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2" onScroll={peek.hide} data-testid="sidebar-scroll">
        {wide && <SidebarRooms onNavigate={close} />}
        {/* the owner's way back to the welcome steps (onboarding/SetupRow.tsx): its own row between the sections */}
        <SetupRow onNavigate={close} />
        <div className="group/recents flex items-center gap-1 pr-1 pl-3" data-testid="recents-head">
          <h2 className="text-xs font-medium text-faint">
            <button type="button" aria-expanded={recentsOpen} aria-controls={listId} onClick={toggleRecents} className="flex items-center gap-1 rounded py-1 hover:text-muted" data-testid="recents-toggle">
              {t('sidebar.aiChats', { name: aiName(t) })}
              <ChevronDown size={12} className={clsx('transition-transform', !recentsOpen && '-rotate-90')} aria-hidden />
            </button>
          </h2>
          {changed.length > 0 && (
            <span className="flex min-w-0 items-center gap-0.5 text-xs text-faint" data-testid="recents-filter-label">
              <span aria-hidden>·</span>
              <span className="truncate">{changed.map((k) => t((VIEW[k].options as Record<string, MessageKey>)[view[k]])).join(', ')}</span>
              <button type="button" onClick={() => setView(DEFAULT_VIEW)} aria-label={t('sidebar.filter.clear')} title={t('sidebar.filter.clear')} className="shrink-0 rounded p-0.5 hover:bg-hover hover:text-ink" data-testid="recents-filter-clear">
                <X size={11} aria-hidden />
              </button>
            </span>
          )}
          <RecentsMenu view={view} onChange={setView} changed={changed.length > 0} />
        </div>
        <div id={listId} hidden={!recentsOpen} data-testid="recents-list">
          {!loaded && <Loader2 size={16} className="mx-auto mt-4 animate-spin text-faint" aria-label={t('common.loading')} />}
          {loaded && !chats.some((c) => !isUnused(c)) && <p className="px-3 py-2 text-sm text-faint">{t('sidebar.noChats')}</p>}
          {loaded && chats.some((c) => !isUnused(c)) && !groups.length && (
            <p className="px-3 py-2 text-sm text-faint" data-testid="recents-no-match">
              {t('sidebar.filter.none')}
            </p>
          )}
          {!full && (
            <ul data-testid="ai-chats-latest">
              {latest.map((c) => (
                <ChatItem key={c.id} chat={c} onNavigate={close} peek={peek} />
              ))}
            </ul>
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
          {full && groups.map(([key, { label, items }]) => (
            <div key={key || 'all'} className="mb-2">
              {label && <h3 className="px-3 pt-2 pb-1 text-micro font-medium text-faint">{label}</h3>}
              <ul>
                {items.map((c) => (
                  <ChatItem key={c.id} chat={c} onNavigate={close} peek={peek} />
                ))}
              </ul>
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
          {wide && allChats && (
            <button type="button" onClick={() => setAllChats(false)} className="flex h-8 w-full items-center rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="ai-chats-less">
              {t('common.less')}
            </button>
          )}
        </div>
      </div>
      {peek.card}
      {wide ? (
        <AccountMenu />
      ) : (
        // phones: the account menu's Deleted chats, at the end of the history
        <div className="border-t border-line p-2">
          <NavLink to="/trash" className={active} onClick={close} data-testid="nav-trash">
            <Trash2 size={16} aria-hidden /> {t('sidebar.trash')}
          </NavLink>
        </div>
      )}
    </nav>
  )
}

/** A computer: the seven rows of before in two. A new AI chat (with its shortcut) and search share one row; files,
 * projects, scheduled tasks, team skills, the Inbox (its count on the bell) and Admin (owners and admins) are one row of
 * icons. Each icon is a link with its name as its label (the Inbox's with the count, so a screen reader says it) and a
 * tooltip on hover and on keyboard focus. Team skills has no count of its own: a suggestion is an Inbox notice already. */
function DesktopNav({ unread, onNewChat, onSearch }: { unread: number; onNewChat: () => void; onSearch: () => void }) {
  const t = useT()
  const me = useMeStrict()
  const nav = 'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-ink hover:bg-hover'
  const active = ({ isActive }: { isActive: boolean }) => clsx(nav, isActive && 'bg-hover font-medium')
  const kbd = 'ml-auto hidden font-sans text-micro text-faint lg:inline'
  // one labeled row each, in the order they had before the icon row (the owner, 2026-11-07)
  return (
    <div className="space-y-0.5 px-2" data-testid="nav-rows">
      <button type="button" className={clsx(nav, 'w-full font-medium')} onClick={onNewChat} data-testid="new-chat">
        <MessageSquarePlus size={16} className="shrink-0 text-accent-text" aria-hidden /> <span className="truncate">{t('sidebar.askAi', { name: aiName(t) })}</span>
        <kbd className={kbd}>{onMac() ? '⇧⌘O' : 'Ctrl+Shift+O'}</kbd>
      </button>
      <button type="button" className={clsx(nav, 'w-full')} aria-keyshortcuts={onMac() ? 'Meta+K' : 'Control+K'} onClick={onSearch} data-testid="nav-search">
        <Search size={16} aria-hidden /> {t('sidebar.search')}
        <kbd className={kbd}>{onMac() ? '⌘K' : 'Ctrl+K'}</kbd>
      </button>
      <NavLink to="/projects" className={active} data-testid="nav-projects">
        <FolderKanban size={16} aria-hidden /> {t('sidebar.projects')}
      </NavLink>
      <NavLink to="/scheduled" className={active} data-testid="nav-scheduled">
        <CalendarClock size={16} aria-hidden /> {t('sidebar.scheduled')}
      </NavLink>
      <NavLink to="/settings/notifications" className={active} onClick={(e) => settingsOpenedFrom(e.currentTarget)} data-testid="nav-inbox">
        <Bell size={16} aria-hidden /> {t('inbox.title')}
        {unread > 0 && (
          // aria-label on a plain span is not read: the number is hidden from screen readers and the words are sr-only
          <span className="ml-auto rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink" data-testid="inbox-unread">
            <span aria-hidden>{unread > 99 ? '99+' : unread}</span>
            <span className="sr-only">{t('notifications.unread', { count: unread })}</span>
          </span>
        )}
      </NavLink>
      <NavLink to="/files" className={active} data-testid="nav-files">
        <FolderOpen size={16} aria-hidden /> {t('sidebar.files')}
      </NavLink>
      <NavLink to="/skills" className={active} data-testid="nav-skills">
        <BookMarked size={16} aria-hidden /> {t('sidebar.skills')}
      </NavLink>
      {isAdmin(me) && (
        <NavLink to="/admin" className={active} data-testid="nav-admin">
          <Shield size={16} aria-hidden /> {t('sidebar.admin')}
        </NavLink>
      )}
    </div>
  )
}

function ChatItem({ chat, onNavigate, peek }: { chat: Chat; onNavigate: () => void; peek: ChatPeek }) {
  const t = useT()
  const [menu, setMenu] = useState(false)
  const actions = useChatActions()
  // "?" your turn, a grey ring while it runs, a dot for a new answer; nothing on an idle row. A row that needs me ("?" or
  // the dot: what "답 필요" and the one count hold) reads in ink, the others stay muted
  const { marker, reason } = useChatMarker(chat)
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!menu) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [menu])

  const rename = () => {
    setMenu(false)
    void actions.rename(chat)
  }
  const del = () => {
    setMenu(false)
    void actions.remove(chat)
  }

  return (
    <li ref={ref} className="group relative" onMouseEnter={(e) => peek.soon(chat, e.currentTarget, 400)} onMouseLeave={peek.hide} data-marker={marker?.kind}>
      <NavLink
        to={`/c/${chat.id}`}
        onClick={() => {
          peek.hide()
          onNavigate()
        }}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && peek.soon(chat, ref.current!, 600)}
        onBlur={peek.hide}
        onKeyDown={(e) => e.key === 'Escape' && peek.hide()}
        className={({ isActive }) =>
          clsx('flex h-9 items-center gap-2 rounded-lg pr-9 pl-3 text-sm hover:bg-hover max-md:h-11 max-md:pr-11', marker && 'max-md:pr-17', isActive ? 'bg-hover font-medium text-ink' : needsMe(marker) ? 'font-medium text-ink' : 'text-muted')
        }
      >
        <span className="truncate">{chat.title || t('chat.untitled')}</span>
        {marker && (
          // one marker at the right end (session markers): its reason is part of the link's name. On a computer it sits in
          // the "···" spot, its right edge in line with the rooms' pills above, and gives way to "···" on hover and focus;
          // on a phone "···" always shows and it sits left of it
          <span className={clsx('pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center max-md:right-11', menu ? 'opacity-0' : 'md:group-focus-within:opacity-0 md:group-hover:opacity-0')} data-testid="chat-marker">
            <SessionMarker marker={marker} label={reason} />
          </span>
        )}
      </NavLink>
      <button
        type="button"
        aria-label={t('chat.menu')}
        aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}
        className={clsx('absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-faint hover:bg-surface hover:text-ink max-md:right-0 max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center', menu ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100')}
      >
        <MoreHorizontal size={15} aria-hidden />
      </button>
      {menu && (
        <div role="menu" className="absolute top-8 right-1 z-30 w-40 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <button role="menuitem" type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-hover" onClick={rename}>
            <Pencil size={14} aria-hidden /> {t('chat.rename')}
          </button>
          <button role="menuitem" type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-danger hover:bg-danger-soft" onClick={del}>
            <Trash2 size={14} aria-hidden /> {t('common.delete')}
          </button>
        </div>
      )}
    </li>
  )
}

/** The profile line at the bottom and its menu above it, like Claude's: who is signed in, then Settings (a dialog over
 * the page, components/settings/SettingsDialog.tsx), Usage (their own usage in Settings; the team's is Admin > Usage),
 * Appearance (the theme, chosen right there), Deleted chats and Sign out. Arrow keys, Home and End move in the menu; Esc
 * closes it and gives the keyboard back. */
function AccountMenu() {
  const t = useT()
  const me = useMeStrict()
  const [open, setOpen] = useState(false)
  const [appearance, setAppearance] = useState(false)
  const setTheme = useSession((s) => s.setTheme)
  const setDrawer = useUi((s) => s.setDrawer)
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const theme: Theme = me.user.prefs.theme ?? 'system'
  const hide = (focusBack: boolean) => {
    setOpen(false)
    setAppearance(false)
    if (focusBack) button.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && hide(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const onKey = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      hide(true)
      return
    }
    if (e.key === 'Tab') return hide(false)
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      items[(n + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(-1)
  }
  const logout = useLogout()
  const item = 'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-ink hover:bg-hover focus-visible:-outline-offset-2'
  return (
    <div ref={ref} className="relative border-t border-line p-2" onKeyDown={onKey}>
      {open && (
        <div ref={menu} role="menu" aria-label={me.user.name} className="absolute right-2 bottom-full left-2 z-30 mb-1 rounded-xl border border-line bg-surface p-1.5 shadow-lg" data-testid="account-dropdown">
          <p className="truncate px-2.5 pt-1 pb-1.5 text-xs text-faint" data-testid="account-who">
            {me.user.email || me.user.username}
          </p>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              settingsOpenedFrom(button.current)
              hide(false)
              setDrawer(false)
              navigate('/settings')
            }}
            data-testid="account-settings"
          >
            <Settings size={16} className="text-muted" aria-hidden /> {t('sidebar.settings')}
          </button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              settingsOpenedFrom(button.current)
              hide(false)
              setDrawer(false)
              navigate('/settings/usage')
            }}
            data-testid="account-usage"
          >
            <Gauge size={16} className="text-muted" aria-hidden /> {t('sidebar.usage')}
          </button>
          <button role="menuitem" type="button" aria-expanded={appearance} className={item} onClick={() => setAppearance((v) => !v)} data-testid="account-appearance">
            <Palette size={16} className="text-muted" aria-hidden /> {t('sidebar.appearance')}
            <ChevronRight size={14} className={clsx('ml-auto text-faint transition-transform', appearance && 'rotate-90')} aria-hidden />
          </button>
          {appearance && (
            <div role="group" aria-label={t('sidebar.appearance')} className="pl-6">
              {(['system', 'light', 'dark'] as Theme[]).map((x) => (
                <button key={x} role="menuitemradio" aria-checked={theme === x} type="button" className={clsx(item, 'h-8')} onClick={() => void setTheme(x).catch(() => {})} data-testid={`account-theme-${x}`}>
                  {t(`settings.theme.${x}`)}
                  {theme === x && <Check size={14} className="ml-auto text-accent-text" aria-hidden />}
                </button>
              ))}
            </div>
          )}
          <Link
            role="menuitem"
            to="/trash"
            onClick={() => {
              hide(false)
              setDrawer(false)
            }}
            className={item}
            data-testid="account-trash"
          >
            <Trash2 size={16} className="text-muted" aria-hidden /> {t('sidebar.trash')}
          </Link>
          <div role="separator" className="mx-1 my-1.5 border-t border-line" />
          <button role="menuitem" type="button" onClick={logout} className={item} data-testid="logout">
            <LogOut size={16} className="text-muted" aria-hidden /> {t('auth.logout')}
          </button>
        </div>
      )}
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => (open ? hide(false) : setOpen(true))}
        className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-hover"
        data-testid="account-menu"
      >
        <Avatar user={me.user} size={24} />
        {/* the team's name is on top of the sidebar (a computer), not said twice here */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="truncate text-sm font-medium">{me.user.name}</span>
        </span>
        <ChevronDown size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
    </div>
  )
}

/** Filter and sort beside "Recents", like Claude's: a square button (a dot when something is not at its default) that
 * opens a menu of four rows (Status, Last activity | Group by, Sort by), each with its current value and a submenu of
 * choices. Keyboard: Enter opens it, arrows move, → or Enter opens a submenu, ← or Esc goes back, Esc closes. The
 * menus sit in <body> (the Recents list scrolls and would clip them); on a narrow screen a submenu takes the menu's
 * place with a way back. */
function RecentsMenu({ view, onChange, changed }: { view: RecentsView; onChange: (v: RecentsView) => void; changed: boolean }) {
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
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('sidebar.filter')}
        title={t('sidebar.filter')}
        onClick={() => (open ? close(false) : openMenu())}
        className={clsx('relative flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink focus-visible:opacity-100 max-sm:opacity-100', open ? 'bg-hover text-ink opacity-100' : changed ? 'opacity-100' : 'opacity-0 group-hover/recents:opacity-100')}
        data-testid="recents-filter"
      >
        <ListFilter size={15} aria-hidden />
        {changed && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" data-testid="recents-filter-dot" />}
      </button>
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

/** The hover quick view of a recent chat, like Claude's: after resting on it (or reaching it with the keyboard), a
 * card beside the sidebar with the start of the last answer or its first file, the title and when. Only where there is
 * a mouse; decorative (aria-hidden: the link already says the title), never in the way (no pointer events), and gone on
 * leave, Esc, a click or a scroll. One read of the last two messages per chat version, kept for the session. */
type ChatPeek = ReturnType<typeof useChatPeek>
/** The peek's first line: the row marker's reason (session markers), as the chat is now (it may have changed since the
 * pointer came). Nothing on an idle chat. */
function PeekReason({ chatId, fallback }: { chatId: string; fallback: Chat }) {
  const chat = useChats((s) => s.chats.find((c) => c.id === chatId)) ?? fallback
  const { marker, reason } = useChatMarker(chat)
  if (!marker) return null
  return (
    <p className={clsx('mb-2 line-clamp-2 text-xs font-medium', marker.kind === 'ask' ? 'text-warn' : marker.kind === 'new' ? 'text-accent-text' : 'text-faint')} data-testid="chat-peek-reason">
      {reason}
    </p>
  )
}
const peeks = new Map<string, Promise<{ text: string; file: string | null }>>()
function peekOf(c: Chat) {
  const key = `${c.id}:${c.updatedAt}`
  let p = peeks.get(key)
  if (!p) {
    p = api.call(API.listMessages, { params: { id: c.id }, query: { limit: 2 } }).then(
      (page) => {
        const items = [...page.items].reverse()
        const answer = items.find((m) => m.role === 'assistant')
        const text = (answer?.content ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240)
        const file = items.flatMap((m) => m.attachments).find(Boolean)?.name ?? null
        return { text, file }
      },
      () => ({ text: '', file: null }),
    )
    peeks.set(key, p)
  }
  return p
}
const canHover = () => typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine) and (min-width: 768px)').matches

function useChatPeek() {
  const t = useT()
  const locale = useLocale()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [shown, setShown] = useState<{ chat: Chat; top: number; left: number } | null>(null)
  const [data, setData] = useState<{ id: string; text: string; file: string | null } | null>(null)
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setShown(null)
  }, [])
  const soon = useCallback((chat: Chat, row: HTMLElement, ms: number) => {
    if (!canHover()) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const r = row.getBoundingClientRect()
      const side = row.closest('nav')?.getBoundingClientRect()
      setShown({ chat, top: Math.max(8, Math.min(r.top - 8, innerHeight - 200)), left: (side?.right ?? r.right) + 8 })
      void peekOf(chat).then((d) => setData({ id: chat.id, ...d }))
    }, ms)
  }, [])
  useEffect(() => {
    if (!shown) return
    const k = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && hide()
    window.addEventListener('keydown', k)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('keydown', k)
      window.removeEventListener('blur', hide)
    }
  }, [shown, hide])
  useEffect(() => hide, [hide])
  const d = shown && data?.id === shown.chat.id ? data : null
  const card = shown
    ? createPortal(
        <div aria-hidden className="pointer-events-none fixed z-40 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg" style={{ top: shown.top, left: shown.left }} data-testid="chat-peek">
          <PeekReason chatId={shown.chat.id} fallback={shown.chat} />
          <div className="mb-2 min-h-12 rounded-lg bg-subtle p-2.5 text-xs text-muted" data-testid="chat-peek-preview">
            {!d ? (
              <span className="block h-3 w-2/3 animate-pulse rounded bg-hover" />
            ) : d.file ? (
              <span className="inline-flex max-w-full items-center rounded-md border border-line bg-surface px-2 py-0.5 text-micro text-ink">
                <span className="truncate">{d.file}</span>
              </span>
            ) : (
              <span className="line-clamp-3">{d.text || t('sidebar.peek.empty')}</span>
            )}
          </div>
          <p className="truncate text-sm font-medium text-ink">{shown.chat.title || t('chat.untitled')}</p>
          <p className="text-xs text-faint">{formatRelative(shown.chat.updatedAt, locale)}</p>
        </div>,
        document.body,
      )
    : null
  return { soon, hide, card }
}
