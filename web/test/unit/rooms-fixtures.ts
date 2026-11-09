// Contract-shaped rooms data for the room tests (parsed with the shared schemas, so a contract change breaks them).
import { Room, RoomMessage, uuidv7, type Room as RoomT, type RoomMessage as RoomMessageT } from '@mycel/shared/api'

export const ME = { id: 'ada', name: 'Ada' }
export const BEN = { id: 'ben', name: 'Ben' }
export const CY = { id: 'cy', name: 'Cy Park' }

const T0 = Date.parse('2026-11-05T09:00:00.000Z')
export const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

export function room(o: Partial<RoomT> = {}): RoomT {
  return Room.parse({
    id: uuidv7(),
    kind: 'team',
    name: 'acme-design',
    canRename: false,
    managerId: null,
    groupId: uuidv7(),
    memberCount: 3,
    peers: [BEN, CY],
    unreadCount: 0,
    threadsUnread: 0,
    nextThreadId: null,
    mentioned: false,
    lastReadSeq: 0,
    lastSeq: 0,
    lastMessage: null,
    muted: false,
    createdAt: at(-60),
    activityAt: at(-60),
    ...o,
  })
}

export function message(o: Partial<RoomMessageT> & Pick<RoomMessageT, 'roomId' | 'seq'>): RoomMessageT {
  return RoomMessage.parse({
    id: uuidv7(),
    authorKind: 'user',
    author: BEN,
    askedBy: null,
    visibility: 'room',
    body: 'hello',
    replyTo: null,
    mentions: [],
    files: [],
    createdAt: at(o.seq),
    editedAt: null,
    deletedAt: null,
    ...o,
  })
}
