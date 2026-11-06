// Team chat rooms ("대화방" v1, docs/DECISIONS.md "대화방 v1"): the room model (team rooms follow their group, the
// everyone room, one DM per pair), what a member sees (from their join on; private messages only to their person),
// permissions (members only, admins included; the author is never taken from the request), my own read position and
// badge (no read receipts: nobody is told who has read what), realtime fan-out to members only, notices, room files
// outside the team folder, and the replay check on reconnect.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { RealtimeConn } from '../../server/src/services'
import { Hub } from '../../server/src/realtime/hub'
import { notificationsOf } from '../../server/src/notifications/service'
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
  h = await harness('b-rooms')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id] })
  const hub = new FanoutHub()
  hub.users = ['olga', ada.id, mia.id, nora.id, otto.id]
  h.ctx.services.realtime = hub
  const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as any[]
  const teamRoom = async (c: Client) => (await rooms(c)).find((r) => r.kind === 'team' && r.groupId === group.id)
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  return { owner, ada, mia, nora, otto, group, hub, rooms, teamRoom, send }
}

test('team rooms follow their group, everyone has the everyone room, and the changes are audited', async () => {
  const { owner, mia, nora, otto, group, rooms, teamRoom } = await setup()
  const mine = await rooms(mia.client)
  expect(mine.map((r) => r.kind).sort()).toEqual(['all', 'team'])
  const team = await teamRoom(mia.client)
  expect(team).toMatchObject({ name: 'design', memberCount: 2, unreadCount: 0, lastMessage: null })
  expect((await rooms(otto.client)).map((r) => r.kind)).toEqual(['all'])
  const all = mine.find((r) => r.kind === 'all')
  expect(all.memberCount).toBe(5)
  // otto joins the group, nora leaves it: the room follows at once (afterAccessChange)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, otto.id] })
  expect((await teamRoom(otto.client))?.id).toBe(team.id)
  expect(await teamRoom(nora.client)).toBeUndefined()
  expect((await nora.client.try('GET', `/api/rooms/${team.id}`)).status).toBe(404)
  // a disabled account leaves the rooms at once; enabled again, it is back and sees messages from then on
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'disabled' })
  expect((await mia.client.call('GET', `/api/rooms/${team.id}`)).memberCount).toBe(1)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_members WHERE user_id = ?').get(otto.id)).toEqual({ n: 0 })
  await mia.client.call('POST', `/api/rooms/${team.id}/messages`, { body: 'while otto was away', clientMessageId: cm() })
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'active' })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_members WHERE user_id = ? AND room_id = ?').get(otto.id, team.id)).toEqual({ n: 1 })
  const back = h.client()
  await back.login('otto', otto.password)
  expect((await back.call('GET', `/api/rooms/${team.id}/messages`)).items).toEqual([])
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'disabled' })
  const actions = (h.ctx.db.query("SELECT action FROM audit_log WHERE action LIKE 'room.%'").all() as { action: string }[]).map((r) => r.action)
  expect(actions).toContain('room.create')
  expect(actions).toContain('room.members')
  // a deleted group's room is archived with nobody in it
  await owner.call('DELETE', `/api/admin/groups/${group.id}`)
  expect((h.ctx.db.query('SELECT archived_at FROM rooms WHERE id = ?').get(team.id) as { archived_at: string | null }).archived_at).toBeTruthy()
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ?').get(team.id)).toEqual({ n: 0 })
  expect((await mia.client.try('GET', `/api/rooms/${team.id}/messages`)).status).toBe(404)
})

test('a later member sees the room from their join on, quotes of earlier messages included', async () => {
  const { owner, mia, otto, group, teamRoom, send } = await setup()
  const team = await teamRoom(mia.client)
  const first = await send(mia.client, team.id, 'before otto joined')
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, otto.id] })
  const forOtto = await teamRoom(otto.client)
  expect(forOtto).toMatchObject({ unreadCount: 0, lastMessage: null })
  expect((await otto.client.call('GET', `/api/rooms/${team.id}/messages`)).items).toEqual([])
  const second = await send(mia.client, team.id, 'after', { replyToId: first.id })
  const page = await otto.client.call('GET', `/api/rooms/${team.id}/messages`)
  expect(page.items.map((m: any) => m.id)).toEqual([second.id])
  expect(page.items[0].replyTo).toEqual({ id: first.id, author: null, excerpt: '', fileCount: 0, deleted: true })
  expect(JSON.stringify(page)).not.toContain('before otto joined')
  // otto cannot reply to what he cannot see
  expect((await otto.client.try('POST', `/api/rooms/${team.id}/messages`, { body: 'x', replyToId: first.id, clientMessageId: cm() })).status).toBe(400)
})

