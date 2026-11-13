// A room's row in the 대화 panel and the phone's 대화 tab (panels/RoomsByKind.tsx draws the list by kind), its badge and
// pin, and the order of the kinds' sections (docs/DECISIONS.md "Pinned conversations", "Conversations by kind under
// Show more").
import clsx from 'clsx'
import { BellOff, Pin } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { pinnedRooms, roomBadge, roomUnread } from '../../lib/rooms'
import { RoomIcon, RoomName, useRoomTitle } from '../rooms/RoomIcon'
import { RoomMenu, useRowMenu } from '../rooms/RoomMenu'
import { PresenceText } from '../Presence'
import { dragRow } from './NavFolders'

/** The kinds' sections of the 대화 list, in this order: team rooms (전체 and the groups' rooms), group chats, DMs. */
export const ROOM_SECTIONS = ['team', 'group', 'dm'] as const
export type RoomSection = (typeof ROOM_SECTIONS)[number]
export const SECTION_WORD = { team: 'rooms.section.team', group: 'rooms.section.group', dm: 'rooms.section.dm' } as const
const sectionOf = (kind: Room['kind']): RoomSection => (kind === 'all' ? 'team' : kind)

/** The rooms not pinned or in a folder (`rest`, by latest activity, as the store has them), by kind
 * (docs/DECISIONS.md "Conversations by kind under Show more"): in each section any pins first (the
 * most recently pinned first), then team rooms with 전체 first and the others by the name their row shows (`titleOf`,
 * compared in the app's language, numbers by their value), group chats and DMs by latest activity. A section with no
 * room is left out. */
export function roomSections<R extends Pick<Room, 'id' | 'kind'> & Partial<Pick<Room, 'pinnedAt'>>>(rest: R[], titleOf: (room: R) => string, locale: string): { section: RoomSection; rooms: R[] }[] {
  return ROOM_SECTIONS.map((section) => {
    const of = rest.filter((r) => sectionOf(r.kind) === section)
    const others = of.filter((r) => !r.pinnedAt)
    if (section === 'team') {
      // each name worked out once, and one collator for the sort (the order of String.localeCompare in this language,
      // numbers by their value: "팀 2" before "팀 10")
      const titles = new Map(others.map((r) => [r.id, titleOf(r)]))
      const collator = new Intl.Collator(locale, { numeric: true })
      others.sort((a, b) => Number(b.kind === 'all') - Number(a.kind === 'all') || collator.compare(titles.get(a.id)!, titles.get(b.id)!))
    }
    return { section, rooms: [...pinnedRooms(of), ...others] }
  }).filter((s) => s.rooms.length > 0)
}

/** A room's one badge: the unread count, or "@" when one of them mentions me; grey for a muted room (which the 대화 tab
 * does not count). */
export function UnreadBadge({ room, className, testId }: { room: Room; className?: string; testId: string }) {
  const t = useT()
  const n = roomUnread(room)
  if (n <= 0) return null
  return (
    <span className={clsx('shrink-0 rounded-full px-1.5 text-micro font-medium', room.muted ? 'bg-hover text-muted' : 'bg-accent text-accent-ink', className)} data-testid={testId} data-muted={room.muted ? '' : undefined}>
      <span aria-hidden>{roomBadge(room)}</span>
      <span className="sr-only">
        {t('rooms.unread', { n })}
        {room.mentioned && `, ${t('rooms.mentionedYou')}`}
      </span>
    </span>
  )
}

/** A pinned room's mark after its name (docs/DECISIONS.md "Pinned conversations"): the AI chats' pin, named 고정됨 for
 * screen readers. */
export function RoomPinIcon({ room, className }: { room: Pick<Room, 'pinnedAt'>; className?: string }) {
  const t = useT()
  if (!room.pinnedAt) return null
  return <Pin size={12} role="img" aria-label={t('chat.pinned')} className={clsx('shrink-0 text-faint', className)} data-testid="room-pin-icon" />
}

/** While a row's "⋯" shows (a mouse on the row, the keyboard in it, its menu open), what sits at the row's right end
 * gives way to it: the pill, the bell, and room for the "⋯" at the name's end. Touch screens have no "⋯" (a long press). */
export const ROW_MENU_SHOWN = 'pointer-fine:group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 group-has-[[aria-expanded=true]]:opacity-0'
export const ROW_MENU_BUTTON = 'opacity-0 pointer-coarse:hidden group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 aria-expanded:opacity-100 focus-visible:opacity-100'

/** `section`: the section of the 대화 list it is in */
export function RoomRow({ room, onNavigate, section }: { room: Room; onNavigate: () => void; section?: RoomSection | 'pinned' | 'folder' }) {
  const t = useT()
  const title = useRoomTitle()(room)
  const unread = roomUnread(room)
  const menu = useRowMenu()
  // a room may go in one of my folders (its "⋯", or dragged onto the folder with a mouse)
  return (
    <li className="group relative" {...menu.row} {...dragRow('rooms', room.id, !room.hidden)} data-testid="sidebar-room-row" data-section={section}>
      <NavLink
        to={`/rooms/${room.id}`}
        onClick={(e) => {
          menu.guard(e)
          if (!e.defaultPrevented) onNavigate()
        }}
        className={({ isActive }) =>
          clsx(
            'flex h-9 items-center gap-2 rounded-lg px-3 text-sm hover:bg-hover max-sm:h-10 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]',
            'pointer-fine:group-hover:pr-9 group-has-[:focus-visible]:pr-9 group-has-[[aria-expanded=true]]:pr-9 group-has-[[aria-expanded=true]]:bg-hover',
            // the ring of a DM's online dot takes the row's colour (index.css .presence-dot)
            '[--presence-bg:var(--c-subtle)] hover:[--presence-bg:var(--c-hover)] aria-[current=page]:[--presence-bg:var(--c-hover)] group-has-[[aria-expanded=true]]:[--presence-bg:var(--c-hover)]',
            isActive ? 'bg-hover font-medium text-ink' : unread > 0 ? 'font-semibold text-ink' : 'text-muted',
          )
        }
        data-testid="sidebar-room"
      >
        <RoomIcon room={room} size={20} presence />
        {/* a long name is cut; the whole of it on hover */}
        <span className="truncate" title={title}>
          <RoomName room={room} />
        </span>
        {room.kind === 'dm' && room.peers[0] && <PresenceText userId={room.peers[0].id} />}
        {room.muted && (
          <>
            <BellOff size={12} className={clsx('shrink-0 text-faint', ROW_MENU_SHOWN)} aria-hidden />
            <span className="sr-only">{t('rooms.muted')}</span>
          </>
        )}
        <RoomPinIcon room={room} className={ROW_MENU_SHOWN} />
        <UnreadBadge room={room} className={clsx('ml-auto', ROW_MENU_SHOWN)} testId="room-unread" />
      </NavLink>
      <RoomMenu
        room={room}
        label={t('rooms.menu.rowLabel', { name: title })}
        title={title}
        className="absolute inset-y-0 right-1 flex items-center"
        // its size in the row (a narrow window with a mouse; touch screens use the row's long press)
        compact
        buttonClassName={clsx('hover:bg-surface', ROW_MENU_BUTTON)}
        openSignal={menu.openSignal}
        openRequest={menu.openRequest}
        testId="sidebar-room-menu"
        folders
      />
    </li>
  )
}
