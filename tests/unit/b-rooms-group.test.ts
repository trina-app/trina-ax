// Group chats and room names (docs/DECISIONS.md "그룹 대화와 방 이름"): a group chat of hand-picked people (made from the
// new-chat picker, any member invites or leaves, the manager or an owner/admin in it takes someone out, the last one
// out archives it), names for rooms (who may set one), and event lines (a seq in the room, counted nowhere, never the
// AI's). Members only, as every room: anyone else gets 404, a member without the right 403, a bad body 400.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ROOM_GROUP_MAX, ROOM_NAME_MAX } from '@mycel/shared/api'
import { notificationsOf } from '../../server/src/notifications/service'
import { GROUPS_PER_HOUR, roomsOf } from '../../server/src/rooms/service'
import { Hub } from '../../server/src/realtime/hub'
import type { RealtimeConn } from '../../server/src/services'
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
  h = await harness('b-rooms-group')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id] })
  const hub = new FanoutHub()
  hub.users = ['olga', ada.id, mia.id, nora.id, otto.id, pia.id]
  h.ctx.services.realtime = hub
  const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as any[]
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const messages = async (c: Client, roomId: string) => (await c.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]
  const makeGroup = (c: Client, userIds: string[], name?: string | null) => c.call('POST', '/api/rooms', { kind: 'group', userIds, ...(name !== undefined ? { name } : {}) })
  return { owner, ada, mia, nora, otto, pia, group, hub, rooms, send, messages, makeGroup }
}

test('a group chat: me and two or more active people; named or not; several with the same people; not audited', async () => {
  const { owner, mia, nora, otto, pia, rooms, messages, makeGroup, hub } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id, nora.id, mia.id])
  expect(g).toMatchObject({ kind: 'group', name: null, memberCount: 3, canRename: true, managerId: mia.id, groupId: null, unreadCount: 0, lastMessage: null })
  expect(g.peers.map((p: any) => p.id).sort()).toEqual([nora.id, otto.id].sort())
  // everyone in it got it at once, nobody else
  expect(hub.to('room.updated').map((e) => e.target).sort()).toEqual([mia.id, nora.id, otto.id].sort())
  // its first line says who made it with whom; it is no message (nothing unread, no list line)
  const lines = await messages(nora.client, g.id)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ seq: 1, author: { id: mia.id }, body: '', event: { type: 'created' } })
  expect(lines[0].event.users.map((u: any) => u.id).sort()).toEqual([nora.id, otto.id].sort())
  expect((await rooms(nora.client)).find((r) => r.id === g.id)).toMatchObject({ unreadCount: 0, lastMessage: null })
  // a second one with the same people is a new room; a name is kept as typed (trimmed)
  const named = await makeGroup(mia.client, [nora.id, otto.id], '  Launch 회의  ')
  expect(named.id).not.toBe(g.id)
  expect(named.name).toBe('Launch 회의')
  // one other person is a DM, not a group chat; myself only or nobody: refused
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id] })).status).toBe(400)
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, mia.id] })).status).toBe(400)
  // only active people of this team, refused the same way whatever is wrong with the id
  await owner.call('PATCH', `/api/admin/users/${pia.id}`, { status: 'disabled' })
  const disabled = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, pia.id] })
  const unknown = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, 'nobody-here'] })
  expect(disabled.status).toBe(400)
  expect(unknown.status).toBe(400)
  const same = (e: any) => ({ ...e, requestId: undefined })
  expect(same(disabled.body.error)).toEqual(same(unknown.body.error))
  // a body that names more than it should is refused (strict)
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], createdBy: nora.id })).status).toBe(400)
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'a‮b' })).status).toBe(400)
  // admins read the audit log: group chats are not in it (who talks to whom)
  const audit = h.ctx.db.query('SELECT action, target, detail FROM audit_log').all() as { action: string; target: string | null; detail: string | null }[]
  expect(audit.filter((r) => [g.id, named.id].includes(r.target ?? '') || [g.id, named.id].some((id) => (r.detail ?? '').includes(id)) || (r.detail ?? '').includes('"group"'))).toEqual([])
})

