// Message links and their previews (docs/DECISIONS.md "Message links and their previews", server/src/rooms/link-previews.ts):
// a person's message that links to another room message carries that message's preview for each viewer who may see it
// now (live), or the snapshot its sender chose to show ("Show message"), else nothing at all (the same as a link to
// nothing). The permission matrix, snapshots and their boundaries, removing a preview, the composer's audience question,
// and the read's query count.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { newId } from '../../server/src/db'
import { roomsOf, LINK_AUDIENCE_BURST } from '../../server/src/rooms/service'
import { snapshotAllowed } from '../../server/src/rooms/link-previews'
import { addMember, harness, RecordingHub, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

const HOST = 'https://acme.example.com'
const link = (roomId: string, messageId: string, rootId?: string) => (rootId ? `${HOST}/rooms/${roomId}/t/${rootId}?m=${messageId}` : `${HOST}/rooms/${roomId}?m=${messageId}`)
/** an id of the right shape that names nothing here */
const NOWHERE = '019a5f00-0000-7000-8000-0000000fffff'

class FanoutHub extends RecordingHub {
  users: string[] = []
  override publishEach(build: (userId: string) => unknown) {
    for (const u of this.users) { const ev = build(u); if (ev) this.events.push({ kind: 'publish', target: u, data: ev }) }
  }
  of(uid: string) { return this.events.filter((e) => e.target === uid).map((e) => e.data as { type: string; data: any }) }
}

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const ownerId = (await owner.call('GET', '/api/me')).user.id as string
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id] })
  const hub = new FanoutHub()
  hub.users = [ownerId, mia.id, nora.id, otto.id]
  h.ctx.services.realtime = hub
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 2000)
  const mine = (await mia.client.call('GET', '/api/rooms')).items as any[]
  const team = mine.find((r) => r.kind === 'team' && r.groupId === group.id)
  const all = mine.find((r) => r.kind === 'all')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const chat = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  let n = 0
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: `client-${++n}-${Date.now()}`, ...extra })
  /** the message `id` of a room's timeline as `c` gets it */
  const seen = async (c: Client, roomId: string, id: string) => ((await c.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]).find((m) => m.id === id)
  const stored = (id: string) => (h.ctx.db.query('SELECT link_previews FROM room_messages WHERE id = ?').get(id) as { link_previews: string | null }).link_previews
  return { owner, ownerId, mia, nora, otto, group, hub, team, all, dm, chat, send, seen, stored }
}

test('live cards: who may see the original gets its card (its place as they name it), everyone else no trace of it', async () => {
  const { owner, mia, nora, otto, team, all, dm, send, seen } = await setup('b-link-previews-live')
  const a = await send(mia.client, team.id, 'design notes v2 **draft**')
  const d = await send(nora.client, dm.id, 'between us: the budget is 42')
  const m = await send(mia.client, all.id, `look ${link(team.id, a.id)} and ${link(dm.id, d.id)}`)
  // the sender sees both (in both rooms)
  expect(m.linkPreviews.map((p: any) => [p.messageId, p.place.kind, p.body])).toEqual([[a.id, 'team', 'design notes v2 **draft**'], [d.id, 'dm', 'between us: the budget is 42']])
  expect(m.linkPreviews[1].place.peers.map((x: any) => x.id)).toEqual([nora.id])
  expect(m.linkPreviews[0].author.id).toBe(mia.id)
  // nora: in design and in the DM; the DM is named after the other person as she sees it (mia)
  const forNora = await seen(nora.client, all.id, m.id)
  expect(forNora.linkPreviews.map((p: any) => p.messageId)).toEqual([a.id, d.id])
  expect(forNora.linkPreviews[1].place.peers.map((x: any) => x.id)).toEqual([mia.id])
  // otto and the owner are in neither: no card, no field at all (an admin is no exception)
  for (const c of [otto.client, owner]) {
    const x = await seen(c, all.id, m.id)
    expect(x.body).toBe(m.body)
    expect('linkPreviews' in x).toBe(false)
    expect(JSON.stringify(x)).not.toContain('budget')
    expect(JSON.stringify(x)).not.toContain('design notes')
  }
  // the live event says the same per member
  const ev = await send(mia.client, all.id, `again ${link(dm.id, d.id)}`)
  const live = h.ctx.services.realtime as FanoutHub
  const got = (uid: string) => live.of(uid).filter((e) => e.type === 'room.message' && e.data.message.id === ev.id).map((e) => e.data.message.linkPreviews?.length ?? 0)
  expect(got(nora.id)).toEqual([1])
  expect(got(otto.id)).toEqual([0])
})

