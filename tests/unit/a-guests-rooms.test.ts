// Guests and rooms (docs/DECISIONS.md "Guests: only what they were invited to"; guest-review leak path 2): a guest is in
// one group chat, never the everyone room, sees and reaches only the people of that chat, cannot make group chats or
// pull outsiders in, and is switched off when they are out of it. Each test uses a real guest (invite + accept) and
// shows the member's normal path still works.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { GUEST_ONE_PLACE_MSG } from '../../server/src/auth/guests'
import { findPeople } from '../../server/src/rooms/reader'
import { readersOf } from '../../server/src/rooms/ai-grants'
import { guestPresenceSend } from '../../server/src/realtime/presence'
import { MY_PROFILE_CHANGED, PROFILE_CHANGED, profileChangedFor } from '../../server/src/auth/profiles'
import { RuleSet } from '../../server/src/policy/access'
import type { PresenceFrame } from '@mycel/shared/api'
import { makePng } from '../lib/images'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })

const cm = () => 'cm-' + crypto.randomUUID()

/** mia, nora, otto share a group chat; pia is a member outside it; gus is mia's guest in that chat. */
async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id, otto.id])
  const gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  return { owner, mia, nora, otto, pia, room, gus }
}
const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as { id: string; kind: string }[]
const peopleIds = async (c: Client) => ((await c.call('GET', '/api/people')).people as { id: string }[]).map((p) => p.id).sort()
const avatar = (c: Client, id: string) => h.fetch(`/api/people/${id}/avatar`, { headers: c.cookie ? { cookie: c.cookie } : {} })
function putAvatar(c: Client) {
  return h.fetch('/api/me/avatar?type=image%2Fpng', { method: 'PUT', headers: { 'x-mycel-csrf': '1', 'content-type': 'application/octet-stream', cookie: c.cookie! }, body: makePng(64, 64) })
}

test('everyone room: a guest is never put in it and no joined line is written for them; members are', async () => {
  const { owner, mia, room, gus } = await setup('a-guests-rooms-all')
  const g = await rooms(gus.client)
  expect(g.map((r) => r.kind)).toEqual(['group'])
  expect(g[0]!.id).toBe(room)
  const all = (await rooms(mia.client)).find((r) => r.kind === 'all')!
  expect(all).toBeTruthy()
  const members = ((await owner.call('GET', `/api/rooms/${all.id}/members`)).items ?? (await owner.call('GET', `/api/rooms/${all.id}/members`))) as { id?: string; user?: { id: string } }[]
  const ids = members.map((m) => m.id ?? m.user?.id)
  expect(ids).toContain(mia.id)
  expect(ids).not.toContain(gus.id)
  // the everyone room's lines: nobody "joined" as gus
  const lines = (await owner.call('GET', `/api/rooms/${all.id}/messages`)).items as { author: { id: string } | null; event?: unknown }[]
  expect(lines.some((l) => l.author?.id === gus.id)).toBe(false)
  // the guest cannot open it either
  expect((await gus.client.try('GET', `/api/rooms/${all.id}/messages`)).status).toBe(404)
})

test('people list and avatars: a guest sees only the people of their place; a member outside it does not see the guest', async () => {
  const { owner, mia, nora, otto, pia, gus } = await setup('a-guests-rooms-people')
  expect(await peopleIds(gus.client)).toEqual([gus.id, mia.id, nora.id, otto.id].sort())
  // members of the place see the guest; a member outside it does not; the owner outside it does not either
  expect(await peopleIds(mia.client)).toContain(gus.id)
  expect(await peopleIds(pia.client)).not.toContain(gus.id)
  expect(await peopleIds(owner)).not.toContain(gus.id)
  // and everyone else is still in a member's list
  expect(await peopleIds(pia.client)).toEqual(expect.arrayContaining([mia.id, nora.id, otto.id, pia.id]))
  // avatars: as an unknown person across the line, both ways; inside it and between members they work
  expect((await putAvatar(pia.client)).status).toBe(200)
  expect((await putAvatar(mia.client)).status).toBe(200)
  expect((await putAvatar(gus.client)).status).toBe(200)
  expect((await avatar(gus.client, pia.id)).status).toBe(404)
  expect((await avatar(pia.client, gus.id)).status).toBe(404)
  expect((await avatar(gus.client, mia.id)).status).toBe(200)
  expect((await avatar(mia.client, gus.id)).status).toBe(200)
  expect((await avatar(nora.client, pia.id)).status).toBe(200)
})

