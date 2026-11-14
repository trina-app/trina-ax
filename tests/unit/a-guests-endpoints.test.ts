// The guest endpoint allow-list (docs/DECISIONS.md "Guests: only what they were invited to"; server/src/auth/
// guest-endpoints.ts, enforced in server/src/http/route.ts enforceAuth): every contract endpoint not on the list is 403
// for a guest whatever its auth level, the listed ones pass the auth step, and nothing changes for a member. Then the
// same through the real server with a real guest (invite + accept).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { listEndpoints } from '@mycel/shared/api'
import { enforceAuth } from '../../server/src/http/route'
import { HttpError } from '../../server/src/http/errors'
import { GUEST_ENDPOINTS } from '../../server/src/auth/guest-endpoints'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const authOf = (role: 'guest' | 'member' | 'admin') => ({ user: { id: 'x', username: 'x', name: 'X', role, locale: 'en', mustChangePassword: false }, session: { id: 's', client: 'web', expiresAt: '' }, via: 'cookie' }) as any
const verdict = (ep: Parameters<typeof enforceAuth>[0], role: 'guest' | 'member' | 'admin'): string => {
  try { enforceAuth(ep, authOf(role)); return 'ok' } catch (e) { return e instanceof HttpError ? e.code : String(e) }
}

test('enforceAuth: a guest reaches only the allow-list; a member is judged as before', () => {
  const all = listEndpoints()
  const listed = all.filter(({ ep }) => GUEST_ENDPOINTS.has(ep))
  // the list holds only contract endpoints of level user, and every one of them is still in the contract
  expect(listed.length).toBe(GUEST_ENDPOINTS.size)
  for (const { name, ep } of listed) expect(`${name} ${ep.auth}`).toBe(`${name} user`)
  for (const { name, ep } of all) {
    if (ep.auth === 'public') { expect(`${name} ${verdict(ep, 'guest')}`).toBe(`${name} ok`); continue }
    const want = GUEST_ENDPOINTS.has(ep) ? 'ok' : 'forbidden'
    expect(`${name} ${verdict(ep, 'guest')}`).toBe(`${name} ${want}`)
    // a member: as before the allow-list (user endpoints pass, admin and owner ones do not)
    const member = ep.auth === 'user' ? 'ok' : 'forbidden'
    expect(`${name} ${verdict(ep, 'member')}`).toBe(`${name} ${member}`)
  }
  // the closed ones a guest must never reach, by name (a sample of the review's paths)
  const closed = new Set(['listSkills', 'listIntegrations', 'listSchedules', 'folderAudience', 'transcribe', 'createGuestInvite', 'createProject', 'putProjectParticipants', 'leaveProject', 'listUsers', 'createInvite', 'removeRoomMember', 'connectTurn', 'getMemberWelcome', 'requestAiAccess'])
  for (const { name, ep } of all) if (closed.has(name)) expect(`${name} ${GUEST_ENDPOINTS.has(ep)}`).toBe(`${name} false`)
})

test('a real guest: closed endpoints answer 403, their own ones work; a member still reaches them', async () => {
  h = await harness('a-guests-endpoints')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const project = await mia.client.call('POST', '/api/projects', { name: 'Quote', participants: [] })
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: project.id } })
  for (const [m, p] of [['GET', '/api/skills'], ['GET', '/api/integrations'], ['GET', '/api/schedules'], ['GET', '/api/admin/users'], ['GET', '/api/files/audience?path=projects/Quote'], ['POST', '/api/projects'], ['GET', '/api/me/welcome'], ['GET', '/api/engines'], ['GET', '/api/connectors/remote']] as const) {
    const r = await g.client.try(m, p, m === 'POST' ? { name: 'x' } : undefined)
    expect(`${m} ${p} ${r.status} ${r.body?.error?.code}`).toBe(`${m} ${p} 403 forbidden`)
  }
  // a guest invite is never theirs to make
  expect((await g.client.try('POST', '/api/guest-invites', { place: { kind: 'project', id: project.id } })).status).toBe(403)
  // their own: account, files of their project, projects, people, rooms
  expect((await g.client.call('GET', '/api/me')).user.role).toBe('guest')
  expect((await g.client.call('GET', '/api/files/tree?path=projects/Quote')).access).toBe('write')
  expect((await g.client.call('GET', '/api/projects')).items.map((p: any) => p.id)).toEqual([project.id])
  expect((await g.client.try('GET', '/api/people')).status).toBe(200)
  expect((await g.client.try('GET', '/api/rooms')).status).toBe(200)
  // a member is not touched by the list
  for (const p of ['/api/skills', '/api/schedules', '/api/files/audience?path=projects/Quote']) expect(`${p} ${(await mia.client.try('GET', p)).status}`).toBe(`${p} 200`)
})
