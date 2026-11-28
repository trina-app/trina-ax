// A room's row in the 대화 panel and the phone's 대화 tab (panels/RoomsByKind.tsx draws the list by kind), its badge and
// pin, and the order of the kinds' sections (docs/DECISIONS.md "Pinned conversations", "Conversations by kind under
// Show more").
import clsx from 'clsx'
import { BellOff, Loader2, Pin } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { uploadingIn, useRoomUploads } from '../../store/roomUploads'
import { isPrivateChannel, isProjectRoom, pinnedRooms, roomBadge, roomCounts } from '../../lib/rooms'
import { RoomIcon, RoomName, useRoomTitle } from '../rooms/RoomIcon'
import { RoomMenu, useRowMenu } from '../rooms/RoomMenu'
import { CountPill } from '../CountPill'
import { PresenceText } from '../Presence'
import { dragRow, SectionAddButton } from './NavFolders'
import { ChannelsAddMenu } from './SidebarSections'
import { PeoplePicker } from '../rooms/PeoplePicker'
import { useMe } from '../../store/session'
import { isGuestMe } from '../../lib/guests'
import { rowBox, rowName } from '../list/List'

/** The kinds' sections of the 대화 list, in this order: channels (전체, the groups' rooms and the named group rooms, which
 * are private channels), then projects (each team project's own chat room: docs/decisions/20261121-sidebar-projects-group.md),
 * then direct messages (1:1s and the unnamed group rooms, as Slack lists group DMs:
 * docs/decisions/20261116-sidebar-channels-dms.md, docs/decisions/20261117-named-groups-private-channels.md). */
export const ROOM_SECTIONS = ['team', 'project', 'dm'] as const
export type RoomSection = (typeof ROOM_SECTIONS)[number]
export const SECTION_WORD = { team: 'rooms.section.team', project: 'rooms.section.project', dm: 'rooms.section.dm' } as const
/** A project's room by its flag (Room.projectRoom, told to every member: one who cannot open the project's folder now has
 * no Room.project and would land under Channels otherwise). */
const sectionOf = (room: Pick<Room, 'kind'> & Partial<Pick<Room, 'name' | 'project' | 'projectRoom'>>): RoomSection =>
  isProjectRoom(room) ? 'project' : room.kind === 'all' || room.kind === 'team' || isPrivateChannel({ kind: room.kind, name: room.name ?? null }) ? 'team' : 'dm'

/** A kind section's "+" (as Slack has it). Channels': a small menu, Create a channel (a name is required: a private
 * channel) and New section (docs/decisions/20261121-personal-sidebar-sections.md); a guest, who makes no channel, gets
 * New section itself. Direct messages': New message (one person: the DM; more: their group DM), none for a guest
 * (docs/decisions/20261117-named-groups-private-channels.md). */
export function RoomSectionAction({ section }: { section: RoomSection }) {
  const t = useT()
  const guest = isGuestMe(useMe())
  const [open, setOpen] = useState(false)
  // Projects has no "+": projects are made on the Projects page and from a conversation's "⋯" (Make it a project)
  if (section === 'project') return null
  if (section === 'team')
    return (
      <>
        <ChannelsAddMenu canMakeChannel={!guest} onNewChannel={() => setOpen(true)} />
        {!guest && <PeoplePicker open={open} onClose={() => setOpen(false)} mode={{ kind: 'channel' }} />}
      </>
    )
  if (guest) return null
  return (
    <>
      <SectionAddButton label={t('rooms.newChat')} onClick={() => setOpen(true)} testId="rooms-new-message" />
      <PeoplePicker open={open} onClose={() => setOpen(false)} mode={{ kind: 'new' }} />
    </>
  )
}

/** The rooms not pinned or in a section (`rest`, by latest activity, as the store has them), by kind
 * (docs/DECISIONS.md "Conversations by kind under Show more"): in each section any pins first (the
 * most recently pinned first), then channels with 전체 first and the others (private channels among them) by the name their row shows (`titleOf`,
 * compared in the app's language, numbers by their value), projects' rooms by name the same way, direct messages (1:1s
 * and unnamed group rooms mixed) by latest activity. A section with no room is left out. */
