// Left sidebar, sized like Claude's (280 px, 14 px rows of 32 px, 16 px icons): new chat, search, projects, files, team
// skills, admin, recent chats by date, and the account menu (the person's email or ID, Settings, Usage for admins,
// Appearance, Sign out), which opens above the profile line. Below 768 px it is a drawer opened from the top bar.
import clsx from 'clsx'
import { BookMarked, CalendarClock, Check, ChevronDown, ChevronRight, FolderOpen, FolderKanban, Gauge, Loader2, LogOut, MessageSquarePlus, MoreHorizontal, Palette, Pencil, Search, Settings, Shield, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import type { Chat, Theme } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { dateBucket, type DateBucket } from '../lib/format'
import { clearLocalData } from '../lib/localData'
import { platform } from '../lib/pwa'
import { useT, type MessageKey } from '../i18n'
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

  const groups = useMemo(() => {
    const g = new Map<DateBucket, Chat[]>()
    for (const c of chats) {
      // a chat made only to hold attachments (a file attached, nothing sent yet) is not a conversation yet
      if (isUnused(c)) continue
      const b = dateBucket(c.updatedAt)
      g.set(b, [...(g.get(b) ?? []), c])
    }
    return [...g.entries()]
  }, [chats])

  const close = () => setDrawer(false)
  // suggestions waiting for me (I manage their skills folder): a count next to "팀 스킬"
  const [pendingSkills, setPendingSkills] = useState(0)
  useEffect(() => {
    const load = () => api.call(API.skillsOverview).then((o) => setPendingSkills(o.pendingReview), () => {})
    void load()
    return skillsChanged.on(() => void load())
  }, [])
  const nav = 'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink hover:bg-hover max-sm:h-10'
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
        <NavLink to="/scheduled" className={active} onClick={close} data-testid="nav-scheduled">
          <CalendarClock size={16} aria-hidden /> {t('sidebar.scheduled')}
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

      <div className="scroll-thin mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <h2 className="px-2.5 pb-1 text-xs font-medium text-faint">{t('sidebar.recents')}</h2>
        {!loaded && <Loader2 size={16} className="mx-auto mt-4 animate-spin text-faint" aria-label={t('common.loading')} />}
        {loaded && !chats.some((c) => !isUnused(c)) && <p className="px-2.5 py-2 text-sm text-faint">{t('sidebar.noChats')}</p>}
        {groups.map(([bucket, list]) => (
          <div key={bucket} className="mb-2">
            <h3 className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-faint">{t(BUCKET_LABEL[bucket])}</h3>
            <ul>
              {list.map((c) => (
                <ChatItem key={c.id} chat={c} onNavigate={close} />
              ))}
            </ul>
          </div>
        ))}
        {cursor && (
          <button
            type="button"
            className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover"
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
        <NavLink to="/trash" className={({ isActive }) => clsx('mt-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-hover', isActive && 'bg-hover')} onClick={close}>
          <Trash2 size={14} aria-hidden /> {t('sidebar.trash')}
        </NavLink>
      </div>
      <AccountMenu />
    </nav>
  )
}

function ChatItem({ chat, onNavigate }: { chat: Chat; onNavigate: () => void }) {
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
    <li ref={ref} className="group relative">
      <NavLink
        to={`/c/${chat.id}`}
        onClick={onNavigate}
        className={({ isActive }) => clsx('flex h-8 items-center gap-2 rounded-lg pr-8 pl-2.5 text-sm hover:bg-hover max-sm:h-10', isActive ? 'bg-hover font-medium text-ink' : 'text-muted')}
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
        className={clsx('absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-faint hover:bg-surface hover:text-ink', menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100')}
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
 * there) and Sign out. Arrow keys, Home and End move in the menu; Esc closes it and gives the keyboard back. */
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
