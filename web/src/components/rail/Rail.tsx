// The rail on computers (768 px and wider; docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): the team's logo on top
// (TeamMenu.tsx: its menu for owners and admins: Invite people, Admin), then four places, each an icon with its name under it (the owner, 2026-11-07: no icon
// without words): 트리나 · 대화 · 파일 · 활동, the order of the phone's tabs; my photo at the bottom (nav/AccountMenu.tsx:
// status, away, Settings, Sign out). A place opens what was open in it last in this browser tab (lib/rail.ts);
// the place already lit opens its start; 트리나 with its "?" opens the first chat that waits on me. Each place's mark is railBadges.ts. Tab goes through the logo, the places and
// the photo in order; Up/Down/Home/End move between them too. The rail takes no shortcut of its own.
import clsx from 'clsx'
import { Bell, FolderOpen, MessageCircle, PanelLeftOpen } from 'lucide-react'
import { useEffect, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useT } from '../../i18n'
import { RAIL_ITEMS, railLinkState, railTarget, useRailHere, useRailMemory, type RailItem } from '../../lib/rail'
import { aiName } from '../../lib/tabs'
import { useActivityUnread, useRoomNoticeUnread } from '../../store/inbox'
import { useChats } from '../../store/chats'
import { useRooms } from '../../store/rooms'
import { useAttention, useWaitingChats } from '../../store/sessionMarkers'
import { AiTabIcon } from '../BottomTabs'
import { AccountMenu } from '../nav/AccountMenu'
import { TeamMenu } from '../TeamMenu'
import { Tooltip } from '../Tooltip'
import { activityMark, aiMark, chatsMark, type RailMark } from './railBadges'
import { useRailPanel } from './railPanel'

/** `showList`: the panel is hidden by the person (below 1052 px): a button to bring it back */
export function Rail({ showList }: { showList: boolean }) {
  const t = useT()
  const current = useRailHere()
  const last = useRailMemory((s) => s.last)
  const attention = useAttention()
  // 트리나's mark counts the AI chats of the chat list: read it here, whichever place opens first (대화, 파일, 활동), not
  // only when 트리나's list mounts (QA: eight unseen answers showed no mark until 트리나 was visited)
  const chatsLoaded = useChats((s) => s.chatsLoaded)
  const loadChats = useChats((s) => s.loadChats)
  useEffect(() => {
    if (!chatsLoaded) void loadChats(true).catch(() => {})
  }, [chatsLoaded, loadChats])
  const rooms = useRooms((s) => s.rooms)
  const roomNotices = useRoomNoticeUnread()
  const notices = useActivityUnread()
  const marks: Record<RailItem, RailMark> = { ai: aiMark(attention), chats: chatsMark(rooms, roomNotices), files: null, activity: activityMark(notices) }
  // 트리나 with its "?": the first chat that waits on me (not the one on screen), wherever it sits in the list, so it
  // never waits below the project groups (UX review S2); without one the place opens as any place does
  const waiting = useWaitingChats()
  const onScreen = /^\/c\/([^/]+)/.exec(useLocation().pathname)?.[1]
  const firstWaiting = marks.ai?.kind === 'ask' ? waiting.find((c) => c.id !== onScreen) : undefined
  const label: Record<RailItem, string> = { ai: aiName(t), chats: t('tabs.chats'), files: t('sidebar.files'), activity: t('inbox.title') }
  const icon = (item: RailItem, lit: boolean): ReactNode =>
    item === 'ai' ? <AiTabIcon active={lit} /> : item === 'chats' ? <MessageCircle size={22} aria-hidden /> : item === 'files' ? <FolderOpen size={22} aria-hidden /> : <Bell size={22} aria-hidden />
  // Up/Down/Home/End between the rail's stops, as an extra to Tab (no roving tabindex)
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-rail-stop]')]
    const i = stops.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? stops.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + stops.length) % stops.length
    stops[n]?.focus()
  }
  return (
    <nav aria-label={t('rail.label')} onKeyDown={onKey} className="flex h-full w-[clamp(72px,4.5rem,88px)] shrink-0 flex-col items-stretch border-r border-line bg-subtle" data-testid="rail">
      <TeamMenu />
      <ul className="mt-2 flex flex-col gap-1 px-1.5">
        {RAIL_ITEMS.map((item) => {
          const lit = item === current
          const to = item === 'ai' && firstWaiting ? `/c/${firstWaiting.id}` : railTarget(item, current, last)
          return (
            <li key={item}>
              <Tooltip label={label[item]}>
                <Link
                  to={to}
                  state={railLinkState(item, to)}
                  aria-current={lit ? 'page' : undefined}
                  className={clsx('group flex w-full flex-col items-center gap-0.5 rounded-lg py-1 text-micro leading-tight focus-visible:-outline-offset-2', lit ? 'font-semibold text-ink' : 'text-muted hover:text-ink')}
                  data-rail-stop=""
                  data-testid={`rail-${item}`}
                >
                  <span className={clsx('relative flex h-8 w-11 items-center justify-center rounded-xl', lit ? 'bg-hover' : 'group-hover:bg-hover')}>
                    {icon(item, lit)}
                    <Mark mark={marks[item]} item={item} />
                  </span>
                  <span className="block w-full truncate px-0.5 text-center">{label[item]}</span>
                  <MarkWords mark={marks[item]} item={item} />
                </Link>
              </Tooltip>
            </li>
          )
        })}
      </ul>
      <div className="mt-auto flex flex-col items-center">
        {showList && (
          <Tooltip label={t('rail.showList')}>
            <button type="button" aria-label={t('rail.showList')} onClick={() => useRailPanel.getState().setHidden(false)} className="mb-1 flex size-11 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink" data-rail-stop="" data-testid="rail-show-list">
              <PanelLeftOpen size={18} aria-hidden />
            </button>
          </Tooltip>
        )}
        <AccountMenu />
      </div>
    </nav>
  )
}