test(`a group chat holds at most ${ROOM_GROUP_MAX} people`, async () => {
  const { mia, nora, otto, makeGroup } = await setup()
  const ids: string[] = []
  const add = h.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')")
  for (let i = 0; i < ROOM_GROUP_MAX; i++) { const id = `p${i}`; add.run(id, id, `Person ${i}`); ids.push(id) }
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: ids })).status).toBe(400)
  const full = await makeGroup(mia.client, ids.slice(0, ROOM_GROUP_MAX - 1))
  expect(full.memberCount).toBe(ROOM_GROUP_MAX)
  const over = await mia.client.try('POST', `/api/rooms/${full.id}/members`, { userIds: [nora.id] })
  expect(over.status).toBe(400)
  const small = await makeGroup(mia.client, [nora.id, otto.id])
  expect((await mia.client.try('POST', `/api/rooms/${small.id}/members`, { userIds: ids.slice(0, ROOM_GROUP_MAX - 3) })).status).toBe(200)
  expect((await mia.client.try('POST', `/api/rooms/${small.id}/members`, { userIds: [ids.at(-1)!] })).status).toBe(400)
})

test('invite: any member adds active people, who see the room from their join on (messages, quotes, files, AI answers)', async () => {
  const { owner, ada, mia, nora, otto, pia, group, rooms, send, messages, makeGroup, hub } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id])
  const before = await send(mia.client, g.id, 'BEFORE-PIA secret plan')
  // a file and an AI answer from before (the AI writes it; put in directly here)
  const form = new FormData()
  form.set('file', new File([new TextEncoder().encode('numbers')], 'plan.txt', { type: 'text/plain' }))
  const up = await (await h.fetch(`/api/rooms/${g.id}/files`, { method: 'POST', body: form, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })).json()
  await send(mia.client, g.id, '', { fileIds: [up.id] })
  const aiId = newId()
  h.ctx.db.transaction(() => {
    const seq = (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(g.id) as { last_seq: number }).last_seq
    h.ctx.db.query("INSERT INTO room_messages (id, room_id, seq, author_kind, asked_by, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'ai', ?, 'room', 'AI-BEFORE answer', '[]', ?)").run(aiId, g.id, seq, mia.id, new Date().toISOString())
  })()
  // not a member: 404 (the room's existence is not told), the owner and admins included
  for (const c of [pia.client, owner, ada.client]) expect((await c.try('POST', `/api/rooms/${g.id}/members`, { userIds: [pia.id] })).status).toBe(404)
  // only active people, refused alike
  await owner.call('PATCH', `/api/admin/users/${ada.id}`, { status: 'disabled' })
  const off = await nora.client.try('POST', `/api/rooms/${g.id}/members`, { userIds: [ada.id] })
  const none = await nora.client.try('POST', `/api/rooms/${g.id}/members`, { userIds: ['nobody-here'] })
  expect([off.status, none.status]).toEqual([400, 400])
  expect({ ...off.body.error, requestId: undefined }).toEqual({ ...none.body.error, requestId: undefined })
  hub.clear()
  // nora (not its maker) invites pia
  const after = await nora.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [pia.id, otto.id] })
  expect(after.memberCount).toBe(4)
  expect(hub.to('room.updated').filter((e) => (e.data as any).data.change === 'added').map((e) => e.target)).toEqual([pia.id])
  expect(hub.to('room.updated').filter((e) => (e.data as any).data.change === 'members').map((e) => e.target).sort()).toEqual([mia.id, nora.id, otto.id].sort())
  // the invite line reaches everyone in it, pia too; nothing from before reaches her
  expect(hub.to('room.message').map((e) => e.target).sort()).toEqual([mia.id, nora.id, otto.id, pia.id].sort())
  expect(JSON.stringify(hub.events.filter((e) => e.target === pia.id))).not.toMatch(/BEFORE-PIA|AI-BEFORE/)
  const forPia = await messages(pia.client, g.id)
  expect(forPia).toHaveLength(1)
  expect(forPia[0]).toMatchObject({ author: { id: nora.id }, event: { type: 'added', users: [{ id: pia.id }] } })
  expect(JSON.stringify(forPia)).not.toMatch(/BEFORE-PIA|AI-BEFORE/)
  expect((await rooms(pia.client)).find((r) => r.id === g.id)).toMatchObject({ unreadCount: 0, lastMessage: null })
  // her quote of the earlier message is refused, and a reply to it shows nothing of it
  expect((await pia.client.try('POST', `/api/rooms/${g.id}/messages`, { body: 'x', replyToId: before.id, clientMessageId: cm() })).status).toBe(400)
  const reply = await send(mia.client, g.id, 'about that', { replyToId: before.id })
  expect((await messages(pia.client, g.id)).find((m) => m.id === reply.id).replyTo).toEqual({ id: before.id, author: null, excerpt: '', fileCount: 0, deleted: true })
  // the file sent before she joined: 404 for her, as for anyone outside
  expect((await h.fetch(`/api/rooms/${g.id}/files/${up.id}`, { headers: { cookie: pia.client.cookie! } })).status).toBe(404)
  expect((await h.fetch(`/api/rooms/${g.id}/files/${up.id}`, { headers: { cookie: otto.client.cookie! } })).status).toBe(200)
  // the AI answer from before: not hers to read or to ask the sources of
  expect((await pia.client.try('GET', `/api/rooms/${g.id}/messages/${aiId}/sources`)).status).toBeGreaterThanOrEqual(400)
  // already in it: nothing happens, no line
  const last = (await mia.client.call('GET', `/api/rooms/${g.id}`)).lastSeq
  await mia.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [pia.id] })
  expect((await mia.client.call('GET', `/api/rooms/${g.id}`)).lastSeq).toBe(last)
  // a team room follows its group and the everyone room the team, a DM keeps its two: 403 for their members
  const team = (await rooms(mia.client)).find((r) => r.kind === 'team' && r.groupId === group.id)
  const all = (await rooms(mia.client)).find((r) => r.kind === 'all')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  for (const id of [team.id, all.id, dm.id]) expect((await mia.client.try('POST', `/api/rooms/${id}/members`, { userIds: [otto.id] })).status).toBe(403)
  expect((await mia.client.try('POST', `/api/rooms/${g.id}/members`, { userIds: [] })).status).toBe(400)
})

