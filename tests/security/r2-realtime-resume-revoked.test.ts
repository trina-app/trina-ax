// Security round 2 (realtime #1): a realtime resume replayed the person's buffered events with no permission check.
// bob (group finance) went offline, the owner made groups/finance/LAYOFF-LIST-…md and groups/finance/acquisition-of-ACME…,
// then removed bob from finance. HTTP answered 404 for the folder, but reconnecting with epoch + after=<old seq> (or
// after=0 from a brand-new login) replayed both names from the buffer. Now every access change drops the replay
// buffer of each person it touches (resume -> resync, the window reloads over REST), and a resume re-checks every
// files.changed / files.conflict entry against the rules as they are now (anything that no longer passes -> resync).
// Real server, real sessions, real WebSocket (tests/security/lib/instance.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEV_SESSION_COOKIE, WS_PROTOCOL } from '@mycel/shared/api'
import { startInstance, Socket, SETUP_TOKEN, type Client, type Instance } from './lib/instance'

let inst: Instance
let owner: Client
let bob: Client
let carol: Client
const BOB_PW = 'Kx7-quartz-plover-91!'
const CAROL_PW = 'Kx7-quartz-heron-42!'
let fin: { id: string; path: string }
let n = 0

async function open(c: Client, q: Record<string, string>): Promise<Socket> {
  const ws = new WebSocket(`${c.inst.url.replace('http', 'ws')}/api/ws?${new URLSearchParams(q)}`,
    { headers: { origin: c.inst.url, cookie: `${DEV_SESSION_COOKIE}=${c.cookie}` }, protocols: [WS_PROTOCOL] } as unknown as string[])
  const s = new Socket(ws, c.label)
  await new Promise<void>((r) => { ws.addEventListener('open', () => r()); ws.addEventListener('close', () => r()) })
  await s.next('hello')
  return s
}

/** open a window, note epoch/seq, close it (the person is now offline with a buffer) */
async function goOffline(c: Client): Promise<{ windowId: string; epoch: string; seq: number }> {
  const windowId = `win-${c.label}-${++n}`
  const s = await open(c, { windowId })
  const hello = await s.next('hello')
  s.close()
  await s.closedWith()
  return { windowId, epoch: hello.epoch, seq: hello.seq }
}

/** resume and give the replay a moment to arrive */
async function resume(c: Client, windowId: string, epoch: string, after: number): Promise<Socket> {
  const s = await open(c, { windowId, epoch, after: String(after) })
  await Bun.sleep(300)
  return s
}

async function newMember(username: string, name: string, pw: string, groups: string[] = []): Promise<Client> {
  const u = await owner.ok('POST', '/api/admin/users', { username, name, role: 'member', id: username, locale: 'en' })
  const c = inst.client(username)
  await c.login(username, u.temporaryPassword)
  await c.ok('POST', '/api/auth/password', { currentPassword: u.temporaryPassword, newPassword: pw })
  if (groups.length) await owner.ok('PATCH', `/api/admin/users/${username}`, { groupIds: groups })
  return c
}

const write = (p: string) => owner.ok('PUT', '/api/files/content', { path: p, content: 'secret\n', baseSha256: null })

