// 대화's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1).
// Its header: 🔍 (search on its 대화 type: rooms, people and messages, as the phone's 대화 tab) and
// ⊕ "새 대화" (the people picker; the only place that word starts something, §2.0). Then the owner's setup row while it
// shows, 멘션·스레드 (Activity's conversation rows, `/activity?in=chats`) with how many are unread, and every room of mine
// by kind with no cap (panels/RoomsByKind.tsx: 고정 · 팀 대화방 · 그룹 대화 · 1:1 대화). The 멘션·스레드 row is
// here because 활동 does not count conversation rows (rail/railBadges.ts).
import clsx from 'clsx'
import { AtSign, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useT } from '../../i18n'
import { activityInChats, CHATS_ACTIVITY } from '../../lib/screens'
import { useRoomNoticeUnread } from '../../store/inbox'
import { useRooms } from '../../store/rooms'
import { useUi } from '../../store/ui'
import { SetupRow } from '../onboarding/SetupRow'
import { PeoplePicker } from '../rooms/PeoplePicker'
import { IconButton } from '../ui'
import { LoadError } from '../LoadError'
import { PanelFrame, panelRow } from './PanelFrame'
import { RoomsByKind } from './RoomsByKind'

export function ChatsPanel() {
  const t = useT()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const [picking, setPicking] = useState(false)
  const failed = useRooms((s) => s.failed)
  const anyRoom = useRooms((s) => s.rooms.length > 0)
  const { pathname, search } = useLocation()
  const here = pathname === '/activity' && activityInChats(search)
  const unread = useRoomNoticeUnread()
  return (
    <PanelFrame
      title={t('tabs.chats')}
      testId="chats-panel"
      actions={
        <>
          <IconButton label={t('rail.searchChats')} onClick={() => setSearchOpen(true, 'rooms')} data-testid="chats-panel-search">
            <Search size={16} aria-hidden />
          </IconButton>
          <IconButton label={t('rooms.newChat')} onClick={() => setPicking(true)} data-testid="rooms-new-dm">
            <Plus size={16} aria-hidden />
          </IconButton>
        </>
      }
      top={
        <>
          <SetupRow />
          <Link to={CHATS_ACTIVITY} aria-current={here ? 'page' : undefined} className={clsx(panelRow, here && 'bg-hover', unread > 0 ? 'font-semibold' : 'font-normal')} data-testid="rooms-activity">
            <AtSign size={16} className="text-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t('feed.chats')}</span>
            {unread > 0 && (
              <span className="ml-auto shrink-0 rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink" data-testid="rooms-activity-unread">
                <span aria-hidden>{unread > 99 ? '99+' : unread}</span>
                <span className="sr-only">{t('feed.chatsUnread')}</span>
              </span>
            )}
          </Link>
        </>
      }
    >
      {/* a list that could not be read: the calm notice with 다시 시도, as 트리나's list has it (components/LoadError.tsx) */}
      {failed && !anyRoom ? <LoadError error={failed} onRetry={() => useRooms.getState().loadRooms()} what="rooms" minor className="mx-1 mt-2" /> : <RoomsByKind />}
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </PanelFrame>
  )
}