test('leave: any member of a group chat; the room goes from all my windows; the last one out archives it', async () => {
  const { owner, mia, nora, otto, group, rooms, messages, makeGroup, hub, send } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id])
  await send(nora.client, g.id, '@MIA hi', { mentions: [mia.id] })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE user_id = ? AND room_id = ?').get(mia.id, g.id)).toEqual({ n: 1 })
  hub.clear()
  expect((await mia.client.try('POST', `/api/rooms/${g.id}/leave`)).status).toBe(204)
  // gone for her: the list, the room, its messages, her notices; her windows drop it and their replay buffer
  expect((await rooms(mia.client)).some((r) => r.id === g.id)).toBe(false)
  expect((await mia.client.try('GET', `/api/rooms/${g.id}/messages`)).status).toBe(404)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE user_id = ? AND room_id = ?').get(mia.id, g.id)).toEqual({ n: 0 })
  expect(hub.forgotten).toContain(mia.id)
  expect(hub.events.filter((e) => e.target === mia.id).map((e) => (e.data as any).data)).toEqual([{ roomId: g.id, change: 'removed', room: null }])
  // the others see the line, and the next manager (the one who joined first, then by id)
  const lines = (await messages(nora.client, g.id)).filter((m) => m.event)
  expect(lines.at(-1)).toMatchObject({ author: { id: mia.id }, event: { type: 'left' } })
  expect((await nora.client.call('GET', `/api/rooms/${g.id}`)).managerId).toBe([nora.id, otto.id].sort()[0])
  // a team room, the everyone room, a DM: not left like that (403); not in it: 404
  const team = (await rooms(nora.client)).find((r) => r.kind === 'team' && r.groupId === group.id)
  const dm = await nora.client.call('POST', '/api/rooms', { kind: 'dm', userId: otto.id })
  for (const id of [team.id, dm.id]) expect((await nora.client.try('POST', `/api/rooms/${id}/leave`)).status).toBe(403)
  expect((await mia.client.try('POST', `/api/rooms/${g.id}/leave`)).status).toBe(404)
  expect((await owner.try('POST', `/api/rooms/${g.id}/leave`)).status).toBe(404)
  await nora.client.call('POST', `/api/rooms/${g.id}/leave`)
  await otto.client.call('POST', `/api/rooms/${g.id}/leave`)
  expect((h.ctx.db.query('SELECT archived_at FROM rooms WHERE id = ?').get(g.id) as { archived_at: string | null }).archived_at).toBeTruthy()
  // inviting back into an archived room is not possible: nobody is in it
  expect((await otto.client.try('POST', `/api/rooms/${g.id}/members`, { userIds: [mia.id] })).status).toBe(404)
})

