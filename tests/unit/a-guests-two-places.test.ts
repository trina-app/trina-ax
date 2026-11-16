// A guest in one group chat AND one project (owner, 2026-11-15; docs/DECISIONS.md "Guests: one group chat and one
// project"). What they reach is the union of their two places and nothing past it; a second place of the same kind is
// refused (409 guest_one_place); out of one place they stay on, out of both they are switched off; the folder policy
// keeps them in their one project whatever rule names them elsewhere.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'
import { RuleSet, loadPrincipal } from '../../server/src/policy/access'
import { newId } from '../../server/src/db'
import { GUEST_ONE_PLACE_MSG, guestSlots, placePeople, reachFilter, seenBy, sharesPlace } from '../../server/src/auth/guests'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const EN_ONE_PLACE = 'A guest can be in one group chat and one project. To add them to more, make them a team member.'

/**
 * mia makes the group chat "Room R" (rita, otto) and the project Quote (nora); otto has the project Secret alone; pat
 * is in neither, and in the group chat "Room S" with nora and otto. gus is invited into Room R, then added to Quote.
 */
async function setup(name: string, o: { both?: boolean } = {}) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const rita = await addMember(h, owner, { username: 'rita' })
  const pat = await addMember(h, owner, { username: 'pat' })
  const roomR = await groupChat(mia.client, [rita.id, otto.id], 'Room R')
  const roomS = await groupChat(nora.client, [otto.id, pat.id], 'Room S')
  const quote = await mia.client.call('POST', '/api/projects', { name: 'Quote', participants: [{ subjectType: 'user', subjectId: nora.id }] })
  const secret = await otto.client.call('POST', '/api/projects', { name: 'Secret', participants: [] })
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: roomR } })
  if (o.both !== false) expect((await addToProject(mia.client, quote.id, g.id)).status).toBe(200)
  return { owner, mia, nora, otto, rita, pat, roomR, roomS, quote, secret, g }
}
const access = (c: Client, id: string) => c.call('GET', `/api/projects/${id}/access`)
async function addToProject(c: Client, projectId: string, userId: string) {
  const a = await access(c, projectId)
  const participants = [...a.participants.map((x: { subjectType: string; subjectId: string }) => ({ subjectType: x.subjectType, subjectId: x.subjectId })), { subjectType: 'user', subjectId: userId }]
  return c.try('PUT', `/api/projects/${projectId}/participants`, { participants, expectedHash: a.rulesHash })
}
async function takeOutOfProject(c: Client, projectId: string, userId: string) {
  const a = await access(c, projectId)
  const participants = a.participants.filter((x: { subjectId: string }) => x.subjectId !== userId).map((x: { subjectType: string; subjectId: string }) => ({ subjectType: x.subjectType, subjectId: x.subjectId }))
  return c.try('PUT', `/api/projects/${projectId}/participants`, { participants, expectedHash: a.rulesHash })
}
const status = (id: string) => (h.ctx.db.query('SELECT status FROM users WHERE id = ?').get(id) as { status: string }).status
const peopleIds = async (c: Client) => ((await c.call('GET', '/api/people')).people as { id: string }[]).map((p) => p.id).sort()
const personOf = async (c: Client, id: string) => ((await c.call('GET', '/api/people')).people as { id: string; guestPlaces?: unknown[] }[]).find((p) => p.id === id)
const reads = (userId: string, path: string) => RuleSet.fromDb(h.ctx.db).access(loadPrincipal(h.ctx.db, userId)!, path.split('/'))

