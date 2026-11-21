// QA TC-3848 follow-up: the live room.updated that shows or hides a team room's Files button (server/src/rooms/service.ts
// groupFoldersChanged) is published after afterAccessChange empties the person's replay buffer, so it is kept: a window
// that saw everything before the rule change resumes with the access_changed notice and the room without the button
// (no resync), and a window that already had the new event resumes with nothing more. Real server, real sessions, real
// WebSocket (tests/security/lib/instance.ts), as tests/unit/b-realtime-resume-access-changed.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { DEV_SESSION_COOKIE, WS_PROTOCOL } from '@mycel/shared/api'
import { startInstance, Socket, SETUP_TOKEN, type Client, type Instance } from '../security/lib/instance'

setDefaultTimeout(30_000)

let inst: Instance
let owner: Client
let bob: Client
let leads: { groupId: string; folderId: string; roomId: string }

async function open(c: Client, q: Record<string, string>): Promise<Socket> {
  const ws = new WebSocket(`${c.inst.url.replace('http', 'ws')}/api/ws?${new URLSearchParams(q)}`,
    { headers: { origin: c.inst.url, cookie: `${DEV_SESSION_COOKIE}=${c.cookie}` }, protocols: [WS_PROTOCOL] } as unknown as string[])
  const s = new Socket(ws, c.label)
  await new Promise<void>((r) => { ws.addEventListener('open', () => r()); ws.addEventListener('close', () => r()) })
  await s.next('hello')
  return s
}

beforeAll(async () => {
  inst = await startInstance('b-rooms-group-folder-resume')
  owner = inst.client('dana')
  await owner.ok('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'T', locale: 'en', owner: { username: 'dana', name: 'Dana', password: 'Owner-pw-123456!' } })
  const u = await owner.ok('POST', '/api/admin/users', { username: 'bob', name: 'Bob', role: 'member', id: 'bob', locale: 'en' })
  bob = inst.client('bob')
  await bob.login('bob', u.temporaryPassword)
  await bob.ok('POST', '/api/auth/password', { currentPassword: u.temporaryPassword, newPassword: 'Kx7-quartz-plover-91!' })
  await owner.ok('POST', '/api/admin/users', { username: 'cara', name: 'Cara', role: 'member', id: 'cara', locale: 'en' })
  const g = await owner.ok('POST', '/api/admin/groups', { name: 'leads', memberIds: ['bob', 'cara'] })
  const folderId = (inst.ctx.db.query('SELECT folder_id FROM groups WHERE id = ?').get(g.id) as { folder_id: string }).folder_id
  const room = ((await bob.ok('GET', '/api/rooms')).items as { id: string; kind: string; groupId: string | null; groupFolder?: string }[]).find((r) => r.kind === 'team' && r.groupId === g.id)!
  expect(room.groupFolder).toBe('groups/leads')
  leads = { groupId: g.id, folderId, roomId: room.id }
})
afterAll(async () => { await inst?.close() })

const buttonEvent = (s: Socket) => s.frames.find((f) => f.type === 'room.updated' && (f as any).data.roomId === leads.roomId && (f as any).data.change === 'updated') as any

describe('resume after the Files button event', () => {
  test('a window from before the rule change resumes with the notice and the room without the button, not resync', async () => {
    // the window stays open through the rule change, so it has seen everything before it (a late event of the setup
    // included); closed only then, it resumes from just before the notice. (Taking hello.seq raced such an event: the
    // change dropped it with the rest of the buffer and the resume was rightly a resync; CI, PR #1088.)
    const s0 = await open(bob, { windowId: 'win-bob-1' })
    const hello = await s0.next('hello')
    // the folder open to cara alone: bob loses it
    await owner.ok('PUT', `/api/admin/folders/${leads.folderId}/rules`, { rules: [{ subjectType: 'user', subjectId: 'cara', access: 'read' }] })
    const notice = await s0.next('notice', (f) => f.data.code === 'access_changed')
    s0.close(); await s0.closedWith()
    const s = await open(bob, { windowId: 'win-bob-1', epoch: hello.epoch, after: String(notice.seq - 1) })
    await Bun.sleep(300)
    expect(s.frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(s.frames.some((f) => f.type === 'resync')).toBe(false)
    expect(s.frames.some((f) => f.type === 'notice' && (f as any).data.code === 'access_changed')).toBe(true)
    const ev = buttonEvent(s)
    expect(ev).toBeDefined()
    expect(ev.data.room.groupFolder).toBeUndefined()
    s.close(); await s.closedWith()

    // a window that already had that event resumes after it: nothing more, still no resync
    const s2 = await open(bob, { windowId: 'win-bob-1', epoch: hello.epoch, after: String(ev.seq) })
    await Bun.sleep(300)
    expect(s2.frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(s2.frames.some((f) => f.type === 'resync')).toBe(false)
    expect(buttonEvent(s2)).toBeUndefined()
    s2.close()
  })

  test('the folder opens again: an open window gets the button live, and a resume from just before it replays it', async () => {
    const live = await open(bob, { windowId: 'win-bob-2' })
    const hello = await live.next('hello')
    await owner.ok('PUT', `/api/admin/folders/${leads.folderId}/rules`, { rules: [{ subjectType: 'group', subjectId: leads.groupId, access: 'read' }] })
    const ev = await live.next('room.updated', (f) => f.data.roomId === leads.roomId && f.data.change === 'updated')
    expect(ev.data.room.groupFolder).toBe('groups/leads')
    live.close(); await live.closedWith()
    const s = await open(bob, { windowId: 'win-bob-2', epoch: hello.epoch, after: String(hello.seq) })
    await Bun.sleep(300)
    expect(s.frames[0]).toMatchObject({ type: 'hello', resumed: true })
    expect(buttonEvent(s)?.data.room.groupFolder).toBe('groups/leads')
    s.close()
  })
})
