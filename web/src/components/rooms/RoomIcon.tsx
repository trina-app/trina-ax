// What stands for a room in a list or a header: the other person's picture in a DM, a "#" for a group's room and the
// people mark for the everyone room. Decorative: the room's name is always written beside it.
import { Hash, Users } from 'lucide-react'
import { useCallback } from 'react'
import type { Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { roomTitle } from '../../lib/rooms'
import { useAvatarOf, usePeopleList } from '../../store/people'
import { Avatar } from '../Avatar'

/** The room's name as the app shows it (DMs: the other person; the everyone room: "전체"). */
export function useRoomTitle() {
  const t = useT()
  const all = t('rooms.all')
  const gone = t('rooms.goneUser')
  return useCallback((room: Pick<Room, 'kind' | 'name' | 'peers'>) => roomTitle(room, { all, gone }), [all, gone])
}

/** `tile`: the icon on a round tile the size of an avatar (lists); without it a bare 16px icon in a box of that size
 * (sidebar rows and the room header, lined up with the DMs' pictures). */
export function RoomIcon({ room, size, tile }: { room: Room; size: number; tile?: boolean }) {
  // the photo comes from the people directory: read it where a DM shows (the 대화 list, the sidebar), not only in a room
  usePeopleList()
  const peer = useAvatarOf(room.kind === 'dm' ? (room.peers[0] ?? null) : null)
  if (room.kind === 'dm') return peer ? <Avatar user={peer} size={size} /> : <span aria-hidden className="shrink-0 rounded-full bg-hover" style={{ width: size, height: size }} />
  const Icon = room.kind === 'all' ? Users : Hash
  if (!tile)
    return (
      <span aria-hidden className="flex shrink-0 items-center justify-center text-muted" style={{ width: size, height: size }}>
        <Icon size={16} />
      </span>
    )
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center rounded-full bg-hover text-muted" style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.45)} />
    </span>
  )
}
