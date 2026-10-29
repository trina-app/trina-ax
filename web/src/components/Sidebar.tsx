// Left sidebar (Claude-like): new chat, search, projects, files, recent chats by date, admin, account menu.
// Below 768 px it is a drawer opened from the top bar.
import clsx from 'clsx'
import { BookMarked, FolderOpen, FolderKanban, Loader2, LogOut, MessageSquarePlus, MoreHorizontal, Search, Settings, Shield, Trash2, Pencil, ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import type { Chat } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { chatTrashDays } from '../lib/chat-trash'
import { dateBucket, type DateBucket } from '../lib/format'
import { clearLocalData } from '../lib/localData'
import { platform } from '../lib/pwa'
import { useLocale, useT, type MessageKey } from '../i18n'
import { useChats } from '../store/chats'
import { skillsChanged } from '../store/live'
import { isAdmin, useMeStrict, useSession } from '../store/session'
import { toast, useUi } from '../store/ui'
import { confirmDialog, promptDialog } from './ui'

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
  const nav = 'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink hover:bg-hover max-sm:py-2.5'
  const active = ({ isActive }: { isActive: boolean }) => clsx(nav, isActive && 'bg-hover font-medium')

  return (
    <nav aria-label={t('sidebar.label')} className="flex h-full w-full flex-col bg-subtle">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <Link to="/" onClick={close} className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" aria-hidden className="size-6 rounded-md" />
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
          <MessageSquarePlus size={17} className="text-accent-text" aria-hidden /> {t('sidebar.newChat')}
          <kbd className="ml-auto hidden text-[11px] text-faint lg:inline">{onMac() ? '⇧⌘O' : 'Ctrl+Shift+O'}</kbd>
        </button>
        <button type="button" className={clsx(nav, 'w-full')} onClick={() => setSearchOpen(true)}>
          <Search size={17} aria-hidden /> {t('sidebar.search')}
          <kbd className="ml-auto hidden text-[11px] text-faint lg:inline">{onMac() ? '⌘K' : 'Ctrl+K'}</kbd>
        </button>
        <NavLink to="/projects" className={active} onClick={close}>
          <FolderKanban size={17} aria-hidden /> {t('sidebar.projects')}
        </NavLink>
        <NavLink to="/files" className={active} onClick={close}>
          <FolderOpen size={17} aria-hidden /> {t('sidebar.files')}
        </NavLink>
        <NavLink to="/skills" className={active} onClick={close} data-testid="nav-skills">
          <BookMarked size={17} aria-hidden /> {t('sidebar.skills')}
          {pendingSkills > 0 && (
            <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] font-medium text-accent-ink" data-testid="skills-pending" aria-label={t('skills.tabReview')}>
              {pendingSkills}
            </span>
          )}
        </NavLink>
        {isAdmin(me) && (
          <NavLink to="/admin" className={active} onClick={close}>
            <Shield size={17} aria-hidden /> {t('sidebar.admin')}
          </NavLink>
        )}
      </div>

      <div className="scroll-thin mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
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
  const me = useMeStrict()
  const locale = useLocale()
  const { chatId } = useParams()
  const [menu, setMenu] = useState(false)
  const upsert = useChats((s) => s.upsertChat)
  const remove = useChats((s) => s.removeChat)
  // the AI of this chat asked something (ask_user / site card) and waits: tab 5 "주의가 필요한 채팅"
  const needsAnswer = useChats((s) => Object.values(s.requests).some((r) => r.chatId === chat.id))
  const navigate = useNavigate()
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!menu) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [menu])

  const rename = async () => {
    setMenu(false)
    const title = await promptDialog({ title: t('chat.rename'), label: t('chat.title'), initial: chat.title, confirm: t('common.save') })
    if (!title) return
    try {
      upsert(await api.call(API.updateChat, { params: { id: chat.id }, body: { title } }))
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const del = async () => {
    setMenu(false)
    if (!(await confirmDialog({ title: t('chat.deleteTitle'), body: t('chat.deleteBody', { days: chatTrashDays(me) }), confirm: t('common.delete'), danger: true }))) return
    try {
      await api.call(API.deleteChat, { params: { id: chat.id } })
      remove(chat.id)
      if (chatId === chat.id) navigate('/')
      toast({ level: 'info', text: t('chat.deleted'), action: { label: t('common.undo'), run: () => void api.call(API.restoreChat, { params: { id: chat.id } }).then(upsert) } })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }

  return (
    <li ref={ref} className="group relative">
      <NavLink
        to={`/c/${chat.id}`}
        onClick={onNavigate}
        className={({ isActive }) => clsx('flex items-center gap-2 rounded-lg py-1.5 pr-8 pl-2.5 text-sm hover:bg-hover max-sm:py-2.5', isActive ? 'bg-hover font-medium text-ink' : 'text-muted')}
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

function AccountMenu() {
  const t = useT()
  const me = useMeStrict()
  const [open, setOpen] = useState(false)
  const signedOut = useSession((s) => s.signedOut)
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', k)
    }
  }, [open])
  const logout = async () => {
    await api.call(API.logout).catch(() => {})
    clearLocalData()
    signedOut()
    navigate('/login')
  }
  return (
    <div ref={ref} className="relative border-t border-line p-2">
      {open && (
        <div role="menu" className="absolute right-2 bottom-full left-2 z-30 mb-1 rounded-xl border border-line bg-surface p-1 shadow-lg">
          <p className="truncate px-2.5 py-1.5 text-xs text-faint">{me.user.username}</p>
          <Link role="menuitem" to="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-hover">
            <Settings size={15} aria-hidden /> {t('sidebar.settings')}
          </Link>
          <button role="menuitem" type="button" onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover" data-testid="logout">
            <LogOut size={15} aria-hidden /> {t('auth.logout')}
          </button>
        </div>
      )}
      <button type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover" data-testid="account-menu">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-ink" aria-hidden>
          {me.user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{me.user.name}</span>
          <span className="block truncate text-xs text-faint">{me.team.name}</span>
        </span>
        <ChevronDown size={15} className="text-faint" aria-hidden />
      </button>
    </div>
  )
}
