// A "shared with you" notice whose file no longer opens (docs/decisions/20261120-file-share-gone-notice.md): who shared
// it while their account is there, why when the server recorded it (stopped, deleted, moved; nothing else), never the
// file's name or link, and once read it drops out of Activity's list (an unread one stays; the notice itself still
// opens by its id). The line the web shows: web/test/unit/file-share-gone-text.test.ts. Fixture: olga = owner, adam = admin; alice, carl = Sales; bob; dave (a member removed later).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileSharesOf } from '../../server/src/files/shares'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, alice: Client, bob: Client, carl: Client, dave: Client
let ids: Record<'alice' | 'bob' | 'carl' | 'dave', string>
const q = (p: string) => '?path=' + encodeURIComponent(p)
const put = (c: Client, p: string, content = 'x') => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })
const share = (c: Client, p: string, add: { subjectType: 'user' | 'group'; subjectId: string }[], remove: typeof add = []) => c.call('PUT', '/api/files/shares', { path: p, add, remove })
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
const list = async (c: Client) => (await c.call('GET', '/api/notifications?limit=100')).items as any[]
/** bob's file.shared notice of this link, as the list shows it (null: not listed) */
const noticeOf = async (linkId: string) => {
  const row = h.ctx.db.query("SELECT id FROM file_share_notices WHERE user_id = ? AND event_type = 'file.shared' AND source_id = ?").get(ids.bob, linkId) as { id: string } | null
  if (!row) throw new Error('no notice row')
  return { id: row.id, listed: (await list(bob)).find((n) => n.id === row.id) ?? null }
}
/** nothing in the notice names the file or links to it */
const private_ = (n: any, fileName: string) => {
  expect(JSON.stringify(n)).not.toContain(fileName)
  expect(n.link).toBeNull()
  expect(n.fileShare.name).toBeNull()
  expect(n.fileShare.linkId).toBeNull()
}

beforeAll(async () => {
  h = await harness('c-file-share-gone-notice')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  const sales = (await a.client.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  const al = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl', groupIds: [sales] })
  const d = await addMember(h, owner, { username: 'dave' })
  alice = al.client; bob = b.client; carl = c.client; dave = d.client
  ids = { alice: al.id, bob: b.id, carl: c.id, dave: d.id }
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'sales'), { recursive: true })
  await a.client.call('POST', '/api/admin/folders', { path: 'sales', limited: true, rules: [{ subjectType: 'group', subjectId: sales, access: 'write' }] })
  // a folder Sales edits and dave reads (not bob): a move from it into sales/ narrows who can open it
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'proj'), { recursive: true })
  await a.client.call('POST', '/api/admin/folders', { path: 'proj', limited: true, rules: [{ subjectType: 'group', subjectId: sales, access: 'write' }, { subjectType: 'user', subjectId: d.id, access: 'read' }] })
}, 60_000)
afterAll(() => h.close())

