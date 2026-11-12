// The phone tab bar (below 768 px; Layout.tsx, and the Settings dialog, which is the 나 tab): 트리나 (the AI: Home with a
// new chat and the latest chats, its history behind ☰), 대화 (rooms, DMs and group chats), 파일, 나 (Settings, opened on
// its list: the Inbox and, for admins, Admin on top). lib/tabs.ts says which tab an address belongs to and which one the
// app opens on. A hairline above, no frame; the tab on screen in ink and medium weight. One count per kind of thing: my
// unread room messages on 대화, my unread Inbox notices on 나. While @트리나 waits on me in a room (Room.aiWaits), 대화's
// pill is an amber "?" instead, as that room's own pill is (docs/DECISIONS.md "Session markers"); the count is the same
// and comes back when the wait ends (a screen reader hears both). Not shown inside a conversation (a room, an AI chat):
// their message box needs the bottom.
// A tap never adds a history entry (lib/screenHistory.ts switchTab): another tab puts its own stack back where it was
// left, the tab on show goes back to its root, so the phone's Back never walks from one tab into another. The tab
// marked is the stack's: a page opened from 나 (연결한 서비스, a notice's page) keeps 나 marked.
import clsx from 'clsx'
import { FolderOpen, MessageCircle, Sparkles, UserRound } from 'lucide-react'
import { useEffect, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useT } from '../i18n'
import { useRealPath } from '../lib/realPath'
import { badgeText, totalUnread } from '../lib/rooms'
import { settleOpened, stackNow, switchTab } from '../lib/screenHistory'
import { aiName, hidesTabs, tabOf, TAB_ROOT, type Tab } from '../lib/tabs'
import { useInboxUnread } from '../store/inbox'
import { useRooms } from '../store/rooms'
import { useMe } from '../store/session'
import { settingsOpenedFrom } from './settings/SettingsDialog'

export function BottomTabs() {
  const t = useT()
  // under the Settings dialog the page below it is what the router shows; the bar marks "나" by the real address
  const path = useRealPath()
  const unread = useRooms((s) => totalUnread(s.rooms))
  // a room I hid counts nowhere (docs/DECISIONS.md "대화 숨기기": what is for me brings it back first)
  const aiWaits = useRooms((s) => s.rooms.some((r) => r.aiWaits && !r.hidden))
  const inbox = useInboxUnread()
  const user = useMe()?.user.id ?? ''
  // the signed-in app shows its first entry: one opened from outside gets its parents put under it
  useEffect(() => settleOpened(), [])
  if (hidesTabs(path)) return null
  const current = stackNow()?.tab ?? tabOf(path)
  const go = (tab: Tab) => (e: MouseEvent<HTMLAnchorElement>) => {
    // a new browser tab or window (a modified click) is the link's own
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (switchTab(tab, user)) e.preventDefault()
  }
  return (
    <nav aria-label={t('tabs.label')} className="flex shrink-0 border-t border-line bg-canvas pb-[max(0.75rem,var(--safe-bottom))] md:hidden in-[.keyboard-open]:hidden" data-bottom-bar data-testid="bottom-tabs">
      <TabLink to={TAB_ROOT.ai} active={current === 'ai'} icon={<Sparkles size={22} aria-hidden />} label={aiName(t)} testId="tab-ai" onClick={go('ai')} />
      <TabLink to={TAB_ROOT.chats} active={current === 'chats'} icon={<MessageCircle size={22} aria-hidden />} label={t('tabs.chats')} testId="tab-chats" onClick={go('chats')}>
        {aiWaits ? (
          <span className="absolute -top-1 left-1/2 ml-2 min-w-4 rounded-full bg-warn px-1 text-center text-nano leading-4 font-bold text-canvas" data-testid="tab-chats-unread" data-ai-waits="">
            <span aria-hidden>?</span>
            <span className="sr-only">{[t('rooms.aiWaits'), unread > 0 && t('rooms.unread', { n: unread })].filter(Boolean).join(', ')}</span>
          </span>
        ) : (
          unread > 0 && <Count n={unread} label={t('rooms.unread', { n: unread })} testId="tab-chats-unread" />
        )}
      </TabLink>
      <TabLink to={TAB_ROOT.files} active={current === 'files'} icon={<FolderOpen size={22} aria-hidden />} label={t('tabs.files')} testId="tab-files" onClick={go('files')} />
      <TabLink to={TAB_ROOT.me} active={current === 'me'} icon={<UserRound size={22} aria-hidden />} label={t('tabs.me')} testId="tab-me" onClick={(e) => { settingsOpenedFrom(e.currentTarget); go('me')(e) }}>
        {inbox > 0 && <Count n={inbox} label={t('notifications.unread', { count: inbox })} testId="tab-me-unread" />}
      </TabLink>
    </nav>
  )
}

/** a count on a tab's icon: the number for the eye, the words for a screen reader */
function Count({ n, label, testId }: { n: number; label: string; testId: string }) {
  return (
    <span className="absolute -top-1 left-1/2 ml-2 min-w-4 rounded-full bg-accent px-1 text-center text-nano leading-4 font-medium text-accent-ink" data-testid={testId}>
      <span aria-hidden>{badgeText(n)}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

function TabLink({ to, active, icon, label, testId, onClick, children }: { to: string; active: boolean; icon: ReactNode; label: string; testId: string; onClick: (e: MouseEvent<HTMLAnchorElement>) => void; children?: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
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