test('remove: the manager, or an owner or admin in it, takes someone out (never themselves); nobody else', async () => {
  const { owner, ada, mia, nora, otto, pia, messages, makeGroup, hub, send } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id, pia.id])
  const del = (c: Client, who: string) => c.try('DELETE', `/api/rooms/${g.id}/members/${who}`)
  // a plain member: 403, the manager included as a target
  expect((await del(nora.client, otto.id)).status).toBe(403)
  expect((await del(nora.client, mia.id)).status).toBe(403)
  // not in it: 404, the owner and admins included
  for (const c of [owner, ada.client]) expect((await del(c, otto.id)).status).toBe(404)
  // the manager: not themselves (that is leaving); someone not in it: 404
  expect((await del(mia.client, mia.id)).status).toBe(400)
  expect((await del(mia.client, ada.id)).status).toBe(404)
  const form = new FormData()
  form.set('file', new File([new TextEncoder().encode('x')], 'x.txt', { type: 'text/plain' }))
  const up = await (await h.fetch(`/api/rooms/${g.id}/files`, { method: 'POST', body: form, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })).json()
  await send(mia.client, g.id, 'with a file', { fileIds: [up.id] })
  expect((await h.fetch(`/api/rooms/${g.id}/files/${up.id}`, { headers: { cookie: otto.client.cookie! } })).status).toBe(200)
  hub.clear()
  expect((await del(mia.client, otto.id)).status).toBe(204)
  // out at once: messages, files, the list; every window of his drops it
  expect((await otto.client.try('GET', `/api/rooms/${g.id}/messages`)).status).toBe(404)
  expect((await h.fetch(`/api/rooms/${g.id}/files/${up.id}`, { headers: { cookie: otto.client.cookie! } })).status).toBe(404)
  expect(hub.forgotten).toContain(otto.id)
  expect(hub.events.filter((e) => e.target === otto.id).map((e) => (e.data as any).data.change)).toEqual(['removed'])
  expect((await messages(nora.client, g.id)).at(-1)).toMatchObject({ author: { id: mia.id }, event: { type: 'removed', user: { id: otto.id } } })
  // an admin who is in it may take out anyone but themselves, the manager too
  await mia.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [ada.id] })
  expect((await del(ada.client, ada.id)).status).toBe(400)
  expect((await del(ada.client, mia.id)).status).toBe(204)
  // the maker is gone: the manager is now the member who joined first (nora and pia joined with the maker, ada later)
  const now = await nora.client.call('GET', `/api/rooms/${g.id}`)
  expect(now.managerId).toBe([nora.id, pia.id].sort()[0])
  const manager = now.managerId === nora.id ? nora : pia
  const other = manager === nora ? pia : nora
  expect((await del(other.client, manager.id)).status).toBe(403)
  expect((await del(manager.client, other.id)).status).toBe(204)
  // the maker invited back is a member like the others: the manager stays who it is
  await manager.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [mia.id] })
  expect((await mia.client.call('GET', `/api/rooms/${g.id}`)).managerId).toBe(manager.id)
  expect((await del(mia.client, manager.id)).status).toBe(403)
  // only in group chats
  const dm = await nora.client.call('POST', '/api/rooms', { kind: 'dm', userId: pia.id })
  expect((await nora.client.try('DELETE', `/api/rooms/${dm.id}/members/${pia.id}`)).status).toBe(403)
})

