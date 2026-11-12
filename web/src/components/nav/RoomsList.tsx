// The rooms as a list (my rooms by latest activity, a capped top and "더 보기" for the rest by kind) and its rows, moved
// out of rooms/SidebarRooms.tsx with no change in what it shows (navigation redesign, docs/AGENTS/plan/
// 20261112-1839-nav-rail.md, phase P0b) so the rail's 대화 panel can draw the same list. The caps are the caller's
// (`caps`: today's sidebar passes SIDEBAR_ROOM_CAPS). What it holds and why: SidebarRooms.tsx's head comment and
// docs/DECISIONS.md "Desktop sidebar: rooms first", "Pinned conversations", "Conversations by kind under Show more".
import clsx from 'clsx'
import { BellOff, Pin } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { badgeText, pinnedRooms, roomBadge, roomUnread, shownInLists } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { RoomIcon, RoomName, useRoomTitle } from '../rooms/RoomIcon'
import { RoomMenu, useRowMenu } from '../rooms/RoomMenu'
import { PresenceText } from '../Presence'

/** the whole list opened ("더 보기"), remembered in this browser like the fold */
const ALL_KEY = 'mycel.sidebar.roomsAll'
/** rooms shown before "더 보기" (docs/DECISIONS.md "Desktop sidebar: rooms first") */
export const ROOMS_SHOWN = 5
/** pinned rooms shown above them before "더 보기" (docs/DECISIONS.md "Pinned conversations"; as the AI chats' pins) */
export const PINS_SHOWN = 10
/** A capped list's top: at most `pins` of my pinned rooms, then the `latest` latest of the others (and the room on
 * screen). */
export interface RoomCaps {
  pins: number
  latest: number
}
/** today's sidebar */
export const SIDEBAR_ROOM_CAPS: RoomCaps = { pins: PINS_SHOWN, latest: ROOMS_SHOWN }

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

/** The rooms a capped list shows, in their order (latest activity first): the first `n`, and the room on screen if it
 * is not one of them. Nothing else: an unread room further down is counted on "더 보기" (hiddenUnread). */
export function shownRooms<R extends Pick<Room, 'id'>>(rooms: R[], n: number, openId: string | null): R[] {
  return rooms.filter((r, i) => i < n || r.id === openId)
}

/** The sidebar's top rows (rooms by latest activity): my pinned ones first, the most recently pinned first, at most
 * `caps.pins` (PINS_SHOWN), then the `caps.latest` (ROOMS_SHOWN) latest of the others, and the room on screen wherever
 * it is (`openId`). An opened "더 보기" asks without the room on screen (null): it is in its section below, so the top
 * rows stay where they were. */
export function sidebarRows<R extends Pick<Room, 'id'> & Partial<Pick<Room, 'pinnedAt'>>>(rooms: R[], openId: string | null, caps: RoomCaps = SIDEBAR_ROOM_CAPS): R[] {
  const pins = pinnedRooms(rooms)
  const rest = rooms.filter((r) => !r.pinnedAt)
  return [...shownRooms(pins, caps.pins, openId), ...shownRooms(rest, caps.latest, openId)]
}

/** The sections under an opened "더 보기", in this order: team rooms (전체 and the groups' rooms), group chats, DMs. */
export const ROOM_SECTIONS = ['team', 'group', 'dm'] as const
export type RoomSection = (typeof ROOM_SECTIONS)[number]
const SECTION_WORD = { team: 'rooms.section.team', group: 'rooms.section.group', dm: 'rooms.section.dm' } as const
const sectionOf = (kind: Room['kind']): RoomSection => (kind === 'all' ? 'team' : kind)

/** The rooms under the top rows of an opened "더 보기" (`rest`, by latest activity, as the store has them), by kind
 * (docs/DECISIONS.md "Conversations by kind under Show more"): in each section my pins past the top ones first (the
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

type Unread = Pick<Room, 'unreadCount' | 'mentioned' | 'muted'> & Partial<Pick<Room, 'threadsUnread'>>
/** What the rooms behind "더 보기" hold for me, as one pill like a room's: the unread messages and followed replies of
 * the rooms that are not muted, added, and "@" when one of those mentions me; only when none has any, the muted rooms'
 * (grey, as their own badges are). Null when nothing is unread there. */
export function hiddenUnread(hidden: Unread[]): { n: number; mentioned: boolean; muted: boolean } | null {
  for (const muted of [false, true]) {
    const some = hidden.filter((r) => !!r.muted === muted && roomUnread(r) > 0)
    if (some.length) return { n: some.reduce((n, r) => n + roomUnread(r), 0), mentioned: some.some((r) => r.mentioned), muted }
  }
  return null
}

/**
 * The list of my rooms (an <ul>): the capped top rows (`caps`), "더 보기 (N)" with what the rest hold for me, which opens
 * them in place by kind, and "모든 대화" to the conversations page. `id` and `hidden` are the fold's (the caller's
 * section title controls it).
 */
