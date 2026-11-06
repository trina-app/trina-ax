// Threads, reactions and no read receipts in rooms (docs/DECISIONS.md "스레드와 반응"). A reply lives in its thread, not
// in the timeline (unless sent to the room too); the root carries the thread's summary; followers (the root's author,
// repliers, people mentioned) are notified and see a marker, nobody else. A thread follows its root: a member who
// cannot see the root (joined later) sees nothing of the thread. Reactions: 8 fixed emoji, members only, never a
// notice. Every route is members only (404 for anyone else, admins included).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ROOM_REACTIONS, ROOM_REACTION_NAMES } from '@mycel/shared/api'
import { notificationsOf } from '../../server/src/notifications/service'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { roomsOf, SEND_BURST } from '../../server/src/rooms/service'
import { newId } from '../../server/src/db'
import { addMember, harness, RecordingHub, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

/** Records what each listed person would receive (publishEach builds per person, like the real hub). */
class FanoutHub extends RecordingHub {
  users: string[] = []
  override publishEach(build: (userId: string) => unknown) {
    for (const u of this.users) { const ev = build(u); if (ev) this.events.push({ kind: 'publish', target: u, data: ev }) }
  }
  to(type: string) { return this.events.filter((e) => (e.data as { type?: string }).type === type) }
  clear() { this.events = []; this.forgotten = [] }
}

const cm = () => 'cm-' + crypto.randomUUID()

async function setup() {
  h = await harness('b-rooms-threads')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id, otto.id] })
  const hub = new FanoutHub()
  hub.users = ['olga', ada.id, mia.id, nora.id, otto.id, pia.id]
  h.ctx.services.realtime = hub
  const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as any[]
  const roomOf = async (c: Client, id: string) => (await rooms(c)).find((r) => r.id === id)
  const teamRoom = async (c: Client) => (await rooms(c)).find((r) => r.kind === 'team' && r.groupId === group.id)
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const reply = (c: Client, roomId: string, rootId: string, body: string, extra: Record<string, unknown> = {}) => send(c, roomId, body, { threadRootId: rootId, ...extra })
  const timeline = async (c: Client, roomId: string) => (await c.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]
  const thread = (c: Client, roomId: string, rootId: string) => c.call('GET', `/api/rooms/${roomId}/messages/${rootId}/thread`)
  const notices = (uid: string) => (h.ctx.db.query('SELECT id, event_type, source_id, read_at FROM room_notices WHERE user_id = ? AND suppressed = 0 ORDER BY created_at, id').all(uid) as { id: string; event_type: string; source_id: string; read_at: string | null }[])
  const unreadNotices = (uid: string) => notices(uid).filter((n) => !n.read_at)
  return { owner, ada, mia, nora, otto, pia, group, hub, rooms, roomOf, teamRoom, send, reply, timeline, thread, notices, unreadNotices }
}