test('no access and no such message give the same message; another host is read by ids; >5 links and repeats', async () => {
  const { mia, otto, dm, all, team, send, seen, nora } = await setup('b-link-previews-same')
  const d = await send(nora.client, dm.id, 'secret')
  const a = await send(mia.client, all.id, `x ${link(dm.id, d.id)}`)
  const b = await send(mia.client, all.id, `x ${link(dm.id, NOWHERE)}`)
  const strip = (m: any) => { const { id, seq, body, createdAt, clientMessageId, ...rest } = m; return rest }
  expect(strip(await seen(otto.client, all.id, a.id))).toEqual(strip(await seen(otto.client, all.id, b.id)))
  // any host: the ids decide (the web draws chips only for its own hosts)
  const other = await send(mia.client, all.id, `https://elsewhere.example/rooms/${dm.id}?m=${d.id}`)
  expect(other.linkPreviews?.length).toBe(1)
  // a link whose room is not the message's room: nothing
  const wrong = await send(mia.client, all.id, link(team.id, d.id))
  expect(wrong.linkPreviews).toBeUndefined()
  // more than five links of any kind: no card; the same link twice: one card
  const many = await send(mia.client, all.id, `${link(dm.id, d.id)} https://a.example https://b.example https://c.example https://d.example https://e.example`)
  expect(many.linkPreviews).toBeUndefined()
  const twice = await send(mia.client, all.id, `${link(dm.id, d.id)} ${link(dm.id, d.id.toUpperCase())}`)
  expect(twice.linkPreviews.length).toBe(1)
})

test('group chat history, archived rooms, hidden answers: as reading the room', async () => {
  const { owner, ownerId, mia, nora, otto, team, all, send, seen, group } = await setup('b-link-previews-matrix')
  // a group chat before otto joined
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, ownerId] })
  const before = await send(mia.client, g.id, 'before otto')
  await mia.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [otto.id] })
  const after = await send(mia.client, g.id, 'after otto')
  const m = await send(mia.client, all.id, `${link(g.id, before.id)} ${link(g.id, after.id)}`)
  expect((await seen(otto.client, all.id, m.id)).linkPreviews.map((p: any) => p.messageId)).toEqual([after.id])
  expect((await seen(nora.client, all.id, m.id)).linkPreviews.length).toBe(2)
  // an archived room: nobody gets a card from it
  const t = await send(mia.client, team.id, 'team words')
  const tm = await send(mia.client, all.id, link(team.id, t.id))
  expect((await seen(nora.client, all.id, tm.id)).linkPreviews.length).toBe(1)
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), team.id)
  expect((await seen(nora.client, all.id, tm.id)).linkPreviews).toBeUndefined()
  h.ctx.db.query('UPDATE rooms SET archived_at = NULL WHERE id = ?').run(team.id)
  // one of nora's hidden old answers (room_hidden_answers): not hers to see through a link either
  h.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(team.id, nora.id, t.id, t.seq)
  expect((await seen(nora.client, all.id, tm.id)).linkPreviews).toBeUndefined()
  expect((await seen(mia.client, all.id, tm.id)).linkPreviews.length).toBe(1)
  // a member taken out of the group: plain from then on
  h.ctx.db.query('DELETE FROM room_hidden_answers WHERE user_id = ?').run(nora.id)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id] })
  await roomsOf(h.ctx).syncNow()
  expect((await seen(nora.client, all.id, tm.id)).linkPreviews).toBeUndefined()
})