export function RoomsList({ id, hidden: folded, onNavigate, caps = SIDEBAR_ROOM_CAPS }: { id?: string; hidden?: boolean; onNavigate: () => void; caps?: RoomCaps }) {
  const t = useT()
  const titleOf = useRoomTitle()
  const locale = useLocale()
  const everyRoom = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const [all, setAll] = useState(() => remembered(ALL_KEY, 'no') === 'yes')
  // "접기" pressed while only the room on screen was below the top rows: the button goes ("모든 대화" takes its place),
  // so the keyboard goes there instead of falling to the page
  const allRooms = useRef<HTMLAnchorElement>(null)
  const focusAll = useRef(false)
  useEffect(() => {
    if (!focusAll.current) return
    focusAll.current = false
    allRooms.current?.focus()
  })
  // the room on screen stays in the list (/rooms/:id, and its threads)
  const openId = /^\/rooms\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null
  // the rooms I hid are in none of the rows, counts or pills here (the one on screen still shows)
  const rooms = shownInLists(everyRoom, openId)
  const someHidden = rooms.length < everyRoom.length
  const showAll = (v: boolean) => (remember(ALL_KEY, v ? 'yes' : 'no'), setAll(v))
  // my pins (at most ten), the five latest of the others and the room on screen; "더 보기 (N)" says what is unread in
  // the rest
  const capped = sidebarRows(rooms, openId, caps)
  const more = rooms.length - capped.length
  // opened: the same top rows without the room on screen (it is in its section, so a clicked row never moves), then the
  // rest by kind. "접기" stays while anything is below the top rows, also when that is only the room on screen.
  const top = sidebarRows(rooms, null, caps)
  const below = rooms.filter((r) => !top.includes(r))
  const opened = all && below.length > 0
  const entry = all ? below.length > 0 : more > 0
  const hidden = all ? null : hiddenUnread(rooms.filter((r) => !capped.includes(r)))
  // a hidden room whose AI waits on me: "?" leads the pill (session markers, docs/DECISIONS.md), amber like the room's
  const hiddenAsk = !all && rooms.some((r) => r.aiWaits && !capped.includes(r))
  const rows: ReactNode[] = (opened ? top : capped).map((r) => <RoomRow key={r.id} room={r} onNavigate={onNavigate} />)
  if (opened)
    for (const { section, rooms: of } of roomSections(below, titleOf, locale)) {
      // a quiet label, not a row (no hover, no fold, no count): "더 보기" is the fold already. A heading inside the
      // list, in an item of its own that is not counted as one, so the fold's aria-controls covers it too.
      rows.push(
        <li key={`section-${section}`} role="presentation" data-testid="sidebar-rooms-section" data-section={section}>
          <h3 className="px-3 pt-4 pb-1 text-micro font-medium text-faint">{t(SECTION_WORD[section])}</h3>
        </li>,
        ...of.map((r) => <RoomRow key={r.id} room={r} onNavigate={onNavigate} section={section} />),
      )
    }
  return (
    <ul id={id} hidden={folded} data-testid="sidebar-rooms-list">
      {loaded && !everyRoom.length && <li className="px-3 py-2 text-sm text-faint">{t('rooms.listEmpty')}</li>}
      {rows}
      {entry && (
        <li>
          <button type="button" aria-expanded={all} onClick={() => ((focusAll.current = all && more === 0), showAll(!all))} className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="rooms-more">
            <span className="truncate">{all ? t('common.less') : t('sidebar.showMore', { n: more })}</span>
            {(hidden || hiddenAsk) && (
              <span className={clsx('ml-auto shrink-0 rounded-full px-1.5 text-micro font-medium', hiddenAsk ? 'bg-warn font-bold text-canvas' : hidden!.muted ? 'bg-hover text-muted' : 'bg-accent text-accent-ink')} data-testid="rooms-more-unread" data-muted={!hiddenAsk && hidden?.muted ? '' : undefined} data-ai-waits={hiddenAsk ? '' : undefined}>
                <span aria-hidden>
                  {hiddenAsk && (hidden ? '? ' : '?')}
                  {hidden?.mentioned && '@ '}
                  {hidden && t('sidebar.moreUnread', { n: badgeText(hidden.n) })}
                </span>
                <span className="sr-only">
                  {[hiddenAsk && t('rooms.aiWaits'), hidden && t('rooms.unread', { n: hidden.n }), hidden?.mentioned && t('rooms.mentionedYou')].filter(Boolean).join(', ')}
                </span>
              </span>
            )}
          </button>
        </li>
      )}
      {/* nothing behind "더 보기": the entry is still there, to the whole conversations page (its search, every room,
          the ones I hid); with the rest opened in place, it is there too while some are hidden (only that page has them) */}
      {(!entry ? everyRoom.length > 0 : all && someHidden) && (
        <li>
          <Link ref={allRooms} to="/rooms" onClick={onNavigate} className="flex h-8 w-full items-center rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="rooms-all">
            <span className="truncate">{t('sidebar.allRooms')}</span>
          </Link>
        </li>
      )}
    </ul>
  )
}

/** A room's one badge: "?" in amber while its AI waits on me (a card of my own question; docs/DECISIONS.md "Session
 * markers"), else the unread count, or "@" when one of them mentions me; grey for a muted room (which the 대화 tab does
 * not count). The same pill, only its mark and colour differ. */
export function UnreadBadge({ room, className, testId }: { room: Room; className?: string; testId: string }) {
  const t = useT()
  const n = roomUnread(room)
  if (room.aiWaits)
    return (
      <span className={clsx('shrink-0 rounded-full bg-warn px-1.5 text-micro font-bold text-canvas', className)} data-testid={testId} data-ai-waits="">
        <span aria-hidden>?</span>
        <span className="sr-only">{[t('rooms.aiWaits'), n > 0 && t('rooms.unread', { n })].filter(Boolean).join(', ')}</span>
      </span>
    )
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

/** `section`: the kind's section it is in under an opened "더 보기" (none in the top rows) */
export function RoomRow({ room, onNavigate, section }: { room: Room; onNavigate: () => void; section?: RoomSection }) {
  const t = useT()
  const title = useRoomTitle()(room)
  const unread = roomUnread(room)
  const menu = useRowMenu()
  return (
    <li className="group relative" {...menu.row} data-testid="sidebar-room-row" data-section={section}>
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
      />
    </li>
  )
}