test('a reply lives in its thread: the timeline, the list line, the badge and the room\'s place stay as they were', async () => {
  const { mia, nora, otto, teamRoom, send, reply, timeline, thread } = await setup()
  const team = await teamRoom(mia.client)
  const root = await send(mia.client, team.id, 'ROOT plan for Q4')
  await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: root.seq })
  await otto.client.call('POST', `/api/rooms/${team.id}/read`, { seq: root.seq })
  const before = await teamRoom(otto.client)
  const r1 = await reply(nora.client, team.id, root.id, 'REPLY one')
  expect(r1).toMatchObject({ threadRootId: root.id, body: 'REPLY one' })
  expect(r1.alsoInRoom).toBeUndefined()
  // not in the timeline; the root shows the thread under it
  const tl = await timeline(otto.client, team.id)
  expect(tl.map((m) => m.body)).toEqual(['ROOT plan for Q4'])
  expect(tl[0].thread).toEqual({ replyCount: 1, lastReplyAt: r1.createdAt, repliers: [{ id: nora.id, name: 'NORA' }], newReplies: false })
  // otto follows nothing: no badge, no list line, no move of the room
  const after = await teamRoom(otto.client)
  expect(after).toMatchObject({ unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastMessage: { id: root.id }, activityAt: before.activityAt })
  // the thread: its root and the replies
  const page = await thread(otto.client, team.id, root.id)
  expect(page.root).toMatchObject({ id: root.id, thread: { replyCount: 1 } })
  expect(page.items.map((m: any) => m.body)).toEqual(['REPLY one'])
  expect(page.nextCursor).toBeNull()
  // also sent to the room: in the timeline too, marked, counting like a message there
  const r2 = await reply(nora.client, team.id, root.id, 'REPLY two, for everyone', { alsoInRoom: true })
  expect(r2).toMatchObject({ threadRootId: root.id, alsoInRoom: true })
  expect((await timeline(otto.client, team.id)).map((m) => m.body)).toEqual(['ROOT plan for Q4', 'REPLY two, for everyone'])
  expect(await teamRoom(otto.client)).toMatchObject({ unreadCount: 1, lastMessage: { id: r2.id } })
  expect((await thread(otto.client, team.id, root.id)).items.map((m: any) => m.body)).toEqual(['REPLY one', 'REPLY two, for everyone'])
  // three people replied: the latest first, at most three
  await reply(otto.client, team.id, root.id, 'REPLY three')
  await reply(mia.client, team.id, root.id, 'REPLY four')
  const summary = (await timeline(nora.client, team.id))[0].thread
  expect(summary.replyCount).toBe(4)
  expect(summary.repliers.map((u: any) => u.id)).toEqual([mia.id, otto.id, nora.id])
  // paging: the newest first, oldest first within a page
  const p1 = await nora.client.call('GET', `/api/rooms/${team.id}/messages/${root.id}/thread?limit=2`)
  expect(p1.items.map((m: any) => m.body)).toEqual(['REPLY three', 'REPLY four'])
  const p2 = await nora.client.call('GET', `/api/rooms/${team.id}/messages/${root.id}/thread?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)
  expect(p2.items.map((m: any) => m.body)).toEqual(['REPLY one', 'REPLY two, for everyone'])
})

test('what can hold a thread: a message of the timeline for the whole room; anything else is refused alike', async () => {
  const { mia, nora, otto, teamRoom, send, reply, thread } = await setup()
  const team = await teamRoom(mia.client)
  const root = await send(mia.client, team.id, 'root')
  const r = await reply(nora.client, team.id, root.id, 'a reply')
  const gone = await send(mia.client, team.id, 'deleted soon')
  await mia.client.call('DELETE', `/api/rooms/${team.id}/messages/${gone.id}`)
  const other = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const elsewhere = await send(mia.client, other.id, 'in the DM')
  // a private preview of mia's (the AI writes it; put in directly here) and an event line (a group chat's first line)
  const privateId = newId()
  h.ctx.db.transaction(() => {
    const seq = (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(team.id) as { last_seq: number }).last_seq
    h.ctx.db.query("INSERT INTO room_messages (id, room_id, seq, author_kind, asked_by, visibility, visible_to, body, mentions, created_at) VALUES (?, ?, ?, 'ai', ?, 'private', ?, 'PREVIEW', '[]', ?)").run(privateId, team.id, seq, mia.id, mia.id, new Date().toISOString())
  })()
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  const line = (await mia.client.call('GET', `/api/rooms/${g.id}/messages`)).items[0]
  const tries = [
    await mia.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'x', clientMessageId: cm(), threadRootId: r.id }), // a reply: no thread in a thread
    await mia.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'x', clientMessageId: cm(), threadRootId: gone.id }), // deleted
    await mia.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'x', clientMessageId: cm(), threadRootId: elsewhere.id }), // another room's
    await mia.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'x', clientMessageId: cm(), threadRootId: privateId }), // private
    await mia.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'x', clientMessageId: cm(), threadRootId: newId() }), // none
    await mia.client.try('POST', `/api/rooms/${g.id}/messages`, { body: 'x', clientMessageId: cm(), threadRootId: line.id }), // an event line
  ]
  const same = (e: any) => ({ ...e, requestId: undefined })
  for (const t of tries) expect([t.status, same(t.body.error)]).toEqual([400, same(tries[0]!.body.error)])
  // a thread reply quotes nothing; "also to the room" belongs to a thread reply
  expect((await mia.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'x', clientMessageId: cm(), threadRootId: root.id, replyToId: root.id })).status).toBe(400)
  expect((await mia.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'x', clientMessageId: cm(), alsoInRoom: true })).status).toBe(400)
  // reading: a reply, a private preview, an event line or an unknown id has no thread (404); a deleted root keeps its replies
  for (const id of [r.id, privateId, newId()]) expect((await mia.client.try('GET', `/api/rooms/${team.id}/messages/${id}/thread`)).status).toBe(404)
  expect((await mia.client.try('GET', `/api/rooms/${g.id}/messages/${line.id}/thread`)).status).toBe(404)
  await mia.client.call('DELETE', `/api/rooms/${team.id}/messages/${root.id}`)
  const kept = await thread(nora.client, team.id, root.id)
  expect(kept.root).toMatchObject({ body: '', deletedAt: expect.any(String), thread: { replyCount: 1 } })
  expect(kept.items.map((m: any) => m.body)).toEqual(['a reply'])
  expect((await nora.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'late', clientMessageId: cm(), threadRootId: root.id })).status).toBe(400)
  // a deleted reply: shown as deleted, no longer counted
  await nora.client.call('DELETE', `/api/rooms/${team.id}/messages/${r.id}`)
  expect((await thread(nora.client, team.id, root.id)).root.thread).toBeUndefined()
})

test('a thread follows its root: a member who joined after the root sees none of it, however late the replies', async () => {
  const { mia, nora, otto, pia, hub, roomOf, send, reply, timeline, thread, notices } = await setup()
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  const old = await send(mia.client, g.id, 'OLD-ROOT before pia')
  await reply(nora.client, g.id, old.id, 'OLD-REPLY before pia')
  await mia.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [pia.id] })
  const piaStart = await roomOf(pia.client, g.id)
  hub.clear()
  // after pia joined: a reply with a file, one also sent to the room, one mentioning her
  const form = new FormData()
  form.set('file', new File([new TextEncoder().encode('numbers')], 'thread-plan.txt', { type: 'text/plain' }))
  const up = await (await h.fetch(`/api/rooms/${g.id}/files`, { method: 'POST', body: form, headers: { cookie: nora.client.cookie!, 'x-mycel-csrf': '1' } })).json()
  const withFile = await reply(nora.client, g.id, old.id, 'LATE-REPLY with a file', { fileIds: [up.id] })
  const loud = await reply(otto.client, g.id, old.id, 'LATE-REPLY to the room too', { alsoInRoom: true })
  await reply(mia.client, g.id, old.id, 'LATE-REPLY @PIA look', { mentions: [pia.id] })
  // the timeline from her join on: no root, no reply, not even the one sent to the room
  const hers = JSON.stringify(await timeline(pia.client, g.id))
  for (const s of ['OLD-ROOT', 'OLD-REPLY', 'LATE-REPLY']) expect(hers).not.toContain(s)
  expect((await pia.client.try('GET', `/api/rooms/${g.id}/messages/${old.id}/thread`)).status).toBe(404)
  // its files, sources, replies and reactions are not hers either
  expect((await pia.client.try('GET', `/api/rooms/${g.id}/files/${up.id}`)).status).toBe(404)
  expect((await pia.client.try('GET', `/api/rooms/${g.id}/messages/${withFile.id}/sources`)).status).toBe(404)
  expect((await pia.client.try('PUT', `/api/rooms/${g.id}/messages/${loud.id}/reactions`, { emoji: '👍', on: true })).status).toBe(404)
  expect((await pia.client.try('POST', `/api/rooms/${g.id}/messages/${old.id}/thread/read`, { seq: 99 })).status).toBe(404)
  // replying there is refused as for a message that is not there
  expect((await pia.client.try('POST', `/api/rooms/${g.id}/messages`, { body: 'me too', clientMessageId: cm(), threadRootId: old.id })).status).toBe(400)
  // no event, notice or badge reached her: not the replies, not the thread's summary, not the mention
  expect(hub.events.filter((e) => e.target === pia.id && JSON.stringify(e.data).includes(old.id))).toEqual([])
  expect(hub.events.filter((e) => e.target === pia.id && JSON.stringify(e.data).includes('LATE-REPLY'))).toEqual([])
  expect(notices(pia.id)).toEqual([])
  // not even as a number: her room's position stays where it was (the room's own counter moved four times)
  expect(await roomOf(pia.client, g.id)).toMatchObject({ unreadCount: 0, threadsUnread: 0, mentioned: false, lastSeq: piaStart.lastSeq })
  expect((h.ctx.db.query('SELECT last_seq FROM rooms WHERE id = ?').get(g.id) as { last_seq: number }).last_seq).toBeGreaterThan(piaStart.lastSeq)
  // nor as the answer to a read past the end: it stops at the newest position she can see, never the room's counter
  const read = await pia.client.call('POST', `/api/rooms/${g.id}/read`, { seq: 1_000_000 })
  expect(read.lastReadSeq).toBe(piaStart.lastSeq)
  // a root after her join is hers like any message, with its thread
  const fresh = await send(mia.client, g.id, 'NEW-ROOT')
  await reply(nora.client, g.id, fresh.id, 'NEW-REPLY')
  expect((await thread(pia.client, g.id, fresh.id)).items.map((m: any) => m.body)).toEqual(['NEW-REPLY'])
  // she follows it (a reply of hers); replies in the old thread move the counter: her thread read stops at that
  // thread's newest reply
  const piaReply = await reply(pia.client, g.id, fresh.id, "PIA-REPLY")
  await reply(nora.client, g.id, old.id, 'LATE-REPLY again')
  await reply(nora.client, g.id, old.id, 'LATE-REPLY and again')
  expect((await pia.client.call('POST', `/api/rooms/${g.id}/messages/${fresh.id}/thread/read`, { seq: 1_000_000 })).lastReadSeq).toBe(piaReply.seq)
  expect((await pia.client.call('POST', `/api/rooms/${g.id}/read`, { seq: 1_000_000 })).lastReadSeq).toBe(fresh.seq)
  // the old members still see everything
  expect((await thread(nora.client, g.id, old.id)).items).toHaveLength(6)
})

test('a thread under an AI answer: the person who asked it follows it like the author of a message', async () => {
  const { mia, nora, otto, teamRoom, reply, unreadNotices } = await setup()
  const team = await teamRoom(mia.client)
  // an AI answer to mia's question (the AI writes it; put in directly here)
  const answer = newId()
  h.ctx.db.transaction(() => {
    const seq = (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(team.id) as { last_seq: number }).last_seq
    h.ctx.db.query("INSERT INTO room_messages (id, room_id, seq, author_kind, asked_by, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'ai', ?, 'room', 'THE ANSWER', '[]', ?)").run(answer, team.id, seq, mia.id, new Date().toISOString())
  })()
  const r = await reply(nora.client, team.id, answer, 'about the answer')
  expect(unreadNotices(mia.id).map((n) => n.source_id)).toEqual([r.id])
  expect(unreadNotices(otto.id)).toEqual([])
  expect(await teamRoom(mia.client)).toMatchObject({ threadsUnread: 1, nextThreadId: answer })
})

test('members only: the thread routes and reactions answer 404 to anyone outside the room, admins included', async () => {
  const { owner, ada, mia, nora, otto, send, reply } = await setup()
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const root = await send(mia.client, dm.id, 'DM-SECRET root')
  await reply(nora.client, dm.id, root.id, 'DM-SECRET reply')
  for (const c of [owner, ada.client, otto.client]) {
    const tries = [
      await c.try('GET', `/api/rooms/${dm.id}/messages/${root.id}/thread`),
      await c.try('POST', `/api/rooms/${dm.id}/messages/${root.id}/thread/read`, { seq: 9 }),
      await c.try('PUT', `/api/rooms/${dm.id}/messages/${root.id}/reactions`, { emoji: '👍', on: true }),
      await c.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'x', clientMessageId: cm(), threadRootId: root.id }),
    ]
    for (const t of tries) {
      expect(t.status).toBe(404)
      expect(JSON.stringify(t.body)).not.toContain('DM-SECRET')
    }
  }
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_reactions').get()).toEqual({ n: 0 })
})

test('followers: the root\'s author, repliers and people mentioned are notified and see a marker; nobody else; muted rooms stay quiet', async () => {
  const { mia, nora, otto, pia, owner, group, teamRoom, roomOf, send, reply, thread, unreadNotices, notices } = await setup()
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, otto.id, pia.id] })
  const team = await teamRoom(mia.client)
  const root = await send(mia.client, team.id, 'ROOT by mia')
  for (const c of [nora, otto, pia]) await c.client.call('POST', `/api/rooms/${team.id}/read`, { seq: root.seq })
  // nora replies: mia (the root's author) follows from now on and is notified; otto and pia are not
  const r1 = await reply(nora.client, team.id, root.id, 'nora replies')
  expect(unreadNotices(mia.id).map((n) => [n.event_type, n.source_id])).toEqual([['room.dm', r1.id]])
  expect(unreadNotices(otto.id)).toEqual([])
  expect(unreadNotices(pia.id)).toEqual([])
  expect(unreadNotices(nora.id)).toEqual([])
  // mia's badge for the room counts the thread; the root has the marker for her only
  expect(await teamRoom(mia.client)).toMatchObject({ unreadCount: 0, threadsUnread: 1, nextThreadId: root.id })
  expect(await teamRoom(otto.client)).toMatchObject({ unreadCount: 0, threadsUnread: 0, nextThreadId: null })
  expect((await thread(mia.client, team.id, root.id)).root.thread.newReplies).toBe(true)
  expect((await thread(otto.client, team.id, root.id)).root.thread.newReplies).toBe(false)
  expect((await thread(nora.client, team.id, root.id)).root.thread.newReplies).toBe(false)
  // a mention brings otto in: notified as a mention, and he follows from then on
  const r2 = await reply(nora.client, team.id, root.id, '@OTTO what do you think', { mentions: [otto.id] })
  expect(unreadNotices(otto.id).map((n) => [n.event_type, n.source_id])).toEqual([['room.mention', r2.id]])
  expect(await teamRoom(otto.client)).toMatchObject({ threadsUnread: 1, mentioned: true })
  // one notice per unread run in a thread: mia's first is still unread, so the second reply adds none
  expect(unreadNotices(mia.id)).toHaveLength(1)
  // reading the room does not read the thread; reading the thread does (and its notices)
  await mia.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 999 })
  expect(unreadNotices(mia.id)).toHaveLength(1)
  expect((await teamRoom(mia.client)).threadsUnread).toBe(1)
  const read = await mia.client.call('POST', `/api/rooms/${team.id}/messages/${root.id}/thread/read`, { seq: r2.seq })
  expect(read).toMatchObject({ lastReadSeq: r2.seq, room: { id: team.id, threadsUnread: 0, nextThreadId: null } })
  expect(unreadNotices(mia.id)).toEqual([])
  expect((await thread(mia.client, team.id, root.id)).root.thread.newReplies).toBe(false)
  // otto replies: he has read the thread up to his reply; nora and mia hear of it, pia (never in it) does not
  await reply(otto.client, team.id, root.id, 'otto answers')
  expect((await teamRoom(otto.client)).threadsUnread).toBe(0)
  expect(unreadNotices(pia.id)).toEqual([])
  expect(unreadNotices(nora.id)).toHaveLength(1)
  expect(unreadNotices(mia.id)).toHaveLength(1)
  // a follower who muted the room is not notified (the marker still shows, as the room's badge would)
  await mia.client.call('PATCH', `/api/rooms/${team.id}`, { muted: true })
  await mia.client.call('POST', `/api/rooms/${team.id}/messages/${root.id}/thread/read`, { seq: 999 })
  await reply(nora.client, team.id, root.id, 'quiet for mia')
  await reply(nora.client, team.id, root.id, '@MIA muted', { mentions: [mia.id] })
  expect(unreadNotices(mia.id)).toEqual([])
  expect((await roomOf(mia.client, team.id)).threadsUnread).toBe(1)
  // reading moves forward only, and never past the end
  const end = (h.ctx.db.query('SELECT last_seq FROM rooms WHERE id = ?').get(team.id) as { last_seq: number }).last_seq
  expect((await mia.client.call('POST', `/api/rooms/${team.id}/messages/${root.id}/thread/read`, { seq: 99_999 })).lastReadSeq).toBe(end)
  expect((await mia.client.call('POST', `/api/rooms/${team.id}/messages/${root.id}/thread/read`, { seq: 1 })).lastReadSeq).toBe(end)
  // a follower who is not mentioned in a DM: a thread reply of the other person notifies only when they follow it
  const dm = await nora.client.call('POST', '/api/rooms', { kind: 'dm', userId: pia.id })
  const own = await send(nora.client, dm.id, 'nora writes')
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await pia.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  const piaBefore = notices(pia.id).length
  await reply(nora.client, dm.id, own.id, 'nora adds in her own thread')
  expect(notices(pia.id)).toHaveLength(piaBefore)
  expect(await roomOf(pia.client, dm.id)).toMatchObject({ unreadCount: 0, threadsUnread: 0 })
  // also sent to the room: in a DM that is a message of the room, so it notifies like one
  await reply(nora.client, dm.id, own.id, 'nora to the room too', { alsoInRoom: true })
  expect(notices(pia.id)).toHaveLength(piaBefore + 1)
  expect(await roomOf(pia.client, dm.id)).toMatchObject({ unreadCount: 1 })
  // for a follower it is one thing to read, not two: it counts in the timeline, not again as a thread with news
  await pia.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await reply(pia.client, dm.id, own.id, 'pia follows now')
  await nora.client.call('POST', `/api/rooms/${dm.id}/messages/${own.id}/thread/read`, { seq: 999 })
  await reply(pia.client, dm.id, own.id, 'PIA-TO-ROOM', { alsoInRoom: true })
  expect(await roomOf(nora.client, dm.id)).toMatchObject({ unreadCount: 1, threadsUnread: 0 })
  expect((await thread(nora.client, dm.id, own.id)).root.thread.newReplies).toBe(false)
})

test("a read answers my badge and whether a followed thread's mention is still unread", async () => {
  const { mia, nora, teamRoom, send, reply } = await setup()
  const team = await teamRoom(mia.client)
  const root = await send(mia.client, team.id, 'root')
  await reply(nora.client, team.id, root.id, '@MIA in the thread', { mentions: [mia.id] })
  await send(nora.client, team.id, 'in the room')
  // reading the room reads the timeline; the thread's mention is still there
  expect(await mia.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 999 })).toMatchObject({ unreadCount: 0, mentioned: true })
  await mia.client.call('POST', `/api/rooms/${team.id}/messages/${root.id}/thread/read`, { seq: 999 })
  expect(await mia.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 999 })).toMatchObject({ unreadCount: 0, mentioned: false })
})

test('a thread notice opens its thread (push path and the notice), names who wrote it, never the text; a deleted reply takes it', async () => {
  const { mia, nora, send, reply, unreadNotices } = await setup()
  const n = notificationsOf(h.ctx)
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const root = await send(nora.client, dm.id, 'nora asks')
  await mia.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  for (const x of unreadNotices(nora.id)) n.read(nora.id, x.id)
  const r = await reply(mia.client, dm.id, root.id, 'LOCK SCREEN MUST NOT SHOW THIS reply')
  const [notice] = unreadNotices(nora.id)
  expect(notice).toMatchObject({ event_type: 'room.dm', source_id: r.id })
  expect(pushPathOf(h.ctx, 'room.dm', notice!.id)).toBe(`/rooms/${dm.id}/t/${root.id}`)
  const item = n.get(nora.id, notice!.id)
  expect(item).toMatchObject({ link: 'room', room: { id: dm.id, from: 'MIA', thread: root.id } })
  expect(JSON.stringify(item)).not.toContain('LOCK SCREEN')
  // a timeline message's notice still opens the room
  await send(mia.client, dm.id, 'in the room')
  const roomNotice = unreadNotices(nora.id).find((x) => x.source_id !== r.id)!
  expect(pushPathOf(h.ctx, 'room.dm', roomNotice.id)).toBe(`/rooms/${dm.id}`)
  expect(n.get(nora.id, roomNotice.id).room).toEqual({ id: dm.id, from: 'MIA' })
  // the reply deleted: its notice goes with it
  await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${r.id}`)
  expect(unreadNotices(nora.id).map((x) => x.source_id)).toEqual([roomNotice.source_id])
})

