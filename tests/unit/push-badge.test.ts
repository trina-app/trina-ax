// The app icon's number in a phone push (server/src/notifications/badge.ts, chat/badge-chats.ts): the web app's one count
// n (web/src/store/sessionMarkers.ts currentCount) as the server knows it. The room rule is the web app's roomWantsMe,
// case by case; on the real app the server's number equals what the web app counts from the same person's rooms list and
// chat list (no chat on screen, no card of one window), and it moves as they read, hide, turn a room off or see an answer.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Chat, Room, RoomAlertSettings } from '@mycel/shared/api'
import { PUSH_GATEWAY_MAX_BADGE } from '../../shared/src/cloud-protocol/push-gateway'
import { badgeCount, roomsWantingMe, roomWants, setBadgeChats, type RoomWants } from '../../server/src/notifications/badge'
import { BADGE_CHATS_PAGE, chatNeedsMe, chatsNeedingMe } from '../../server/src/chat/badge-chats'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { roomWantsMe } from '../../web/src/lib/rooms'
import { attentionCount } from '../../web/src/lib/sessionMarkers'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)

describe('the room rule is the web app\'s', () => {
  test('roomWants equals roomWantsMe for every combination', () => {
    let cases = 0
    for (const hidden of [false, true]) for (const aiWaits of [false, true]) for (const level of ['all', 'mentions', 'off'] as const)
      for (const unread of [0, 2]) for (const threadsUnread of [0, 1]) for (const mentioned of [false, true]) for (const threadReplies of [false, true]) {
        const r: RoomWants = { hidden, aiWaits, level, unread, threadsUnread, mentioned, threadReplies }
        const web = roomWantsMe({ kind: 'team', unreadCount: unread, threadsUnread, mentioned, muted: level === 'off', ...(aiWaits ? { aiWaits } : {}), ...(hidden ? { hidden } : {}), notify: { own: level, byDefault: 'mentions', level } }, threadReplies)
        expect(roomWants(r)).toBe(web)
        cases++
      }
    expect(cases).toBe(2 * 2 * 3 * 2 * 2 * 2 * 2)
  })

  test('a chat wants me as its marker says: a card, or an unseen answer while nothing runs or waits', () => {
    expect(chatNeedsMe({ waiting: true, runState: 'running', unseen: false })).toBe(true)
    expect(chatNeedsMe({ waiting: false, runState: 'idle', unseen: true })).toBe(true)
    expect(chatNeedsMe({ waiting: false, runState: 'running', unseen: true })).toBe(false)
    expect(chatNeedsMe({ waiting: false, runState: 'queued', unseen: true })).toBe(false)
    expect(chatNeedsMe({ waiting: false, runState: 'idle', unseen: false })).toBe(false)
  })
})