test('a thread reply, an edited and a deleted original, an event line', async () => {
  const { mia, nora, team, all, send, seen } = await setup('b-link-previews-thread')
  const root = await send(mia.client, team.id, 'root')
  const reply = await send(nora.client, team.id, 'in the thread', { threadRootId: root.id })
  const m = await send(mia.client, all.id, link(team.id, reply.id, root.id))
  expect(m.linkPreviews[0]).toMatchObject({ messageId: reply.id, rootId: root.id, body: 'in the thread' })
  // a link that names the wrong thread: nothing
  const bad = await send(mia.client, all.id, link(team.id, reply.id, m.id))
  expect(bad.linkPreviews).toBeUndefined()
  await nora.client.call('PATCH', `/api/rooms/${team.id}/messages/${reply.id}`, { body: 'in the thread, edited' })
  const e = (await seen(mia.client, all.id, m.id)).linkPreviews[0]
  expect([e.body, typeof e.editedAt]).toEqual(['in the thread, edited', 'string'])
  await nora.client.call('DELETE', `/api/rooms/${team.id}/messages/${reply.id}`)
  const gone = (await seen(mia.client, all.id, m.id)).linkPreviews[0]
  expect([gone.deleted, gone.body, gone.files.count]).toEqual([true, '', 0])
  // an event line links to nothing
  const ev = h.ctx.db.query("SELECT id FROM room_messages WHERE room_id = ? AND event IS NOT NULL LIMIT 1").get(all.id) as { id: string } | null
  if (ev) expect((await send(mia.client, all.id, link(all.id, ev.id))).linkPreviews).toBeUndefined()
})