test('union reach: the people of both places and nobody else; both places in Me; each side names only its own place', async () => {
  const { owner, mia, nora, otto, rita, pat, roomR, quote, secret, g } = await setup('a-guests-two-union')
  expect(status(g.id)).toBe('active')
  // the guest: Room R's people (mia, rita, otto) and Quote's (mia, nora), never pat or the owner (in neither)
  expect(await peopleIds(g.client)).toEqual([g.id, mia.id, nora.id, otto.id, rita.id].sort())
  // DMs: with a person of either place, never with pat (both ways)
  expect((await g.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })).kind).toBe('dm')
  expect((await g.client.call('POST', '/api/rooms', { kind: 'dm', userId: rita.id })).kind).toBe('dm')
  expect((await g.client.try('POST', '/api/rooms', { kind: 'dm', userId: pat.id })).status).toBe(404)
  expect((await pat.client.try('POST', '/api/rooms', { kind: 'dm', userId: g.id })).status).toBe(404)
  // the people who see the guest: both places' people, not pat
  for (const m of [mia, nora, otto, rita]) expect(await peopleIds(m.client)).toContain(g.id)
  expect(await peopleIds(pat.client)).not.toContain(g.id)
  const db = h.ctx.db
  expect([...placePeople(db, g.id)].sort()).toEqual([g.id, mia.id, nora.id, otto.id, rita.id].sort())
  expect(sharesPlace(db, g.id, pat.id)).toBe(false)
  expect(reachFilter(db, pat.id)(g.id)).toBe(false)
  const seen = seenBy(db, g.id)
  expect([nora.id, rita.id, pat.id].map(seen)).toEqual([true, true, false])
  // Me: both places by name, the group chat first
  const me = await g.client.call('GET', '/api/me')
  expect(me.guest.places.map((p: { kind: string; name: string }) => `${p.kind}:${p.name}`)).toEqual(['room:Room R', 'project:Quote'])
  // Admin's row: both
  const row = ((await owner.call('GET', '/api/admin/users')).items as { id: string; guest?: { places: { kind: string; id: string }[] } }[]).find((u) => u.id === g.id)!
  expect(row.guest!.places.map((p) => `${p.kind}:${p.id}`)).toEqual([`room:${roomR}`, `project:${quote.id}`])
  // a person of one place learns the other's kind only: never its name or id
  expect((await personOf(rita.client, g.id))!.guestPlaces).toEqual([{ kind: 'room', id: roomR, name: 'Room R' }, { kind: 'project' }])
  expect((await personOf(nora.client, g.id))!.guestPlaces).toEqual([{ kind: 'room' }, { kind: 'project', id: quote.id, name: 'Quote' }])
  // files and projects: Quote only
  expect((await g.client.call('GET', '/api/projects')).items.map((p: { id: string }) => p.id)).toEqual([quote.id])
  expect((await g.client.try('GET', `/api/projects/${secret.id}`)).status).toBe(404)
  expect(reads(g.id, quote.folderPath)).toBe('write')
  expect(reads(g.id, secret.folderPath)).toBe('none')
  // rooms: Room R and their DMs, never Room S
  const rooms = (await g.client.call('GET', '/api/rooms')).items as { id: string; kind: string }[]
  expect(rooms.filter((r) => r.kind === 'group').map((r) => r.id)).toEqual([roomR])
})

test('a second group chat or a second project is refused: invite, new group, members panel, new project', async () => {
  const { mia, nora, otto, pat, roomS, secret, g } = await setup('a-guests-two-third')
  const add = await nora.client.try('POST', `/api/rooms/${roomS}/members`, { userIds: [g.id] }, { 'accept-language': 'en' })
  expect(add.status).toBe(409)
  expect(add.body.error.params.reason).toBe('guest_one_place')
  expect([GUEST_ONE_PLACE_MSG.ko, EN_ONE_PLACE]).toContain(add.body.error.message)
  expect(GUEST_ONE_PLACE_MSG.en).toBe(EN_ONE_PLACE)
  expect((await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [g.id, pat.id], name: 'another' })).status).toBe(409)
  const proj = await addToProject(otto.client, secret.id, g.id)
  expect(proj.status).toBe(409)
  expect(proj.body.error.params.reason).toBe('guest_one_place')
  expect((await nora.client.try('POST', '/api/projects', { name: 'Third', participants: [{ subjectType: 'user', subjectId: g.id }] })).status).toBe(409)
  // nothing changed: still in Room R and Quote only
  expect(guestSlots(h.ctx.db, g.id).map((p) => p.kind)).toEqual(['room', 'project'])
  expect(reads(g.id, secret.folderPath)).toBe('none')
})

