// A guest into a personal project (docs/DECISIONS.md "Guests into a personal project"). Nobody else ever reads a
// personal folder (users/<id>/), so POST /api/guest-invites refuses a personal project (a guest let in would land in
// nothing); the invite picker first shares it as the project's own "Add people" does (POST /api/projects/:id/share
// with nobody else yet): it becomes a team project in projects/<name> that still only I see, and the guest who joins is
// its first other person. Their files are the guest's to open; my chats are not.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('a personal project: refused as a guest place until shared; shared with nobody yet it stays only mine, then the guest joins it', async () => {
  h = await harness('a-guests-personal-project')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const p = await mia.client.call('POST', '/api/projects', { name: 'Offer', scope: 'personal' })
  expect(p.folderPath.startsWith(`users/${mia.id}/`)).toBe(true)
  await mia.client.call('PUT', '/api/files/content', { path: `${p.folderPath}/price.txt`, content: 'banana price', baseSha256: null })
  const before = await mia.client.call('POST', '/api/chats', { projectId: p.id, title: 'before the guest' })
  const place = { kind: 'project' as const, id: p.id }

  // a personal project is no guest place: not for its creator, not for the owner (403, the same answer as a place one
  // may not open a guest into)
  expect((await mia.client.try('POST', '/api/guest-invites', { place })).status).toBe(403)
  expect((await owner.try('POST', '/api/guest-invites', { place })).status).toBe(403)

  // shared with nobody else yet (the picker's step before Create link): a team project in projects/ that only I see
  const shared = await mia.client.call('POST', `/api/projects/${p.id}/share`, { participants: [] })
  expect(shared.folderPath.startsWith('projects/')).toBe(true)
  const mine = await mia.client.call('GET', `/api/projects/${p.id}`)
  expect(mine.audience).toBe(1)
  // its new chats are shared with its members from now on; the one from before stays mine
  const after = await mia.client.call('POST', '/api/chats', { projectId: p.id, title: 'after the share' })
  expect(after.shared).toBeTruthy()
  expect((await mia.client.call('GET', `/api/chats/${before.id}`)).shared).toBeFalsy()

  // now the invite is made and the guest joins: two people see it (it moves to Team projects)
  const g = await addGuest(h, mia.client, { username: 'gus', place })
  const seen = await mia.client.call('GET', `/api/projects/${p.id}`)
  expect(seen.audience).toBe(2)
  // ...but a shared chat of it is never the guest's (QA TC-b4s s2: "2명이 이 채팅을 볼 수 있어요" counted them): the
  // chat's count and a new chat's count leave the guest out
  expect(seen.chatAudience).toBe(1)
  expect((await mia.client.call('GET', `/api/chats/${after.id}`)).shared.audience).toBe(1)
  const people = await mia.client.call('GET', `/api/projects/${p.id}/people`)
  expect(people.people.map((x: any) => x.id).sort()).toEqual([mia.id, g.id].sort())
  // the guest: this one project and its folder, its files (moved along with it), none of my chats (shared or not)
  expect((await g.client.call('GET', '/api/projects')).items.map((x: any) => x.id)).toEqual([p.id])
  expect((await g.client.call('GET', `/api/files/content?path=${encodeURIComponent(`${shared.folderPath}/price.txt`)}`)).content).toBe('banana price')
  expect((await g.client.call('GET', `/api/chats?projectId=${p.id}`)).items).toEqual([])
  for (const c of [before, after]) expect((await g.client.try('GET', `/api/chats/${c.id}`)).status).toBe(404)
  // the guest's own new chat there: they and mia see it
  expect((await g.client.call('GET', `/api/projects/${p.id}`)).chatAudience).toBe(2)
})

test('an invite made for a project that was personal stays refused at accept if it is somehow personal again', async () => {
  // (the accept re-checks inviteMakerOk: an invite row naming a personal project, however it came to be, lets nobody in)
  h = await harness('a-guests-personal-project-accept')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const team = await mia.client.call('POST', '/api/projects', { name: 'Team one', scope: 'team' })
  const inv = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'project', id: team.id } })
  const personal = await mia.client.call('POST', '/api/projects', { name: 'Private one', scope: 'personal' })
  h.ctx.db.query('UPDATE invites SET guest_place_id = ? WHERE id = ?').run(personal.id, inv.invite.id)
  const token = String(inv.url).split('/invite/')[1]!
  const r = await h.client({ ip: '10.0.0.9' }).try('POST', `/api/invites/${token}/accept`, { username: 'gus', name: 'Gus', password: 'guest river lamp 77' })
  expect(r.status).toBeGreaterThanOrEqual(400)
  expect(h.ctx.db.query("SELECT 1 FROM users WHERE username = 'gus'").get()).toBeNull()
})
