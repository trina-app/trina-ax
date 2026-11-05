// The "대화방" group in the sidebar, above the AI chats: my rooms (a group's rooms, 전체, DMs) by latest activity, one
// count pill each for what I have not read ("@" in front when one of them mentions me), and "+" for a new 1:1 chat.
// Folds like Recents (remembered in this browser). Gone on a server without rooms (the list could not be read).
import clsx from 'clsx'
import { BellOff, ChevronDown, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { badgeText } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { PeoplePicker } from './PeoplePicker'
import { RoomIcon, useRoomTitle } from './RoomIcon'

const OPEN_KEY = 'mycel.sidebar.rooms'
/** rows shown before "모두 보기" (the rooms page lists every one) */
const SHOWN = 8

const rememberedOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'closed'
  } catch {
    return true
  }
}

export function SidebarRooms({ onNavigate }: { onNavigate: () => void }) {
  const t = useT()
  const rooms = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const failed = useRooms((s) => s.failed)
  const [open, setOpen] = useState(rememberedOpen)
  const [picking, setPicking] = useState(false)
  const listId = useId()
  if (failed && !rooms.length) return null
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? 'closed' : 'open')
      } catch {
        /* not kept */
      }
      return !v
    })
  // unread rooms stay in sight even past the first rows
  const shown = rooms.filter((r, i) => i < SHOWN || r.unreadCount > 0)
  return (
    <div className="mb-3" data-testid="sidebar-rooms">
      <div className="flex items-center gap-1 pr-1 pl-3">
        <h2 className="text-xs font-medium text-faint">
          <button type="button" aria-expanded={open} aria-controls={listId} onClick={toggle} className="flex items-center gap-1 rounded py-1 hover:text-muted" data-testid="rooms-toggle">
            {t('rooms.title')}
            <ChevronDown size={12} className={clsx('transition-transform', !open && '-rotate-90')} aria-hidden />
          </button>
        </h2>
        <button type="button" onClick={() => setPicking(true)} aria-label={t('rooms.newDm')} title={t('rooms.newDm')} className="ml-auto flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink" data-testid="rooms-new-dm">
          <Plus size={15} aria-hidden />
        </button>
      </div>
      <ul id={listId} hidden={!open} data-testid="sidebar-rooms-list">
        {loaded && !rooms.length && <li className="px-3 py-2 text-sm text-faint">{t('rooms.listEmpty')}</li>}
        {shown.map((r) => (
          <RoomRow key={r.id} room={r} onNavigate={onNavigate} />
        ))}
        {shown.length < rooms.length && (
          <li>
            <Link to="/rooms" onClick={onNavigate} className="flex h-8 items-center rounded-lg px-3 text-xs text-muted hover:bg-hover">
              {t('rooms.showAll')}
            </Link>
          </li>
        )}
      </ul>
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </div>
  )
}

function RoomRow({ room, onNavigate }: { room: Room; onNavigate: () => void }) {
  const t = useT()
  const title = useRoomTitle()(room)
  const unread = room.unreadCount
  return (
    <li>
      <NavLink
        to={`/rooms/${room.id}`}
        onClick={onNavigate}
        className={({ isActive }) => clsx('flex h-9 items-center gap-2 rounded-lg px-3 text-sm hover:bg-hover max-sm:h-10', isActive ? 'bg-hover font-medium text-ink' : unread > 0 ? 'font-medium text-ink' : 'text-muted')}
        data-testid="sidebar-room"
      >
        <RoomIcon room={room} size={20} />
        <span className="truncate">{title}</span>
        {room.muted && (
          <>
            <BellOff size={12} className="shrink-0 text-faint" aria-hidden />
            <span className="sr-only">{t('rooms.muted')}</span>
          </>
        )}
        {unread > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-accent px-1.5 text-[11px] font-medium text-accent-ink" data-testid="room-unread">
            <span aria-hidden>
              {room.mentioned && '@'}
              {badgeText(unread)}
            </span>
            <span className="sr-only">
              {t('rooms.unread', { n: unread })}
              {room.mentioned && `, ${t('rooms.mentionedYou')}`}
            </span>
          </span>
        )}
      </NavLink>
    </li>
  )
}