test('rename: group chats by any member; team and everyone rooms by an owner or admin in them; never a DM', async () => {
  const { owner, ada, mia, nora, otto, group, rooms, messages, makeGroup, hub } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id])
  const patch = (c: Client, id: string, body: unknown) => c.try('PATCH', `/api/rooms/${id}`, body)
  hub.clear()
  const r = await patch(nora.client, g.id, { name: '  주간 회의  ' })
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ name: '주간 회의', canRename: true })
  expect(hub.to('room.updated').map((e) => e.target).sort()).toEqual([mia.id, nora.id, otto.id].sort())
  expect((await messages(otto.client, g.id)).at(-1)).toMatchObject({ author: { id: nora.id }, event: { type: 'renamed', name: '주간 회의' } })
  // the same name again: nothing new
  const seq = (await mia.client.call('GET', `/api/rooms/${g.id}`)).lastSeq
  await patch(mia.client, g.id, { name: '주간 회의' })
  expect((await mia.client.call('GET', `/api/rooms/${g.id}`)).lastSeq).toBe(seq)
  // '' or null: back to the members' names
  expect((await patch(mia.client, g.id, { name: '' })).body.name).toBeNull()
  expect((await messages(otto.client, g.id)).at(-1).event).toEqual({ type: 'renamed', name: null })
  // the name's rules: at most ROOM_NAME_MAX characters after trimming, no control characters or bidi overrides
  expect((await patch(mia.client, g.id, { name: 'x'.repeat(ROOM_NAME_MAX + 1) })).status).toBe(400)
  expect((await patch(mia.client, g.id, { name: `  ${'가'.repeat(ROOM_NAME_MAX)}  ` })).status).toBe(200)
  for (const bad of ['a\nb', 'a\u0000b', 'a‮b', 'a⁦b', 'a\u0085b']) expect((await patch(mia.client, g.id, { name: bad })).status).toBe(400)
  expect((await patch(mia.client, g.id, {})).status).toBe(400)
  expect((await patch(mia.client, g.id, { name: 'x', createdBy: nora.id })).status).toBe(400)
  // not in it: 404, admins included
  for (const c of [owner, ada.client]) expect((await patch(c, g.id, { name: 'mine now' })).status).toBe(404)
  // a DM is the other person: 403 (mute still works)
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  expect(dm.canRename).toBe(false)
  expect((await patch(mia.client, dm.id, { name: 'us' })).status).toBe(403)
  expect((await patch(mia.client, dm.id, { muted: true })).body.muted).toBe(true)
  // the team room: a plain member 403 (and the mute in the same request is not applied); an admin in it may
  const team = (await rooms(mia.client)).find((x) => x.kind === 'team' && x.groupId === group.id)
  expect(team.canRename).toBe(false)
  expect((await patch(mia.client, team.id, { name: 'ours', muted: true })).status).toBe(403)
  expect((await mia.client.call('GET', `/api/rooms/${team.id}`)).muted).toBe(false)
  expect((await patch(ada.client, team.id, { name: 'ours' })).status).toBe(404)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, ada.id] })
  const forAda = (await rooms(ada.client)).find((x) => x.id === team.id)
  expect(forAda.canRename).toBe(true)
  expect((await patch(ada.client, team.id, { name: '디자인 이야기' })).body.name).toBe('디자인 이야기')
  expect((await mia.client.call('GET', `/api/rooms/${team.id}`)).name).toBe('디자인 이야기')
  // team and everyone rooms are the admins' to see in the audit log, group chats not
  const renames = h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action = 'room.rename'").all() as { target: string; detail: string }[]
  expect(renames.map((x) => x.target)).toEqual([team.id])
  // the everyone room: the owner (a member of it) may, a member may not
  const all = (await rooms(owner)).find((x) => x.kind === 'all')
  expect((await patch(otto.client, all.id, { name: '우리 회사' })).status).toBe(403)
  expect((await patch(owner, all.id, { name: '우리 회사' })).body.name).toBe('우리 회사')
  // a custom name stays when the group changes or is renamed (sync never touches it); '' takes it back to the group's
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { name: 'design-2', memberIds: [mia.id, nora.id, ada.id, otto.id] })
  roomsOf(h.ctx).sync()
  expect((await otto.client.call('GET', `/api/rooms/${team.id}`)).name).toBe('디자인 이야기')
  expect((await otto.client.call('GET', `/api/rooms/${all.id}`)).name).toBe('우리 회사')
  expect((await patch(ada.client, team.id, { name: '' })).body.name).toBe('design-2')
  expect((await patch(owner, all.id, { name: null })).body.name).toBeNull()
})

