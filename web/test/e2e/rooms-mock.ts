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
  sent: { body: string; mentions: string[]; mentionsAll?: boolean; threadRootId?: string | null }[]
  /** the reactions put on or taken off (PUT …/reactions), in order */
  reacted: { messageId: string; emoji: string; on: boolean }[]
}

/** A message of the room; `threadRootId`: a reply in that message's thread (in the thread, not the timeline); `extra`:
 * more contract fields as they are (reactions, a thread's summary, …). */
export interface MockMessage { id: string; author: { id: string; name: string }; body: string; mentions?: string[]; threadRootId?: string; extra?: Record<string, unknown> }

/** `kind`: the room's kind ('group' by default; 'all' for the everyone room, 'dm' for a 1:1 chat) */
export async function routeRoom(page: Page, o: { members: { id: string; name: string }[]; messages?: MockMessage[]; kind?: 'group' | 'team' | 'all' | 'dm' }): Promise<MockRoom> {
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
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}/ai`) return route.fulfill(json({ answering: 0, mine: [] }))
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
      return route.fulfill(json(message({ id, author: { id: 'olga', name: 'Olga' }, body: b.body, mentions: b.mentions, mentionsAll: b.mentionsAll }, n), 201))
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return state
}