/** A place's mark at the top right of its icon, for the eyes only: MarkWords says it after the place's name ("대화, 안 읽은
 * 대화 1개", not the count before the name). */
function Mark({ mark, item }: { mark: RailMark; item: RailItem }) {
  if (!mark) return null
  const at = 'absolute -top-1 right-0'
  const testId = `rail-${item}-mark`
  if (mark.kind === 'ask')
    return (
      <span aria-hidden className={clsx(at, 'min-w-4 rounded-full bg-warn px-1 text-center text-nano leading-4 font-bold text-canvas')} data-testid={testId} data-mark="ask">
        ?
      </span>
    )
  if (mark.kind === 'dot') return <span aria-hidden className={clsx(at, 'right-1.5 size-2 rounded-full bg-accent')} data-testid={testId} data-mark="dot" />
  return (
    <span aria-hidden className={clsx(at, 'min-w-4 rounded-full bg-accent px-1 text-center text-nano leading-4 font-medium text-accent-ink')} data-testid={testId} data-mark="count" data-n={mark.n}>
      {mark.n > 99 ? '99+' : mark.n}
    </span>
  )
}

/** A place's mark in words for screen readers, after its name. */
function MarkWords({ mark, item }: { mark: RailMark; item: RailItem }) {
  const t = useT()
  if (!mark) return null
  const words =
    mark.kind === 'ask' ? (item === 'chats' ? t('rooms.aiWaits') : t('marker.card'))
    : mark.kind === 'dot' ? (item === 'chats' ? t('feed.chatsUnread') : t('marker.new'))
    : item === 'chats' ? t('rail.unreadRooms', { n: mark.n }) : t('notifications.unread', { count: mark.n })
  return <span className="sr-only" data-testid={`rail-${item}-mark-words`}>, {words}</span>
}
