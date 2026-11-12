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
import clsx from 'clsx'
import { BellOff, Pin, Plus } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { badgeText, pinnedRooms, roomBadge, roomUnread, shownInLists } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { PeoplePicker } from './PeoplePicker'
import { RoomIcon, RoomName, useRoomTitle } from './RoomIcon'
import { RoomMenu, useRowMenu } from './RoomMenu'
import { Tooltip } from '../Tooltip'
import { SidebarSectionTitle } from '../ui'
import { PresenceText } from '../Presence'

const OPEN_KEY = 'mycel.sidebar.rooms'
/** the whole list opened ("더 보기"), remembered in this browser like the fold */
const ALL_KEY = 'mycel.sidebar.roomsAll'
/** rooms shown before "더 보기" (docs/DECISIONS.md "Desktop sidebar: rooms first") */
export const ROOMS_SHOWN = 5
/** pinned rooms shown above them before "더 보기" (docs/DECISIONS.md "Pinned conversations"; as the AI chats' pins) */
export const PINS_SHOWN = 10

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
 * PINS_SHOWN, then the ROOMS_SHOWN latest of the others, and the room on screen wherever it is (`openId`). An opened
 * "더 보기" asks without the room on screen (null): it is in its section below, so the top rows stay where they were. */
export function sidebarRows<R extends Pick<Room, 'id'> & Partial<Pick<Room, 'pinnedAt'>>>(rooms: R[], openId: string | null): R[] {
  const pins = pinnedRooms(rooms)
  const rest = rooms.filter((r) => !r.pinnedAt)
  return [...shownRooms(pins, PINS_SHOWN, openId), ...shownRooms(rest, ROOMS_SHOWN, openId)]
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

export function SidebarRooms({ onNavigate }: { onNavigate: () => void }) {
  const t = useT()
  const titleOf = useRoomTitle()
  const locale = useLocale()
  const everyRoom = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const failed = useRooms((s) => s.failed)
  const [open, setOpen] = useState(() => remembered(OPEN_KEY, 'open') !== 'closed')
  const [all, setAll] = useState(() => remembered(ALL_KEY, 'no') === 'yes')
  const [picking, setPicking] = useState(false)
  const listId = useId()
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
  if (failed && !everyRoom.length) return null
  // the rooms I hid are in none of the rows, counts or pills here (the one on screen still shows)
  const rooms = shownInLists(everyRoom, openId)
  const someHidden = rooms.length < everyRoom.length
  const toggle = () => setOpen((v) => (remember(OPEN_KEY, v ? 'closed' : 'open'), !v))
  const showAll = (v: boolean) => (remember(ALL_KEY, v ? 'yes' : 'no'), setAll(v))
  // my pins (at most ten), the five latest of the others and the room on screen; "더 보기 (N)" says what is unread in
  // the rest
  const capped = sidebarRows(rooms, openId)
  const more = rooms.length - capped.length
  // opened: the same top rows without the room on screen (it is in its section, so a clicked row never moves), then the
  // rest by kind. "접기" stays while anything is below the top rows, also when that is only the room on screen.
  const top = sidebarRows(rooms, null)
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
      <ul id={listId} hidden={!open} data-testid="sidebar-rooms-list">
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
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </div>
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
function RoomRow({ room, onNavigate, section }: { room: Room; onNavigate: () => void; section?: RoomSection }) {
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