test('only members read or send; admins and the owner are no exception; the author comes from the session', async () => {
  const { owner, ada, mia, nora, otto, teamRoom, send } = await setup()
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const msg = await send(mia.client, dm.id, 'between the two of us')
  for (const c of [ada.client, owner, otto.client]) {
    expect((await c.try('GET', `/api/rooms/${dm.id}`)).status).toBe(404)
    expect((await c.try('GET', `/api/rooms/${dm.id}/messages`)).status).toBe(404)
    expect((await c.try('GET', `/api/rooms/${dm.id}/members`)).status).toBe(404)
    expect((await c.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'hi', clientMessageId: cm() })).status).toBe(404)
    expect((await c.try('POST', `/api/rooms/${dm.id}/read`, { seq: 1 })).status).toBe(404)
    expect((await c.try('PATCH', `/api/rooms/${dm.id}`, { muted: true })).status).toBe(404)
    expect((await c.try('DELETE', `/api/rooms/${dm.id}/messages/${msg.id}`)).status).toBe(404)
    expect(JSON.stringify(await c.call('GET', '/api/rooms'))).not.toContain('between the two of us')
  }
  // not a member of the design room either
  const team = await teamRoom(mia.client)
  expect((await otto.client.try('GET', `/api/rooms/${team.id}/messages`)).status).toBe(404)
  // a body that names an author (or anything else) is refused; the message is always the caller's
  for (const extra of [{ author: { id: nora.id, name: 'NORA' } }, { authorId: nora.id }, { authorKind: 'ai' }, { visibility: 'private' }]) {
    const r = await mia.client.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'spoof', clientMessageId: cm(), ...extra })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('validation')
  }
  expect(msg.author).toEqual({ id: mia.id, name: 'MIA' })
  // edit and delete: own messages only
  expect((await nora.client.try('PATCH', `/api/rooms/${dm.id}/messages/${msg.id}`, { body: 'changed' })).status).toBe(403)
  expect((await nora.client.try('DELETE', `/api/rooms/${dm.id}/messages/${msg.id}`)).status).toBe(403)
  const edited = await mia.client.call('PATCH', `/api/rooms/${dm.id}/messages/${msg.id}`, { body: 'changed' })
  expect(edited).toMatchObject({ body: 'changed' })
  expect(edited.editedAt).toBeTruthy()
  expect((await mia.client.try('DELETE', `/api/rooms/${dm.id}/messages/${msg.id}`)).status).toBe(204)
  const after = (await nora.client.call('GET', `/api/rooms/${dm.id}/messages`)).items[0]
  expect(after).toMatchObject({ body: '', deletedAt: expect.any(String), files: [], mentions: [] })
})

test('one DM per pair, from either side; never with oneself or a disabled account', async () => {
  const { owner, mia, nora, otto } = await setup()
  const a = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const b = await nora.client.call('POST', '/api/rooms', { kind: 'dm', userId: mia.id })
  expect(b.id).toBe(a.id)
  expect(a).toMatchObject({ kind: 'dm', name: null, memberCount: 2, peers: [{ id: nora.id, name: 'NORA' }] })
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'dm', userId: mia.id })).status).toBe(400)
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'disabled' })
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'dm', userId: otto.id })).status).toBe(404)
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'group', memberIds: [nora.id] })).status).toBe(400)
  // admins read the audit log: who opened a DM with whom is not in it
  const rows = h.ctx.db.query('SELECT action, target, detail FROM audit_log').all() as { action: string; target: string | null; detail: string | null }[]
  expect(rows.filter((r) => r.target === a.id || (r.detail ?? '').includes(a.id) || (r.detail ?? '').includes('"dm"'))).toEqual([])
})

