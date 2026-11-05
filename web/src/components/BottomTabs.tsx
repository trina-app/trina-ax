// The phone tab bar (below 768 px; Layout.tsx, and the Settings dialog, which is the 나 tab): 대화 (the rooms list,
// with the AI chat pinned first), 파일, 나 (Settings, opened on its list: the person's photo row on top opens the
// profile). A hairline above, no frame; the tab on screen in ink and medium weight; my unread room messages as one
// count on 대화. Not shown inside a conversation (a room, an AI chat): their message box needs the bottom.
import clsx from 'clsx'
import { FolderOpen, MessageCircle, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useT } from '../i18n'
import { useRealPath } from '../lib/realPath'
import { badgeText, totalUnread } from '../lib/rooms'
import { useRooms } from '../store/rooms'
import { settingsOpenedFrom } from './settings/SettingsDialog'

/** where the bar stays away: inside a room and inside an AI chat */
export const hidesTabs = (path: string) => /^\/rooms\/[^/]+/.test(path) || path.startsWith('/c/')

type Tab = 'chats' | 'files' | 'me'
export function tabOf(path: string): Tab | null {
  if (path === '/' || path === '/rooms' || path.startsWith('/rooms/') || path.startsWith('/c/')) return 'chats'
  if (path === '/files' || path.startsWith('/files/')) return 'files'
  if (path === '/settings' || path.startsWith('/settings/')) return 'me'
  return null
}

export function BottomTabs() {
  const t = useT()
  // under the Settings dialog the page below it is what the router shows; the bar marks "나" by the real address
  const path = useRealPath()
  const unread = useRooms((s) => totalUnread(s.rooms))
  if (hidesTabs(path)) return null
  const current = tabOf(path)
  return (
    <nav aria-label={t('tabs.label')} className="flex shrink-0 border-t border-line bg-canvas pb-[max(0.75rem,var(--safe-bottom))] md:hidden" data-testid="bottom-tabs">
      <TabLink to="/rooms" active={current === 'chats'} icon={<MessageCircle size={22} aria-hidden />} label={t('tabs.chats')} testId="tab-chats">
        {unread > 0 && (
          <span className="absolute -top-1 left-1/2 ml-2 min-w-4 rounded-full bg-accent px-1 text-center text-nano leading-4 font-medium text-accent-ink" data-testid="tab-chats-unread">
            <span aria-hidden>{badgeText(unread)}</span>
            <span className="sr-only">{t('rooms.unread', { n: unread })}</span>
          </span>
        )}
      </TabLink>
      <TabLink to="/files" active={current === 'files'} icon={<FolderOpen size={22} aria-hidden />} label={t('tabs.files')} testId="tab-files" />
      <TabLink to="/settings" active={current === 'me'} icon={<UserRound size={22} aria-hidden />} label={t('tabs.me')} testId="tab-me" onClick={(el) => settingsOpenedFrom(el)} />
    </nav>
  )
}

function TabLink({ to, active, icon, label, testId, onClick, children }: { to: string; active: boolean; icon: ReactNode; label: string; testId: string; onClick?: (el: HTMLElement) => void; children?: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => onClick?.(e.currentTarget)}
      className={clsx('flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 pt-2 text-micro', active ? 'font-medium text-ink' : 'text-faint')}
      data-testid={testId}
    >
      <span className="relative">
        {icon}
        {children}
      </span>
      {label}
    </Link>
  )
}
