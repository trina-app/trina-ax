// What stands for a room in a list or a header: the other person's picture in a DM, a "#" for a group's room, the
// people mark for the everyone room and two speech bubbles for a group chat. Decorative: the room's name is always
// written beside it. `presence`: a DM's picture carries the other person's online dot (components/Presence.tsx; the
// caller says the state in words after the name, PresenceText). A group chat has none, as in Slack.
import { Hash, MessagesSquare, Users } from 'lucide-react'
import { useCallback } from 'react'
import type { Room } from '@mycel/shared/api'
import { translate, useLocale, useT } from '../../i18n'
import { roomTitle } from '../../lib/rooms'
import { useAvatarOf, usePeople, usePeopleList } from '../../store/people'
import { Avatar } from '../Avatar'
import { PresenceFace } from '../Presence'

/** The room's name as the app shows it (its own name; DMs: the other person; the everyone room: "전체"; an unnamed group
 * chat: "가, 나, 다 외 2명"). */
export function useRoomTitle() {
  const t = useT()
  const all = t('rooms.all')
  const gone = t('rooms.goneUser')
  const alone = t('rooms.groupAlone')
  const sep = t('rooms.nameSep')
  const locale = useLocale()
  // a DM and an unnamed group chat are named after the people as the directory has them now (a changed name shows at once)
  const byId = usePeople((s) => s.byId)
  return useCallback((room: Pick<Room, 'kind' | 'name' | 'peers'> & Partial<Pick<Room, 'memberCount'>>) => {
    const peers = room.kind === 'dm' || room.kind === 'group' ? room.peers.map((p) => (byId[p.id] ? { ...p, name: byId[p.id]!.name } : p)) : room.peers
    return roomTitle({ ...room, peers }, { all, gone, alone, sep, names: (names, n) => (n > 0 ? translate(locale, 'rooms.groupNamesMore', { names, n }) : names) })
  }, [all, gone, alone, sep, locale, byId])
}

/** `tile`: the icon on a round tile the size of an avatar (lists); without it a bare 16px icon in a box of that size
 * (sidebar rows and the room header, lined up with the DMs' pictures). */
export function RoomIcon({ room, size, tile, presence }: { room: Room; size: number; tile?: boolean; presence?: boolean }) {
  // the photo comes from the people directory: read it where a DM shows (the 대화 list, the sidebar), not only in a room
  usePeopleList()
  const peer = useAvatarOf(room.kind === 'dm' ? (room.peers[0] ?? null) : null)
  if (room.kind === 'dm') return peer ? (presence ? <PresenceFace user={peer} size={size} /> : <Avatar user={peer} size={size} />) : <span aria-hidden className="shrink-0 rounded-full bg-hover" style={{ width: size, height: size }} />
  const Icon = room.kind === 'all' ? Users : room.kind === 'group' ? MessagesSquare : Hash
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