test('reading: my own position and badge only, forward only; no message says who has not read it', async () => {
  const { owner, mia, nora, otto, group, teamRoom, send } = await setup()
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, otto.id] })
  const team = await teamRoom(mia.client)
  const m1 = await send(mia.client, team.id, 'one')
  const m2 = await send(mia.client, team.id, 'two @NORA', { mentions: [nora.id, 'nobody-here', mia.id] })
  // no read receipts: a message carries no count of readers, before or after anyone read it
  expect(m1).not.toHaveProperty('unread')
  expect(m2.mentions).toEqual([nora.id])
  expect(await teamRoom(nora.client)).toMatchObject({ unreadCount: 2, mentioned: true, lastReadSeq: 0, lastSeq: 2 })
  expect((await teamRoom(mia.client)).unreadCount).toBe(0)
  const before = JSON.stringify((await mia.client.call('GET', `/api/rooms/${team.id}/messages`)).items)
  expect(await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 1 })).toEqual({ lastReadSeq: 1, unreadCount: 1, mentioned: true })
  // what mia gets is the same whoever read what
  expect(JSON.stringify((await mia.client.call('GET', `/api/rooms/${team.id}/messages`)).items)).toBe(before)
  expect(before).not.toContain('"unread"')
  // never back, never past the end
  expect(await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 0 })).toEqual({ lastReadSeq: 1, unreadCount: 1, mentioned: true })
  expect(await otto.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 99 })).toEqual({ lastReadSeq: 2, unreadCount: 0, mentioned: false })
  expect(JSON.stringify((await mia.client.call('GET', `/api/rooms/${team.id}/messages`)).items)).toBe(before)
  // nora answers: sending reads the room up to her message (her own badge), and tells mia nothing about it
  await send(nora.client, team.id, 'three')
  expect((await teamRoom(nora.client)).unreadCount).toBe(0)
  expect(await teamRoom(otto.client)).toMatchObject({ unreadCount: 1, lastReadSeq: 2 })
})

test('a private message (reserved for the AI step) is seen by its one person only and counts for nobody else', async () => {
  const { mia, nora, teamRoom, send } = await setup()
  const team = await teamRoom(mia.client)
  await send(mia.client, team.id, 'visible')
  // the AI step will write these; here the row is put in directly
  const id = newId()
  h.ctx.db.transaction(() => {
    const seq = (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(team.id) as { last_seq: number }).last_seq
    h.ctx.db.query("INSERT INTO room_messages (id, room_id, seq, author_kind, asked_by, visibility, visible_to, body, mentions, created_at) VALUES (?, ?, ?, 'ai', ?, 'private', ?, 'PRIVATE PREVIEW', ?, ?)")
      .run(id, team.id, seq, mia.id, mia.id, JSON.stringify([nora.id]), new Date().toISOString())
  })()
  const forMia = (await mia.client.call('GET', `/api/rooms/${team.id}/messages`)).items
  expect(forMia.map((m: any) => m.body)).toEqual(['visible', 'PRIVATE PREVIEW'])
  expect(forMia[1]).toMatchObject({ authorKind: 'ai', author: null, askedBy: { id: mia.id }, visibility: 'private' })
  const forNora = await nora.client.call('GET', `/api/rooms/${team.id}/messages`)
  expect(JSON.stringify(forNora)).not.toContain('PRIVATE PREVIEW')
  expect(await teamRoom(nora.client)).toMatchObject({ unreadCount: 1, mentioned: false })
  expect((await teamRoom(nora.client)).lastMessage.excerpt).toBe('visible')
  expect(notificationsOf(h.ctx).list(nora.id, {}).items).toHaveLength(0)
})

test('realtime: room events reach the room\'s members only, and a read goes to the reader\'s own windows only', async () => {
  const { ada, mia, nora, otto, hub, send } = await setup()
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  expect(hub.to('room.updated').map((e) => e.target).sort()).toEqual([mia.id, nora.id].sort())
  hub.clear()
  const msg = await send(mia.client, dm.id, 'secret plan')
  const created = hub.to('room.message')
  expect(created.map((e) => e.target).sort()).toEqual([mia.id, nora.id].sort())
  expect((created[0]!.data as any).data.message).toMatchObject({ id: msg.id })
  expect((created[0]!.data as any).data.message).not.toHaveProperty('unread')
  for (const e of hub.events) expect([mia.id, nora.id]).toContain(e.target)
  expect(hub.events.some((e) => [ada.id, otto.id, 'olga'].includes(e.target) && JSON.stringify(e.data).includes('secret plan'))).toBe(false)
  hub.clear()
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: msg.seq })
  // no read receipts: mia is not told that nora read it; nora's own windows get her position and badge
  const reads = hub.to('room.read')
  expect(reads.map((e) => e.target)).toEqual([nora.id])
  expect((reads[0]!.data as any).data).toEqual({ roomId: dm.id, lastReadSeq: 1, unreadCount: 0, mentioned: false })
  expect(hub.events.filter((e) => e.target === mia.id)).toEqual([])
  hub.clear()
  await mia.client.call('PATCH', `/api/rooms/${dm.id}/messages/${msg.id}`, { body: 'new plan' })
  expect(hub.to('room.message.updated').map((e) => e.target).sort()).toEqual([mia.id, nora.id].sort())
})