test('event lines count nowhere: no unread, badge, list line, notice or push; not editable, deletable, quotable or postable', async () => {
  const { owner, mia, nora, otto, rooms, messages, makeGroup, send } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id])
  const msg = await send(mia.client, g.id, 'a real message')
  await mia.client.call('PATCH', `/api/rooms/${g.id}`, { name: 'Plan' })
  await mia.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [(await addMember(h, owner, { username: 'quin' })).id] })
  const forNora = (await rooms(nora.client)).find((r) => r.id === g.id)
  // the one real message counts; the lines after it do not, nor are they the list's line
  expect(forNora).toMatchObject({ unreadCount: 1, lastMessage: { id: msg.id, excerpt: 'a real message' } })
  const lines = (await messages(nora.client, g.id)).filter((m) => m.event)
  expect(lines.map((m) => m.event.type)).toEqual(['created', 'renamed', 'added'])
  expect(lines.every((m) => m.body === '' && m.files.length === 0 && m.mentions.length === 0 && !m.reactions && !m.thread)).toBe(true)
  // nora reads up to the end: nothing left
  await nora.client.call('POST', `/api/rooms/${g.id}/read`, { seq: 999 })
  expect((await rooms(nora.client)).find((r) => r.id === g.id).unreadCount).toBe(0)
  // only the real message made a notice (a group chat message notifies like a DM)
  const notices = h.ctx.db.query('SELECT source_id FROM room_notices WHERE room_id = ?').all(g.id) as { source_id: string }[]
  expect(notices.every((n) => n.source_id === msg.id)).toBe(true)
  expect(notices.length).toBe(2)
  // its author cannot edit or delete one; nobody can answer it or post it
  const line = lines[1]
  expect((await mia.client.try('PATCH', `/api/rooms/${g.id}/messages/${line.id}`, { body: 'changed' })).status).toBe(403)
  expect((await mia.client.try('DELETE', `/api/rooms/${g.id}/messages/${line.id}`)).status).toBe(403)
  expect((await nora.client.try('POST', `/api/rooms/${g.id}/messages`, { body: 'x', replyToId: line.id, clientMessageId: cm() })).status).toBe(400)
  expect((await mia.client.try('POST', `/api/rooms/${g.id}/messages/${line.id}/share`)).status).toBe(404)
  expect(h.ctx.db.query('SELECT body, deleted_at FROM room_messages WHERE id = ?').get(line.id)).toEqual({ body: '', deleted_at: null })
  // nothing in the inbox or a push queue for a line (a group chat's message is no Inbox row either: the 대화 tab has it)
  for (const u of [nora.id, otto.id]) expect(notificationsOf(h.ctx).list(u, {}).items).toHaveLength(0)
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE source_id IN (SELECT id FROM room_messages WHERE event IS NOT NULL)').get() as { n: number }).n).toBe(0)
})

test('sync keeps group chats as they are; a disabled or deleted account still leaves them, and the last one out archives', async () => {
  const { owner, mia, nora, otto, pia, rooms, messages, makeGroup } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id], 'Kept name')
  const pair = await makeGroup(otto.client, [pia.id, nora.id])
  roomsOf(h.ctx).sync()
  expect((await mia.client.call('GET', `/api/rooms/${g.id}`)).memberCount).toBe(3)
  // a group change and the minute tick do not touch who is in a group chat, nor its name
  const grp = await owner.call('POST', '/api/admin/groups', { name: 'ops', memberIds: [mia.id] })
  roomsOf(h.ctx).sync()
  expect(await mia.client.call('GET', `/api/rooms/${g.id}`)).toMatchObject({ memberCount: 3, name: 'Kept name' })
  void grp
  // disabled: out (with a line, no audit), not back when enabled again
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'disabled' })
  expect((await mia.client.call('GET', `/api/rooms/${g.id}`)).memberCount).toBe(2)
  expect((await messages(mia.client, g.id)).at(-1)).toMatchObject({ author: { id: otto.id }, event: { type: 'left' } })
  expect((await nora.client.call('GET', `/api/rooms/${pair.id}`)).managerId).toBe([nora.id, pia.id].sort()[0])
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'active' })
  expect((await mia.client.call('GET', `/api/rooms/${g.id}`)).memberCount).toBe(2)
  expect((h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'room.%' AND target IN (?, ?)").get(g.id, pair.id) as { n: number }).n).toBe(0)
  // deleted: out too
  await owner.call('DELETE', `/api/admin/users/${nora.id}`)
  expect((await mia.client.call('GET', `/api/rooms/${g.id}`)).memberCount).toBe(1)
  // a room left with nobody active in it is archived
  await owner.call('PATCH', `/api/admin/users/${mia.id}`, { status: 'disabled' })
  expect((h.ctx.db.query('SELECT archived_at FROM rooms WHERE id = ?').get(g.id) as { archived_at: string | null }).archived_at).toBeTruthy()
  expect((await rooms(pia.client)).some((r) => r.id === pair.id)).toBe(true)
})

