// One team chat room for the e2e specs (the mock server lists no rooms: test/mock/server.ts listRooms): its REST answers
// through page.route, contract-shaped, and the messages sent to it kept for the spec to read. The signed-in owner (olga)
// is a member; the others are people of this room only (not in the directory).
import type { Page } from '@playwright/test'

export const ROOM_ID = '019a5f00-0000-7000-8000-00000000a001'
const T0 = Date.parse('2026-11-05T09:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
let seq = 100

export interface MockRoom {
  /** the bodies of POST /api/rooms/:id/messages, in order */
  sent: { body: string; mentions: string[]; mentionsAll?: boolean; threadRootId?: string | null; alsoInRoom?: boolean }[]
  /** the reactions put on or taken off (PUT …/reactions), in order */
  reacted: { messageId: string; emoji: string; on: boolean }[]
}

/** A message of the room; `threadRootId`: a reply in that message's thread (in the thread, not the timeline); `extra`:
 * more contract fields as they are (reactions, a thread's summary, …). */
export interface MockMessage { id: string; author: { id: string; name: string }; body: string; mentions?: string[]; threadRootId?: string; extra?: Record<string, unknown> }

/** The AI in the room as GET /api/rooms/:id/ai and GET /api/rooms/:id/ai/requests answer it, read at each request (a
 * spec changes it as the server would: a question of mine running, its card open, answered). */
export interface MockRoomAi { answering: number; mine: unknown[]; requests: unknown[] }

/** `kind`: the room's kind ('group' by default; 'all' for the everyone room, 'dm' for a 1:1 chat); `ai`: the AI's state
 * (none by default) */
export async function routeRoom(page: Page, o: { members: { id: string; name: string }[]; messages?: MockMessage[]; kind?: 'group' | 'team' | 'all' | 'dm'; ai?: MockRoomAi }): Promise<MockRoom> {
  const state: MockRoom = { sent: [], reacted: [] }
  // the reactions each message has now (mine only: olga is the only one reacting here)
  const mine = new Map<string, string[]>()
  const members = [{ id: 'olga', name: 'Olga' }, ...o.members]
  const message = (m: { id: string; author: { id: string; name: string } | null; body: string; mentions?: string[]; mentionsAll?: boolean; threadRootId?: string; extra?: Record<string, unknown> }, n: number) => ({
    id: m.id, roomId: ROOM_ID, seq: n, authorKind: 'user', author: m.author, askedBy: null, visibility: 'room', body: m.body, replyTo: null,
    mentions: m.mentions ?? [], ...(m.mentionsAll ? { mentionsAll: true } : {}), files: [], createdAt: at(n), editedAt: null, deletedAt: null,
    ...(m.threadRootId ? { threadRootId: m.threadRootId } : {}), ...(m.extra ?? {}),
  })
  const all = (o.messages ?? []).map((m, i) => message(m, i + 1))
  const messages = all.filter((m) => !('threadRootId' in m))
  const replies = (root: string) => all.filter((m) => (m as { threadRootId?: string }).threadRootId === root)
  const last = Math.max(0, ...messages.map((m) => m.seq))
  const room = {
    id: ROOM_ID, kind: o.kind ?? 'group', name: o.kind === 'all' || o.kind === 'dm' ? null : '디자인 리뷰', canRename: true, managerId: 'olga', groupId: null, memberCount: members.length,
    peers: o.members.slice(0, 4), lastSeq: last, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false,
    lastReadSeq: last, lastMessage: null, muted: false, createdAt: at(-60), activityAt: at(messages.length),
  }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/rooms(\/|\?|$)/, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const method = req.method()
    if (method === 'GET' && path === '/api/rooms') return route.fulfill(json({ items: [room] }))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}`) return route.fulfill(json(room))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}/messages`) return route.fulfill(json({ items: messages, nextCursor: null }))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}/members`) return route.fulfill(json({ items: members.map((user) => ({ user, joinedAt: at(-60) })) }))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}/ai`) return route.fulfill(json({ answering: o.ai?.answering ?? 0, mine: o.ai?.mine ?? [] }))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}/ai/requests`) return route.fulfill(json({ items: o.ai?.requests ?? [] }))
    if (method === 'POST' && path === `/api/rooms/${ROOM_ID}/read`) return route.fulfill(json({ lastReadSeq: room.lastSeq, unreadCount: 0, mentioned: false }))
    const react = /^\/api\/rooms\/[^/]+\/messages\/([^/]+)\/reactions$/.exec(path)
    if (react && method === 'PUT') {
      const b = req.postDataJSON() as { emoji: string; on: boolean }
      state.reacted.push({ messageId: react[1]!, ...b })
      const list = (mine.get(react[1]!) ?? []).filter((e) => e !== b.emoji)
      if (b.on) list.push(b.emoji)
      mine.set(react[1]!, list)
      return route.fulfill(json({ reactions: list.map((emoji) => ({ emoji, count: 1, mine: true, users: [{ id: 'olga', name: 'Olga' }] })) }))
    }
    const thread = /^\/api\/rooms\/[^/]+\/messages\/([^/]+)\/thread(\/read)?$/.exec(path)
    const root = thread && messages.find((m) => m.id === thread[1])
    if (thread && root && method === 'GET' && !thread[2]) return route.fulfill(json({ root, items: replies(root.id), nextCursor: null }))
    if (thread && root && method === 'POST' && thread[2]) return route.fulfill(json({ lastReadSeq: room.lastSeq, room }))
    if (method === 'POST' && path === `/api/rooms/${ROOM_ID}/messages`) {
      const b = req.postDataJSON() as MockRoom['sent'][number]
      state.sent.push(b)
      const n = ++seq
      const id = `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
      // a reply comes back as one, and is in its thread when the thread is read again
      const sent = message({ id, author: { id: 'olga', name: 'Olga' }, body: b.body, mentions: b.mentions, mentionsAll: b.mentionsAll, ...(b.threadRootId ? { threadRootId: b.threadRootId, extra: b.alsoInRoom ? { alsoInRoom: true } : {} } : {}) }, n)
      if (b.threadRootId) all.push(sent)
      return route.fulfill(json(sent, 201))
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return state
}