test('presence: a guest is told only about their place; a member outside it is not told about the guest', async () => {
  const { mia, nora, otto, pia, gus } = await setup('a-guests-rooms-presence')
  const sent: { to: string; ids: string[] }[] = []
  const send = guestPresenceSend(h.ctx, (to, frame) => { sent.push({ to, ids: frame.people.map((p) => p.id).sort() }) })
  const frame: PresenceFrame = { type: 'presence', full: false, people: [mia.id, nora.id, otto.id, pia.id, gus.id].map((id) => ({ id, state: 'online' as const })) }
  // one frame to every window (as Presence.flush does): the guest's view is worked out once for it
  let queries = 0
  const q = h.ctx.db.query.bind(h.ctx.db)
  ;(h.ctx.db as { query: typeof q }).query = ((sql: string) => { if (/guest = 1/.test(sql)) queries++; return q(sql) }) as typeof q
  try { for (const to of [gus.id, mia.id, pia.id, nora.id]) send(to, frame) } finally { (h.ctx.db as { query: typeof q }).query = q }
  expect(queries).toBe(1)
  const to = (id: string) => sent.find((s) => s.to === id)!.ids
  expect(to(gus.id)).toEqual([gus.id, mia.id, nora.id, otto.id].sort())
  expect(to(pia.id)).toEqual([mia.id, nora.id, otto.id, pia.id].sort())
  expect(to(mia.id)).toEqual([mia.id, nora.id, otto.id, pia.id, gus.id].sort())
  // a change only about outsiders reaches no guest window at all
  sent.length = 0
  send(gus.id, { type: 'presence', full: false, people: [{ id: pia.id, state: 'away' }] })
  expect(sent).toHaveLength(0)
})

test('profile notice: "someone changed their profile" goes only to people who may see that person (a guest and outsiders never exchange it)', async () => {
  const { mia, nora, pia, gus } = await setup('a-guests-rooms-profile-notice')
  const db = h.ctx.db
  // the guest changes their name or photo: themselves, and the people of their place, are told; a member outside it is not
  const byGuest = profileChangedFor(db, gus.id)
  expect(byGuest(gus.id)).toEqual(MY_PROFILE_CHANGED)
  expect(byGuest(mia.id)).toEqual(PROFILE_CHANGED)
  expect(byGuest(nora.id)).toEqual(PROFILE_CHANGED)
  expect(byGuest(pia.id)).toBeNull()
  // a member outside the guest's place changes theirs: the guest is not told, the team is
  const byPia = profileChangedFor(db, pia.id)
  expect(byPia(gus.id)).toBeNull()
  expect(byPia(mia.id)).toEqual(PROFILE_CHANGED)
  // several people at once (statuses that ended): told when any of them may be seen
  expect(profileChangedFor(db, [pia.id, mia.id])(gus.id)).toEqual(PROFILE_CHANGED)
  expect(profileChangedFor(db, [pia.id])(gus.id)).toBeNull()
})

test('DMs: a guest opens one only with the people of their place, a member outside it cannot open one with the guest', async () => {
  const { mia, pia, gus } = await setup('a-guests-rooms-dm')
  const dm = await gus.client.call('POST', '/api/rooms', { kind: 'dm', userId: mia.id })
  expect(dm.kind).toBe('dm')
  await gus.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: 'hello', clientMessageId: cm() })
  expect((await gus.client.try('POST', '/api/rooms', { kind: 'dm', userId: pia.id })).status).toBe(404)
  expect((await pia.client.try('POST', '/api/rooms', { kind: 'dm', userId: gus.id })).status).toBe(404)
  // members still open DMs with each other
  expect((await pia.client.call('POST', '/api/rooms', { kind: 'dm', userId: mia.id })).kind).toBe('dm')
  // the DM never counts as a place: mia leaves the group chat, the DM stops working for both
  await mia.client.call('POST', `/api/rooms/${(await rooms(gus.client)).find((r) => r.kind === 'group')!.id}/leave`)
  // closed to both as if it were not there (security review): no send, no reading, no members, not listed, not searched
  expect((await gus.client.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'still there?', clientMessageId: cm() })).status).toBe(404)
  expect((await mia.client.try('POST', `/api/rooms/${dm.id}/messages`, { body: 'yes', clientMessageId: cm() })).status).toBe(404)
  expect((await gus.client.try('GET', `/api/rooms/${dm.id}/messages`)).status).toBe(404)
  expect((await gus.client.try('GET', `/api/rooms/${dm.id}/members`)).status).toBe(404)
  expect((await rooms(gus.client)).some((r) => r.id === dm.id)).toBe(false)
  expect((await rooms(mia.client)).some((r) => r.id === dm.id)).toBe(false)
  expect((await gus.client.call('GET', '/api/room-messages?q=hello')).items).toEqual([])
  // members' own DMs are untouched
  expect((await rooms(pia.client)).some((r) => r.kind === 'dm')).toBe(true)
})

