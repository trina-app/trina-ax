// The team chat rooms ("대화방" v1, shared/src/api/rooms.ts): the rooms I am in with their unread badges, and the
// messages of the one room on screen (pages/Room.tsx). Only that room's messages are kept: leaving it drops them and
// opening a room reads its newest page. The WebSocket's room.* events come in through store/live.ts dispatch →
// handleEvent; the pure with* functions below make the state changes (test/unit/rooms-store.test.ts), handleEvent adds
// the requests they need. A reconnect the server could not resume reloads through resync (components/rooms/useRoomsSync).
import { create } from 'zustand'
import { uuidv7, type Room, type RoomFile, type RoomLastMessage, type RoomMember, type RoomMessage, type RoomQuote, type ServerEvent } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { navigateTo } from '../lib/nav'
import { currentLocale, t } from '../i18n'
import { useSession } from './session'
import { toast } from './ui'

export type RoomEvent = Extract<ServerEvent, { type: 'room.message' | 'room.message.updated' | 'room.read' | 'room.updated' }>

export const ROOM_PAGE = 50

export interface RoomThread {
  roomId: string
  messages: RoomMessage[]
  /** older messages (null: this is the start of what I can see) */
  nextCursor: string | null
  loading: boolean
  error: unknown
}

/** A message on its way (or that could not be sent): shown at the end of the room until the server has it. */
export interface PendingSend {
  clientMessageId: string
  body: string
  mentions: string[]
  replyTo: RoomQuote | null
  files: RoomFile[]
  state: 'sending' | 'failed'
  error?: string
  createdAt: string
}

export interface RoomsData {
  rooms: Room[]
  /** the room on screen */
  openRoomId: string | null
  thread: RoomThread | null
}

const time = (iso: string) => Date.parse(iso) || 0

/** Most recent activity first, as GET /api/rooms lists them. */
export const sortRooms = (rooms: Room[]) => [...rooms].sort((a, b) => time(b.activityAt) - time(a.activityAt))

/** One copy per message id (the newest wins), in room order. A message's unread count only ever goes down (readers are
 * added, nobody can see it again later), so the lower one is kept: the answer to my own send can arrive after the
 * room.read of someone who read it already. */