test('notices: a DM or an @mention, one unread notice of each per room (pushed, never listed in the Inbox); muted rooms are quiet; reading clears them; no text', async () => {
  const { mia, nora, teamRoom, send } = await setup()
  const n = notificationsOf(h.ctx)
  // the room notices a push opens by id (GET /api/notifications/:id); the Inbox's own list leaves them out (the 대화
  // tab's badge is where unread room messages are)
  const notices = (uid: string) => {
    const rows = h.ctx.db.query('SELECT id FROM room_notices WHERE user_id = ? AND suppressed = 0 ORDER BY created_at DESC, id DESC').all(uid) as { id: string }[]
    const items = rows.map((r) => n.get(uid, r.id))
    expect(n.list(uid, {}).items.some((x) => x.code === 'room.dm' || x.code === 'room.mention')).toBe(false)
    return { items, unreadCount: items.filter((x) => x.readAt === null).length }
  }
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  await send(mia.client, dm.id, 'TOP SECRET ONE')
  await send(mia.client, dm.id, 'TOP SECRET TWO')
  let inbox = notices(nora.id)
  expect(inbox.items).toHaveLength(1)
  expect(inbox.items[0]).toMatchObject({ code: 'room.dm', link: 'room', room: { id: dm.id, from: 'MIA' }, chatId: null })
  expect(JSON.stringify(inbox)).not.toContain('TOP SECRET')
  expect(notices(mia.id).items).toHaveLength(0)
  // reading the DM marks it read; the next message is a new notice
  const last = (await nora.client.call('GET', `/api/rooms/${dm.id}`)).lastSeq
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: last })
  expect(notices(nora.id).unreadCount).toBe(0)
  // a team room message notifies only those mentioned, and mentions too come once per unread run
  const team = await teamRoom(mia.client)
  await send(mia.client, team.id, 'for everyone')
  expect(notices(nora.id).unreadCount).toBe(0)
  await send(mia.client, team.id, '@NORA look', { mentions: [nora.id] })
  await send(mia.client, team.id, '@NORA and this', { mentions: [nora.id] })
  inbox = notices(nora.id)
  expect(inbox.unreadCount).toBe(1)
  expect(inbox.items[0]).toMatchObject({ code: 'room.mention', room: { id: team.id } })
  await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 999 })
  expect(notices(nora.id).unreadCount).toBe(0)
  // muted: neither DM messages nor mentions make a notice
  await nora.client.call('PATCH', `/api/rooms/${dm.id}`, { muted: true })
  await nora.client.call('PATCH', `/api/rooms/${team.id}`, { muted: true })
  await send(mia.client, dm.id, 'quiet')
  await send(mia.client, dm.id, '@NORA look', { mentions: [nora.id] })
  await send(mia.client, team.id, '@NORA in the team room', { mentions: [nora.id] })
  expect(notices(nora.id).unreadCount).toBe(0)
  await nora.client.call('PATCH', `/api/rooms/${team.id}`, { muted: false })
  // the person's setting turns room notices off
  n.setPreferences(nora.id, { roomMessages: false })
  await send(mia.client, team.id, '@NORA again', { mentions: [nora.id] })
  expect(notices(nora.id).unreadCount).toBe(0)
  // a deleted message takes its notice with it
  n.setPreferences(nora.id, { roomMessages: true })
  await nora.client.call('PATCH', `/api/rooms/${dm.id}`, { muted: false })
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  const gone = await send(mia.client, dm.id, 'to be deleted')
  expect(notices(nora.id).unreadCount).toBe(1)
  await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${gone.id}`)
  expect(notices(nora.id).unreadCount).toBe(0)
})

test('sending is rate limited per person; a resend of the same message is free', async () => {
  const { mia, nora } = await setup()
  const { SEND_BURST } = await import('../../server/src/rooms/service')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const first = { body: 'one', clientMessageId: cm() }
  for (let i = 0; i < SEND_BURST; i++) await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, i === 0 ? first : { body: `m${i}`, clientMessageId: cm() })
  const over = await mia.client.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'one too many', clientMessageId: cm() })
  expect(over.status).toBe(429)
  expect(over.body.error).toMatchObject({ code: 'rate_limited', retryAfter: expect.any(Number) })
  // the same message again (a reconnect) is answered, not counted
  expect((await mia.client.try('POST', `/api/rooms/${dm.id}/messages`, first)).status).toBe(201)
  // another person has their own budget
  expect((await nora.client.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'hi', clientMessageId: cm() })).status).toBe(201)
})

test('files: kept outside the team folder, readable by the room\'s members only, gone with their message', async () => {
  const { ada, owner, mia, nora, otto } = await setup()
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const form = new FormData()
  form.set('file', new File([new TextEncoder().encode('quarterly numbers')], 'plan.txt', { type: 'text/plain' }))
  const upRes = await h.fetch(`/api/rooms/${dm.id}/files`, { method: 'POST', body: form, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })
  expect(upRes.status).toBe(201)
  const file = await upRes.json()
  expect(file).toMatchObject({ name: 'plan.txt', size: 17, kind: 'text', thumb: false })
  const get = (c: Client, q = '') => h.fetch(`/api/rooms/${dm.id}/files/${file.id}${q}`, { headers: { cookie: c.cookie! } })
  // before it is sent: only the uploader
  expect((await get(mia.client)).status).toBe(200)
  expect((await get(nora.client)).status).toBe(404)
  // another person cannot send someone else's upload
  expect((await nora.client.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'x', fileIds: [file.id], clientMessageId: cm() })).status).toBe(400)
  const msg = await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: '', fileIds: [file.id], clientMessageId: cm() })
  expect(msg.files).toEqual([file])
  const r = await get(nora.client, '?download=1')
  expect(r.status).toBe(200)
  expect(await r.text()).toBe('quarterly numbers')
  for (const c of [ada.client, owner, otto.client]) expect((await get(c)).status).toBe(404)
  // kept in .system/rooms (with the team folder, so in its backups), which no person reaches through the files API,
  // the owner included; and nowhere else in the team folder
  const stored = path.join(h.ctx.config.teamRoot, '.system', 'rooms', dm.id, file.id)
  expect(fs.existsSync(stored)).toBe(true)
  for (const c of [owner, ada.client, mia.client]) {
    expect((await c.try('GET', `/api/files/download?path=${encodeURIComponent(`.system/rooms/${dm.id}/${file.id}`)}`)).status).toBe(404)
  }
  const elsewhere = (dir: string): boolean => fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() ? e.name !== '.system' && elsewhere(path.join(dir, e.name)) : e.name.includes(file.id) || e.name === 'plan.txt')
  expect(elsewhere(h.ctx.config.teamRoot)).toBe(false)
  await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${msg.id}`)
  expect((await get(nora.client)).status).toBe(404)
  expect(fs.existsSync(stored)).toBe(false)
})

