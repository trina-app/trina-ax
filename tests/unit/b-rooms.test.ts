// Team chat rooms ("대화방" v1, docs/DECISIONS.md "대화방 v1"): the room model (team rooms follow their group, the
// everyone room, one DM per pair), what a member sees (from their join on; private messages only to their person),
// permissions (members only, admins included; the author is never taken from the request), KakaoTalk's unread count,
// realtime fan-out to members only, notices, room files outside the team folder, and the replay check on reconnect.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { RealtimeConn } from '../../server/src/services'
import { Hub } from '../../server/src/realtime/hub'
import { notificationsOf } from '../../server/src/notifications/service'
import { roomsOf } from '../../server/src/rooms/service'
import { unreadOf } from '../../server/src/rooms/store'
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
  // a disabled account leaves the rooms
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'disabled' })
  roomsOf(h.ctx).sync()
  expect((await mia.client.call('GET', `/api/rooms/${team.id}`)).memberCount).toBe(1)
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

test('unread: each message counts the members who have not read it; reads move forward only', async () => {
  const { owner, mia, nora, otto, group, teamRoom, send } = await setup()
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, otto.id] })
  const team = await teamRoom(mia.client)
  const m1 = await send(mia.client, team.id, 'one')
  const m2 = await send(mia.client, team.id, 'two @NORA', { mentions: [nora.id, 'nobody-here', mia.id] })
  expect(m1.unread).toBe(2)
  expect(m2.mentions).toEqual([nora.id])
  expect(await teamRoom(nora.client)).toMatchObject({ unreadCount: 2, mentioned: true, lastReadSeq: 0, lastSeq: 2 })
  expect((await teamRoom(mia.client)).unreadCount).toBe(0)
  expect(await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 1 })).toEqual({ lastReadSeq: 1, unreadCount: 1 })
  let page = (await mia.client.call('GET', `/api/rooms/${team.id}/messages`)).items
  expect(page.map((m: any) => m.unread)).toEqual([1, 2])
  // never back, never past the end
  expect(await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 0 })).toEqual({ lastReadSeq: 1, unreadCount: 1 })
  expect(await otto.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 99 })).toEqual({ lastReadSeq: 2, unreadCount: 0 })
  page = (await mia.client.call('GET', `/api/rooms/${team.id}/messages`)).items
  expect(page.map((m: any) => m.unread)).toEqual([0, 1])
  // nora answers: sending reads the room up to her message
  const m3 = await send(nora.client, team.id, 'three')
  expect(m3.unread).toBe(2)
  page = (await mia.client.call('GET', `/api/rooms/${team.id}/messages`)).items
  expect(page.map((m: any) => m.unread)).toEqual([0, 0, 2])
  // the count rule itself
  expect(unreadOf({ seq: 5, visibility: 'room', deleted_at: null }, [{ last_read_seq: 4, visible_from_seq: 0 }, { last_read_seq: 5, visible_from_seq: 0 }, { last_read_seq: 5, visible_from_seq: 5 }, { last_read_seq: 0, visible_from_seq: 6 }])).toBe(1)
  expect(unreadOf({ seq: 5, visibility: 'private', deleted_at: null }, [{ last_read_seq: 0, visible_from_seq: 0 }])).toBe(0)
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
  expect(forMia[1]).toMatchObject({ authorKind: 'ai', author: null, askedBy: { id: mia.id }, visibility: 'private', unread: 0 })
  const forNora = await nora.client.call('GET', `/api/rooms/${team.id}/messages`)
  expect(JSON.stringify(forNora)).not.toContain('PRIVATE PREVIEW')
  expect(await teamRoom(nora.client)).toMatchObject({ unreadCount: 1, mentioned: false })
  expect((await teamRoom(nora.client)).lastMessage.excerpt).toBe('visible')
  expect(notificationsOf(h.ctx).list(nora.id, {}).items).toHaveLength(0)
})