test('realtime: a reply goes to those who see its root, the summary to each as they see it, my reading only to my windows', async () => {
  const { mia, nora, otto, ada, hub, teamRoom, send, reply } = await setup()
  const team = await teamRoom(mia.client)
  const root = await send(mia.client, team.id, 'root')
  hub.clear()
  const r = await reply(nora.client, team.id, root.id, 'REPLY-RT')
  expect(hub.to('room.message').map((e) => e.target).sort()).toEqual([mia.id, nora.id, otto.id].sort())
  const summaries = hub.to('room.thread')
  expect(summaries.map((e) => e.target).sort()).toEqual([mia.id, nora.id, otto.id].sort())
  const forMia = summaries.find((e) => e.target === mia.id)!.data as any
  const forOtto = summaries.find((e) => e.target === otto.id)!.data as any
  expect(forMia.data).toMatchObject({ roomId: team.id, rootId: root.id, thread: { replyCount: 1, newReplies: true } })
  expect(forOtto.data.thread).toMatchObject({ replyCount: 1, newReplies: false })
  // the follower's badge comes as their room, and the author's (their other windows keep their place in the thread);
  // the others' rooms did not change
  expect(hub.to('room.updated').map((e) => e.target).sort()).toEqual([mia.id, nora.id].sort())
  expect((hub.to('room.updated').find((e) => e.target === nora.id)!.data as any).data.room).toMatchObject({ threadsUnread: 0 })
  for (const e of hub.events) expect([mia.id, nora.id, otto.id]).toContain(e.target)
  expect(hub.events.some((e) => e.target === ada.id)).toBe(false)
  hub.clear()
  await mia.client.call('POST', `/api/rooms/${team.id}/messages/${root.id}/thread/read`, { seq: r.seq })
  // (and the signal that her notices changed: the reply's notice is read now)
  expect(hub.events.map((e) => [e.target, (e.data as any).type]).sort()).toEqual([[mia.id, 'notice'], [mia.id, 'room.thread'], [mia.id, 'room.updated']].sort())
})