test('group chats: a guest makes none; a member cannot put a guest into a second group chat (409 guest_one_place)', async () => {
  const { mia, nora, otto, pia, room, gus } = await setup('a-guests-rooms-group')
  expect((await gus.client.try('POST', '/api/rooms', { kind: 'group', userIds: [mia.id, nora.id] })).status).toBe(403)
  // a new group chat with the guest in it
  const made = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [gus.id, pia.id] })
  expect(made.status).toBe(409)
  expect(made.body.error.params.reason).toBe('guest_one_place')
  // the message the person reads (Korean team default, English when asked)
  expect([GUEST_ONE_PLACE_MSG.ko, GUEST_ONE_PLACE_MSG.en]).toContain(made.body.error.message)
  const en = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [gus.id, pia.id] }, { 'accept-language': 'en' })
  expect(en.body.error.params.reason).toBe('guest_one_place')
  // add-member into another group chat
  const other = await groupChat(mia.client, [pia.id, otto.id], 'other')
  const add = await mia.client.try('POST', `/api/rooms/${other}/members`, { userIds: [gus.id] })
  expect(add.status).toBe(409)
  expect(add.body.error.params.reason).toBe('guest_one_place')
  expect([GUEST_ONE_PLACE_MSG.ko, GUEST_ONE_PLACE_MSG.en]).toContain(add.body.error.message)
  expect((await rooms(gus.client)).map((r) => r.id)).toEqual([room])
  // members still make group chats and add each other
  const ok = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [pia.id, otto.id], name: 'fine' })
  expect(ok.kind).toBe('group')
  await mia.client.call('POST', `/api/rooms/${ok.id}/members`, { userIds: [nora.id] })
})

test('adding people: a guest adds only people of their place (an outsider: 403), not into another chat', async () => {
  const { mia, nora, otto, pia, owner, gus } = await setup('a-guests-rooms-add')
  // a second group chat with gus's people but not gus
  const room2 = await groupChat(nora.client, [otto.id, mia.id], 'members only')
  // in their own place: pia (an outsider) refused
  const own = (await rooms(gus.client))[0]!.id
  expect((await gus.client.try('POST', `/api/rooms/${own}/members`, { userIds: [pia.id] })).status).toBe(403)
  // a room they are not in: 404 as for anyone
  expect((await gus.client.try('POST', `/api/rooms/${room2}/members`, { userIds: [mia.id] })).status).toBe(404)
  // members add people as before
  await mia.client.call('POST', `/api/rooms/${own}/members`, { userIds: [pia.id] })
  expect(await peopleIds(gus.client)).toContain(pia.id)
  void owner
})

test('findPeople (the AI people lookup): a guest finds only the people of their place; members find everyone but the outside guest', async () => {
  const { mia, pia, gus } = await setup('a-guests-rooms-find')
  expect(findPeople(h.ctx.db, gus.id, 'PIA')).toBeNull()
  expect(findPeople(h.ctx.db, gus.id, `person:${pia.id}`)).toBeNull()
  const m = findPeople(h.ctx.db, gus.id, 'MIA')
  expect(m && 'one' in m && m.one.id).toBe(mia.id)
  expect(findPeople(h.ctx.db, pia.id, 'GUS')).toBeNull()
  const p = findPeople(h.ctx.db, pia.id, 'MIA')
  expect(p && 'one' in p && p.one.id).toBe(mia.id)
  const g = findPeople(h.ctx.db, mia.id, 'GUS')
  expect(g && 'one' in g && g.one.id).toBe(gus.id)
})

test('room settings: a guest changes their own notification level, never the room name', async () => {
  const { mia, room, gus } = await setup('a-guests-rooms-patch')
  expect((await gus.client.try('PATCH', `/api/rooms/${room}`, { name: 'mine now' })).status).toBe(403)
  const r = await gus.client.call('PATCH', `/api/rooms/${room}`, { notifyLevel: 'mentions' })
  expect(r.notifyLevel ?? r.id).toBeTruthy()
  const named = await mia.client.call('PATCH', `/api/rooms/${room}`, { name: 'Client chat' })
  expect(named.name).toBe('Client chat')
})

