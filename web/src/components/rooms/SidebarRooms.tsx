// The "대화" group in the computer's sidebar, above 트리나 기록: my rooms (a group's rooms, 전체, group chats, DMs) by
// latest activity, one count pill each for what I have not read ("@" instead when one of them mentions me; grey in a
// muted room), and "+" for a new conversation. Strictly the five latest show, and the room on screen if it is not one
// of them (six at most); "더 보기 (N)" opens the rest in place ("접기" closes it), remembered in this browser like the
// fold, and carries what the hidden rooms hold unread ("안 읽음 M", "@" when one mentions me), so no count the 대화
// tab shows is lost (a muted room's count only when nothing else is unread there, as its own badge is grey).
// Gone on a server without rooms (the list could not be read).
import clsx from 'clsx'
import { BellOff, ChevronDown, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { badgeText, roomBadge, roomUnread } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { PeoplePicker } from './PeoplePicker'
import { RoomIcon, useRoomTitle } from './RoomIcon'

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
  const rooms = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const failed = useRooms((s) => s.failed)
  const [open, setOpen] = useState(() => remembered(OPEN_KEY, 'open') !== 'closed')
  const [all, setAll] = useState(() => remembered(ALL_KEY, 'no') === 'yes')
  const [picking, setPicking] = useState(false)
  const listId = useId()
  // the room on screen stays in the list (/rooms/:id, and its threads)
  const openId = /^\/rooms\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null
  if (failed && !rooms.length) return null
  const toggle = () => setOpen((v) => (remember(OPEN_KEY, v ? 'closed' : 'open'), !v))
  const showAll = (v: boolean) => (remember(ALL_KEY, v ? 'yes' : 'no'), setAll(v))
  // the five latest and the room on screen; "더 보기 (N)" opens the rest in place and says what is unread there
  const capped = shownRooms(rooms, ROOMS_SHOWN, openId)
  const shown = all ? rooms : capped
  const more = rooms.length - capped.length
  const hidden = all ? null : hiddenUnread(rooms.filter((r) => !capped.includes(r)))
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
        {loaded && !rooms.length && <li className="px-3 py-2 text-sm text-faint">{t('rooms.listEmpty')}</li>}
        {shown.map((r) => (
          <RoomRow key={r.id} room={r} onNavigate={onNavigate} />
        ))}
        {more > 0 && (
          <li>
            <button type="button" aria-expanded={all} onClick={() => showAll(!all)} className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="rooms-more">
              <span className="truncate">{all ? t('common.less') : t('sidebar.showMore', { n: more })}</span>
              {hidden && (
                <span className={clsx('ml-auto shrink-0 rounded-full px-1.5 text-micro font-medium', hidden.muted ? 'bg-hover text-muted' : 'bg-accent text-accent-ink')} data-testid="rooms-more-unread" data-muted={hidden.muted ? '' : undefined}>
                  <span aria-hidden>
                    {hidden.mentioned && '@ '}
                    {t('sidebar.moreUnread', { n: badgeText(hidden.n) })}
                  </span>
                  <span className="sr-only">
                    {t('rooms.unread', { n: hidden.n })}
                    {hidden.mentioned && `, ${t('rooms.mentionedYou')}`}
                  </span>
                </span>
              )}
            </button>
          </li>
        )}
      </ul>
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </div>
  )
}

/** A room's unread badge: the count, or "@" when one of them mentions me; grey for a muted room (which the 대화 tab
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

function RoomRow({ room, onNavigate }: { room: Room; onNavigate: () => void }) {
  const t = useT()
  const title = useRoomTitle()(room)
  const unread = roomUnread(room)
  return (
    <li>
      <NavLink
        to={`/rooms/${room.id}`}
        onClick={onNavigate}
        className={({ isActive }) => clsx('flex h-9 items-center gap-2 rounded-lg px-3 text-sm hover:bg-hover max-sm:h-10', isActive ? 'bg-hover font-medium text-ink' : unread > 0 ? 'font-semibold text-ink' : 'text-muted')}
        data-testid="sidebar-room"
      >
        <RoomIcon room={room} size={20} />
        {/* a long name is cut; the whole of it on hover */}
        <span className="truncate" title={title}>
          {title}
        </span>
        {room.muted && (
          <>
            <BellOff size={12} className="shrink-0 text-faint" aria-hidden />
            <span className="sr-only">{t('rooms.muted')}</span>
          </>
        )}
        <UnreadBadge room={room} className="ml-auto" testId="room-unread" />
      </NavLink>
    </li>
  )
}
