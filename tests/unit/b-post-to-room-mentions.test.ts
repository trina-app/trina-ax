// post_to_room makes real mentions (server/src/chat/post-to-room.ts, chat/post-mentions.ts; docs/decisions/
// 20261118-ai-post-real-mentions.md): the people come from the room's members on the server's records, go as "@Name" in
// the person's own line before the AI's quote (own_words: in the text), are stored as the message's mentions and notify
// like a mention the person typed; the card and the result name them. A non-member, a look-alike or a name two people
// share is never mentioned; "@everyone" only when the asker's own message wrote it (and in the everyone room only for an
// owner or admin). The fixture team (b-harness): alice and erin in marketing, bob in finance, carol admin, dana owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { dropAlways, keepAlways } from '../../server/src/chat/always-allow'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives, their strings as JSON escapes: the person's own words are only what the test writes
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const post = (args: Record<string, unknown>) => fake({ tool: 'post_to_room', args, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
let rooms: { all: string; marketing: string }
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-post-to-room-mentions', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  const alice = (await h.api('alice').call(API.listRooms)).items as Room[]
  rooms = { all: alice.find((r) => r.kind === 'all')!.id, marketing: alice.find((r) => r.kind === 'team' && r.name === 'Marketing')!.id }
  for (const u of ['alice', 'bob', 'carol']) {
    socks[u] = await h.ws(u, { windowId: `win-ptrm-${u}` })
    await socks[u]!.next('hello')
  }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

type Card = { question: string; details?: { label: string; text: string }[] }
async function turn(user: string, content: string, answer?: string) {
  const chatId = (await h.api(user).call(API.createChat, { body: {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card = null as Card | null
  if (answer !== undefined) {
    const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer } })
  }
  const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { content: done.data.message.content as string, card }
}
const last = async (viewer: string, roomId: string) => ((await h.api(viewer).call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items as RoomMessage[]).at(-1)!
const authored = (roomId: string, user: string) => (h.ctx.db.query('SELECT COUNT(*) n FROM room_messages WHERE room_id = ? AND author_id = ?').get(roomId, user) as { n: number }).n
/** a mention notice for `user` that covers the message (its own, or the open one of the run it joined) */
const mentionNotice = (user: string, m: RoomMessage) => !!h.ctx.db.query("SELECT 1 FROM room_notices WHERE user_id = ? AND event_type = 'room.mention' AND room_id = ? AND (source_id = ? OR last_seq >= ?)").get(user, m.roomId, m.id, m.seq)
const readAll = async (user: string, roomId: string) => { const m = await last(user, roomId); if (m) await h.api(user).call(API.markRoomRead, { params: { id: roomId }, body: { seq: m.seq } }) }

describe('the AI\'s post mentions people of the room for real', () => {
  test('mention: a member is named on the card, goes as "@Name" in the person\'s line, is stored and notified; the result lists them', async () => {
    await readAll('erin', rooms.all)
    const r = await turn('bob', post({ room: rooms.all, text: '메일 전달드려요: 견적 회신 부탁', mention: ['Erin Yoo'] }), 'send')
    expect(r.card!.details).toContainEqual({ label: '알림 받을 사람 (멘션)', text: 'Erin Yoo', noSize: true } as never)
    const m = await last('erin', rooms.all)
    expect(m.author?.id).toBe('bob')
    expect(m.body).toBe('@Erin Yoo\n\n메일 전달드려요: 견적 회신 부탁')
    expect(m.sharedAnswer).toMatchObject({ at: '@Erin Yoo\n\n'.length })
    expect(m.mentions).toEqual(['erin'])
    expect(mentionNotice('erin', m)).toBe(true)
    // nobody else is mentioned (alice gets no mention notice from it)
    expect(mentionNotice('alice', m)).toBe(false)
    const out = JSON.parse(r.content)
    expect(out).toMatchObject({ status: 'sent', mentioned: ['Erin Yoo'] })
    expect(out.note).toContain('It mentions Erin Yoo: they get a mention notice.')
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'room.answer_share' AND target = ?").get(m.id) as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ via: 'ai', mentions: 1 })
  })

  test('"@Full Name" the text starts with: a real mention, moved to the person\'s line (the bug: plain text before)', async () => {
    const r = await turn('bob', post({ room: rooms.all, text: '@Erin Yoo Forwarding a mail from the supplier.' }), 'send')
    const m = await last('erin', rooms.all)
    expect(m.body).toBe('@Erin Yoo\n\nForwarding a mail from the supplier.')
    expect(m.mentions).toEqual(['erin'])
    expect(JSON.parse(r.content).mentioned).toEqual(['Erin Yoo'])
  })

  test('own_words: the "@name" stays in the text, written as the exact name; a name given in mention goes before it', async () => {
    await turn('bob', post({ room: rooms.all, text: '@erin yoo 회의는 10시예요', own_words: true }), 'send')
    const m = await last('erin', rooms.all)
    expect(m.body).toBe('@Erin Yoo 회의는 10시예요')
    expect(m.sharedAnswer).toBeUndefined()
    expect(m.mentions).toEqual(['erin'])
    await turn('bob', post({ room: rooms.all, text: '회의는 11시예요', own_words: true, mention: ['Alice Kim'] }), 'send')
    const n = await last('alice', rooms.all)
    expect(n.body).toBe('@Alice Kim 회의는 11시예요')
    expect(n.mentions).toEqual(['alice'])
  })

  test('a non-member in mention (or by person:<id>), or the asker: nothing posted, no card', async () => {
    const before = authored(rooms.marketing, 'alice')
    for (const mention of [['Bob Lee'], ['person:bob'], ['Alice Kim']]) {
      const r = await turn('alice', post({ room: rooms.marketing, text: 'Please check the quote', mention }))
      expect(r.card).toBeNull()
      expect(r.content).toContain('only people there can be mentioned')
    }
    expect(authored(rooms.marketing, 'alice')).toBe(before)
  })

  test('"@Name" of a non-member, a look-alike: plain text, nobody mentioned, the result says so', async () => {
    const r = await turn('alice', post({ room: rooms.marketing, text: '@Bob Lee and @Erin Yo0 see the quote' }), 'send')
    const m = await last('alice', rooms.marketing)
    expect(m.body).toBe('@Bob Lee and @Erin Yo0 see the quote')
    expect(m.mentions).toEqual([])
    const out = JSON.parse(r.content)
    expect(out.mentioned).toBeUndefined()
    expect(out.note).toContain('stayed plain text (not exactly one person in that room')
    expect(out.note).toContain('Never say you tagged someone')
  })

  test('"@everyone": refused unless the asker\'s own message wrote it; then a real "@everyone"; in the everyone room only for an admin', async () => {
    const no = await turn('alice', post({ room: rooms.marketing, text: 'Launch moved', mention: ['everyone'] }))
    expect(no.card).toBeNull()
    expect(no.content).toContain('only when the user\'s own message writes')
    // "@everyone" in the AI's text alone: plain, nobody notified
    await turn('alice', post({ room: rooms.marketing, text: '@everyone Launch moved' }), 'send')
    const plain = await last('alice', rooms.marketing)
    expect(plain.mentionsAll).toBeUndefined()
    // the asker wrote it: mentions everyone there
    const yes = await turn('alice', `tell @everyone the launch moved\n${post({ room: rooms.marketing, text: 'The launch moved to Friday', mention: ['everyone'] })}`, 'send')
    expect(yes.card!.details).toContainEqual({ label: 'Mentions (they get a notice)', text: 'Everyone in this room (@everyone)', noSize: true } as never)
    const all = await last('erin', rooms.marketing)
    expect(all.body).toBe('@everyone\n\nThe launch moved to Friday')
    expect(all.mentionsAll).toBe(true)
    expect(JSON.parse(yes.content).mentioned_everyone).toBe(true)
    // the everyone room: a member cannot, an admin can
    const member = await turn('bob', `@전체 공지해줘\n${post({ room: rooms.all, text: '공지', mention: ['전체'] })}`)
    expect(member.content).toContain('only an owner or admin can mention everyone')
    await turn('carol', `@전체 공지해줘\n${post({ room: rooms.all, text: '공지입니다', mention: ['전체'] })}`, 'send')
    const admin = await last('bob', rooms.all)
    expect(admin.body).toBe('@전체\n\n공지입니다')
    expect(admin.mentionsAll).toBe(true)
  })

  test('"Always allow" on (Rule A): a post that mentions a room member goes with no card, also one the AI resolved; "@everyone" too (docs/decisions/20261122-always-allow-holds-everywhere.md B5)', async () => {
    keepAlways(h.ctx.db, 'alice', 'post_to_room', null)
    try {
      const tagged = await turn('alice', post({ room: rooms.marketing, text: 'please look', mention: ['Erin'] }))
      expect(tagged.card).toBeNull()
      expect(JSON.parse(tagged.content)).toMatchObject({ status: 'sent', mentioned: ['Erin Yoo'] })
      expect((await last('erin', rooms.marketing)).mentions).toEqual(['erin'])
      // everyone: the asker wrote it, and her Always allow covers it, no card
      const all = await turn('alice', `@everyone heads up\n${post({ room: rooms.marketing, text: 'Launch moved', mention: ['everyone'] })}`)
      expect(all.card).toBeNull()
      expect((await last('erin', rooms.marketing)).mentionsAll).toBe(true)
    } finally { expect(dropAlways(h.ctx.db, 'alice', 'card:post_to_room')).toBe(true) }
  })

  test('the asker\'s own words name the person (in full, or by the name the AI found exactly one member by): no card after the explicit ask; a name inside another member\'s name they wrote: the card', async () => {
    const named = await turn('alice', `post this to the Marketing room and tag Erin\n${post({ room: 'Marketing', text: 'budget is approved', mention: ['Erin'] })}`)
    expect(named.card).toBeNull()
    expect(JSON.parse(named.content)).toMatchObject({ status: 'sent', mentioned: ['Erin Yoo'] })
    const other = await turn('alice', `post this to the Marketing room\n${post({ room: 'Marketing', text: 'budget is approved', mention: ['Erin'] })}`, 'no')
    expect(other.card).not.toBeNull()
  })

  test('the button\'s share of a finished answer still mentions nobody', async () => {
    const chatId = (await h.api('bob').call(API.createChat, { body: {} })).id
    const r = await h.api('bob').call(API.sendMessage, { params: { id: chatId }, body: { content: fake({ say: '@Erin Yoo here is the summary' }), clientMessageId: cm(), attachmentIds: [] } })
    await socks.bob!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    const s = await h.api('bob').call(API.shareAnswerToRoom, { params: { id: chatId, messageId: r.assistantMessage.id }, body: { roomId: rooms.all, clientMessageId: cm() } })
    expect(s.status).toBe('sent')
    if (s.status === 'sent') expect(s.message.mentions).toEqual([])
  })
})
