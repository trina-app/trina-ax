// Security regressions (permission audit round 1, realtime): what a person receives over /api/ws must never name a
// folder they cannot see, and a socket must not outlive its session.
//   1. files.changed for a restricted folder that is renamed or trashed was judged with the rules AFTER the change
//      (the folder's rules move with it), so the old path fell back to the parent's "everyone: write" and every
//      member got {path:'shared/<secret>', action:'delete'}.
//   2. The access_changed notice listed every deciding path whose access changed, including a restricted folder
//      created in that same request (a member's inherited access there went from write to none).
//   3. A socket was authenticated only at connect: after its session expired it kept receiving team events.
// Real app (real sessions, files and admin routes) with the real realtime hub on in-memory connections.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { WsClose, type ServerFrame } from '@mycel/shared/api'
import { Hub } from '../../server/src/realtime/hub'
import type { RealtimeConn } from '../../server/src/services'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

class MemConn implements RealtimeConn {
  sent: ServerFrame[] = []
  closed: { code: number; reason?: string } | null = null
  private cls: (() => void)[] = []
  send(d: string) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(d)) }
  close(code: number, reason?: string) { if (this.closed) return; this.closed = { code, reason }; for (const f of this.cls) f() }
  bufferedAmount() { return 0 }
  ping() {}
  onMessage() {}
  onClose(fn: () => void) { this.cls.push(fn) }
  text() { return JSON.stringify(this.sent) }
  of(type: string) { return this.sent.filter((f) => f.type === type) as any[] }
  clear() { this.sent = [] }
}

let h: Harness
let hub: Hub
let owner: Client
let hr: { client: Client; id: string }
let mallory: { client: Client; id: string; password: string }
let mal: MemConn

async function connect(c: Client, windowId: string): Promise<MemConn> {
  const conn = new MemConn()
  await hub.attach(conn, new Request(`http://team.localhost/api/ws?windowId=${windowId}`, { headers: { origin: 'http://team.localhost', cookie: c.cookie! } }), { ip: '10.0.0.7', via: 'test' })
  return conn
}

beforeAll(async () => {
  h = await harness('s1-realtime-leaks')
  hub = new Hub(h.ctx, { now: () => h.auth.now() })
  h.ctx.services.realtime = hub
  h.ctx.onClose(() => hub.close())
  owner = await withOwner(h)
  hr = await addMember(h, owner, { username: 'hrlead' })
  mallory = await addMember(h, owner, { username: 'mallory' })
  mal = await connect(mallory.client, 'win-mallory')
  expect(mal.of('hello').length).toBe(1)
})
afterAll(async () => { await h?.close() })

const restricted = () => [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'user', subjectId: hr.id, access: 'write' }]

describe('files.changed for a restricted folder', () => {
  test('renaming and trashing a folder hidden from mallory sends her nothing that names it', async () => {
    await owner.call('POST', '/api/admin/folders', { path: 'shared/Layoffs-2027-plan', create: true, rules: restricted() })
    await hr.client.call('PUT', '/api/files/content', { path: 'shared/Layoffs-2027-plan/list.md', content: 'names', baseSha256: null })
    // she cannot see it
    expect((await mallory.client.try('GET', '/api/files/tree?path=' + encodeURIComponent('shared/Layoffs-2027-plan'))).status).toBe(404)
    mal.clear()
    await hr.client.call('POST', '/api/files/move', { from: 'shared/Layoffs-2027-plan', to: 'shared/Layoffs-2027-final' })
    await hr.client.call('DELETE', '/api/files?path=' + encodeURIComponent('shared/Layoffs-2027-final'))
    expect(mal.text()).not.toContain('Layoffs')
    expect(mal.of('files.changed')).toEqual([])
    // restoring it from the trash: its rules come back with it, still nothing for her
    const trash = await hr.client.call('GET', '/api/files/trash')
    const item = trash.items.find((t: any) => t.originalPath === 'shared/Layoffs-2027-final')
    await hr.client.call('POST', `/api/files/trash/${item.id}/restore`)
    expect(mal.text()).not.toContain('Layoffs')
  })

  test('control: renaming and trashing a folder she can see still reaches her', async () => {
    await owner.call('POST', '/api/files/mkdir', { path: 'shared/Team-offsite' })
    mal.clear()
    await owner.call('POST', '/api/files/move', { from: 'shared/Team-offsite', to: 'shared/Team-offsite-2027' })
    expect(mal.of('files.changed').flatMap((f) => f.data.changes)).toContainEqual(expect.objectContaining({ path: 'shared/Team-offsite-2027', from: 'shared/Team-offsite', action: 'move' }))
    mal.clear()
    await owner.call('DELETE', '/api/files?path=' + encodeURIComponent('shared/Team-offsite-2027'))
    expect(mal.of('files.changed').flatMap((f) => f.data.changes)).toContainEqual(expect.objectContaining({ path: 'shared/Team-offsite-2027', action: 'delete' }))
  })

  test('control: a file moved out of the hidden folder into shared/ arrives as a create', async () => {
    await owner.call('POST', '/api/admin/folders', { path: 'shared/Board-room', create: true, rules: restricted() })
    await hr.client.call('PUT', '/api/files/content', { path: 'shared/Board-room/memo.md', content: 'x', baseSha256: null })
    mal.clear()
    await hr.client.call('POST', '/api/files/move', { from: 'shared/Board-room/memo.md', to: 'shared/memo.md' })
    const ch = mal.of('files.changed').flatMap((f) => f.data.changes)
    expect(ch).toEqual([expect.objectContaining({ path: 'shared/memo.md', action: 'create' })])
    expect(mal.text()).not.toContain('Board-room')
  })
})
