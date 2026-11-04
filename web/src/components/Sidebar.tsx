// Left sidebar, sized like Claude's (280 px, 14 px rows of 32 px, 16 px icons): new chat, search, projects, files, team
// skills, admin, recent chats by date, and the account menu (the person's email or ID, Settings, Usage for admins,
// Appearance, Deleted chats, Sign out), which opens above the profile line. Below 768 px it is a drawer opened from the top bar.
import clsx from 'clsx'
import { BookMarked, Check, ChevronDown, ChevronRight, FolderKanban, FolderOpen, Gauge, ListFilter, Loader2, LogOut, MessageSquarePlus, MoreHorizontal, Palette, Pencil, Search, Settings, Shield, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import type { Chat, Theme } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { dateBucket, formatRelative, type DateBucket } from '../lib/format'
import { clearLocalData } from '../lib/localData'
import { platform } from '../lib/pwa'
import { useLocale, useT, type MessageKey } from '../i18n'
import { useChats } from '../store/chats'
import { skillsChanged } from '../store/live'
import { isAdmin, useMeStrict, useSession } from '../store/session'
import { useUi } from '../store/ui'
import { useChatActions } from './chat/chatActions'
import { settingsOpenedFrom } from './settings/SettingsDialog'

/** shortcut hints in the keys of this computer (the handlers take ⌘ and Ctrl alike, Layout.tsx) */
const onMac = () => platform() === 'mac' || platform() === 'ios'

const BUCKET_LABEL: Record<DateBucket, MessageKey> = { today: 'sidebar.today', yesterday: 'sidebar.yesterday', week: 'sidebar.week', month: 'sidebar.month', older: 'sidebar.older' }

/** never sent in and never named: created for the attachments of a draft (the composer, "Ask AI about this") */
const isUnused = (c: Chat) => !c.title && c.createdAt === c.updatedAt && c.runState === 'idle'

/** The Recents filter: only what the chat list itself knows. "Active": an answer is running or queued, or the AI is
 * waiting for the person. */
type RecentsFilter = 'all' | 'project' | 'noProject' | 'active' | 'confidential'
const FILTERS: { id: RecentsFilter; label: MessageKey }[] = [
  { id: 'all', label: 'sidebar.filter.all' },
  { id: 'project', label: 'sidebar.filter.project' },
  { id: 'noProject', label: 'sidebar.filter.noProject' },
  { id: 'active', label: 'sidebar.filter.active' },
  { id: 'confidential', label: 'sidebar.filter.confidential' },
]
const passes = (f: RecentsFilter, c: Chat, waiting: boolean) =>
  f === 'project' ? !!c.projectId : f === 'noProject' ? !c.projectId : f === 'active' ? c.runState !== 'idle' || waiting : f === 'confidential' ? !!c.confidential : true

/** This browser remembers whether Recents is open and its filter (a private window may refuse: then it just forgets). */
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
const FILTER_KEY = 'mycel.sidebar.recentsFilter'

export default function Sidebar() {
  const t = useT()
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
  const [filter, setFilterState] = useState<RecentsFilter>(() => remembered(FILTER_KEY, FILTERS.map((f) => f.id), 'all'))
  const setFilter = (f: RecentsFilter) => {
    setFilterState(f)
    remember(FILTER_KEY, f)
  }
  const waiting = useChats((s) => s.requests)
  const groups = useMemo(() => {
    const asked = new Set(Object.values(waiting).map((r) => r.chatId))
    const g = new Map<DateBucket, Chat[]>()
    for (const c of chats) {
      // a chat made only to hold attachments (a file attached, nothing sent yet) is not a conversation yet
      if (isUnused(c)) continue
      if (!passes(filter, c, asked.has(c.id))) continue
      const b = dateBucket(c.updatedAt)
      g.set(b, [...(g.get(b) ?? []), c])
    }
    return [...g.entries()]
  }, [chats, filter, waiting])
  const listId = useId()
  const peek = useChatPeek()

  const close = () => setDrawer(false)
  // suggestions waiting for me (I manage their skills folder): a count next to "팀 스킬"
  const [pendingSkills, setPendingSkills] = useState(0)
  useEffect(() => {
    const load = () => api.call(API.skillsOverview).then((o) => setPendingSkills(o.pendingReview), () => {})
    void load()
    return skillsChanged.on(() => void load())
  }, [])
  const nav = 'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-ink hover:bg-hover max-sm:h-10'
  const active = ({ isActive }: { isActive: boolean }) => clsx(nav, isActive && 'bg-hover font-medium')

  return (
    <nav aria-label={t('sidebar.label')} className="flex h-full w-full flex-col bg-subtle">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <Link to="/" onClick={close} className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" aria-hidden className="size-5 rounded-md" />
          {PRODUCT.displayName}
        </Link>
      </div>
      <div className="space-y-0.5 px-2">
        <button
          type="button"
          className={clsx(nav, 'w-full font-medium')}
          onClick={() => {
            close()
            navigate('/')
          }}
          data-testid="new-chat"
        >
          <MessageSquarePlus size={16} className="text-accent-text" aria-hidden /> {t('sidebar.newChat')}
          <kbd className="ml-auto hidden font-sans text-[11px] text-faint lg:inline">{onMac() ? '⇧⌘O' : 'Ctrl+Shift+O'}</kbd>
        </button>
        <button type="button" className={clsx(nav, 'w-full')} onClick={() => setSearchOpen(true)}>
          <Search size={16} aria-hidden /> {t('sidebar.search')}
          <kbd className="ml-auto hidden font-sans text-[11px] text-faint lg:inline">{onMac() ? '⌘K' : 'Ctrl+K'}</kbd>
        </button>
        <NavLink to="/projects" className={active} onClick={close}>
          <FolderKanban size={16} aria-hidden /> {t('sidebar.projects')}
        </NavLink>
        <NavLink to="/files" className={active} onClick={close}>
          <FolderOpen size={16} aria-hidden /> {t('sidebar.files')}
        </NavLink>
        <NavLink to="/skills" className={active} onClick={close} data-testid="nav-skills">
          <BookMarked size={16} aria-hidden /> {t('sidebar.skills')}
          {pendingSkills > 0 && (
            <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] font-medium text-accent-ink" data-testid="skills-pending" aria-label={t('skills.tabReview')}>
              {pendingSkills}
            </span>
          )}
        </NavLink>
        {isAdmin(me) && (
          <NavLink to="/admin" className={active} onClick={close}>
            <Shield size={16} aria-hidden /> {t('sidebar.admin')}
          </NavLink>
        )}
      </div>

      <div className="scroll-thin mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2" onScroll={peek.hide}>
        <div className="group/recents flex items-center gap-1 pr-1 pl-3">
          <h2 className="text-xs font-medium text-faint">
            <button type="button" aria-expanded={recentsOpen} aria-controls={listId} onClick={() => setRecentsOpen((v) => (remember(OPEN_KEY, v ? 'closed' : 'open'), !v))} className="flex items-center gap-1 rounded py-1 hover:text-muted" data-testid="recents-toggle">
              {t('sidebar.recents')}
              <ChevronDown size={12} className={clsx('transition-transform', !recentsOpen && '-rotate-90')} aria-hidden />
            </button>
          </h2>
          {filter !== 'all' && (
            <span className="flex min-w-0 items-center gap-0.5 text-xs text-faint" data-testid="recents-filter-label">
              <span aria-hidden>·</span>
              <span className="truncate">{t(FILTERS.find((f) => f.id === filter)!.label)}</span>
              <button type="button" onClick={() => setFilter('all')} aria-label={t('sidebar.filter.clear')} title={t('sidebar.filter.clear')} className="rounded p-0.5 hover:bg-hover hover:text-ink" data-testid="recents-filter-clear">
                <X size={11} aria-hidden />
              </button>
            </span>
          )}
          <FilterMenu value={filter} onChange={setFilter} shown={filter !== 'all'} />
        </div>
        <div id={listId} hidden={!recentsOpen} data-testid="recents-list">
          {!loaded && <Loader2 size={16} className="mx-auto mt-4 animate-spin text-faint" aria-label={t('common.loading')} />}
          {loaded && !chats.some((c) => !isUnused(c)) && <p className="px-3 py-2 text-sm text-faint">{t('sidebar.noChats')}</p>}
          {loaded && chats.some((c) => !isUnused(c)) && !groups.length && (
            <p className="px-3 py-2 text-sm text-faint" data-testid="recents-no-match">
              {t('sidebar.filter.none')}
            </p>
          )}
          {groups.map(([bucket, list]) => (
            <div key={bucket} className="mb-2">
              <h3 className="px-3 pt-2 pb-1 text-[11px] font-medium text-faint">{t(BUCKET_LABEL[bucket])}</h3>
              <ul>
                {list.map((c) => (
                  <ChatItem key={c.id} chat={c} onNavigate={close} peek={peek} />
                ))}
              </ul>
            </div>
          ))}
          {cursor && (
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
        </div>
      </div>
      {peek.card}
      <AccountMenu />
    </nav>
  )
}

function ChatItem({ chat, onNavigate, peek }: { chat: Chat; onNavigate: () => void; peek: ChatPeek }) {
  const t = useT()
  const [menu, setMenu] = useState(false)
  const actions = useChatActions()
  // the AI of this chat asked something (ask_user / site / connect_service card) and waits: tab 5 "주의가 필요한 채팅"
  const needsAnswer = useChats((s) => Object.values(s.requests).some((r) => r.chatId === chat.id))
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
    <li ref={ref} className="group relative" onMouseEnter={(e) => peek.soon(chat, e.currentTarget, 400)} onMouseLeave={peek.hide}>
      <NavLink
        to={`/c/${chat.id}`}
        onClick={() => {
          peek.hide()
          onNavigate()
        }}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && peek.soon(chat, ref.current!, 600)}
        onBlur={peek.hide}
        onKeyDown={(e) => e.key === 'Escape' && peek.hide()}
        className={({ isActive }) => clsx('flex h-9 items-center gap-2 rounded-lg pr-9 pl-3 text-sm hover:bg-hover max-sm:h-10', isActive ? 'bg-hover font-medium text-ink' : 'text-muted')}
      >
        {needsAnswer ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
        ) : (
          chat.runState !== 'idle' && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label={t(chat.runState === 'queued' ? 'chat.queued' : 'chat.running')} />
        )}
        <span className="truncate">{chat.title || t('chat.untitled')}</span>
        {needsAnswer && (
          <span className="shrink-0 text-[11px] font-medium text-warn" data-testid="needs-answer">
            {t('chat.needsAnswer')}
          </span>
        )}
      </NavLink>
      <button
        type="button"
        aria-label={t('chat.menu')}
        aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}
        className={clsx('absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-faint hover:bg-surface hover:text-ink', menu ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100')}
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
 * the page, components/settings/SettingsDialog.tsx), Usage (admins: Admin > Usage), Appearance (the theme, chosen right
 * there), Deleted chats and Sign out. Arrow keys, Home and End move in the menu; Esc closes it and gives the keyboard back. */
function AccountMenu() {
  const t = useT()
  const me = useMeStrict()
  const [open, setOpen] = useState(false)
  const [appearance, setAppearance] = useState(false)
  const signedOut = useSession((s) => s.signedOut)
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
  const logout = async () => {
    await api.call(API.logout).catch(() => {})
    clearLocalData()
    signedOut()
    navigate('/login')
  }
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
          {isAdmin(me) && (
            <Link role="menuitem" to="/admin/usage" onClick={() => hide(false)} className={item} data-testid="account-usage">
              <Gauge size={16} className="text-muted" aria-hidden /> {t('sidebar.usage')}
            </Link>
          )}
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
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-ink" aria-hidden>
          {me.user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="truncate text-sm font-medium">{me.user.name}</span>
          <span className="shrink-0 text-xs text-faint" aria-hidden>
            ·
          </span>
          <span className="truncate text-xs text-faint">{me.team.name}</span>
        </span>
        <ChevronDown size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
    </div>
  )
}

/** The filter beside "Recents": quiet until the row is pointed at or reached with the keyboard (always there when a
 * filter is on, and on touch screens). */
function FilterMenu({ value, onChange, shown }: { value: RecentsFilter; onChange: (f: RecentsFilter) => void; shown: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const onKey = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      button.current?.focus()
      return
    }
    if (e.key === 'Tab') return setOpen(false)
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  }
  return (
    <div ref={ref} className="relative ml-auto" onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('sidebar.filter')}
        title={t('sidebar.filter')}
        onClick={() => setOpen((v) => !v)}
        className={clsx('rounded p-1 text-faint hover:bg-hover hover:text-ink focus-visible:opacity-100 max-sm:opacity-100', open || shown ? 'opacity-100' : 'opacity-0 group-hover/recents:opacity-100')}
        data-testid="recents-filter"
      >
        <ListFilter size={14} aria-hidden />
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={t('sidebar.filter')} className="absolute top-full right-0 z-30 mt-1 w-56 rounded-xl border border-line bg-surface p-1 shadow-lg" data-testid="recents-filter-menu">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="menuitemradio"
              aria-checked={value === f.id}
              onClick={() => {
                onChange(f.id)
                setOpen(false)
                button.current?.focus()
              }}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm hover:bg-hover focus-visible:-outline-offset-2"
              data-testid={`recents-filter-${f.id}`}
            >
              {t(f.label)}
              {value === f.id && <Check size={14} className="ml-auto text-accent-text" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The hover quick view of a recent chat, like Claude's: after resting on it (or reaching it with the keyboard), a
 * card beside the sidebar with the start of the last answer or its first file, the title and when. Only where there is
 * a mouse; decorative (aria-hidden: the link already says the title), never in the way (no pointer events), and gone on
 * leave, Esc, a click or a scroll. One read of the last two messages per chat version, kept for the session. */
type ChatPeek = ReturnType<typeof useChatPeek>
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
          <div className="mb-2 min-h-12 rounded-lg bg-subtle p-2.5 text-xs text-muted" data-testid="chat-peek-preview">
            {!d ? (
              <span className="block h-3 w-2/3 animate-pulse rounded bg-hover" />
            ) : d.file ? (
              <span className="inline-flex max-w-full items-center rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-ink">
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