test('photos: the place they were taken and the camera are cut out; they stand upright at the size shown', async () => {
  const { exifOrientation } = await import('../../server/src/uploads/metadata')
  const { mia, nora } = await setup()
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const original = fs.readFileSync(path.join(import.meta.dir, '../fixtures/exif/portrait-o6.jpg'))
  expect(original.toString('latin1')).toContain('FixtureCam')
  const form = new FormData()
  form.set('file', new File([original], 'IMG_0001.jpg', { type: 'image/jpeg' }))
  const up = await h.fetch(`/api/rooms/${dm.id}/files`, { method: 'POST', body: form, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })
  expect(up.status).toBe(201)
  const file = await up.json()
  // stored landscape with orientation 6: shown portrait, so the room's box is portrait too
  expect(file).toMatchObject({ kind: 'image', width: 48, height: 64 })
  await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: '', fileIds: [file.id], clientMessageId: cm() })
  const got = new Uint8Array(await (await h.fetch(`/api/rooms/${dm.id}/files/${file.id}?download=1`, { headers: { cookie: nora.client.cookie! } })).arrayBuffer())
  const text = Buffer.from(got).toString('latin1')
  for (const leak of ['FixtureCam', 'Fixture Phone', 'FIXTURE-COMMENT', 'xmpmeta', '\x88\x25']) expect({ leak, in: text.includes(leak) }).toEqual({ leak, in: false })
  expect(exifOrientation(got)).toBe(6)
  expect(file.size).toBe(got.length)
  // a TIFF (it can carry GPS like any camera EXIF, and is not cleaned) goes as a plain file: no preview, no thumbnail
  const tif = new FormData()
  tif.set('file', new File([fs.readFileSync(path.join(import.meta.dir, '../fixtures/exif/photo-gps.tif'))], 'scan.tif', { type: 'image/tiff' }))
  const tifRes = await h.fetch(`/api/rooms/${dm.id}/files`, { method: 'POST', body: tif, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })
  expect(tifRes.status).toBe(201)
  expect(await tifRes.json()).toMatchObject({ name: 'scan.tif', kind: 'other', thumb: false })
  // a file that only claims to be a photo is refused with a reason, and nothing is kept
  const bad = new FormData()
  bad.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0])], 'broken.jpg', { type: 'image/jpeg' }))
  const no = await h.fetch(`/api/rooms/${dm.id}/files`, { method: 'POST', body: bad, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })
  expect(no.status).toBe(400)
})

