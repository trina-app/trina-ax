// A person @mentioned in a thread's root message follows the thread from its first reply on, as in Slack
// (docs/decisions/20261123-thread-follow-root-mention.md): every reply after the root is a row in their Mentions &
// threads and marks the root for them, without a mention in the reply. "@everyone" in the root makes nobody follow; a
// person mentioned in the root who is not in the room now, or cannot see the root, is not added. Room threads have no
// unfollow (no route, no flag), so adding them again on each reply overrides no choice. The push follows "Replies in
// threads I'm part of", on by default as in Slack (docs/decisions/20261123-thread-replies-default-on.md).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { noticeWanted } from '../../server/src/rooms/alerts'
import { roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup() {
  h = await harness('b-rooms-thread-root-mention')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id, otto.id] })
  // many sends: the sending budget's clock moves 2 s a send (the budget is tested in b-rooms)
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 2000)
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const reply = (c: Client, roomId: string, rootId: string, body: string, extra: Record<string, unknown> = {}) => send(c, roomId, body, { threadRootId: rootId, ...extra })
  const followers = (rootId: string) => (h.ctx.db.query('SELECT user_id, last_read_seq FROM room_thread_follows WHERE root_id = ? ORDER BY user_id').all(rootId) as { user_id: string; last_read_seq: number }[])
  /** someone's unread notices of replies in threads, oldest first (quiet ones marked) */
  const threadNotices = (roomId: string, uid: string) => (h.ctx.db.query('SELECT n.id, n.event_type, n.quiet, n.source_id FROM room_notices n JOIN room_messages m ON m.id = n.source_id WHERE n.user_id = ? AND n.room_id = ? AND n.read_at IS NULL AND m.thread_root_id IS NOT NULL ORDER BY n.created_at, n.id').all(uid, roomId) as { id: string; event_type: string; quiet: number; source_id: string }[])
  const roomOf = async (c: Client, id: string) => ((await c.call('GET', '/api/rooms')).items as any[]).find((r) => r.id === id)
  const readRoom = (c: Client, roomId: string) => c.call('POST', `/api/rooms/${roomId}/read`, { seq: 999 })
  return { owner, mia, nora, otto, pia, group, send, reply, followers, threadNotices, roomOf, readRoom }
}

test('a person mentioned in the root follows its thread from the first reply: each reply is a row for them, nobody else is added', async () => {
  const { mia, nora, otto, send, reply, followers, threadNotices, roomOf, readRoom } = await setup()
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  // the owner's report: a list for @nora as the root, then replies with no mention at all
  const root = await send(mia.client, g.id, '@NORA 1. pricing 2. deck 3. invoice', { mentions: [nora.id] })
  await readRoom(nora.client, g.id)
  await readRoom(otto.client, g.id)
  // nora never saved her notification settings: the defaults apply
  expect(h.ctx.db.query('SELECT 1 FROM notification_preferences WHERE user_id = ?').get(nora.id)).toBeNull()
  const r1 = await reply(mia.client, g.id, root.id, 'pricing is done')
  // the root's author (mia, also the replier: read up to her reply) and nora (mentioned in the root, from the root on)
  expect(followers(root.id)).toEqual([{ user_id: mia.id, last_read_seq: r1.seq }, { user_id: nora.id, last_read_seq: root.seq }].sort((a, b) => a.user_id.localeCompare(b.user_id)))
  // nora: a row in Mentions & threads that rings ("Replies in threads I'm part of" is on by default: pushed, as in Slack)
  const first = threadNotices(g.id, nora.id)
  expect(first.map((n) => [n.event_type, n.quiet, n.source_id])).toEqual([['room.dm', 0, r1.id]])
  expect(noticeWanted(h.ctx.db, first[0]!.id)).toBe(true)
  const inbox = await nora.client.call('GET', '/api/notifications?only=rooms')
  expect(inbox.items.map((x: any) => x.room?.message)).toContain(r1.id)
  // the root is marked for her, and the room counts the thread
  expect(await roomOf(nora.client, g.id)).toMatchObject({ threadsUnread: 1, nextThreadId: root.id })
  expect((await nora.client.call('GET', `/api/rooms/${g.id}/messages/${root.id}/thread`)).root.thread.newReplies).toBe(true)
  // otto, not mentioned anywhere, is not added and hears nothing
  expect(threadNotices(g.id, otto.id)).toEqual([])
  expect(await roomOf(otto.client, g.id)).toMatchObject({ threadsUnread: 0 })
  // more replies: each one a notice of its own (the owner's six replies were six notices), the follow not added twice
  await reply(mia.client, g.id, root.id, 'deck is done')
  await reply(mia.client, g.id, root.id, 'invoice is sent')
  expect(followers(root.id).filter((f) => f.user_id === nora.id)).toHaveLength(1)
  expect(threadNotices(g.id, nora.id).map((n) => n.quiet)).toEqual([0, 0, 0])
  // with the switch off, a reply is still her row in Mentions & threads, quiet (never pushed, rung or told)
  await nora.client.call('POST', `/api/rooms/${g.id}/messages/${root.id}/thread/read`, { seq: 999 })
  await nora.client.call('PATCH', '/api/notification-preferences', { roomThreadReplies: false })
  const r4 = await reply(mia.client, g.id, root.id, 'one more thing')
  expect(threadNotices(g.id, nora.id).map((n) => [n.event_type, n.quiet, n.source_id])).toEqual([['room.dm', 1, r4.id]])
  // reading the thread clears it; replying keeps her place at her reply
  await nora.client.call('POST', `/api/rooms/${g.id}/messages/${root.id}/thread/read`, { seq: 999 })
  const own = await reply(nora.client, g.id, root.id, 'thanks')
  expect(followers(root.id).find((f) => f.user_id === nora.id)!.last_read_seq).toBe(own.seq)
  expect(threadNotices(g.id, mia.id).map((n) => n.source_id)).toEqual([own.id])
})