describe('on the real app', () => {
  let h: Harness, owner: Client
  type Person = { client: Client; id: string }
  let ana: Person, bo: Person, cy: Person
  let dm: string, group: string, everyone: string
  const cm = () => 'cm-' + crypto.randomUUID()
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  /** what the web app counts for this person from their own lists (no chat on screen, no card of one window) */
  async function webCount(p: Person): Promise<number> {
    const rooms = await p.client.call('GET', '/api/rooms') as { items: Room[]; alerts: RoomAlertSettings }
    const chats = (await p.client.call('GET', '/api/chats?limit=50') as { items: Chat[] }).items
    return attentionCount(chats, rooms.items, { threadReplies: rooms.alerts.threadReplies }).n
  }
  async function same(p: Person, n: number) {
    expect(badgeCount(h.ctx.db, p.id)).toBe(n)
    expect(await webCount(p)).toBe(n)
  }
  const lastSeq = async (p: Person, roomId: string) => ((await p.client.call('GET', `/api/rooms/${roomId}`)) as Room).lastSeq

  beforeAll(async () => {
    h = await harness('push-badge')
    owner = await withOwner(h)
    ana = await addMember(h, owner, { username: 'ana' })
    bo = await addMember(h, owner, { username: 'bo' })
    cy = await addMember(h, owner, { username: 'cy' })
    dm = (await ana.client.call('POST', '/api/rooms', { kind: 'dm', userId: bo.id })).id
    group = (await ana.client.call('POST', '/api/rooms', { kind: 'group', userIds: [bo.id, cy.id] })).id
    const list = (await ana.client.call('GET', '/api/rooms')) as { items: Room[] }
    everyone = list.items.find((r) => r.kind === 'all')!.id
  })
  afterAll(async () => { await h?.close() })

  test('nothing unread: 0', async () => {
    await same(ana, 0)
  })

  test('a DM and a group chat count once each, however many messages; reading takes them off', async () => {
    await send(bo.client, dm, '안녕하세요')
    await send(bo.client, dm, '확인 부탁드려요')
    await same(ana, 1)
    await send(cy.client, group, '회의 몇 시예요?')
    await same(ana, 2)
    await ana.client.call('POST', `/api/rooms/${dm}/read`, { seq: await lastSeq(ana, dm) })
    await same(ana, 1)
    await ana.client.call('POST', `/api/rooms/${group}/read`, { seq: await lastSeq(ana, group) })
    await same(ana, 0)
    // the sender's own messages never count for them: bo has only cy's group message
    await same(bo, 1)
  })

  test('the everyone room: a plain message does not count (its default is mentions), an @mention does', async () => {
    await send(bo.client, everyone, '공지: 내일 휴무예요')
    await same(ana, 0)
    await send(bo.client, everyone, '@ana 확인해 주세요', { mentions: [ana.id] })
    await same(ana, 1)
    await ana.client.call('POST', `/api/rooms/${everyone}/read`, { seq: await lastSeq(ana, everyone) })
    await same(ana, 0)
  })

  test('a room at 끄기 and a hidden room never count', async () => {
    await ana.client.call('PATCH', `/api/rooms/${group}`, { notifyLevel: 'off' })
    await send(cy.client, group, '끄기여도 오나요?')
    await same(ana, 0)
    await ana.client.call('PATCH', `/api/rooms/${group}`, { notifyLevel: null })
    await same(ana, 1)
    await ana.client.call('POST', `/api/rooms/${group}/read`, { seq: await lastSeq(ana, group) })
    await ana.client.call('PUT', `/api/rooms/${dm}/hidden`, { hidden: true })
    expect(roomsWantingMe(h.ctx.db, ana.id)).toBe(0)
    // whatever comes for me in a hidden DM brings it back first, and then it counts
    await send(bo.client, dm, '숨겨도 와요')
    await same(ana, 1)
    await ana.client.call('POST', `/api/rooms/${dm}/read`, { seq: await lastSeq(ana, dm) })
    await same(ana, 0)
  })

  test('an AI chat with an unseen answer counts until it is seen; a running one does not', async () => {
    const rt = getChatRuntime(h.ctx)
    const chat = (await ana.client.call('POST', '/api/chats', {})) as Chat
    h.ctx.db.query('UPDATE chats SET created_at = ?, updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', chat.id)
    const q = rt.store.insertMessage({ chatId: chat.id, parentId: null, role: 'user', authorId: ana.id, content: '요약해 줘', status: 'done' })
    rt.store.insertMessage({ chatId: chat.id, parentId: q, role: 'assistant', authorId: null, content: '요약이에요', status: 'done' })
    rt.store.touchChat(chat.id)
    expect(chatsNeedingMe(rt, ana.id)).toBe(1)
    await same(ana, 1)
    await send(bo.client, dm, '그리고 이것도요')
    await same(ana, 2)
    await ana.client.call('POST', `/api/chats/${chat.id}/seen`)
    await same(ana, 1)
    await ana.client.call('POST', `/api/rooms/${dm}/read`, { seq: await lastSeq(ana, dm) })
    await same(ana, 0)
    // someone else's chat is never theirs to count
    expect(chatsNeedingMe(rt, bo.id)).toBe(0)
  })

  test('the chat list part reads the web app\'s first page only, and the number is capped', () => {
    expect(BADGE_CHATS_PAGE).toBe(50)
    setBadgeChats(h.ctx.db, () => 123_456)
    expect(badgeCount(h.ctx.db, ana.id)).toBe(PUSH_GATEWAY_MAX_BADGE)
    // a part that fails counts as 0; the push still goes
    setBadgeChats(h.ctx.db, () => { throw new Error('busy') })
    expect(badgeCount(h.ctx.db, ana.id)).toBe(0)
    setBadgeChats(h.ctx.db, (userId) => chatsNeedingMe(getChatRuntime(h.ctx), userId))
  })
})
