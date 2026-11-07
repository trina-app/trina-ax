// The "대화" group in the computer's sidebar, above 트리나 기록: my rooms (a group's rooms, 전체, group chats, DMs) by
// latest activity, one pill each: "?" while the room's AI waits on me (session markers), else the count of what I have
// not read ("@" instead when one of them mentions me; grey in a muted room), and "+" for a new conversation. Strictly
// the five latest show, and the room on screen if it is not one of them (six at most); "더 보기 (N)" opens the rest in
// place ("접기" closes it), remembered in this browser like the fold, and carries what the hidden rooms hold for me
// ("?" when one's AI waits on me, "안 읽음 M", "@" when one mentions me), so no count the 대화
// tab shows is lost (a muted room's count only when nothing else is unread there, as its own badge is grey). With
// nothing hidden the same row is "모든 대화", to the whole conversations page (/rooms, with its search): the entry is
// always there (the owner, 2026-11-07).
// Rooms I hid (docs/DECISIONS.md "대화 숨기기") are in none of this: not in the five, not in "더 보기" or its pill (the
// room on screen still shows); they are under "숨긴 대화" on the conversations page, which "모든 대화" leads to (also
// below an opened "더 보기" while there are hidden ones). Each row has the room's "⋯" (RoomMenu.tsx) on hover or keyboard
// focus, in the pill's place, and on a right-click.
// Gone on a server without rooms (the list could not be read).
import clsx from 'clsx'
import { BellOff, ChevronDown, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { badgeText, roomBadge, roomUnread, shownInLists } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { PeoplePicker } from './PeoplePicker'
import { RoomIcon, useRoomTitle } from './RoomIcon'
import { RoomMenu, useRowMenu } from './RoomMenu'

const OPEN_KEY = 'mycel.sidebar.rooms'
/** the whole list opened ("더 보기"), remembered in this browser like the fold */
const ALL_KEY = 'mycel.sidebar.roomsAll'
/** rooms shown before "더 보기" (docs/DECISIONS.md "Desktop sidebar: rooms first") */
export const ROOMS_SHOWN = 5

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
  const everyRoom = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const failed = useRooms((s) => s.failed)
  const [open, setOpen] = useState(() => remembered(OPEN_KEY, 'open') !== 'closed')
  const [all, setAll] = useState(() => remembered(ALL_KEY, 'no') === 'yes')
  const [picking, setPicking] = useState(false)
  const listId = useId()
  // the room on screen stays in the list (/rooms/:id, and its threads)
  const openId = /^\/rooms\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null
  if (failed && !everyRoom.length) return null
  // the rooms I hid are in none of the rows, counts or pills here (the one on screen still shows)
  const rooms = shownInLists(everyRoom, openId)
  const someHidden = rooms.length < everyRoom.length
  const toggle = () => setOpen((v) => (remember(OPEN_KEY, v ? 'closed' : 'open'), !v))
  const showAll = (v: boolean) => (remember(ALL_KEY, v ? 'yes' : 'no'), setAll(v))
  // the five latest and the room on screen; "더 보기 (N)" opens the rest in place and says what is unread there
  const capped = shownRooms(rooms, ROOMS_SHOWN, openId)
  const shown = all ? rooms : capped
  const more = rooms.length - capped.length
  const hidden = all ? null : hiddenUnread(rooms.filter((r) => !capped.includes(r)))
  // a hidden room whose AI waits on me: "?" leads the pill (session markers, docs/DECISIONS.md), amber like the room's
  const hiddenAsk = !all && rooms.some((r) => r.aiWaits && !capped.includes(r))
  return (
    <div className="mb-3" data-testid="sidebar-rooms">
      <div className="flex items-center gap-1 pr-1 pl-3">
        <h2 className="text-xs font-medium text-faint">
          <button type="button" aria-expanded={open} aria-controls={listId} onClick={toggle} className="flex items-center gap-1 rounded py-1 hover:text-muted" data-testid="rooms-toggle">
            {t('rooms.title')}
            <ChevronDown size={12} className={clsx('transition-transform', !open && '-rotate-90')} aria-hidden />
          </button>
        </h2>
        <button type="button" onClick={() => setPicking(true)} aria-label={t('rooms.newChat')} title={t('rooms.newChat')} className="ml-auto flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink" data-testid="rooms-new-dm">
          <Plus size={15} aria-hidden />
        </button>
      </div>
      <ul id={listId} hidden={!open} data-testid="sidebar-rooms-list">
        {loaded && !everyRoom.length && <li className="px-3 py-2 text-sm text-faint">{t('rooms.listEmpty')}</li>}
        {shown.map((r) => (
          <RoomRow key={r.id} room={r} onNavigate={onNavigate} />
        ))}
        {more > 0 && (
          <li>
            <button type="button" aria-expanded={all} onClick={() => showAll(!all)} className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="rooms-more">
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
        {(more === 0 ? everyRoom.length > 0 : all && someHidden) && (
          <li>
            <Link to="/rooms" onClick={onNavigate} className="flex h-8 w-full items-center rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="rooms-all">
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

/** While a row's "⋯" shows (a mouse on the row, the keyboard in it, its menu open), what sits at the row's right end
 * gives way to it: the pill, the bell, and room for the "⋯" at the name's end. Touch screens have no "⋯" (a long press). */
export const ROW_MENU_SHOWN = 'pointer-fine:group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 group-has-[[aria-expanded=true]]:opacity-0'
export const ROW_MENU_BUTTON = 'opacity-0 pointer-coarse:hidden group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 aria-expanded:opacity-100 focus-visible:opacity-100'

function RoomRow({ room, onNavigate }: { room: Room; onNavigate: () => void }) {
  const t = useT()
  const title = useRoomTitle()(room)
  const unread = roomUnread(room)
  const menu = useRowMenu()
  return (
    <li className="group relative" {...menu.row} data-testid="sidebar-room-row">
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
            isActive ? 'bg-hover font-medium text-ink' : unread > 0 ? 'font-semibold text-ink' : 'text-muted',
          )
        }
        data-testid="sidebar-room"
      >
        <RoomIcon room={room} size={20} />
        {/* a long name is cut; the whole of it on hover */}
        <span className="truncate" title={title}>
          {title}
        </span>
        {room.muted && (
          <>
            <BellOff size={12} className={clsx('shrink-0 text-faint', ROW_MENU_SHOWN)} aria-hidden />
            <span className="sr-only">{t('rooms.muted')}</span>
          </>
        )}
        <UnreadBadge room={room} className={clsx('ml-auto', ROW_MENU_SHOWN)} testId="room-unread" />
      </NavLink>
      <RoomMenu
        room={room}
        label={t('rooms.menu.rowLabel', { name: title })}
        className="absolute inset-y-0 right-1 flex items-center"
        buttonClassName={clsx('hover:bg-surface', ROW_MENU_BUTTON)}
        openSignal={menu.openSignal}
        openRequest={menu.openRequest}
        testId="sidebar-room-menu"
      />
    </li>
  )
}
