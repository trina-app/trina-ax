// Guests and projects (docs/DECISIONS.md "Guests: only what they were invited to"; guest-review paths 6 and the
// one-place rule). A project guest sees that one project in the list, its people, and their own chats there; other
// members' shared chats of it never (owner decision 2026-11-14: the guest's own chats stay visible to the members). A
// guest is in one place only: adding them to a second project (the members panel, a new project's people) is 409
// guest_one_place; taking them out of their project (a save without them, the project in the trash) switches the
// account off.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'
import { getChatRuntime } from '../../server/src/chat/runtime'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const quote = await mia.client.call('POST', '/api/projects', { name: 'Quote', participants: [{ subjectType: 'user', subjectId: nora.id }] })
  const secret = await mia.client.call('POST', '/api/projects', { name: 'Secret', participants: [{ subjectType: 'user', subjectId: otto.id }] })
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: quote.id } })
  return { owner, mia, nora, otto, quote, secret, g }
}
const access = (c: Client, id: string) => c.call('GET', `/api/projects/${id}/access`)
const put = async (c: Client, id: string, participants: unknown[]) => c.try('PUT', `/api/projects/${id}/participants`, { participants, expectedHash: (await access(c, id)).rulesHash })
const user = (id: string) => ({ subjectType: 'user', subjectId: id })
const status = (id: string) => (h.ctx.db.query('SELECT status FROM users WHERE id = ?').get(id) as { status: string }).status

test('projects: the guest lists and opens only their project; its people are the project people; a member is as before', async () => {
  const { mia, nora, otto, quote, secret, g } = await setup('a-guests-projects-list')
  expect((await g.client.call('GET', '/api/projects')).items.map((p: any) => p.id)).toEqual([quote.id])
  expect((await g.client.call('GET', `/api/projects/${quote.id}`)).id).toBe(quote.id)
  expect((await g.client.try('GET', `/api/projects/${secret.id}`)).status).toBe(404)
  expect((await g.client.try('GET', `/api/projects/${secret.id}/people`)).status).toBe(404)
  const people = await g.client.call('GET', `/api/projects/${quote.id}/people`)
  expect(people.people.map((p: any) => p.id).sort()).toEqual([g.id, mia.id, nora.id].sort())
  expect(people.groups).toBeUndefined()
  // the guest never manages it (members panel, access) and cannot leave it through the API (a guest has one place)
  expect((await g.client.try('GET', `/api/projects/${quote.id}/access`)).status).toBe(403)
  expect((await g.client.try('POST', `/api/projects/${quote.id}/leave`)).status).toBe(403)
  // members see both of theirs, as before
  expect((await otto.client.call('GET', '/api/projects')).items.map((p: any) => p.id)).toEqual([secret.id])
  expect((await mia.client.call('GET', '/api/projects')).items.map((p: any) => p.id).sort()).toEqual([quote.id, secret.id].sort())
})

test('project chats: a member\'s shared chat is not the guest\'s; the guest\'s own chat is visible to the members', async () => {
  const { mia, nora, quote, g } = await setup('a-guests-projects-chats')
  const noraChat = await nora.client.call('POST', '/api/chats', { projectId: quote.id, title: 'pricing talk' })
  expect(noraChat.shared).toBeTruthy()
  const gusChat = await g.client.call('POST', '/api/chats', { projectId: quote.id, title: 'guest question' })
  // the guest: their own chat only, in the list, the project's page and by id
  const listed = (await g.client.call('GET', `/api/chats?projectId=${quote.id}`)).items.map((c: any) => c.id)
  expect(listed).toEqual([gusChat.id])
  expect((await g.client.call('GET', '/api/chats')).items.map((c: any) => c.id)).not.toContain(noraChat.id)
  expect((await g.client.try('GET', `/api/chats/${noraChat.id}`)).status).toBe(404)
  expect((await g.client.try('GET', `/api/chats/${noraChat.id}/messages`)).status).toBe(404)
  const sent = await g.client.try('POST', `/api/chats/${noraChat.id}/messages`, { content: 'hi', clientMessageId: crypto.randomUUID() })
  expect(sent.status).toBe(404)
  // the project's count of shared chats says only theirs
  expect((await g.client.call('GET', `/api/projects/${quote.id}`)).sharedChats).toBe(1)
  // the members: both chats
  for (const m of [mia, nora]) {
    const ids = (await m.client.call('GET', `/api/chats?projectId=${quote.id}`)).items.map((c: any) => c.id).sort()
    expect(ids).toEqual([noraChat.id, gusChat.id].sort())
    expect((await m.client.call('GET', `/api/chats/${gusChat.id}`)).id).toBe(gusChat.id)
  }
  // the live updates of nora's chat go to the members, never to the guest (chat/runtime.ts publishChat)
  const rt = getChatRuntime(h.ctx)
  const told: string[] = []
  const pub = rt.hub.publish.bind(rt.hub)
  rt.hub.publish = ((uid: string, ev: any) => { if (ev?.type === 'chat.updated') told.push(uid); return pub(uid, ev) }) as typeof rt.hub.publish
  try { rt.publishChat(nora.id, noraChat.id, 'updated') } finally { rt.hub.publish = pub }
  expect(told.sort()).toEqual([mia.id, nora.id].sort())
  // the guest's own chat: the members are told, and the guest
  told.length = 0
  rt.hub.publish = ((uid: string, ev: any) => { if (ev?.type === 'chat.updated') told.push(uid); return pub(uid, ev) }) as typeof rt.hub.publish
  try { rt.publishChat(g.id, gusChat.id, 'updated') } finally { rt.hub.publish = pub }
  expect(told.sort()).toEqual([g.id, mia.id, nora.id].sort())
})