test('backups: room files are in the team archive and come back with a restore; rows and files match after it', async () => {
  const { mia, nora } = await setup()
  const { BackupManager } = await import('../../server/src/system/backup')
  const { resolveLayout } = await import('../../server/src/system/layout')
  const { roomFilesOf } = await import('../../server/src/rooms/files')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const upload = async (name: string, text: string) => {
    const form = new FormData()
    form.set('file', new File([new TextEncoder().encode(text)], name, { type: 'text/plain' }))
    const r = await h.fetch(`/api/rooms/${dm.id}/files`, { method: 'POST', body: form, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })
    const f = await r.json()
    const m = await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: name, fileIds: [f.id], clientMessageId: cm() })
    return { file: f, msg: m }
  }
  const a = await upload('a.txt', 'first file')
  const layout = resolveLayout(h.ctx.config)
  const mgr = new BackupManager({ db: h.ctx.db, dbFile: path.join(h.ctx.config.dataDir, 'app.db'), layout, log: h.ctx.log, version: '0.0.0' })
  const meta = await mgr.run({ kind: 'manual', scope: 'full' })
  const manifest = JSON.parse(fs.readFileSync(path.join(mgr.teamDir(meta.id), 'manifest.json'), 'utf8')) as Record<string, unknown>
  expect(Object.keys(manifest)).toContain(`.system/rooms/${dm.id}/${a.file.id}`)
  // the team folder rebuilt from the backup holds the room file, byte for byte
  const dest = path.join(h.ctx.config.dataDir, 'restored-team')
  await mgr.restoreTeamTo(meta.id, dest)
  expect(fs.readFileSync(path.join(dest, '.system', 'rooms', dm.id, a.file.id), 'utf8')).toBe('first file')
  // after the backup: a new file, and the first message deleted (its file goes)
  const b = await upload('b.txt', 'second file')
  await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${a.msg.id}`)
  // the database of the backup comes back (Admin › Backups): it has a's row and not b's. Put the rows that way.
  const old = (await import('bun:sqlite')).Database
  const copy = new old(mgr.dbFileOf(meta.id)!, { readonly: true })
  const aRow = copy.query('SELECT * FROM room_files WHERE id = ?').get(a.file.id) as Record<string, string | number | null>
  copy.close()
  h.ctx.db.query(`INSERT INTO room_files (${Object.keys(aRow).join(', ')}) VALUES (${Object.keys(aRow).map(() => '?').join(', ')})`).run(...Object.values(aRow))
  h.ctx.db.query('DELETE FROM room_files WHERE id = ?').run(b.file.id)
  const sys = path.join(h.ctx.config.teamRoot, '.system')
  const r = roomFilesOf(h.ctx).reconcile()
  // a's row stays (its file is gone: 404, counted only); b's file is set aside, not deleted
  expect(r).toMatchObject({ missingFiles: 1, orphansMoved: 1 })
  expect(h.ctx.db.query('SELECT id FROM room_files WHERE id = ?').get(a.file.id)).toEqual({ id: a.file.id })
  expect((await h.fetch(`/api/rooms/${dm.id}/files/${a.file.id}`, { headers: { cookie: nora.client.cookie! } })).status).toBe(404)
  expect(fs.existsSync(path.join(sys, 'rooms', dm.id, b.file.id))).toBe(false)
  const [batch] = fs.readdirSync(path.join(sys, 'rooms-orphans'))
  expect(fs.readFileSync(path.join(sys, 'rooms-orphans', batch!, dm.id, b.file.id), 'utf8')).toBe('second file')
  expect(batch).toMatch(/^\d{8}T\d{6}Z-\d+-0$/)
  // a second start changes nothing more; a clock earlier than the newest room file purges nothing; after 30 days (by the
  // name and the folder's time) the set-aside batch goes
  expect(roomFilesOf(h.ctx).reconcile()).toMatchObject({ orphansMoved: 0, orphanBatchesPurged: 0 })
  expect(roomFilesOf(h.ctx).reconcile(Date.now() - 86400_000)).toMatchObject({ orphanBatchesPurged: 0 })
  // a name 40 days old on a folder made now (a clock that was wrong when it was made) is not enough either
  const aged = new Date(Date.now() - 40 * 86400_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-1-0'
  fs.renameSync(path.join(sys, 'rooms-orphans', batch!), path.join(sys, 'rooms-orphans', aged))
  expect(roomFilesOf(h.ctx).reconcile()).toMatchObject({ orphanBatchesPurged: 0 })
  expect(roomFilesOf(h.ctx).reconcile(Date.now() + 31 * 86400_000)).toMatchObject({ orphanBatchesPurged: 1 })
  expect(fs.readdirSync(path.join(sys, 'rooms-orphans'))).toEqual([])
  // the folder missing (a share not mounted yet) or unreadable: nothing is touched
  const c = await upload('c.txt', 'third file')
  fs.renameSync(path.join(sys, 'rooms'), path.join(sys, 'rooms-away'))
  expect(roomFilesOf(h.ctx).reconcile()).toMatchObject({ skipped: true, orphansMoved: 0 })
  fs.renameSync(path.join(sys, 'rooms-away'), path.join(sys, 'rooms'))
  fs.chmodSync(path.join(sys, 'rooms'), 0o000)
  try { expect(roomFilesOf(h.ctx).reconcile()).toMatchObject({ skipped: true }) } finally { fs.chmodSync(path.join(sys, 'rooms'), 0o700) }
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_files').get()).toEqual({ n: 2 })
  // files of the first layout (<data dir>/rooms) move to the team folder file by file; a copy cut short is not kept
  fs.mkdirSync(path.join(h.ctx.config.dataDir, 'rooms'), { recursive: true })
  fs.renameSync(path.join(sys, 'rooms', dm.id), path.join(h.ctx.config.dataDir, 'rooms', dm.id))
  fs.mkdirSync(path.join(sys, 'rooms', dm.id), { recursive: true })
  fs.writeFileSync(path.join(sys, 'rooms', dm.id, `${c.file.id}.moving`), 'half')
  expect(roomFilesOf(h.ctx).reconcile()).toMatchObject({ movedFiles: 1, orphansMoved: 0 })
  expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'rooms'))).toBe(false)
  expect(fs.readdirSync(path.join(sys, 'rooms', dm.id))).toEqual([c.file.id])
  const got = await h.fetch(`/api/rooms/${dm.id}/files/${c.file.id}`, { headers: { cookie: nora.client.cookie! } })
  expect(await got.text()).toBe('third file')
})

test('replay after a reconnect: room events are replayed only while the person is still in the room', async () => {
  const { owner, mia, nora, group, teamRoom } = await setup()
  const team = await teamRoom(nora.client)
  const hub = new Hub(h.ctx)
  h.ctx.services.realtime = hub
  try {
    const frames: any[] = []
    const conn = (): RealtimeConn => ({ send(d) { frames.push(JSON.parse(d)) }, close() {}, bufferedAmount: () => 0, ping() {}, onMessage() {}, onClose() {} })
    const open = (q: string) => hub.attach(conn(), new Request(`http://team.localhost/api/ws?windowId=win-nora-0001${q}`, { headers: { cookie: nora.client.cookie!, origin: 'http://team.localhost' } }), { ip: null, via: 'test' })
    await open('')
    const hello = frames.find((f) => f.type === 'hello')
    await mia.client.call('POST', `/api/rooms/${team.id}/messages`, { body: 'design review notes', clientMessageId: cm() })
    // still a member: replayed
    frames.length = 0
    await open(`&epoch=${hello.epoch}&after=${hello.seq}`)
    expect(frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(JSON.stringify(frames)).toContain('design review notes')
    // removed from the group: the same resume is a resync, with nothing from the room
    await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id] })
    frames.length = 0
    await open(`&epoch=${hello.epoch}&after=${hello.seq}`)
    expect(frames.some((f) => f.type === 'resync')).toBe(true)
    expect(JSON.stringify(frames)).not.toContain('design review notes')
  } finally { hub.close() }
})