/** One of several rooms for routeRooms: its kind and name, the other people in it, what is unread, how long ago its
 * last message came, and whether I hid it (docs/DECISIONS.md "대화 숨기기"). */
export interface MockRoomSpec {
  id: string
  kind: 'team' | 'all' | 'dm' | 'group'
  name: string | null
  peers: { id: string; name: string }[]
  unread?: number
  mentioned?: boolean
  muted?: boolean
  hidden?: boolean
  /** when I pinned it (docs/DECISIONS.md "Pinned conversations"); absent: not pinned */
  pinnedAt?: string
  /** minutes before the fixed "now" of its last message (smaller: higher in the list) */
  ago: number
  last: string
}

export interface MockRooms {
  /** PUT /api/rooms/:id/hidden, in order */
  hidden: { roomId: string; hidden: boolean }[]
  /** POST /api/rooms/:id/leave, in order */
  left: string[]
  /** PATCH /api/rooms/:id bodies, in order */
  updated: { roomId: string; body: Record<string, unknown> }[]
  /** POST (true) and DELETE (false) /api/rooms/:id/pin, in order */
  pinned: { roomId: string; pinned: boolean }[]
}

/** Several rooms of every kind for the specs of the rooms' "⋯" and hidden rooms: GET /api/rooms and each room's own
 * reads (one message from the first other person, the members, no AI), and the changes a person makes to a room of
 * theirs (hide or show it, leave a group chat, its notification level, its name), answered as the server would,
 * contract-shaped.
 * The signed-in owner (olga) is in all of them. */
