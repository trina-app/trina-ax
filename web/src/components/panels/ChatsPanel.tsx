// 대화's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1).
// Its header: 🔍 (search on its 대화 type: rooms, people and messages, as the phone's 대화 tab) and
// ⊕ "새 대화" (the people picker; the only place that word starts something, §2.0). Then the owner's setup row while it
// shows and every room of mine by kind with no cap (panels/RoomsByKind.tsx: 고정 · 팀 대화방 · 그룹 대화 · 1:1 대화).
// Mentions, DMs and thread replies as notices are 활동's, the one Activity (docs/decisions/20261126-one-activity.md).
import { Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { useUi } from '../../store/ui'
import { SetupRow } from '../onboarding/SetupRow'
import { PeoplePicker } from '../rooms/PeoplePicker'
import { IconButton } from '../ui'
import { useCanStartChat } from '../GuestView'
import { LoadError } from '../LoadError'
import { PanelFrame } from './PanelFrame'
import { RoomsByKind } from './RoomsByKind'

export function ChatsPanel() {
  const t = useT()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const [picking, setPicking] = useState(false)
  const failed = useRooms((s) => s.failed)
  const anyRoom = useRooms((s) => s.rooms.length > 0)
  // "+": a guest only when someone of their place is there to talk to (components/GuestView.tsx)
  const canStart = useCanStartChat()
  return (
    <PanelFrame
      title={t('tabs.chats')}
      testId="chats-panel"
      actions={
        <>
          <IconButton label={t('rail.searchChats')} onClick={() => setSearchOpen(true, 'rooms')} data-testid="chats-panel-search">
            <Search size={16} aria-hidden />
          </IconButton>
          {canStart && (
            <IconButton label={t('rooms.newChat')} onClick={() => setPicking(true)} data-testid="rooms-new-dm">
              <Plus size={16} aria-hidden />
            </IconButton>
          )}
        </>
      }
      top={<SetupRow />}
    >
      {/* a list that could not be read: the calm notice with 다시 시도, as 트리나's list has it (components/LoadError.tsx) */}
      {failed && !anyRoom ? <LoadError error={failed} onRetry={() => useRooms.getState().loadRooms()} what="rooms" minor className="mx-1 mt-2" /> : <RoomsByKind />}
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </PanelFrame>
  )
}