test('one place: a project guest added to a second project is 409 guest_one_place; their own project still saves', async () => {
  const { owner, mia, nora, quote, secret, g } = await setup('a-guests-projects-one-place')
  // the members panel of another project (its creator, and an admin)
  for (const c of [mia.client, owner]) {
    const r = await put(c, secret.id, [user('otto'), user(g.id)])
    expect(`${r.status} ${r.body?.error?.params?.reason}`).toBe('409 guest_one_place')
    expect(r.body.error.message).toContain('팀원')
  }
  // a new project with the guest among its people
  const made = await mia.client.try('POST', '/api/projects', { name: 'Third', participants: [user(g.id)] })
  expect(`${made.status} ${made.body?.error?.params?.reason}`).toBe('409 guest_one_place')
  // Admin › Folder permissions: a person rule for the guest on a team folder
  const folder = await owner.try('POST', '/api/admin/folders', { path: 'Handbook', rules: [{ subjectType: 'user', subjectId: g.id, access: 'read' }] })
  expect(`${folder.status} ${folder.body?.error?.params?.reason}`).toBe('409 guest_one_place')
  // nothing was written for them anywhere else
  expect(h.ctx.db.query("SELECT f.path FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE r.subject_type = 'user' AND r.subject_id = ? AND r.access <> 'none' ORDER BY f.path").all(g.id)).toEqual([{ path: 'projects/Quote' }])
  // their own project's people save as before, the guest kept
  const ok = await put(mia.client, quote.id, [user(nora.id), user(g.id)])
  expect(ok.status).toBe(200)
  expect(status(g.id)).toBe('active')
})

test('removal: a save that leaves the guest out switches the account off; trashing the project does too', async () => {
  const { mia, nora, quote, g } = await setup('a-guests-projects-removal')
  const before = await g.client.try('GET', '/api/me')
  expect(before.status).toBe(200)
  const r = await put(mia.client, quote.id, [user(nora.id)])
  expect(r.status).toBe(200)
  expect(status(g.id)).toBe('disabled')
  expect((await g.client.try('GET', '/api/me')).status).toBe(401)
  // the member who stayed is fine
  expect(status(nora.id)).toBe('active')
  expect((await nora.client.call('GET', '/api/projects')).items.map((p: any) => p.id)).toEqual([quote.id])
  // an admin may not switch them on again while they have no place
  const owner = h.client()
  await owner.login('olga', 'owner horse battery 42')
  const on = await owner.try('PATCH', `/api/admin/users/${g.id}`, { status: 'active' })
  expect(`${on.status} ${on.body?.error?.params?.reason}`).toBe('409 guest_no_place')

  // a second guest, in a project that goes to the trash
  const other = await mia.client.call('POST', '/api/projects', { name: 'Other', participants: [] })
  const g2 = await addGuest(h, mia.client, { username: 'gina', place: { kind: 'project', id: other.id } })
  expect(status(g2.id)).toBe('active')
  await mia.client.call('DELETE', `/api/projects/${other.id}`)
  expect(status(g2.id)).toBe('disabled')

  // a third, whose project's folder an admin puts in the trash from Files (Delete), not through the project
  const third = await owner.call('POST', '/api/projects', { name: 'Third', participants: [] })
  const g3 = await addGuest(h, owner, { username: 'gwen', place: { kind: 'project', id: third.id } })
  expect(status(g3.id)).toBe('active')
  await owner.call("DELETE", `/api/files?path=${encodeURIComponent(third.folderPath)}`)
  expect(status(g3.id)).toBe('disabled')
  expect((await g3.client.try('GET', '/api/me')).status).toBe(401)
})