test('reactions: the fixed set, on and off, counted for members; never on lines, deleted messages or previews; no notice', async () => {
  const { mia, nora, otto, hub, teamRoom, send, reply, timeline, thread, unreadNotices } = await setup()
  const team = await teamRoom(mia.client)
  const m = await send(mia.client, team.id, 'react to me')
  await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: m.seq })
  hub.clear()
  const put = (c: Client, emoji: string, on = true, id = m.id) => c.try('PUT', `/api/rooms/${team.id}/messages/${id}/reactions`, { emoji, on })
  const first = await put(nora.client, '👍')
  expect(first.status).toBe(200)
  expect(first.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: true, users: [{ id: nora.id, name: 'NORA' }] }])
  // the same again changes nothing; a second person and a second emoji
  expect((await put(nora.client, '👍')).body.reactions).toEqual(first.body.reactions)
  await put(otto.client, '👍')
  await put(otto.client, '❤️')
  const seen = (await timeline(mia.client, team.id))[0].reactions
  expect(seen).toEqual([
    { emoji: '👍', count: 2, mine: false, users: [{ id: nora.id, name: 'NORA' }, { id: otto.id, name: 'OTTO' }] },
    { emoji: '❤️', count: 1, mine: false, users: [{ id: otto.id, name: 'OTTO' }] },
  ])
  // realtime: to the members, each with their own "mine"
  const ev = hub.to('room.reactions').filter((e) => e.target === otto.id).at(-1)!.data as any
  expect(ev.data.reactions.map((r: any) => [r.emoji, r.mine])).toEqual([['👍', true], ['❤️', true]])
  // off again; the last one off takes the chip
  expect((await put(otto.client, '❤️', false)).body.reactions.map((r: any) => r.emoji)).toEqual(['👍'])
  // never a notice, a badge or an unread count, and the room keeps its place
  expect(unreadNotices(mia.id)).toEqual([])
  expect(await teamRoom(nora.client)).toMatchObject({ unreadCount: 0, threadsUnread: 0 })
  // only the 8; replies take them too; not event lines, deleted messages or private previews
  expect(ROOM_REACTIONS).toHaveLength(8)
  for (const bad of ['💩', 'thumbsup', '👍🏽', '']) expect((await put(nora.client, bad)).status).toBe(400)
  expect((await nora.client.try('PUT', `/api/rooms/${team.id}/messages/${m.id}/reactions`, { emoji: '👍', on: true, userId: mia.id })).status).toBe(400)
  const r = await reply(nora.client, team.id, m.id, 'a reply')
  expect((await put(mia.client, '🎉', true, r.id)).status).toBe(200)
  expect((await thread(otto.client, team.id, m.id)).items[0].reactions).toMatchObject([{ emoji: '🎉', count: 1 }])
  const gone = await send(mia.client, team.id, 'deleted')
  await put(nora.client, '👀', true, gone.id)
  await mia.client.call('DELETE', `/api/rooms/${team.id}/messages/${gone.id}`)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_reactions WHERE message_id = ?').get(gone.id)).toEqual({ n: 0 })
  expect((await put(nora.client, '👀', true, gone.id)).status).toBe(400)
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  const line = (await mia.client.call('GET', `/api/rooms/${g.id}/messages`)).items[0]
  expect((await nora.client.try('PUT', `/api/rooms/${g.id}/messages/${line.id}/reactions`, { emoji: '👍', on: true })).status).toBe(400)
  // every emoji of the set is accepted (the ❤️ with its variation selector too)
  for (const e of ROOM_REACTIONS) expect((await put(mia.client, e, true, r.id)).status).toBe(200)
})