test('push: a room notice goes out through the push service with ids and an event code only', async () => {
  const { mia, nora, send } = await setup()
  const { PushService } = await import('../../server/src/notifications/push-service')
  const crypto = await import('node:crypto')
  const e = crypto.createECDH('prime256v1'); e.generateKeys()
  const keys = { publicKey: e.getPublicKey().toString('base64url'), privateKey: e.getPrivateKey().toString('base64url') }
  const sent: any[] = []
  let now = Date.now()
  const p = new PushService(h.ctx, { config: () => ({ enabled: true, subject: 'mailto:push@example.test', ...keys }), now: () => now, transport: async (i) => { sent.push(i.payload); return { statusCode: 201 } } })
  try {
    const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC').get(nora.id) as { id: string }).id
    const k = crypto.createECDH('prime256v1'); k.generateKeys()
    const sub = p.subscribe(nora.id, sid, { consent: true, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-room', keys: { p256dh: k.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
    now += 10
    const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
    await send(mia.client, dm.id, 'LOCK SCREEN MUST NOT SHOW THIS')
    now = Date.now() + 20
    await p.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ subscriptionId: sub.id, code: 'room.dm' })
    expect(Object.keys(sent[0]).sort()).toEqual(['code', 'notificationId', 'subscriptionId'])
    expect(JSON.stringify(sent)).not.toContain('LOCK SCREEN')
    expect(p.settings(nora.id, sid).messages?.bodies['room.dm']).toBeTruthy()
    // read before it went out: nothing is sent
    await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 99 })
    await send(mia.client, dm.id, 'second run')
    await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 99 })
    now = Date.now() + 40
    await p.tick()
    expect(sent).toHaveLength(1)
  } finally { await p.stop() }
})