test('reader level: a database with group chats is refused by an older build (restore the backup to go back)', async () => {
  const { readMigrations, SCHEMA_READER_LEVEL, openDb, migrate, SchemaTooNewError } = await import('../../server/src/db')
  h = await harness('b-rooms-group-reader')
  const m = readMigrations().find((x) => x.name === '250_b_group_rooms.sql')!
  expect(m.minCompatibleReader).toBe(5)
  expect(SCHEMA_READER_LEVEL).toBeGreaterThanOrEqual(5)
  const dir = path.join(h.ctx.config.dataDir, 'old-migrations')
  fs.mkdirSync(dir, { recursive: true })
  for (const x of readMigrations()) if (x.version < 250) fs.writeFileSync(path.join(dir, x.name), x.sql)
  const file = path.join(h.ctx.config.dataDir, 'newer.db')
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true })
  const db = openDb(file)
  expect(() => migrate(db, { migrationsDir: dir, readerLevel: 4 })).toThrow(SchemaTooNewError)
  db.close()
})

// ---------------- second review (2026-11-06) ----------------
test('after leaving and being invited back, my messages from before are out of sight: not mine to edit or delete (also in a team room)', async () => {
  const { owner, mia, nora, otto, group, rooms, send, makeGroup } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id])
  const old = await send(nora.client, g.id, 'NORA-BEFORE-LEAVING')
  const old2 = await send(nora.client, g.id, 'NORA-BEFORE-LEAVING-2')
  await nora.client.call('POST', `/api/rooms/${g.id}/leave`)
  await mia.client.call('POST', `/api/rooms/${g.id}/members`, { userIds: [nora.id] })
  expect((await nora.client.try('PATCH', `/api/rooms/${g.id}/messages/${old.id}`, { body: 'rewritten' })).status).toBe(404)
  expect((await nora.client.try('DELETE', `/api/rooms/${g.id}/messages/${old2.id}`)).status).toBe(404)
  expect(h.ctx.db.query('SELECT body, deleted_at FROM room_messages WHERE id = ?').get(old.id)).toEqual({ body: 'NORA-BEFORE-LEAVING', deleted_at: null })
  expect(h.ctx.db.query('SELECT deleted_at FROM room_messages WHERE id = ?').get(old2.id)).toEqual({ deleted_at: null })
  // her new messages are hers as before
  const fresh = await send(nora.client, g.id, 'after')
  expect((await nora.client.try('PATCH', `/api/rooms/${g.id}/messages/${fresh.id}`, { body: 'after (fixed)' })).status).toBe(200)
  // a team room: out of the group and back in
  const team = (await rooms(nora.client)).find((r) => r.kind === 'team' && r.groupId === group.id)
  const teamOld = await send(nora.client, team.id, 'TEAM-BEFORE')
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id] })
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id] })
  expect((await nora.client.try('PATCH', `/api/rooms/${team.id}/messages/${teamOld.id}`, { body: 'x' })).status).toBe(404)
  expect((await nora.client.try('DELETE', `/api/rooms/${team.id}/messages/${teamOld.id}`)).status).toBe(404)
})

