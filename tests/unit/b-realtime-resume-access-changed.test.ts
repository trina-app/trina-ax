// QA TC-3837, copied from tests/security/r2-realtime-resume-revoked.test.ts (tests/security does not run in CI): taking
// someone out of a group clears their replay buffer twice in one request (afterAccessChange, then the rooms' sync for
// the group's team room). The second clear threw away the access_changed notice, so a window that had seen everything
// before the change got resync instead of the notice (docs/decisions/20261116-realtime-resume-access-changed.md).
// Real server, real sessions, real WebSocket (tests/security/lib/instance.ts).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { DEV_SESSION_COOKIE, WS_PROTOCOL } from '@mycel/shared/api'
import { startInstance, Socket, SETUP_TOKEN, type Client, type Instance } from '../security/lib/instance'

setDefaultTimeout(30_000)

let inst: Instance
let owner: Client
let bob: Client
let fin: { id: string; path: string }

async function open(c: Client, q: Record<string, string>): Promise<Socket> {
  const ws = new WebSocket(`${c.inst.url.replace('http', 'ws')}/api/ws?${new URLSearchParams(q)}`,
    { headers: { origin: c.inst.url, cookie: `${DEV_SESSION_COOKIE}=${c.cookie}` }, protocols: [WS_PROTOCOL] } as unknown as string[])
  const s = new Socket(ws, c.label)
  await new Promise<void>((r) => { ws.addEventListener('open', () => r()); ws.addEventListener('close', () => r()) })
  await s.next('hello')
  return s
}

beforeAll(async () => {
  inst = await startInstance('b-realtime-resume-access-changed')
  owner = inst.client('dana')
  await owner.ok('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'T', locale: 'en', owner: { username: 'dana', name: 'Dana', password: 'Owner-pw-123456!' } })
  const g = await owner.ok('POST', '/api/admin/groups', { name: 'finance', memberIds: [] })
  const folders = (await owner.ok('GET', '/api/admin/folders')).items as { path: string }[]
  fin = { id: g.id, path: folders.find((f) => f.path.startsWith('groups/') && f.path.includes('finance'))!.path }
  const u = await owner.ok('POST', '/api/admin/users', { username: 'bob', name: 'Bob', role: 'member', id: 'bob', locale: 'en' })
  bob = inst.client('bob')
  await bob.login('bob', u.temporaryPassword)
  await bob.ok('POST', '/api/auth/password', { currentPassword: u.temporaryPassword, newPassword: 'Kx7-quartz-plover-91!' })
  await owner.ok('PATCH', `/api/admin/users/bob`, { groupIds: [g.id] })
})
afterAll(async () => { await inst?.close() })

describe('realtime resume after a group removal', () => {
  test('a window that saw everything before the removal resumes with the access_changed notice, not resync', async () => {
    const s0 = await open(bob, { windowId: 'win-bob-1' })
    const hello = await s0.next('hello')
    s0.close(); await s0.closedWith()
    // the group has a team room: the removal also takes bob out of it (the second clear of the replay buffer)
    await owner.ok('PATCH', `/api/admin/groups/${fin.id}`, { memberIds: [] })
    const s = await open(bob, { windowId: 'win-bob-1', epoch: hello.epoch, after: String(hello.seq) })
    await Bun.sleep(300)
    expect(s.frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(s.frames.some((f) => f.type === 'resync')).toBe(false)
    expect(s.frames.some((f) => f.type === 'notice' && (f as any).data.code === 'access_changed')).toBe(true)
    expect(s.frames.some((f) => f.type === 'room.updated' && (f as any).data.change === 'removed')).toBe(true)
    s.close()
  })

  test('a window from before the last event it missed still gets resync', async () => {
    await owner.ok('PATCH', `/api/admin/groups/${fin.id}`, { memberIds: ['bob'] })
    const s0 = await open(bob, { windowId: 'win-bob-2' })
    const hello = await s0.next('hello')
    s0.close(); await s0.closedWith()
    await owner.ok('PUT', '/api/files/content', { path: `${fin.path}/BEFORE-REMOVAL-QX3.md`, content: 'x\n', baseSha256: null })
    await owner.ok('PATCH', `/api/admin/groups/${fin.id}`, { memberIds: [] })
    const s = await open(bob, { windowId: 'win-bob-2', epoch: hello.epoch, after: String(hello.seq) })
    await Bun.sleep(300)
    expect(s.frames[0]).toMatchObject({ type: 'hello', resumed: false })
    expect(s.frames.some((f) => f.type === 'resync')).toBe(true)
    expect(s.all()).not.toContain('QX3')
    s.close()
  })
})