export async function routeRooms(page: Page, specs: MockRoomSpec[]): Promise<MockRooms> {
  const state: MockRooms = { hidden: [], left: [], updated: [], pinned: [] }
  const NOW = Date.parse('2026-11-07T09:00:00.000Z')
  const when = (ago: number) => new Date(NOW - ago * 60_000).toISOString()
  const live = new Map(specs.map((s) => [s.id, { ...s, own: null as null | 'all' | 'mentions' | 'off' }]))
  const msgId = (i: number) => `019a5f00-0000-7000-8000-${String(900 + i).padStart(12, '0')}`
  const roomOf = (s: MockRoomSpec & { own: null | 'all' | 'mentions' | 'off' }, i: number) => {
    const byDefault = s.kind === 'team' || s.kind === 'all' ? 'mentions' : 'all'
    const level = s.own ?? byDefault
    return {
      id: s.id, kind: s.kind, name: s.name, canRename: s.kind === 'group', managerId: s.kind === 'group' ? 'olga' : null,
      groupId: s.kind === 'team' ? `019a5f00-0000-7000-8000-${String(800 + i).padStart(12, '0')}` : null,
      memberCount: s.peers.length + 1, peers: s.peers.slice(0, 4), lastSeq: 3, unreadCount: s.unread ?? 0, threadsUnread: 0, nextThreadId: null,
      mentioned: !!s.mentioned, lastReadSeq: 3 - Math.min(3, s.unread ?? 0),
      lastMessage: { id: msgId(i), seq: 3, author: s.peers[0] ?? null, excerpt: s.last, fileCount: 0, deleted: false, createdAt: when(s.ago) },
      muted: level === 'off', notify: { own: s.own, byDefault, level }, createdAt: when(600), activityAt: when(s.ago),
      ...(s.hidden ? { hidden: true } : {}),
      ...(s.pinnedAt ? { pinnedAt: s.pinnedAt } : {}),
    }
  }
  const all = () => [...live.values()].map((s) => roomOf(s, specs.findIndex((x) => x.id === s.id))).sort((a, b) => b.activityAt.localeCompare(a.activityAt))
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/rooms(\/|\?|$)/, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const method = req.method()
    if (method === 'GET' && path === '/api/rooms') return route.fulfill(json({ items: all(), alerts: { threadReplies: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false }, timeZone: 'Asia/Seoul' } }))
    const m = /^\/api\/rooms\/([^/]+)(?:\/(messages|members|ai|read|hidden|leave|pin))?$/.exec(path)
    const s = m && live.get(m[1]!)
    if (!m || !s) return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
    const i = specs.findIndex((x) => x.id === s.id)
    const what = m[2]
    if (method === 'GET' && !what) return route.fulfill(json(roomOf(s, i)))
    if (method === 'GET' && what === 'messages') {
      const author = s.peers[0] ?? { id: 'olga', name: 'Olga' }
      return route.fulfill(json({ items: [{ id: msgId(i), roomId: s.id, seq: 3, authorKind: 'user', author, askedBy: null, visibility: 'room', body: s.last, replyTo: null, mentions: [], files: [], createdAt: when(s.ago), editedAt: null, deletedAt: null }], nextCursor: null }))
    }
    if (method === 'GET' && what === 'members') return route.fulfill(json({ items: [{ id: 'olga', name: 'Olga' }, ...s.peers].map((user) => ({ user, joinedAt: when(600) })) }))
    if (method === 'GET' && what === 'ai') return route.fulfill(json({ answering: 0, mine: [] }))
    if (method === 'POST' && what === 'read') return route.fulfill(json({ lastReadSeq: 3, unreadCount: 0, mentioned: false }))
    if (method === 'PUT' && what === 'hidden') {
      const b = req.postDataJSON() as { hidden: boolean }
      state.hidden.push({ roomId: s.id, hidden: b.hidden })
      if (b.hidden && s.kind === 'group') return route.fulfill(json({ error: { code: 'forbidden', message: 'leave it instead' } }, 403))
      s.hidden = b.hidden
      // hiding unpins it, as the server does
      if (b.hidden) delete s.pinnedAt
      return route.fulfill(json(roomOf(s, i)))
    }
    // "상단에 고정" / "고정 해제" (server/src/rooms/service.ts pin): a hidden room is refused, as the server does
    if (what === 'pin' && (method === 'POST' || method === 'DELETE')) {
      state.pinned.push({ roomId: s.id, pinned: method === 'POST' })
      if (method === 'POST' && s.hidden) return route.fulfill(json({ error: { code: 'conflict', message: 'hidden' } }, 409))
      if (method === 'POST' && !s.pinnedAt) s.pinnedAt = new Date(Math.max(Date.now(), ...[...live.values()].map((x) => (x.pinnedAt ? Date.parse(x.pinnedAt) + 1 : 0)))).toISOString()
      if (method === 'DELETE') delete s.pinnedAt
      return route.fulfill(json(roomOf(s, i)))
    }
    if (method === 'POST' && what === 'leave') {
      state.left.push(s.id)
      live.delete(s.id)
      return route.fulfill({ status: 204, body: '' })
    }
    if (method === 'PATCH' && !what) {
      const b = req.postDataJSON() as Record<string, unknown>
      state.updated.push({ roomId: s.id, body: b })
      if ('notifyLevel' in b) s.own = (b.notifyLevel as typeof s.own) ?? null
      if ('name' in b) s.name = (b.name as string | null) ?? null
      return route.fulfill(json(roomOf(s, i)))
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return state
}