test(`reactions name the first ${ROOM_REACTION_NAMES} people and count everyone in the room now; leaving takes mine`, async () => {
  const { owner, mia, nora, otto, send } = await setup()
  const all = (await mia.client.call('GET', '/api/rooms')).items.find((r: any) => r.kind === 'all')
  const m = await send(mia.client, all.id, 'everyone, react')
  const add = h.ctx.db.query("INSERT INTO room_reactions (room_id, message_id, user_id, emoji, created_at) VALUES (?, ?, ?, '🔥', ?)")
  const ids: string[] = []
  for (let i = 0; i < ROOM_REACTION_NAMES + 3; i++) {
    const p = await addMember(h, owner, { username: `p${i}` })
    ids.push(p.id)
  }
  await mia.client.call('GET', '/api/rooms') // the new people join the everyone room
  ids.forEach((id, i) => add.run(all.id, m.id, id, new Date(Date.now() + i).toISOString()))
  let r = (await nora.client.call('GET', `/api/rooms/${all.id}/messages`)).items.find((x: any) => x.id === m.id).reactions[0]
  expect(r.count).toBe(ROOM_REACTION_NAMES + 3)
  expect(r.users.map((u: any) => u.id)).toEqual(ids.slice(0, ROOM_REACTION_NAMES))
  // someone no longer in the room: their reaction goes, and is not counted
  await owner.call('PATCH', `/api/admin/users/${ids[0]}`, { status: 'disabled' })
  r = (await nora.client.call('GET', `/api/rooms/${all.id}/messages`)).items.find((x: any) => x.id === m.id).reactions[0]
  expect(r.count).toBe(ROOM_REACTION_NAMES + 2)
  expect(r.users[0].id).toBe(ids[1])
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_reactions WHERE user_id = ?').get(ids[0])).toEqual({ n: 0 })
  // leaving a group chat takes my reactions and the threads I followed there
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  const gm = await send(mia.client, g.id, 'group root')
  await otto.client.call('PUT', `/api/rooms/${g.id}/messages/${gm.id}/reactions`, { emoji: '✅', on: true })
  await send(otto.client, g.id, 'otto replies', { threadRootId: gm.id })
  await otto.client.call('POST', `/api/rooms/${g.id}/leave`)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_reactions WHERE room_id = ? AND user_id = ?').get(g.id, otto.id)).toEqual({ n: 0 })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_thread_follows WHERE room_id = ? AND user_id = ?').get(g.id, otto.id)).toEqual({ n: 0 })
})