test('mentions (QA M7): a guest mentions people of their place; anyone else stays plain text, the words are never cut', async () => {
  const { mia, nora, pia, room, gus } = await setup('a-guests-rooms-mentions')
  const body = 'Hello from the guest, @MIA and @PIA'
  const sent = await gus.client.call('POST', `/api/rooms/${room}/messages`, { body, mentions: [mia.id, pia.id], fileIds: [], clientMessageId: cm() })
  expect(sent.body).toBe(body)
  expect(sent.mentions).toEqual([mia.id])
  // as the others read it: the same words, mia mentioned and told (a mention notice); pia is not in it and hears nothing
  const read = ((await nora.client.call('GET', `/api/rooms/${room}/messages`)).items as { id: string; body: string; mentions: string[] }[]).find((m) => m.id === sent.id)!
  expect(read).toMatchObject({ body, mentions: [mia.id] })
  expect(((await mia.client.call('GET', '/api/rooms')).items as { id: string; mentioned: boolean }[]).find((r) => r.id === room)?.mentioned).toBe(true)
  // an edit keeps the same rule
  const edited = await gus.client.call('PATCH', `/api/rooms/${room}/messages/${sent.id}`, { body: `${body}!`, mentions: [pia.id, nora.id] })
  expect(edited).toMatchObject({ body: `${body}!`, mentions: [nora.id] })
})

test('removal from the one place switches the guest off: taken out by the manager', async () => {
  const { owner, mia, room, gus } = await setup('a-guests-rooms-remove')
  expect((await gus.client.call('GET', '/api/me')).user.role).toBe('guest')
  await mia.client.call('DELETE', `/api/rooms/${room}/members/${gus.id}`)
  expect((await gus.client.try('GET', '/api/me')).status).toBe(401)
  const users = (await owner.call('GET', '/api/admin/users')).items as { id: string; status: string; role: string }[]
  expect(users.find((u) => u.id === gus.id)).toMatchObject({ status: 'disabled', role: 'guest' })
  // members taken out stay on
  expect(users.find((u) => u.id === mia.id)!.status).toBe('active')
})

test('removal from the one place switches the guest off: they leave it themselves', async () => {
  const { owner, mia, room, gus } = await setup('a-guests-rooms-leave')
  await gus.client.call('POST', `/api/rooms/${room}/leave`)
  expect((await gus.client.try('GET', '/api/me')).status).toBe(401)
  const users = (await owner.call('GET', '/api/admin/users')).items as { id: string; status: string }[]
  expect(users.find((u) => u.id === gus.id)!.status).toBe('disabled')
  // a member who leaves stays on and the chat goes on
  await mia.client.call('POST', `/api/rooms/${room}/leave`)
  const after = (await owner.call('GET', '/api/admin/users')).items as { id: string; status: string }[]
  expect(after.find((u) => u.id === mia.id)!.status).toBe('active')
  expect((await mia.client.call('GET', '/api/me')).user.id).toBe(mia.id)
})

test('room lists and searches: a guest finds only their own chat; a member still finds the everyone room', async () => {
  const { owner, mia, room, gus } = await setup('a-guests-rooms-search')
  const all = (await rooms(owner)).find((r) => r.kind === 'all')!.id
  await owner.call('POST', `/api/rooms/${all}/messages`, { body: 'banana budget for the whole team', clientMessageId: cm() })
  await mia.client.call('POST', `/api/rooms/${room}/messages`, { body: 'banana plan for the client', clientMessageId: cm() })
  const found = (await gus.client.call('GET', '/api/room-messages?q=banana')).items as { roomId: string }[]
  expect(found.length).toBe(1)
  expect(found.every((x) => x.roomId === room)).toBe(true)
  const mine = (await mia.client.call('GET', '/api/room-messages?q=banana')).items as { roomId: string }[]
  expect(new Set(mine.map((x) => x.roomId))).toEqual(new Set([room, all]))
  const files = (await gus.client.call('GET', '/api/room-files?q=banana')).items as unknown[]
  expect(files).toHaveLength(0)
})

test("the room AI's wider-audience readers: a guest does not read team folders, a member does", async () => {
  const { mia, gus } = await setup('a-guests-rooms-readers')
  const rules = RuleSet.fromDb(h.ctx.db)
  const shared = readersOf(h.ctx.db, rules, ['shared'])
  expect(shared).toContain(mia.id)
  expect(shared).not.toContain(gus.id)
})