test('Show message: a snapshot only from the sender\'s own access, only a person\'s message; frozen; wiped on delete', async () => {
  const { mia, nora, otto, dm, all, chat, send, seen, stored } = await setup('b-link-previews-snapshot')
  const d = await send(nora.client, dm.id, `the plan @mia, see the file`, { mentions: [mia.id] })
  // otto is not in the DM: his "Show message" for it is dropped, the same as for an id that is not there
  const o1 = await send(otto.client, all.id, link(dm.id, d.id), { showMessages: [d.id] })
  const o2 = await send(otto.client, all.id, link(dm.id, NOWHERE), { showMessages: [NOWHERE] })
  expect([stored(o1.id), stored(o2.id)]).toEqual([null, null])
  expect([o1.linkPreviews, o2.linkPreviews]).toEqual([undefined, undefined])
  // an id that is not linked in the body: dropped
  const o3 = await send(mia.client, all.id, 'no link here', { showMessages: [d.id] })
  expect(stored(o3.id)).toBeNull()
  // mia (in the DM) shows it in the everyone room: otto gets the snapshot, marked shared by mia, the DM named by kind only
  const m = await send(mia.client, all.id, `fyi ${link(dm.id, d.id)}`, { showMessages: [d.id] })
  const snap = (await seen(otto.client, all.id, m.id)).linkPreviews[0]
  expect(snap).toMatchObject({ messageId: d.id, place: { kind: 'dm', name: null, peers: [] }, body: 'the plan @mia, see the file', deleted: false, sharedBy: { id: mia.id } })
  expect(snap.author.id).toBe(nora.id)
  // nora is in the DM: her card is the live one (no sharedBy)
  expect((await seen(nora.client, all.id, m.id)).linkPreviews[0].sharedBy).toBeUndefined()
  // mentions inside the snapshot notify nobody: mia is mentioned in the original, the new message mentions no one
  expect(m.mentions).toEqual([])
  // frozen: an edit of the original does not reach it
  await nora.client.call('PATCH', `/api/rooms/${dm.id}/messages/${d.id}`, { body: 'changed my mind' })
  expect((await seen(otto.client, all.id, m.id)).linkPreviews[0].body).toBe('the plan @mia, see the file')
  // the rooms list's line and search hold the typed text only
  const allRoom = ((await otto.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.id === all.id)
  expect(allRoom.lastMessage.excerpt).not.toContain('plan')
  const found = await otto.client.call('GET', '/api/room-messages?q=plan')
  expect(found.items.length).toBe(0)
  // the original deleted: the snapshot's words go too
  await nora.client.call('DELETE', `/api/rooms/${dm.id}/messages/${d.id}`)
  expect(stored(m.id)).not.toContain('the plan')
  const after = (await seen(otto.client, all.id, m.id)).linkPreviews[0]
  expect([after.deleted, after.body]).toEqual([true, ''])
  // an AI answer is never snapshotted (nor an app's card or a shared answer)
  const ai = newId()
  h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, body, mentions, created_at) VALUES (?, ?, (SELECT last_seq + 1 FROM rooms WHERE id = ?), 'ai', NULL, ?, 'room', 'an AI answer', '[]', ?)`).run(ai, chat.id, chat.id, mia.id, new Date().toISOString())
  h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ?').run(chat.id)
  const s2 = await send(mia.client, dm.id, link(chat.id, ai), { showMessages: [ai] })
  expect(stored(s2.id)).toBeNull()
  const row = (id: string) => h.ctx.db.query('SELECT * FROM room_messages WHERE id = ?').get(id) as any
  expect(snapshotAllowed(row(ai))).toBe(false)
  expect(snapshotAllowed({ ...row(s2.id), answer_at: 0 })).toBe(false)
  expect(snapshotAllowed({ ...row(s2.id), app_card: '{}' })).toBe(false)
  expect(snapshotAllowed(row(s2.id))).toBe(true)
  // the 4,000-character cap and the files line (names only)
  const long = await send(nora.client, dm.id, 'x'.repeat(5000))
  const l = await send(mia.client, all.id, link(dm.id, long.id), { showMessages: [long.id] })
  expect((await seen(otto.client, all.id, l.id)).linkPreviews[0].body.length).toBe(4000)
  // a group chat's snapshot: "Group chat", nobody named
  const g = await send(otto.client, chat.id, 'group words')
  const gm = await send(mia.client, dm.id, link(chat.id, g.id), { showMessages: [g.id] })
  expect(gm.linkPreviews[0].sharedBy).toBeUndefined()
  expect(JSON.parse(stored(gm.id)!).snapshots[0]).toMatchObject({ kind: 'group', name: null })
})

test('an edit that takes the link out loses its snapshot; deleting the message holding it too', async () => {
  const { mia, nora, otto, dm, all, send, seen, stored } = await setup('b-link-previews-edit')
  const d = await send(nora.client, dm.id, 'secret plan')
  const m = await send(mia.client, all.id, `see ${link(dm.id, d.id)}`, { showMessages: [d.id] })
  expect(stored(m.id)).toContain('secret plan')
  // an edit cannot ask for one (strict body)
  expect((await mia.client.try('PATCH', `/api/rooms/${all.id}/messages/${m.id}`, { body: 'x', showMessages: [d.id] })).status).toBe(400)
  await mia.client.call('PATCH', `/api/rooms/${all.id}/messages/${m.id}`, { body: 'nothing to see' })
  expect(stored(m.id)).toBeNull()
  // a link added by an edit is live only (never a snapshot)
  await mia.client.call('PATCH', `/api/rooms/${all.id}/messages/${m.id}`, { body: `see ${link(dm.id, d.id)}` })
  expect((await seen(otto.client, all.id, m.id)).linkPreviews).toBeUndefined()
  const m2 = await send(mia.client, all.id, `again ${link(dm.id, d.id)}`, { showMessages: [d.id] })
  await mia.client.call('DELETE', `/api/rooms/${all.id}/messages/${m2.id}`)
  expect(stored(m2.id)).toBeNull()
})

test('remove preview: the sender only, for everyone, the snapshot goes, no "(edited)"', async () => {
  const { mia, nora, otto, dm, all, team, send, seen, stored, hub } = await setup('b-link-previews-hide')
  const d = await send(nora.client, dm.id, 'secret plan')
  const t = await send(nora.client, team.id, 'team words')
  const m = await send(mia.client, all.id, `${link(dm.id, d.id)} ${link(team.id, t.id)}`, { showMessages: [d.id] })
  // not the sender (nora can see the message): 404, as for a message that is not theirs
  expect((await nora.client.try('POST', `/api/rooms/${all.id}/messages/${m.id}/hide-preview`, { linkedMessageId: d.id })).status).toBe(404)
  // a link the message does not have: 404
  expect((await mia.client.try('POST', `/api/rooms/${all.id}/messages/${m.id}/hide-preview`, { linkedMessageId: NOWHERE })).status).toBe(404)
  expect((await mia.client.try('POST', `/api/rooms/${all.id}/messages/${m.id}/hide-preview`, { linkedMessageId: d.id, x: 1 })).status).toBe(400)
  hub.events = []
  const r = await mia.client.call('POST', `/api/rooms/${all.id}/messages/${m.id}/hide-preview`, { linkedMessageId: d.id })
  // mia sees both originals: the removed one stays a chip (its place), with no card
  expect(r.linkPreviews.map((p: any) => [p.messageId, !!p.removed, p.body])).toEqual([[d.id, true, ''], [t.id, false, 'team words']])
  expect(r.editedAt).toBeNull()
  expect(stored(m.id)).not.toContain('secret plan')
  expect(hub.of(nora.id).some((e) => e.type === 'room.message.updated' && e.data.message.id === m.id)).toBe(true)
  expect((await seen(otto.client, all.id, m.id)).linkPreviews).toBeUndefined()
  expect((await seen(nora.client, all.id, m.id)).linkPreviews.map((p: any) => [p.messageId, !!p.removed])).toEqual([[d.id, true], [t.id, false]])
})

test('the audience question: only links I see that a reader here cannot, yes/no only; 404, strict, bounded, rate limited', async () => {
  const { mia, nora, otto, dm, all, team, chat, send } = await setup('b-link-previews-audience')
  const d = await send(nora.client, dm.id, 'secret')
  const t = await send(nora.client, team.id, 'team words')
  const c = await send(otto.client, chat.id, 'chat words')
  const ask = (cl: Client, roomId: string, body: unknown) => cl.try('POST', `/api/rooms/${roomId}/message-links/audience`, body)
  // into the everyone room: otto cannot see the DM nor the team room; everyone in the group chat sees its message there? no:
  // the owner is not in it
  const r = await ask(mia.client, all.id, { links: [{ roomId: dm.id, messageId: d.id }, { roomId: team.id, messageId: t.id }] })
  expect(r.status).toBe(200)
  expect(r.body.items.map((i: any) => [i.messageId, i.someoneCannotSee, i.snapshotAllowed])).toEqual([[d.id, true, true], [t.id, true, true]])
  expect(r.body.items[0].preview).toMatchObject({ messageId: d.id, body: 'secret', place: { kind: 'dm', name: null, peers: [] }, sharedBy: { id: mia.id } })
  // into the DM (nora sees both the team room message and... the DM itself): nothing to ask
  expect((await ask(mia.client, dm.id, { links: [{ roomId: team.id, messageId: t.id }] })).body.items).toEqual([])
  // a link I cannot see and one that is not there: the same answer (left out)
  const no = await ask(otto.client, all.id, { links: [{ roomId: dm.id, messageId: d.id }] })
  const none = await ask(otto.client, all.id, { links: [{ roomId: dm.id, messageId: NOWHERE }] })
  expect([no.status, no.body]).toEqual([none.status, none.body])
  expect(no.body.items).toEqual([])
  // a room I am not in: 404 like any room
  expect((await ask(otto.client, dm.id, { links: [{ roomId: chat.id, messageId: c.id }] })).status).toBe(404)
  // strict body, 1..5 links
  expect((await ask(mia.client, all.id, { links: [] })).status).toBe(400)
  expect((await ask(mia.client, all.id, { links: Array.from({ length: 6 }, () => ({ roomId: dm.id, messageId: d.id })) })).status).toBe(400)
  expect((await ask(mia.client, all.id, { links: [{ roomId: dm.id, messageId: d.id }], extra: 1 })).status).toBe(400)
  // a thread of the room: who sees the thread reads it
  const root = await send(mia.client, chat.id, 'root')
  const th = await ask(mia.client, chat.id, { links: [{ roomId: dm.id, messageId: d.id }], threadRootId: root.id })
  expect(th.body.items.map((i: any) => i.messageId)).toEqual([d.id])
  // rate limited after a burst (the clock moves 2 s per call in these tests: hold it still)
  roomsOf(h.ctx).clock = () => 1_000_000
  let limited = 0
  for (let i = 0; i < LINK_AUDIENCE_BURST + 2; i++) if ((await ask(mia.client, all.id, { links: [{ roomId: dm.id, messageId: d.id }] })).status === 429) limited++
  expect(limited).toBeGreaterThan(0)
})

test('a page of 50 messages with 5 links each reads the previews in a bounded number of queries', async () => {
  const { mia, nora, team, all, send } = await setup('b-link-previews-queries')
  const targets = [] as string[]
  for (let i = 0; i < 5; i++) targets.push((await send(nora.client, team.id, `t${i}`)).id)
  const body = targets.map((id) => link(team.id, id)).join(' ')
  const count = async (n: number) => {
    const room = n === 5 ? all.id : (await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })).id
    // (a fresh DM of mia and nora for the big page: the DM is the same room, so use counts on top of what is there)
    for (let i = 0; i < n; i++) await send(mia.client, room, `${i} ${body}`)
    const db = h.ctx.db as any
    const query = db.query.bind(db)
    let q = 0
    db.query = (sql: string) => { q++; return query(sql) }
    try { await mia.client.call('GET', `/api/rooms/${room}/messages?limit=50`) } finally { db.query = query }
    return q
  }
  const few = await count(5)
  const many = await count(50)
  // the same reads for 5 or 50 messages, give or take the page's own per-message work (none for previews)
  expect(many - few).toBeLessThan(20)
})
