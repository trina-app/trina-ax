// The labeled menu rows at the top of the sidebar (the owner, 2026-11-07: one labeled row each, no icon row), moved out
// of Sidebar.tsx unchanged (navigation redesign, docs/AGENTS/plan/20261112-1839-nav-rail.md, phase P0b): MenuRows on a
// computer, PhoneMenuRows in the phone's drawer (the AI's tab: search, scheduled tasks, team skills).
import clsx from 'clsx'
import { Bell, BookMarked, CalendarClock, FolderKanban, FolderOpen, Search } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { aiName } from '../../lib/tabs'
import { platform } from '../../lib/pwa'
import { useT } from '../../i18n'
import { AiMark } from '../rooms/AiFace'

/** shortcut hints in the keys of this computer (the handlers take ⌘ and Ctrl alike, Layout.tsx) */
const onMac = () => platform() === 'mac' || platform() === 'ios'

/** A computer: one labeled row each, a new AI chat and search with their shortcuts, then projects, scheduled tasks, the
 * Inbox (its count on the row, in words for a screen reader), files and team skills (Connectors is in Settings). Admin is in the team menu on top
 * (TeamMenu.tsx), not a row. Team skills has no count of its own: a suggestion is an Inbox notice already. */
export function MenuRows({ unread, onNewChat, onSearch }: { unread: number; onNewChat: () => void; onSearch: () => void }) {
  const t = useT()
  const nav = 'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-ink hover:bg-hover'
  const active = ({ isActive }: { isActive: boolean }) => clsx(nav, isActive && 'bg-hover font-medium')
  const kbd = 'ml-auto hidden font-sans text-micro text-faint lg:inline'
  // one labeled row each, in the order they had before the icon row (the owner, 2026-11-07)
  return (
    <div className="space-y-0.5 px-2" data-testid="nav-rows">
      <button type="button" className={clsx(nav, 'w-full font-medium')} onClick={onNewChat} data-testid="new-chat">
        <AiMark place="nav" /> <span className="truncate">{t('sidebar.askAi', { name: aiName(t) })}</span>
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
      <NavLink to="/activity" className={active} data-testid="nav-inbox">
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
    </div>
  )
}

/** The phone's drawer: the AI's history only (프로젝트 and 파일, the Inbox and Admin are tabs or in the 나 tab there).
 * Each row closes the drawer (`onNavigate`); search takes the drawer's place. */
export function PhoneMenuRows({ onNavigate, onSearch }: { onNavigate: () => void; onSearch: () => void }) {
  const t = useT()
  const close = onNavigate
  const nav = 'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-ink hover:bg-hover max-md:h-11'
  const active = ({ isActive }: { isActive: boolean }) => clsx(nav, isActive && 'bg-hover font-medium')
  return (
    <div className="space-y-0.5 px-2">
      {/* search takes the drawer's place (and its history entry): Back closes search and shows the page */}
      <button
        type="button"
        className={clsx(nav, 'w-full')}
        onClick={() => {
          close()
          onSearch()
        }}
        data-testid="drawer-search"
      >
        <Search size={16} aria-hidden /> {t('sidebar.search')}
      </button>
      <NavLink to="/scheduled" className={active} onClick={close} data-testid="nav-scheduled">
        <CalendarClock size={16} aria-hidden /> {t('sidebar.scheduled')}
      </NavLink>
      <NavLink to="/skills" className={active} onClick={close} data-testid="nav-skills">
        <BookMarked size={16} aria-hidden /> {t('sidebar.skills')}
      </NavLink>
    </div>
  )
}
