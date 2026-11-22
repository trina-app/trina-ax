// The Share dialog's "Ask <owner>" (QA TC-7230: POST /api/files/shared/:id/ask-for over FileShares.requestFor) and the
// owner's request card knowing the person is outside the file's project (QA TC-7231: fileShare.outside). A project
// member who may not share another member's file asks its owner to share it with someone; the owner's existing Share
// grants it. Fixture: olga = owner; alice made the project and its file; bob is in the project; carl is not.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let alice: Client, bob: Client, carl: Client
let ids: Record<'alice' | 'bob' | 'carl', string>
let file = ''
let linkId = ''
const notices = async (c: Client) => ((await c.call('GET', '/api/notifications?limit=50')).items as any[]).filter((n) => String(n.eventType).startsWith('file.'))

beforeAll(async () => {
  h = await harness('c-file-share-ask-for')
  const owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'alice' })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl' })
  alice = a.client; bob = b.client; carl = c.client
  ids = { alice: a.id, bob: b.id, carl: c.id }
  const p = await alice.call('POST', '/api/projects', { name: 'Launch', scope: 'team', participants: [{ subjectType: 'user', subjectId: b.id, access: 'write' }] })
  const folder = (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(p.id) as { folder_path: string }).folder_path
  file = `${folder}/plan.txt`
  await alice.call('PUT', '/api/files/content', { path: file, content: 'plan', baseSha256: null })
  linkId = (await bob.call('POST', '/api/files/link', { path: file })).id
}, 60_000)
afterAll(() => h.close())

test('a project member who may not share the file asks its owner for someone outside the project; Share grants it', async () => {
  const view = await bob.call('GET', `/api/files/shares?path=${encodeURIComponent(file)}`)
  expect(view).toMatchObject({ canShare: false, mine: false, owner: { id: ids.alice } })
  expect(await bob.call('POST', `/api/files/shared/${linkId}/ask-for`, { people: [ids.carl] })).toEqual({ asked: 1, already: 0 })
  // asked again: waiting already, nothing new
  expect(await bob.call('POST', `/api/files/shared/${linkId}/ask-for`, { people: [ids.carl] })).toEqual({ asked: 0, already: 1 })
  const n = (await notices(alice)).find((x) => x.eventType === 'file.access_requested')
  expect(n.fileShare).toMatchObject({ by: 'BOB', for: 'CARL', name: 'plan.txt', state: 'pending', canAnswer: true, outside: 'project' })
  const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'file.access_request' ORDER BY id DESC LIMIT 1").get() as { detail: string }
  expect(JSON.parse(audit.detail)).toMatchObject({ for: 1, via: 'dialog' })
  expect(await alice.call('POST', `/api/files/requests/${n.fileShare.requestId}`, { answer: 'approve' })).toEqual({ state: 'approved' })
  expect((await carl.call('GET', `/api/files/shared/${linkId}`)).status).toBe('open')
  // answered: no outside line, no buttons
  const after = (await notices(alice)).find((x) => x.eventType === 'file.access_requested')
  expect(after.fileShare.outside).toBeUndefined()
  expect(after.fileShare.canAnswer).toBeUndefined()
})

test('the owner may share it herself (409), and someone who cannot open it learns nothing (404)', async () => {
  expect((await alice.try('POST', `/api/files/shared/${linkId}/ask-for`, { people: [ids.bob] })).status).toBe(409)
  const other = `users/${ids.alice}/own.txt`
  await alice.call('PUT', '/api/files/content', { path: other, content: 'own', baseSha256: null })
  const id = (await alice.call('POST', '/api/files/link', { path: other })).id
  expect((await bob.try('POST', `/api/files/shared/${id}/ask-for`, { people: [ids.carl] })).status).toBe(404)
  // a request for a file in a personal folder: no project line on the card
  expect((await bob.call('POST', `/api/files/shared/${id}/request`, {})).status).toBe('sent')
  const n = (await notices(alice)).find((x) => x.eventType === 'file.access_requested' && x.fileShare?.name === 'own.txt')
  expect(n.fileShare).toMatchObject({ by: 'BOB', canAnswer: true })
  expect(n.fileShare.outside).toBeUndefined()
})