describe('why a shared file no longer opens', () => {
  test('the sharer takes me off: who shared it, "stopped", no name', async () => {
    const p = `users/${ids.alice}/stop-report.txt`
    await put(alice, p, 'r')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    expect((await noticeOf(l.id)).listed.fileShare).toMatchObject({ by: 'ALICE', name: 'stop-report.txt' })
    await share(alice, p, [], [user(ids.bob)])
    const { listed: n } = await noticeOf(l.id)
    expect(n.fileShare).toMatchObject({ by: 'ALICE', gone: true, why: 'stopped' })
    private_(n, 'stop-report')
  })

  test('the file goes to the trash: "deleted"; restored, the notice names it again', async () => {
    const p = `users/${ids.alice}/trash-plan.txt`
    await put(alice, p, 't')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    const del = await alice.call('DELETE', '/api/files' + q(p))
    const { listed: n } = await noticeOf(l.id)
    expect(n.fileShare).toMatchObject({ by: 'ALICE', gone: true, why: 'deleted' })
    private_(n, 'trash-plan')
    await alice.call('POST', `/api/files/trash/${del.trashId}/restore`)
    expect((await noticeOf(l.id)).listed.fileShare).toMatchObject({ by: 'ALICE', name: 'trash-plan.txt', linkId: l.id })
  })

  test('someone moves it where I cannot open it: "moved", never where to', async () => {
    await put(alice, 'proj/move-budget.txt', 'm')
    const { link: l } = await share(alice, 'proj/move-budget.txt', [user(ids.bob)])
    await carl.call('POST', '/api/files/move', { from: 'proj/move-budget.txt', to: 'sales/move-budget.txt' })
    const { listed: n } = await noticeOf(l.id)
    expect(n.fileShare).toMatchObject({ by: 'ALICE', gone: true, why: 'moved' })
    private_(n, 'move-budget')
    expect(JSON.stringify(n)).not.toContain('sales')
  })

  test('a different file on the disk at its path: who shared it, no reason (the server records none)', async () => {
    const p = `users/${ids.alice}/disk-swap.txt`
    await put(alice, p, 'v1')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    const abs = path.join(h.ctx.files.fx.root, 'users', ids.alice, 'disk-swap.txt')
    fs.rmSync(abs)
    fs.writeFileSync(abs, 'another file entirely')
    const { listed: n } = await noticeOf(l.id)
    expect(n.fileShare).toMatchObject({ by: 'ALICE', gone: true })
    expect(n.fileShare.why).toBeUndefined()
    private_(n, 'disk-swap')
  })

  test('a stop older than a share again does not count: the file opens and is named', async () => {
    const p = `users/${ids.alice}/again.txt`
    await put(alice, p, 'a')
    await share(alice, p, [user(ids.bob)])
    await share(alice, p, [], [user(ids.bob)])
    const { link: l } = await share(alice, p, [user(ids.bob)])
    expect((await noticeOf(l.id)).listed.fileShare).toMatchObject({ by: 'ALICE', name: 'again.txt' })
    expect((await noticeOf(l.id)).listed.fileShare.gone).toBeUndefined()
  })

  test('the sharer is no longer in the team: no name, no reason, still no file name', async () => {
    await put(dave, `users/${ids.dave}/dave-notes.txt`, 'd')
    const { link: l } = await share(dave, `users/${ids.dave}/dave-notes.txt`, [user(ids.bob)])
    expect((await noticeOf(l.id)).listed.fileShare).toMatchObject({ by: 'DAVE', name: 'dave-notes.txt' })
    h.ctx.db.query("UPDATE users SET status = 'disabled', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), ids.dave)
    const { listed: n } = await noticeOf(l.id)
    expect(n.fileShare).toMatchObject({ by: null, gone: true })
    expect(n.fileShare.why).toBeUndefined()
    private_(n, 'dave-notes')
  })

  test('the share row itself gone (its owner removed): a bare line', () => {
    const n = fileSharesOf(h.ctx).noticeOut({ id: 'x', user_id: ids.bob, event_type: 'file.shared', source_id: 'no-such-share-id-00000', created_at: new Date().toISOString(), read_at: null })
    expect(n.link).toBeNull()
    expect(n.fileShare).toEqual({ by: null, name: null, linkId: null, gone: true })
  })
})

describe('a gone share notice in the list', () => {
  test('unread it stays (muted, nothing to open); read it drops out of the list but still opens by its id', async () => {
    const p = `users/${ids.alice}/drop-me.txt`
    await put(alice, p, 'x')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    await share(alice, p, [], [user(ids.bob)])
    const { id, listed } = await noticeOf(l.id)
    expect(listed).not.toBeNull()
    expect(listed.readAt).toBeNull()
    const read = await bob.call('POST', `/api/notifications/${id}/read`)
    expect(read.fileShare).toMatchObject({ gone: true, why: 'stopped' })
    expect((await noticeOf(l.id)).listed).toBeNull()
    // the notice by its id (what a push opens) still answers, without the file
    const one = await bob.call('GET', `/api/notifications/${id}`)
    expect(one.fileShare).toMatchObject({ by: 'ALICE', gone: true })
    private_(one, 'drop-me')
  })

  test('a read share notice whose file still opens stays listed', async () => {
    const p = `users/${ids.alice}/keep-me.txt`
    await put(alice, p, 'k')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    const { id } = await noticeOf(l.id)
    await bob.call('POST', `/api/notifications/${id}/read`)
    expect((await noticeOf(l.id)).listed.fileShare).toMatchObject({ name: 'keep-me.txt' })
  })
})