test('names that show nothing are refused: invisible letters, format characters, combining marks alone', async () => {
  const { mia, nora, otto, makeGroup } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id])
  const bad = ['ㅤ', 'ᅟᅠ', 'ﾠ', 'a⁠b', 'a⁤b', 'a⁪b', 'a⁯b', 'a­b', 'a᠎b', '͏', '⠀', 'a￹b', 'a￻b', '‍', '‌', 'a‌b', '́̂', '　ㅤ']
  for (const name of bad) {
    const r = await mia.client.try('PATCH', `/api/rooms/${g.id}`, { name })
    expect({ name: [...name].map((c) => c.codePointAt(0)!.toString(16)), status: r.status }).toEqual({ name: [...name].map((c) => c.codePointAt(0)!.toString(16)), status: 400 })
    expect((await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name })).status).toBe(400)
  }
  // an emoji sequence (with its joiner), Korean, accents and punctuation are fine
  for (const name of ['👩‍💻 개발팀', 'Café — Q4', '「기획」', '#1']) expect((await mia.client.try('PATCH', `/api/rooms/${g.id}`, { name })).body.name).toBe(name)
})

test('an event line this build cannot read is a neutral line by nobody, never "<who> left"', async () => {
  const { mia, nora, otto, makeGroup, messages } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id])
  const put = (event: string) => h.ctx.db.transaction(() => {
    const seq = (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(g.id) as { last_seq: number }).last_seq
    h.ctx.db.query("INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, event) VALUES (?, ?, ?, 'user', ?, 'room', '', '[]', ?, ?)")
      .run(newId(), g.id, seq, mia.id, new Date().toISOString(), event)
  })()
  put('{"type":"pinned","by":"x"}')
  put('{"type":"removed"}')
  put('not json')
  const lines = (await messages(nora.client, g.id)).slice(-3)
  for (const l of lines) expect(l).toMatchObject({ author: null, event: { type: 'unknown' }, body: '' })
})

test(`at most ${GROUPS_PER_HOUR} new group chats an hour per person, with a 429 that says so`, async () => {
  const { mia, nora, otto, makeGroup } = await setup()
  for (let i = 0; i < GROUPS_PER_HOUR; i++) await makeGroup(mia.client, [nora.id, otto.id])
  const over = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  expect(over.status).toBe(429)
  expect(over.body.error).toMatchObject({ code: 'rate_limited', retryAfter: expect.any(Number) })
  expect(over.body.error.message).toContain(String(GROUPS_PER_HOUR))
  // another person has their own count; a DM is not a group chat
  expect((await nora.client.try('POST', '/api/rooms', { kind: 'group', userIds: [mia.id, otto.id] })).status).toBe(201)
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'dm', userId: otto.id })).status).toBe(201)
})

test('replay after a reconnect: someone taken out of a group chat gets a resync, nothing of the chat', async () => {
  const { mia, nora, otto, makeGroup } = await setup()
  const g = await makeGroup(mia.client, [nora.id, otto.id])
  const hub = new Hub(h.ctx)
  h.ctx.services.realtime = hub
  try {
    const frames: any[] = []
    const conn = (): RealtimeConn => ({ send(d) { frames.push(JSON.parse(d)) }, close() {}, bufferedAmount: () => 0, ping() {}, onMessage() {}, onClose() {} })
    const open = (q: string) => hub.attach(conn(), new Request(`http://team.localhost/api/ws?windowId=win-nora-0002${q}`, { headers: { cookie: nora.client.cookie!, origin: 'http://team.localhost' } }), { ip: null, via: 'test' })
    await open('')
    const hello = frames.find((f) => f.type === 'hello')
    await mia.client.call('POST', `/api/rooms/${g.id}/messages`, { body: 'GROUP-REPLAY-ONE', clientMessageId: cm() })
    frames.length = 0
    await open(`&epoch=${hello.epoch}&after=${hello.seq}`)
    expect(frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(JSON.stringify(frames)).toContain('GROUP-REPLAY-ONE')
    // taken out by the manager: the same resume is a resync, with nothing from the chat
    await mia.client.call('DELETE', `/api/rooms/${g.id}/members/${nora.id}`)
    frames.length = 0
    await open(`&epoch=${hello.epoch}&after=${hello.seq}`)
    expect(frames.some((f) => f.type === 'resync')).toBe(true)
    expect(JSON.stringify(frames)).not.toContain('GROUP-REPLAY-ONE')
  } finally { hub.close() }
})