test('a guest in a group chat can be put into a new project at its start, and a project guest into a new group chat', async () => {
  const { mia, nora, rita, pat, g } = await setup('a-guests-two-new', { both: false })
  const made = await mia.client.call('POST', '/api/projects', { name: 'Fresh', participants: [{ subjectType: 'user', subjectId: g.id }] })
  expect(reads(g.id, made.folderPath)).toBe('write')
  expect((await g.client.call('GET', '/api/projects')).items.map((p: { id: string }) => p.id)).toEqual([made.id])
  // a project-only guest into a brand-new group chat
  const p2 = await nora.client.call('POST', '/api/projects', { name: 'Solo', participants: [] })
  const g2 = await addGuest(h, nora.client, { username: 'gia', place: { kind: 'project', id: p2.id } })
  const room = await nora.client.call('POST', '/api/rooms', { kind: 'group', userIds: [g2.id, pat.id], name: 'with gia' })
  expect(guestSlots(h.ctx.db, g2.id)).toEqual([{ kind: 'room', id: room.id }, { kind: 'project', id: p2.id }])
  expect(await peopleIds(g2.client)).toEqual([g2.id, nora.id, pat.id].sort())
  void rita
})

test('out of one place the account stays on; out of both it is switched off; a freed kind takes another place', async () => {
  const { mia, nora, otto, rita, roomR, roomS, quote, g } = await setup('a-guests-two-removal')
  // out of the group chat: still on, through Quote; rita (Room R only) is out of reach, nora still in it
  expect((await mia.client.try('DELETE', `/api/rooms/${roomR}/members/${g.id}`)).status).toBeLessThan(300)
  expect(status(g.id)).toBe('active')
  expect(await peopleIds(g.client)).toEqual([g.id, mia.id, nora.id].sort())
  expect((await g.client.try('POST', '/api/rooms', { kind: 'dm', userId: rita.id })).status).toBe(404)
  expect((await g.client.call('GET', '/api/me')).guest.places.map((p: { kind: string }) => p.kind)).toEqual(['project'])
  // the group chat kind is free again: another group chat takes them
  expect((await nora.client.try('POST', `/api/rooms/${roomS}/members`, { userIds: [g.id] })).status).toBeLessThan(300)
  expect(await peopleIds(g.client)).toContain(otto.id)
  // out of the project too, then out of Room S: switched off only at the last one
  expect((await takeOutOfProject(mia.client, quote.id, g.id)).status).toBe(200)
  expect(status(g.id)).toBe('active')
  expect((await nora.client.try('DELETE', `/api/rooms/${roomS}/members/${g.id}`)).status).toBeLessThan(300)
  expect(status(g.id)).toBe('disabled')
})

test('out of the project first: still on through the group chat; then out of the chat: off', async () => {
  const { mia, roomR, quote, g } = await setup('a-guests-two-removal-b')
  expect((await takeOutOfProject(mia.client, quote.id, g.id)).status).toBe(200)
  expect(status(g.id)).toBe('active')
  expect(reads(g.id, quote.folderPath)).toBe('none')
  expect((await g.client.call('GET', '/api/projects')).items).toEqual([])
  expect((await mia.client.try('DELETE', `/api/rooms/${roomR}/members/${g.id}`)).status).toBeLessThan(300)
  expect(status(g.id)).toBe('disabled')
})

