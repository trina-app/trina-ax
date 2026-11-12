// The "대화" group in the computer's sidebar, above 트리나 기록: my rooms (a group's rooms, 전체, group chats, DMs) by
// latest activity, one pill each: "?" while the room's AI waits on me (session markers), else the count of what I have
// not read ("@" instead when one of them mentions me; grey in a muted room), and "+" for a new conversation. Strictly
// the five latest show, and the room on screen if it is not one of them (six at most); "더 보기 (N)" carries what the
// rooms behind it hold for me ("?" when one's AI waits on me, "안 읽음 M", "@" when one mentions me), so no count the
// 대화 tab shows is lost (a muted room's count only when nothing else is unread there, as its own badge is grey). With
// nothing behind it the same row is "모든 대화", to the whole conversations page (/rooms, with its search): the entry is
// always there (the owner, 2026-11-07).
// "더 보기" opens the rest in place ("접기" closes it), remembered in this browser like the fold (docs/DECISIONS.md
// "Conversations by kind under Show more"): the pins and the five latest stay where they were, computed without the
// room on screen, which is in its section below (so a clicked row never moves; when it was the extra sixth row it moves
// into its section on opening), and every other room follows by kind under a quiet heading each: 팀 대화방 (전체 first,
// then by the name the row shows), 그룹 대화 and 1:1 대화 (latest activity). A kind with nothing has no heading. Two
// rare cases move the top rows: with a pin past ten on screen (among the pins while closed) the five latest move up one
// row on opening; a room I hid that is on screen and among the latest takes a top place while opened, so clicking
// another row gives that place back (left so: the other choice moves rows on opening instead). When "접기" closes onto
// "모든 대화" (only the room on screen was below), the keyboard goes to "모든 대화".
// Rooms I hid (docs/DECISIONS.md "대화 숨기기") are in none of this: not in the five, not in "더 보기" or its pill (the
// room on screen still shows); they are under "숨긴 대화" on the conversations page, which "모든 대화" leads to (also
// below an opened "더 보기" while there are hidden ones). Each row has the room's "⋯" (RoomMenu.tsx) on hover or keyboard
// focus, in the pill's place, and on a right-click.
// Rooms I pinned (docs/DECISIONS.md "Pinned conversations") come first, the most recently pinned first, with a small pin
// after the name and no header of their own: at most ten of them above the five latest of the others (and the room on
// screen); under an opened "더 보기" the rest of them lead their own kind's section.
// Gone on a server without rooms (the list could not be read).
// The list itself and its rows are nav/RoomsList.tsx (navigation redesign, docs/AGENTS/plan/20261112-1839-nav-rail.md,
// phase P0b); this is the sidebar's section around it: its title (it folds) and "+" for a new conversation.
import { Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { PeoplePicker } from './PeoplePicker'
import { Tooltip } from '../Tooltip'
import { SidebarSectionTitle } from '../ui'
import { RoomsList } from '../nav/RoomsList'

export { hiddenUnread, PINS_SHOWN, ROOM_SECTIONS, roomSections, RoomPinIcon, ROOMS_SHOWN, ROW_MENU_BUTTON, ROW_MENU_SHOWN, shownRooms, sidebarRows, UnreadBadge, type RoomSection } from '../nav/RoomsList'

const OPEN_KEY = 'mycel.sidebar.rooms'

const remembered = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback
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

export function SidebarRooms({ onNavigate }: { onNavigate: () => void }) {
  const t = useT()
  const everyRoom = useRooms((s) => s.rooms)
  const failed = useRooms((s) => s.failed)
  const [open, setOpen] = useState(() => remembered(OPEN_KEY, 'open') !== 'closed')
  const [picking, setPicking] = useState(false)
  const listId = useId()
  if (failed && !everyRoom.length) return null
  const toggle = () => setOpen((v) => (remember(OPEN_KEY, v ? 'closed' : 'open'), !v))
  return (
    // 20px (mb-5) after the list: about the same distance between texts as above 대화 (35px against 33px) and about
    // twice the gap between two rows' text, before 트리나 기록 or the setup row (the owner, 2026-11-07)
    <div className="mb-5" data-testid="sidebar-rooms">
      <div className="flex items-center gap-1 pr-1 pl-3">
        <SidebarSectionTitle open={open} onToggle={toggle} controls={listId} testId="rooms-toggle">
          {t('rooms.title')}
        </SidebarSectionTitle>
        <Tooltip label={t('rooms.newChat')}>
          <button type="button" onClick={() => setPicking(true)} aria-label={t('rooms.newChat')} className="ml-auto flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink" data-testid="rooms-new-dm">
            <Plus size={15} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <RoomsList id={listId} hidden={!open} onNavigate={onNavigate} />
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </div>
  )
}
