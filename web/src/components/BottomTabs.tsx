// The phone tab bar (below 768 px; Layout.tsx, and the Settings dialog, which is the 나 tab): 트리나 (the AI: Home with a
// new chat and the latest chats, its history behind ☰), 대화 (rooms, DMs and group chats), 프로젝트 (the projects list,
// with the team folder as its last row: QA TC-255), 나 (Settings, opened on its list: the Inbox and, for admins, Admin on
// top). lib/tabs.ts says which tab an address belongs to and which one the app opens on. A hairline above, no frame; the
// tab on screen in ink and medium weight. Each label stays on one line, cut with "…" when a language's word does not fit
// a quarter of a narrow phone at a large text size. Each unread thing counted once
// (QA TC-256): my unread room messages on 대화 (a mention and a followed thread's replies among them), on 나 the unread
// Inbox notices that are not about a conversation (store/inbox.ts useNoticeUnread). Not shown inside a conversation
// (a room, an AI chat): their message box needs the bottom. 트리나's icon is Trina's own star (TrinaStar, as the room
// header's ✦, the AI's face in rooms and the sidebar's "트리나에게 묻기") where the product is named after its AI, in its
// own orange (the owner, 2026-11-12: "AI 아이콘은 색넣는게 좋지 않을까?"), dimmed while another tab is on show so the bar
// still marks where you are; the sparkle in the core edition, in the tab's colours (as rooms/AiFace.tsx). The star is thin (it fills
// about 4/5 of its box), so it is drawn 26 px to read as big as the 22 px icons, overhanging its 22 px slot so the bar
// keeps its height (the owner, 2026-11-12: "모바일에서는 트리나 아이콘이 달라서 좀 헷갈리는듯").
// A tap never adds a history entry (lib/screenHistory.ts switchTab): another tab puts its own stack back where it was
// left, the tab on show goes back to its root, so the phone's Back never walks from one tab into another. The tab
// marked is the stack's: a page opened from 나 (연결한 서비스, a notice's page) keeps 나 marked.
import clsx from 'clsx'
import { FolderKanban, MessageCircle, Sparkles, UserRound } from 'lucide-react'
import { useEffect, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { useT } from '../i18n'
import { useRealPath } from '../lib/realPath'
import { badgeText, totalUnread } from '../lib/rooms'
import { settleOpened, stackNow, switchTab } from '../lib/screenHistory'
import { aiName, hidesTabs, tabOf, TAB_ROOT, type Tab } from '../lib/tabs'
import { useNoticeUnread } from '../store/inbox'
import { useRooms } from '../store/rooms'
import { useMe } from '../store/session'
import { settingsOpenedFrom } from './settings/SettingsDialog'
import { TrinaStar } from './TrinaStar'

/** 트리나's tab icon (see the top of this file); `active`: its tab is on show; `named`: this build's
 * PRODUCT_NAMED_AFTER_AI, a prop for the tests */
export function AiTabIcon({ active = false, named = PRODUCT_NAMED_AFTER_AI }: { active?: boolean; named?: boolean }) {
  return named ? <TrinaStar size={26} className={clsx('-m-0.5', !active && 'opacity-55')} /> : <Sparkles size={22} aria-hidden />
}

export function BottomTabs() {
  const t = useT()
  // under the Settings dialog the page below it is what the router shows; the bar marks "나" by the real address
  const path = useRealPath()
  const unread = useRooms((s) => totalUnread(s.rooms))
  const inbox = useNoticeUnread()
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
      <TabLink to={TAB_ROOT.ai} active={current === 'ai'} icon={<AiTabIcon active={current === 'ai'} />} label={aiName(t)} testId="tab-ai" onClick={go('ai')} />
      <TabLink to={TAB_ROOT.chats} active={current === 'chats'} icon={<MessageCircle size={22} aria-hidden />} label={t('tabs.chats')} testId="tab-chats" onClick={go('chats')}>
        {unread > 0 && <Count n={unread} label={t('rooms.unread', { n: unread })} testId="tab-chats-unread" />}
      </TabLink>
      <TabLink to={TAB_ROOT.projects} active={current === 'projects'} icon={<FolderKanban size={22} aria-hidden />} label={t('tabs.projects')} testId="tab-projects" onClick={go('projects')} />
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
      className={clsx('flex min-h-12 min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 px-0.5 pt-2 text-micro', active ? 'font-medium text-ink' : 'text-faint')}
      data-testid={testId}
    >
      <span className="relative">
        {icon}
        {children}
      </span>
      {/* one line: cut at the tab's width, never wrapped */}
      <span className="block max-w-full truncate whitespace-nowrap" data-testid="bottom-tab-label">{label}</span>
    </Link>
  )
}