test('a trashed project keeps its slot while it keeps their rule; restored, they are back in it; taken out before, the slot is free', async () => {
  const { owner, mia, otto, quote, secret, g } = await setup('a-guests-two-trash')
  await owner.call('DELETE', `/api/projects/${quote.id}`)
  // still on through the group chat, and the trashed project is still theirs: no second project meanwhile
  expect(status(g.id)).toBe('active')
  expect((await addToProject(otto.client, secret.id, g.id)).status).toBe(409)
  await owner.call('POST', `/api/projects/${quote.id}/restore`)
  expect(status(g.id)).toBe('active')
  expect(reads(g.id, quote.folderPath)).toBe('write')
  // taken out, then the project trashed: their project kind is free (nothing of theirs comes back with it)
  expect((await takeOutOfProject(mia.client, quote.id, g.id)).status).toBe(200)
  await owner.call('DELETE', `/api/projects/${quote.id}`)
  expect((await addToProject(otto.client, secret.id, g.id)).status).toBe(200)
  expect(reads(g.id, secret.folderPath)).toBe('write')
  // Quote restored now: none of its rules is theirs, and the policy keeps them in Secret only anyway
  await owner.call('POST', `/api/projects/${quote.id}/restore`)
  expect(reads(g.id, quote.folderPath)).toBe('none')
})

test('the policy keeps a guest in their one project whatever rule names them elsewhere (a moved or restored folder)', async () => {
  const { quote, secret, g } = await setup('a-guests-two-policy')
  const db = h.ctx.db
  const f = db.query('SELECT id FROM folders WHERE path = ?').get(secret.folderPath) as { id: string }
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by, updated_at) VALUES (?, ?, 'user', ?, 'write', NULL, ?)").run(newId(), f.id, g.id, new Date().toISOString())
  expect(reads(g.id, secret.folderPath)).toBe('none')
  expect(reads(g.id, `${secret.folderPath}/notes.txt`)).toBe('none')
  expect(reads(g.id, quote.folderPath)).toBe('write')
  expect((await g.client.try('GET', `/api/files/tree?path=${encodeURIComponent(secret.folderPath)}`)).status).toBe(404)
})

test('a guest adds nobody to their group chat, not even their project people', async () => {
  const { nora, roomR, g } = await setup('a-guests-two-add')
  expect((await g.client.try('POST', `/api/rooms/${roomR}/members`, { userIds: [nora.id] })).status).toBe(403)
})

test('a guests row an older build wrote (no slot set) reads as its invite place, in reach and in the policy', async () => {
  const { mia, rita, quote, g } = await setup('a-guests-two-legacy', { both: false })
  const db = h.ctx.db
  db.query('UPDATE guests SET room_id = NULL, project_id = NULL WHERE user_id = ?').run(g.id)
  expect(await peopleIds(g.client)).toContain(rita.id)
  // a project guest of an older build: the policy reads the invite's project
  const g2 = await addGuest(h, mia.client, { username: 'gia', place: { kind: 'project', id: quote.id } })
  db.query('UPDATE guests SET room_id = NULL, project_id = NULL WHERE user_id = ?').run(g2.id)
  expect(reads(g2.id, quote.folderPath)).toBe('write')
  expect(guestSlots(db, g2.id)).toEqual([{ kind: 'project', id: quote.id }])
  // their second place keeps the first (security review): the project guest into a group chat, the chat guest into a project
  const room = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [g2.id, rita.id], name: 'with gia' })
  expect(guestSlots(db, g2.id)).toEqual([{ kind: 'room', id: room.id }, { kind: 'project', id: quote.id }])
  expect(reads(g2.id, quote.folderPath)).toBe('write')
  expect((await addToProject(mia.client, quote.id, g.id)).status).toBe(200)
  expect(guestSlots(db, g.id).map((p) => p.kind)).toEqual(['room', 'project'])
  expect(await peopleIds(g.client)).toContain(rita.id)
})

test('the "joined as a guest" notice names the place the invite opened, not a later one', async () => {
  const { mia, g } = await setup('a-guests-two-joined')
  const items = (await mia.client.call('GET', '/api/notifications')).items as { eventType: string; sourceId: string; joined?: { guestPlace?: { kind: string; name: string } } }[]
  const n = items.find((x) => x.eventType === 'team.joined' && x.sourceId === g.id)
  expect(n?.joined?.guestPlace).toMatchObject({ kind: 'room', name: 'Room R' })
})