beforeAll(async () => {
  inst = await startInstance('r2-realtime-resume')
  owner = inst.client('dana')
  await owner.ok('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'T', locale: 'en', owner: { username: 'dana', name: 'Dana', password: 'Owner-pw-123456!' } })
  const g = await owner.ok('POST', '/api/admin/groups', { name: 'finance', memberIds: [] })
  const folders = (await owner.ok('GET', '/api/admin/folders')).items as { path: string }[]
  fin = { id: g.id, path: folders.find((f) => f.path.startsWith('groups/') && f.path.includes('finance'))!.path }
  bob = await newMember('bob', 'Bob', BOB_PW, [g.id])
  carol = await newMember('carol', 'Carol', CAROL_PW, [g.id])
})
afterAll(async () => { await inst?.close() })

describe('realtime resume after access was revoked', () => {
  test('control: a member who keeps access gets the replay (resume still works for sharing)', async () => {
    const off = await goOffline(carol)
    await write(`${fin.path}/q3-board-pack-OK1.md`)
    const s = await resume(carol, off.windowId, off.epoch, off.seq)
    expect(s.frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(s.all()).toContain('q3-board-pack-OK1.md')
    expect(s.frames.some((f) => f.type === 'resync')).toBe(false)
    s.close()
  })

  test('removed from the group while offline: resume (old seq, and after=0 from a new login) is a resync with no names', async () => {
    const off = await goOffline(bob)
    const carolOff = await goOffline(carol)
    await write(`${fin.path}/LAYOFF-LIST-Q4-ZQ9.md`)
    await owner.ok('POST', '/api/files/mkdir', { path: `${fin.path}/acquisition-of-ACME-ZQ9` })
    await owner.ok('PATCH', `/api/admin/groups/${fin.id}`, { memberIds: ['carol'] })
    expect((await bob.req('GET', `/api/files/tree?path=${encodeURIComponent(fin.path)}`)).status).toBe(404)

    const a = await resume(bob, off.windowId, off.epoch, off.seq)
    expect(a.frames[0]).toMatchObject({ type: 'hello', resumed: false })
    expect(a.frames.some((f) => f.type === 'resync')).toBe(true)
    expect(a.all()).not.toContain('ZQ9')
    a.close()

    // another device, signed in after the change, asking for everything still buffered
    const phone = inst.client('bob-phone')
    await phone.login('bob', BOB_PW)
    const b = await resume(phone, 'win-bob-phone', off.epoch, 0)
    expect(b.frames.some((f) => f.type === 'resync')).toBe(true)
    expect(b.all()).not.toContain('ZQ9')
    b.close()

    // carol (still a member, her access did not change) keeps her replay
    const c = await resume(carol, carolOff.windowId, carolOff.epoch, carolOff.seq)
    expect(c.frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(c.all()).toContain('LAYOFF-LIST-Q4-ZQ9.md')
    c.close()

    // control: nothing published after the removal reaches bob live
    const live = await open(bob, { windowId: `win-bob-live-${++n}` })
    await write(`${fin.path}/POST-REVOKE-ZQ9.md`)
    await Bun.sleep(300)
    expect(live.all()).not.toContain('ZQ9')
    live.close()
  })

  test('the access_changed notice published with the change is still replayed to a window that saw everything before it', async () => {
    await owner.ok('PATCH', `/api/admin/groups/${fin.id}`, { memberIds: ['carol', 'bob'] })
    const s0 = await open(bob, { windowId: `win-bob-${++n}` })
    const hello = await s0.next('hello')
    s0.close(); await s0.closedWith()
    // nothing else happens to bob before the removal: his window has seen everything up to `hello.seq`
    await owner.ok('PATCH', `/api/admin/groups/${fin.id}`, { memberIds: ['carol'] })
    const s = await resume(bob, `win-bob-${n}`, hello.epoch, hello.seq)
    expect(s.frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(s.frames.some((f) => f.type === 'notice' && (f as any).data.code === 'access_changed')).toBe(true)
    s.close()
  })

  test('second check: access narrowed behind afterAccessChange\'s back is still re-checked at resume', async () => {
    await owner.ok('PATCH', `/api/admin/groups/${fin.id}`, { memberIds: ['carol', 'bob'] })
    const off = await goOffline(bob)
    await write(`${fin.path}/RIF-PLAN-XK7.md`)
    // straight in the DB: no afterAccessChange, so the buffer is not dropped; only the resume check stands
    inst.ctx.db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(fin.id, 'bob')
    const s = await resume(bob, off.windowId, off.epoch, off.seq)
    expect(s.frames.some((f) => f.type === 'resync')).toBe(true)
    expect(s.all()).not.toContain('XK7')
    s.close()
  })

  test('disabled and enabled again: nothing buffered before is replayed', async () => {
    await owner.ok('PATCH', `/api/admin/groups/${fin.id}`, { memberIds: ['carol', 'bob'] })
    const off = await goOffline(bob)
    await write(`${fin.path}/before-disable-DZ4.md`)
    await owner.ok('PATCH', '/api/admin/users/bob', { status: 'disabled' })
    await owner.ok('PATCH', '/api/admin/users/bob', { status: 'active' })
    const again = inst.client('bob-again')
    await again.login('bob', BOB_PW)
    const s = await resume(again, off.windowId, off.epoch, off.seq)
    expect(s.frames.some((f) => f.type === 'resync')).toBe(true)
    expect(s.all()).not.toContain('DZ4')
    s.close()
  })
})