test('a reply by someone else: the root author and the people mentioned in the root both follow from the root on', async () => {
  const { mia, nora, otto, group, send, reply, followers, threadNotices } = await setup()
  const team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'team' && r.groupId === group.id)
  const root = await send(mia.client, team.id, '@NORA can you check this', { mentions: [nora.id] })
  const r1 = await reply(otto.client, team.id, root.id, 'otto chimes in')
  expect(new Map(followers(root.id).map((f) => [f.user_id, f.last_read_seq]))).toEqual(new Map([[mia.id, root.seq], [nora.id, root.seq], [otto.id, r1.seq]]))
  expect(threadNotices(team.id, mia.id).map((n) => n.source_id)).toEqual([r1.id])
  expect(threadNotices(team.id, nora.id).map((n) => n.source_id)).toEqual([r1.id])
})

test('"@everyone" in the root makes nobody follow its thread (as in Slack)', async () => {
  const { mia, nora, otto, group, send, reply, followers, threadNotices, readRoom } = await setup()
  const team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'team' && r.groupId === group.id)
  const root = await send(mia.client, team.id, '@everyone standup at 3', { mentionsAll: true })
  expect(root).toMatchObject({ mentionsAll: true, mentions: [] })
  await readRoom(nora.client, team.id)
  await readRoom(otto.client, team.id)
  await reply(mia.client, team.id, root.id, 'moved to 4')
  expect(followers(root.id).map((f) => f.user_id)).toEqual([mia.id])
  expect(threadNotices(team.id, nora.id)).toEqual([])
  expect(threadNotices(team.id, otto.id)).toEqual([])
})

test('a person mentioned in the root who left the room, or who cannot see the root, does not follow its thread', async () => {
  const { mia, nora, otto, pia, send, reply, followers, threadNotices } = await setup()
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  // otto is mentioned, then leaves before the first reply
  const root = await send(mia.client, g.id, '@OTTO @NORA please look', { mentions: [otto.id, nora.id] })
  expect((await otto.client.try('POST', `/api/rooms/${g.id}/leave`)).status).toBe(204)
  // pia joins after the root (she cannot see it); an edit mentions her in it
  await mia.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [pia.id] })
  const edited = await mia.client.call('PATCH', `/api/rooms/${g.id}/messages/${root.id}`, { body: '@OTTO @NORA @PIA please look', mentions: [nora.id, pia.id] })
  expect(edited.mentions).toEqual([nora.id, pia.id])
  const r1 = await reply(mia.client, g.id, root.id, 'first reply')
  expect(followers(root.id).map((f) => f.user_id).sort()).toEqual([mia.id, nora.id].sort())
  expect(threadNotices(g.id, nora.id).map((n) => n.source_id)).toEqual([r1.id])
  expect(threadNotices(g.id, pia.id)).toEqual([])
  expect(h.ctx.db.query('SELECT 1 FROM room_notices WHERE user_id = ? AND room_id = ?').get(otto.id, g.id)).toBeNull()
})