test('replies and reactions take from the one sending budget', async () => {
  const { mia, nora, send } = await setup()
  // the budget's clock stands still: nothing refills, however slow the machine
  const t0 = Date.now()
  roomsOf(h.ctx).clock = () => t0
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const root = await send(nora.client, dm.id, 'root')
  for (let i = 0; i < SEND_BURST / 2; i++) await send(mia.client, dm.id, `reply ${i}`, { threadRootId: root.id })
  const emojis = [...ROOM_REACTIONS]
  let i = 0
  for (; i < SEND_BURST; i++) {
    const r = await mia.client.try('PUT', `/api/rooms/${dm.id}/messages/${root.id}/reactions`, { emoji: emojis[i % emojis.length], on: Math.floor(i / emojis.length) % 2 === 0 })
    if (r.status === 429) break
    expect(r.status).toBe(200)
  }
  // the replies took half of it: the reactions ran out at exactly the other half
  expect(i).toBe(SEND_BURST / 2)
  // a reaction that changes nothing costs nothing, even now
  expect((await mia.client.try('PUT', `/api/rooms/${dm.id}/messages/${root.id}/reactions`, { emoji: '👍', on: false })).status).toBe(200)
  // a second later one more
  roomsOf(h.ctx).clock = () => t0 + 1000
  expect((await mia.client.try('PUT', `/api/rooms/${dm.id}/messages/${root.id}/reactions`, { emoji: '👍', on: true })).status).toBe(200)
  const over = await mia.client.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'one too many', clientMessageId: cm(), threadRootId: root.id })
  expect(over.status).toBe(429)
  expect(over.body.error).toMatchObject({ code: 'rate_limited', retryAfter: expect.any(Number) })
})

test('reader level: a database with thread replies is refused by an older build (restore the backup to go back)', async () => {
  const { readMigrations, SCHEMA_READER_LEVEL, openDb, migrate, SchemaTooNewError } = await import('../../server/src/db')
  h = await harness('b-rooms-threads-reader')
  const m = readMigrations().find((x) => x.name === '251_b_room_threads.sql')!
  expect(m.minCompatibleReader).toBe(6)
  expect(SCHEMA_READER_LEVEL).toBeGreaterThanOrEqual(6)
  const dir = path.join(h.ctx.config.dataDir, 'with-threads')
  fs.mkdirSync(dir, { recursive: true })
  for (const x of readMigrations()) if (x.version <= 251) fs.writeFileSync(path.join(dir, x.name), x.sql)
  const file = path.join(h.ctx.config.dataDir, 'threads.db')
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true })
  const db = openDb(file)
  expect(() => migrate(db, { migrationsDir: dir, readerLevel: 5 })).toThrow(SchemaTooNewError)
  db.close()
})