test('push: room notices and the other notices reach Web Push and phones alike; a phone opens the room', async () => {
  const { mia, nora, otto, send } = await setup()
  const { PushService } = await import('../../server/src/notifications/push-service')
  const crypto = await import('node:crypto')
  const e = crypto.createECDH('prime256v1'); e.generateKeys()
  const keys = { publicKey: e.getPublicKey().toString('base64url'), privateKey: e.getPrivateKey().toString('base64url') }
  const web: any[] = [], phone: any[] = []
  let now = Date.now()
  const p = new PushService(h.ctx, { config: () => ({ enabled: true, subject: 'mailto:push@example.test', ...keys }), native: () => ({ url: 'https://push.example.test' }), now: () => now,
    transport: async (i) => { web.push(i.payload); return { statusCode: 201 } }, nativeTransport: async (i) => { phone.push(i.payload); return { statusCode: 200 } } })
  try {
    const sid = (userId: string) => (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC').get(userId) as { id: string }).id
    const k = crypto.createECDH('prime256v1'); k.generateKeys()
    const sub = p.subscribe(nora.id, sid(nora.id), { consent: true, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-room-web', keys: { p256dh: k.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
    const device = p.registerDevice(otto.id, sid(otto.id), { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex') })
    now += 10
    const toNora = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
    const toOtto = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: otto.id })
    await send(mia.client, toNora.id, 'LOCK SCREEN MUST NOT SHOW THIS')
    await send(mia.client, toOtto.id, 'LOCK SCREEN MUST NOT SHOW THIS')
    notificationsOf(h.ctx).connectionReconnect(otto.id, 'reconnect-1', new Date(now).toISOString())
    now = Date.now() + 20
    await p.tick(); await p.tick()
    expect(web).toEqual([{ notificationId: expect.any(String), subscriptionId: sub.id, code: 'room.dm' }])
    expect(phone).toHaveLength(2)
    // ids, the event code, the language, the device tag and an id path: never names or text
    expect(phone.find((x) => x.code === 'room.dm')).toEqual({ notificationId: expect.any(String), code: 'room.dm', locale: expect.any(String), tag: device.id, path: `/rooms/${toOtto.id}` })
    expect(phone.find((x) => x.code === 'connection.reconnect')).toEqual({ notificationId: expect.any(String), code: 'connection.reconnect', locale: expect.any(String), tag: device.id, path: '/settings/notifications' })
    expect(JSON.stringify([web, phone])).not.toContain('LOCK SCREEN')
    expect(h.ctx.db.query('SELECT state FROM room_push_deliveries WHERE subscription_id = ?').all(device.id)).toEqual([{ state: 'sent' }])
    expect(h.ctx.db.query('SELECT state FROM push_deliveries WHERE subscription_id = ?').all(device.id)).toEqual([{ state: 'sent' }])
    // the room setting off: no phone push for a room notice, the other notices still go
    await otto.client.call('PATCH', '/api/notification-preferences', { roomMessages: false })
    await otto.client.call('POST', `/api/rooms/${toOtto.id}/read`, { seq: 99 })
    await send(mia.client, toOtto.id, 'muted run')
    now = Date.now() + 40
    await p.tick()
    expect(phone).toHaveLength(2)
  } finally { await p.stop() }
})