export function mergeMessages(list: RoomMessage[], incoming: RoomMessage[]): RoomMessage[] {
  const byId = new Map(list.map((m) => [m.id, m]))
  for (const m of incoming) {
    const prev = byId.get(m.id)
    byId.set(m.id, prev && prev.unread < m.unread ? { ...m, unread: prev.unread } : m)
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

export function lastLineOf(m: RoomMessage): RoomLastMessage {
  return { id: m.id, seq: m.seq, author: m.author, excerpt: m.deletedAt ? '' : m.body.slice(0, 120), fileCount: m.files.length, deleted: !!m.deletedAt, createdAt: m.createdAt }
}

export function quoteOf(m: RoomMessage): RoomQuote {
  return { id: m.id, author: m.author, excerpt: m.deletedAt ? '' : m.body.slice(0, 200), fileCount: m.files.length, deleted: !!m.deletedAt }
}

/**
 * A new message: once (by id) in the open room's messages; its room moves to the top with it as the last line. A
 * message after the room's last position that is not mine and arrives while the room is not on screen counts as unread
 * (and "mentions me" when it does); a message seen before (a replay, my own send's answer) counts nothing again. My
 * own message moves my read position to it (the server does the same), so the room has nothing unread for me then.
 */
export function withMessage(d: RoomsData, roomId: string, m: RoomMessage, meId: string | null): RoomsData {
  const thread = d.thread && d.thread.roomId === roomId ? { ...d.thread, messages: mergeMessages(d.thread.messages, [m]) } : d.thread
  const room = d.rooms.find((r) => r.id === roomId)
  if (!room) return { ...d, thread }
  const fresh = m.seq > room.lastSeq
  const mine = !!meId && m.author?.id === meId
  const counts = fresh && !mine && m.visibility === 'room' && !m.deletedAt && d.openRoomId !== roomId
  const next: Room = {
    ...room,
    lastSeq: Math.max(room.lastSeq, m.seq),
    lastMessage: fresh || room.lastMessage?.id === m.id ? lastLineOf(m) : room.lastMessage,
    activityAt: fresh && time(m.createdAt) > time(room.activityAt) ? m.createdAt : room.activityAt,
    unreadCount: mine && fresh ? 0 : counts ? Math.min(999, room.unreadCount + 1) : room.unreadCount,
    mentioned: mine && fresh ? false : room.mentioned || (counts && !!meId && m.mentions.includes(meId)),
    lastReadSeq: mine ? Math.max(room.lastReadSeq, m.seq) : room.lastReadSeq,
  }
  return { ...d, rooms: sortRooms(d.rooms.map((r) => (r.id === roomId ? next : r))), thread }
}

/** An edited or deleted message: replaced where it shows (the open room, quotes of it, the room's last line). */
export function withUpdatedMessage(d: RoomsData, roomId: string, m: RoomMessage): RoomsData {
  let thread = d.thread
  if (thread && thread.roomId === roomId) {
    const q = quoteOf(m)
    thread = { ...thread, messages: thread.messages.map((x) => (x.id === m.id ? { ...m, unread: Math.min(x.unread, m.unread) } : x.replyTo?.id === m.id ? { ...x, replyTo: { ...q, author: x.replyTo.author } } : x)) }
  }
  const rooms = d.rooms.some((r) => r.id === roomId && r.lastMessage?.id === m.id) ? d.rooms.map((r) => (r.id === roomId && r.lastMessage?.id === m.id ? { ...r, lastMessage: lastLineOf(m) } : r)) : d.rooms
  return { ...d, rooms, thread }
}

/** Somebody read fromSeq < seq <= toSeq: each of those messages has one person fewer who has not read it (never below 0). */
export function decrementUnread(messages: RoomMessage[], fromSeq: number, toSeq: number): RoomMessage[] {
  let changed = false
  const out = messages.map((m) => {
    if (m.seq <= fromSeq || m.seq > toSeq || m.unread <= 0) return m
    changed = true
    return { ...m, unread: m.unread - 1 }
  })
  return changed ? out : messages
}

export function withRead(d: RoomsData, roomId: string, fromSeq: number, toSeq: number): RoomsData {
  if (!d.thread || d.thread.roomId !== roomId) return d
  const messages = decrementUnread(d.thread.messages, fromSeq, toSeq)
  return messages === d.thread.messages ? d : { ...d, thread: { ...d.thread, messages } }
}

/** The server's copy of a room (new to me, renamed, my setting, members changed): in its place by activity. */
export function withRoom(d: RoomsData, room: Room): RoomsData {
  const rooms = d.rooms.some((r) => r.id === room.id) ? d.rooms.map((r) => (r.id === room.id ? room : r)) : [...d.rooms, room]
  return { ...d, rooms: sortRooms(rooms) }
}

/** I am no longer in the room: gone from the list, and its messages with it. */
export function withoutRoom(d: RoomsData, roomId: string): RoomsData {
  return { ...d, rooms: d.rooms.filter((r) => r.id !== roomId), thread: d.thread?.roomId === roomId ? null : d.thread }
}

/** The read position the server answered: my badge for the room follows it. */
export function withReadState(d: RoomsData, roomId: string, s: { lastReadSeq: number; unreadCount: number }): RoomsData {
  return { ...d, rooms: d.rooms.map((r) => (r.id === roomId ? { ...r, lastReadSeq: Math.max(r.lastReadSeq, s.lastReadSeq), unreadCount: s.unreadCount, mentioned: s.unreadCount > 0 && r.mentioned } : r)) }
}

const myId = () => {
  const s = useSession.getState().status
  return s.kind === 'signed-in' ? s.me.user.id : null
}

interface RoomsState extends RoomsData {
  loaded: boolean
  /** the list could not be read (an older server without rooms: the sidebar group stays away) */
  failed: unknown
  members: Record<string, RoomMember[]>
  pending: Record<string, PendingSend[]>
  loadRooms: () => Promise<void>
  /** null: not one of my rooms (gone from the list) */
  fetchRoom: (id: string) => Promise<Room | null>
  open: (roomId: string) => void
  close: (roomId: string) => void
  loadNewest: (roomId: string) => Promise<void>
  loadOlder: (roomId: string) => Promise<void>
  loadMembers: (roomId: string, force?: boolean) => Promise<void>
  send: (roomId: string, input: { body: string; mentions: string[]; replyTo: RoomQuote | null; files: RoomFile[] }) => void
  retry: (roomId: string, clientMessageId: string) => void
  discard: (roomId: string, clientMessageId: string) => void
  edit: (roomId: string, messageId: string, body: string, mentions: string[]) => Promise<void>
  remove: (roomId: string, messageId: string) => Promise<void>
  markRead: (roomId: string, seq: number) => Promise<void>
  setMuted: (roomId: string, muted: boolean) => Promise<void>
  /** the DM with this person (the existing one when there is one) */
  openDm: (userId: string) => Promise<Room>
  resync: () => Promise<void>
  handleEvent: (ev: RoomEvent) => void
  reset: () => void
}

const EMPTY: Pick<RoomsState, 'rooms' | 'openRoomId' | 'thread' | 'loaded' | 'failed' | 'members' | 'pending'> = { rooms: [], openRoomId: null, thread: null, loaded: false, failed: null, members: {}, pending: {} }

/** what was typed in a room and not sent yet, while this page is open (components/rooms/RoomComposer.tsx); gone at
 * sign-out with the rest */
export const roomDrafts = new Map<string, string>()

/** read positions already asked for, per room (a scroll fires many times; one request per new position) */
const asked = new Map<string, number>()
/** a newer read of the same room's messages wins over an older one still on its way */
let threadGen = 0

const omit = <T,>(o: Record<string, T>, key: string) => {
  if (!(key in o)) return o
  const next = { ...o }
  delete next[key]
  return next
}

export const useRooms = create<RoomsState>((set, get) => {
  const setPending = (roomId: string, f: (list: PendingSend[]) => PendingSend[]) =>
    set((s) => {
      const list = f(s.pending[roomId] ?? [])
      return { pending: list.length ? { ...s.pending, [roomId]: list } : omit(s.pending, roomId) }
    })

  const post = async (roomId: string, p: PendingSend) => {
    try {
      const m = await api.call(API.sendRoomMessage, { params: { id: roomId }, body: { body: p.body, mentions: p.mentions, replyToId: p.replyTo?.id ?? null, fileIds: p.files.map((f) => f.id), clientMessageId: p.clientMessageId } })
      set((s) => withMessage(s, roomId, m, myId()))
      setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== p.clientMessageId))
    } catch (e) {
      const error = errorText(e, currentLocale(), t('error.network'))
      setPending(roomId, (list) => list.map((x) => (x.clientMessageId === p.clientMessageId ? { ...x, state: 'failed', error } : x)))
    }
  }

  return {
    ...EMPTY,

    async loadRooms() {
      try {
        const r = await api.call(API.listRooms)
        set({ rooms: sortRooms(r.items), loaded: true, failed: null })
      } catch (e) {
        set({ loaded: true, failed: e })
      }
    },

    async fetchRoom(id) {
      try {
        const room = await api.call(API.getRoom, { params: { id } })
        set((s) => withRoom(s, room))
        return room
      } catch (e) {
        if (isApiError(e, 'not_found') || isApiError(e, 'forbidden')) {
          set((s) => withoutRoom(s, id))
          return null
        }
        throw e
      }
    },

    open(roomId) {
      asked.delete(roomId)
      set({ openRoomId: roomId, thread: { roomId, messages: [], nextCursor: null, loading: true, error: null } })
      void get().loadNewest(roomId)
      void get().loadMembers(roomId)
    },

    close(roomId) {
      if (get().openRoomId !== roomId) return
      threadGen++
      set({ openRoomId: null, thread: null })
      // messages that came while it was on screen did not count; left without reading them, the server's count is right
      const r = get().rooms.find((x) => x.id === roomId)
      if (r && r.lastReadSeq < r.lastSeq) void get().fetchRoom(roomId).catch(() => {})
    },

    async loadNewest(roomId) {
      const gen = ++threadGen
      set((s) => (s.thread?.roomId === roomId ? { thread: { ...s.thread, loading: true, error: null } } : {}))
      try {
        const page = await api.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: ROOM_PAGE } })
        if (gen !== threadGen || get().openRoomId !== roomId) return
        set({ thread: { roomId, messages: mergeMessages([], page.items), nextCursor: page.nextCursor, loading: false, error: null } })
      } catch (error) {
        if (gen !== threadGen || get().openRoomId !== roomId) return
        set((s) => ({ thread: { roomId, messages: s.thread?.roomId === roomId ? s.thread.messages : [], nextCursor: s.thread?.roomId === roomId ? s.thread.nextCursor : null, loading: false, error } }))
      }
    },

    async loadOlder(roomId) {
      const th = get().thread
      if (!th || th.roomId !== roomId || !th.nextCursor || th.loading) return
      const gen = threadGen
      set({ thread: { ...th, loading: true } })
      try {
        const page = await api.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: ROOM_PAGE, cursor: th.nextCursor } })
        if (gen !== threadGen) return
        set((s) => (s.thread?.roomId === roomId ? { thread: { ...s.thread, messages: mergeMessages(s.thread.messages, page.items), nextCursor: page.nextCursor, loading: false } } : {}))
      } catch {
        if (gen !== threadGen) return
        set((s) => (s.thread?.roomId === roomId ? { thread: { ...s.thread, loading: false } } : {}))
      }
    },

    async loadMembers(roomId, force) {
      if (get().members[roomId] && !force) return
      try {
        const r = await api.call(API.listRoomMembers, { params: { id: roomId } })
        set((s) => ({ members: { ...s.members, [roomId]: r.items } }))
      } catch {
        /* the header and the @ list do without; the next open asks again */
      }
    },

    send(roomId, input) {
      const p: PendingSend = { clientMessageId: uuidv7(), ...input, state: 'sending', createdAt: new Date().toISOString() }
      setPending(roomId, (list) => [...list, p])
      void post(roomId, p)
    },

    retry(roomId, clientMessageId) {
      const p = get().pending[roomId]?.find((x) => x.clientMessageId === clientMessageId)
      if (!p || p.state === 'sending') return
      setPending(roomId, (list) => list.map((x) => (x.clientMessageId === clientMessageId ? { ...x, state: 'sending', error: undefined } : x)))
      // the same client id: a send the server did get before the failure comes back as that message, not a second one
      void post(roomId, { ...p, state: 'sending' })
    },

    discard(roomId, clientMessageId) {
      setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== clientMessageId))
    },

    async edit(roomId, messageId, body, mentions) {
      const m = await api.call(API.editRoomMessage, { params: { id: roomId, messageId }, body: { body, mentions } })
      set((s) => withUpdatedMessage(s, roomId, m))
    },

    async remove(roomId, messageId) {
      await api.call(API.deleteRoomMessage, { params: { id: roomId, messageId } })
      // the room.message.updated event says the same; show it at once
      const m = get().thread?.roomId === roomId ? get().thread!.messages.find((x) => x.id === messageId) : undefined
      if (m) set((s) => withUpdatedMessage(s, roomId, { ...m, body: '', files: [], mentions: [], unread: 0, deletedAt: new Date().toISOString() }))
    },

    async markRead(roomId, seq) {
      const room = get().rooms.find((r) => r.id === roomId)
      if (room && seq <= room.lastReadSeq) return
      if ((asked.get(roomId) ?? 0) >= seq) return
      asked.set(roomId, seq)
      try {
        const r = await api.call(API.markRoomRead, { params: { id: roomId }, body: { seq } })
        set((s) => withReadState(s, roomId, r))
      } catch {
        if (asked.get(roomId) === seq) asked.delete(roomId)
      }
    },

    async setMuted(roomId, muted) {
      const room = await api.call(API.updateRoom, { params: { id: roomId }, body: { muted } })
      set((s) => withRoom(s, room))
    },

    async openDm(userId) {
      const room = await api.call(API.createRoom, { body: { kind: 'dm', userId } })
      set((s) => withRoom(s, room))
      return room
    },

    async resync() {
      await get().loadRooms()
      const open = get().openRoomId
      if (open) {
        asked.delete(open)
        await Promise.all([get().loadNewest(open), get().loadMembers(open, true)])
      }
    },

    handleEvent(ev) {
      switch (ev.type) {
        case 'room.message': {
          const { roomId, message } = ev.data
          const known = get().rooms.some((r) => r.id === roomId)
          set((s) => withMessage(s, roomId, message, myId()))
          // a room I was just added to whose "added" did not reach this window: its counts come from the server
          if (!known && get().loaded) void get().fetchRoom(roomId).catch(() => {})
          return
        }
        case 'room.message.updated':
          set((s) => withUpdatedMessage(s, ev.data.roomId, ev.data.message))
          return
        case 'room.read':
          set((s) => withRead(s, ev.data.roomId, ev.data.fromSeq, ev.data.toSeq))
          // I read it in another window or on my phone: my badge for the room is counted again
          if (ev.data.mine) void get().fetchRoom(ev.data.roomId).catch(() => {})
          return
        case 'room.updated': {
          const { roomId, change, room } = ev.data
          if (change === 'removed' || !room) {
            const wasOpen = get().openRoomId === roomId
            set((s) => ({ ...withoutRoom(s, roomId), members: omit(s.members, roomId), pending: omit(s.pending, roomId), ...(wasOpen ? { openRoomId: null } : {}) }))
            if (wasOpen) {
              toast({ level: 'info', text: t('rooms.removed') })
              navigateTo('/rooms')
            }
            return
          }
          set((s) => withRoom(s, room))
          if (change === 'members') {
            set((s) => ({ members: omit(s.members, roomId) }))
            // someone joined or left: the member list and every message's unread count change
            if (get().openRoomId === roomId) {
              void get().loadMembers(roomId, true)
              void get().loadNewest(roomId)
            }
          }
          return
        }
      }
    },

    reset() {
      asked.clear()
      roomDrafts.clear()
      threadGen++
      set({ ...EMPTY })
    },
  }
})