test('realtime: room events reach the room\'s members only, and a read names nobody', async () => {
  const { ada, mia, nora, otto, hub, send } = await setup()
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  expect(hub.to('room.updated').map((e) => e.target).sort()).toEqual([mia.id, nora.id].sort())
  hub.clear()
  const msg = await send(mia.client, dm.id, 'secret plan')
  const created = hub.to('room.message')
  expect(created.map((e) => e.target).sort()).toEqual([mia.id, nora.id].sort())
  expect((created[0]!.data as any).data.message).toMatchObject({ id: msg.id, unread: 1 })
  for (const e of hub.events) expect([mia.id, nora.id]).toContain(e.target)
  expect(hub.events.some((e) => [ada.id, otto.id, 'olga'].includes(e.target) && JSON.stringify(e.data).includes('secret plan'))).toBe(false)
  hub.clear()
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: msg.seq })
  const reads = hub.to('room.read')
  expect(reads.map((e) => [e.target, (e.data as any).data.mine]).sort()).toEqual([[mia.id, false], [nora.id, true]].sort())
  expect((reads[0]!.data as any).data).toEqual({ roomId: dm.id, fromSeq: 0, toSeq: 1, mine: expect.any(Boolean) })
  hub.clear()
  await mia.client.call('PATCH', `/api/rooms/${dm.id}/messages/${msg.id}`, { body: 'new plan' })
  expect(hub.to('room.message.updated').map((e) => e.target).sort()).toEqual([mia.id, nora.id].sort())
})

test('notices: a DM or an @mention, one unread notice of each per room; muted rooms are quiet; reading clears them; no text', async () => {
  const { mia, nora, teamRoom, send } = await setup()
  const n = notificationsOf(h.ctx)
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  await send(mia.client, dm.id, 'TOP SECRET ONE')
  await send(mia.client, dm.id, 'TOP SECRET TWO')
  let inbox = n.list(nora.id, {})
  expect(inbox.items).toHaveLength(1)
  expect(inbox.items[0]).toMatchObject({ code: 'room.dm', link: 'room', room: { id: dm.id, from: 'MIA' }, chatId: null })
  expect(JSON.stringify(inbox)).not.toContain('TOP SECRET')
  expect(n.list(mia.id, {}).items).toHaveLength(0)
  // reading the DM marks it read; the next message is a new notice
  const last = (await nora.client.call('GET', `/api/rooms/${dm.id}`)).lastSeq
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: last })
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
  // a team room message notifies only those mentioned, and mentions too come once per unread run
  const team = await teamRoom(mia.client)
  await send(mia.client, team.id, 'for everyone')
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
  await send(mia.client, team.id, '@NORA look', { mentions: [nora.id] })
  await send(mia.client, team.id, '@NORA and this', { mentions: [nora.id] })
  inbox = n.list(nora.id, {})
  expect(inbox.unreadCount).toBe(1)
  expect(inbox.items[0]).toMatchObject({ code: 'room.mention', room: { id: team.id } })
  await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 999 })
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
  // muted: neither DM messages nor mentions make a notice
  await nora.client.call('PATCH', `/api/rooms/${dm.id}`, { muted: true })
  await nora.client.call('PATCH', `/api/rooms/${team.id}`, { muted: true })
  await send(mia.client, dm.id, 'quiet')
  await send(mia.client, dm.id, '@NORA look', { mentions: [nora.id] })
  await send(mia.client, team.id, '@NORA in the team room', { mentions: [nora.id] })
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
  await nora.client.call('PATCH', `/api/rooms/${team.id}`, { muted: false })
  // the person's setting turns room notices off
  n.setPreferences(nora.id, { roomMessages: false })
  await send(mia.client, team.id, '@NORA again', { mentions: [nora.id] })
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
  // a deleted message takes its notice with it
  n.setPreferences(nora.id, { roomMessages: true })
  await nora.client.call('PATCH', `/api/rooms/${dm.id}`, { muted: false })
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  const gone = await send(mia.client, dm.id, 'to be deleted')
  expect(n.list(nora.id, {}).unreadCount).toBe(1)
  await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${gone.id}`)
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
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
  const r = roomFilesOf(h.ctx).reconcile()
  expect(r).toMatchObject({ rowsRemoved: 1, filesRemoved: 1 })
  expect(h.ctx.db.query('SELECT id FROM room_files WHERE id IN (?, ?)').all(a.file.id, b.file.id)).toEqual([])
  expect(fs.existsSync(path.join(h.ctx.config.teamRoot, '.system', 'rooms', dm.id, b.file.id))).toBe(false)
  // files of the first layout (<data dir>/rooms) move to the team folder at the next start
  const c = await upload('c.txt', 'third file')
  fs.mkdirSync(path.join(h.ctx.config.dataDir, 'rooms'), { recursive: true })
  fs.renameSync(path.join(h.ctx.config.teamRoot, '.system', 'rooms', dm.id), path.join(h.ctx.config.dataDir, 'rooms', dm.id))
  expect(roomFilesOf(h.ctx).reconcile()).toMatchObject({ movedRooms: 1, rowsRemoved: 0 })
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