export function roomSections<R extends Pick<Room, 'id' | 'kind'> & Partial<Pick<Room, 'pinnedAt' | 'name' | 'project' | 'projectRoom'>>>(rest: R[], titleOf: (room: R) => string, locale: string): { section: RoomSection; rooms: R[] }[] {
  return ROOM_SECTIONS.map((section) => {
    const of = rest.filter((r) => sectionOf(r) === section)
    const others = of.filter((r) => !r.pinnedAt)
    if (section === 'team' || section === 'project') {
      // each name worked out once, and one collator for the sort (the order of String.localeCompare in this language,
      // numbers by their value: "팀 2" before "팀 10")
      const titles = new Map(others.map((r) => [r.id, titleOf(r)]))
      const collator = new Intl.Collator(locale, { numeric: true })
      others.sort((a, b) => Number(b.kind === 'all') - Number(a.kind === 'all') || collator.compare(titles.get(a.id)!, titles.get(b.id)!))
    }
    return { section, rooms: [...pinnedRooms(of), ...others] }
  }).filter((s) => s.rooms.length > 0)
}

/** A room's one badge (shared roomCounts, docs/decisions/20261116-mentions-only-no-count.md): its number, or "@" when one
 * of the unread messages mentions me; grey for a room I turned off (which the 대화 tab does not count). Plain messages in
 * a room at 멘션만 show no number: the row is only bold, and a screen reader still hears that something is unread. */
export function UnreadBadge({ room, className, testId }: { room: Room; className?: string; testId: string }) {
  const t = useT()
  const c = roomCounts(room)
  if (!c.bold) return null
  if (!c.mention && c.number <= 0) return <span className="sr-only" data-testid={`${testId}-bold`}>{t('rooms.unreadNoCount')}</span>
  return <CountPill text={roomBadge(room)} label={`${t('rooms.unread', { n: c.number })}${c.mention ? `, ${t('rooms.mentionedYou')}` : ''}`} quiet={c.quiet} className={className} testId={testId} data-muted={c.quiet ? '' : undefined} />
}

/** A file of mine is still going up in this room (store/roomUploads.ts): its row says so while I am somewhere else, so
 * an upload that goes on is never out of sight. */
export function RoomUploadMark({ roomId, className }: { roomId: string; className?: string }) {
  const t = useT()
  const on = useRoomUploads((s) => uploadingIn(s, roomId))
  if (!on) return null
  return <Loader2 size={12} role="img" aria-label={t('rooms.uploadingMark')} className={clsx('shrink-0 animate-spin text-faint', className)} data-testid="room-upload-mark" />
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
  const { bold } = roomCounts(room)
  const menu = useRowMenu()
  // a conversation may go in one of my sections (its "⋯", or dragged onto the section with a mouse)
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
            // the lists' row height (rowBox: 30px, 48px on a phone)
            'flex items-center gap-2 rounded-lg px-3 hover:bg-hover pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]',
            rowBox,
            'pointer-fine:group-hover:pr-9 group-has-[:focus-visible]:pr-9 group-has-[[aria-expanded=true]]:pr-9 group-has-[[aria-expanded=true]]:bg-hover',
            // the ring of a DM's online dot takes the row's colour (index.css .presence-dot)
            '[--presence-bg:var(--c-subtle)] hover:[--presence-bg:var(--c-hover)] aria-[current=page]:[--presence-bg:var(--c-hover)] group-has-[[aria-expanded=true]]:[--presence-bg:var(--c-hover)]',
            isActive && 'bg-hover',
            rowName({ selected: isActive, unread: bold }),
          )
        }
        data-testid="sidebar-room"
      >
        {({ isActive }) => (
          <>
            {/* an unnamed group room: its people's faces (FaceStack), ringed in the row's colour; a named one: a lock */}
            <RoomIcon room={room} size={20} presence faces on="subtle" selected={isActive} />
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
            <RoomUploadMark roomId={room.id} className={ROW_MENU_SHOWN} />
            <UnreadBadge room={room} className={clsx('ml-auto', ROW_MENU_SHOWN)} testId="room-unread" />
          </>
        )}
      </NavLink>
      <RoomMenu
        room={room}
        label={t('rooms.menu.rowLabel', { name: title })}
        title={title}
        className="absolute inset-y-0 right-1 flex items-center"
        // its size in the row (a narrow window with a mouse; touch screens use the row's long press)
        compact
        buttonClassName={clsx('hover:bg-surface', ROW_MENU_BUTTON)}
        {...menu.open}
        testId="sidebar-room-menu"
        folders
      />
    </li>
  )
}
