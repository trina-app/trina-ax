// "Everyone on the team" for a file and one notice for several files shared in one press (QA TC-3509, TC-3510;
// server/src/files/shares.ts, files/share-push.ts; docs/decisions/20261116-file-share-everyone.md).
// Fixture: olga = owner, adam = admin; alice, carl = Sales; bob; gina is a guest. dave joins later.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FILE_SHARE_EVERYONE, FILE_SHARE_MAX } from '@mycel/shared/api'
import { fileSharesOf } from '../../server/src/files/shares'
import { FILE_SHARE_TEXT } from '../../server/src/files/share-text'
import { fileSharePushWanted } from '../../server/src/files/share-push'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { runAccountCleanups } from '../../server/src/auth/account-removal'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client, gina: Client
let ids: Record<'olga' | 'adam' | 'alice' | 'bob' | 'carl' | 'gina', string>
let sales: string
const ALL = { subjectType: 'group' as const, subjectId: FILE_SHARE_EVERYONE }
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
const q = (p: string) => '?path=' + encodeURIComponent(p)
const put = (c: Client, p: string, content = 'x') => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })
const share = (c: Client, p: string, add: { subjectType: 'user' | 'group'; subjectId: string }[], remove: typeof add = []) => c.call('PUT', '/api/files/shares', { path: p, add, remove })
const many = (c: Client, paths: string[], add: { subjectType: 'user' | 'group'; subjectId: string }[]) => c.call('POST', '/api/files/shares/batch', { paths, add })
const page = (c: Client, id: string) => c.call('GET', `/api/files/shared/${id}`)
const fileNotices = async (c: Client) => ((await c.call('GET', '/api/notifications?limit=100')).items as any[]).filter((n) => n.eventType === 'file.shared')
const lastAudit = (action: string) => h.ctx.db.query('SELECT detail FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action) as { detail: string }

beforeAll(async () => {
  h = await harness('c-file-share-everyone')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  admin = a.client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  const al = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl', groupIds: [sales] })
  const g = await addMember(h, owner, { username: 'gina' })
  h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(g.id)
  alice = al.client; bob = b.client; carl = c.client; gina = g.client
  const olga = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  ids = { olga, adam: a.id, alice: al.id, bob: b.id, carl: c.id, gina: g.id }
}, 60_000)
afterAll(() => h.close())

describe('Everyone on the team (TC-3509)', () => {
  test('a member shares their own file with everyone: every member and the owner and admins open it, never a guest; one row, one audit', async () => {
    const p = `users/${ids.alice}/handbook.txt`
    await put(alice, p, 'handbook')
    const v = await share(alice, p, [ALL])
    expect(v.people).toEqual([{ subjectType: 'group', subjectId: FILE_SHARE_EVERYONE, name: FILE_SHARE_TEXT.everyone!.ko, everyone: true }])
    const id = v.link.id
    for (const c of [bob, carl, owner, admin]) expect(await page(c, id)).toMatchObject({ status: 'open', name: 'handbook.txt', sharedBy: 'ALICE' })
    expect((await gina.raw('GET', `/api/files/shared/${id}`)).status).toBe(403)
    expect([403, 404]).toContain((await gina.raw('GET', `/api/files/shared/${id}/download`)).status)
    const d = JSON.parse(lastAudit('file.share').detail)
    expect(d).toMatchObject({ personal: true, people: 0, groups: 0, everyone: true })
  })

  test('someone who joins later opens it too; a member switched off, or turned into a guest, does not', async () => {
    const p = `users/${ids.alice}/later.txt`
    await put(alice, p, 'later')
    const id = (await share(alice, p, [ALL])).link.id
    const d = await addMember(h, owner, { username: 'dave' })
    expect(await page(d.client, id)).toMatchObject({ status: 'open' })
    h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(d.id)
    expect(fileSharesOf(h.ctx).open(d.id, id).kind).toBe('no_access')
    h.ctx.db.query('UPDATE users SET guest = 0, status = ? WHERE id = ?').run('disabled', d.id)
    expect(fileSharesOf(h.ctx).open(d.id, id).kind).toBe('no_access')
  })

  test('removing it takes it away from everyone; it counts as one of the 50', async () => {
    const p = `users/${ids.alice}/count.txt`
    await put(alice, p, 'count')
    const id = (await share(alice, p, [ALL])).link.id
    // 49 more entries fit beside it (people and a group), the 51st does not
    const extra = Array.from({ length: FILE_SHARE_MAX - 1 }, (_, i) => `ghost-${i}`)
    h.ctx.db.transaction(() => { for (const x of extra) h.ctx.db.query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?, 'user', ?, 'view', ?, ?, 'dialog')").run(id, x, ids.alice, new Date().toISOString()) })()
    const full = await alice.raw('PUT', '/api/files/shares', { path: p, add: [user(ids.bob)], remove: [] })
    expect(full.status).toBe(400)
    h.ctx.db.query("DELETE FROM file_share_grants WHERE share_id = ? AND subject_id LIKE 'ghost-%'").run(id)
    await share(alice, p, [], [ALL])
    expect(await page(bob, id)).toMatchObject({ status: 'no_access' })
  })

  test('the same rules as any share: a member only their own file, never while the team switch is off; admins any team file', async () => {
    await put(bob, 'shared/everyone-bob.txt', 'bob')
    expect((await carl.raw('PUT', '/api/files/shares', { path: 'shared/everyone-bob.txt', add: [ALL], remove: [] })).status).toBe(403)
    const v = await share(admin, 'shared/everyone-bob.txt', [ALL])
    expect(v.people.map((r: any) => r.subjectId)).toEqual([FILE_SHARE_EVERYONE])
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      const p = `users/${ids.bob}/off.txt`
      await put(bob, p, 'off')
      expect((await bob.raw('PUT', '/api/files/shares', { path: p, add: [ALL], remove: [] })).status).toBe(403)
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })

  test('the whole team never stands for a real group elsewhere: a project or a chat refuses it', async () => {
    const r = await alice.raw('POST', '/api/projects', { name: 'Star test', scope: 'team', participants: [ALL] })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  test('the team owner\'s Remove all and a narrowing move take it with the rest', async () => {
    const p = `users/${ids.carl}/all.txt`
    await put(carl, p, 'all')
    const id = (await share(carl, p, [ALL])).link.id
    expect(fileSharesOf(h.ctx).counts().people).toBeGreaterThanOrEqual(5)
    await owner.call('DELETE', '/api/admin/file-shares')
    expect(await page(bob, id)).toMatchObject({ status: 'no_access' })
  })
})

describe('one notice for several files in one press (TC-3510)', () => {
  test('a press of three files to bob by name and Sales: bob and Sales\' people get ONE notice each, which opens the list', async () => {
    const paths = ['a.txt', 'b.txt', 'c.txt'].map((n) => `users/${ids.alice}/press/${n}`)
    for (const p of paths) await put(alice, p, p)
    const before = { bob: (await fileNotices(bob)).length, carl: (await fileNotices(carl)).length }
    const r = await many(alice, paths, [user(ids.bob), { subjectType: 'group', subjectId: sales }])
    expect(r).toEqual({ shared: paths, failed: [] })
    const nb = await fileNotices(bob)
    expect(nb.length).toBe(before.bob + 1)
    expect(nb[0].fileShare).toMatchObject({ by: 'ALICE', name: null, count: 3 })
    const batch = nb[0].fileShare.batchId as string
    expect(nb[0].sourceId).toBe(`b:${batch}`)
    expect((await fileNotices(carl)).length).toBe(before.carl + 1)
    const list = await bob.call('GET', `/api/files/shared-batch/${batch}`)
    expect(list.by).toBe('ALICE')
    expect(list.files.map((f: any) => f.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    // someone the press did not tell: not found (an id says nothing)
    expect((await owner.raw('GET', `/api/files/shared-batch/${batch}`)).status).toBe(404)
    // only bob was added by name: only his notice is pushed
    const named = h.ctx.db.query("SELECT u.username, n.named FROM file_share_notices n JOIN users u ON u.id = n.user_id WHERE n.source_id = ? ORDER BY u.username").all(`b:${batch}`)
    expect(named).toEqual([{ username: 'alice', named: 0 }, { username: 'bob', named: 1 }, { username: 'carl', named: 0 }].filter((x) => x.username !== 'alice'))
    const bobNotice = h.ctx.db.query("SELECT id FROM file_share_notices WHERE user_id = ? AND source_id = ?").get(ids.bob, `b:${batch}`) as { id: string }
    const carlNotice = h.ctx.db.query("SELECT id FROM file_share_notices WHERE user_id = ? AND source_id = ?").get(ids.carl, `b:${batch}`) as { id: string }
    expect(fileSharePushWanted(h.ctx, bobNotice.id)).toBe(true)
    expect(fileSharePushWanted(h.ctx, carlNotice.id)).toBe(false)
    expect(pushPathOf(h.ctx, 'file.shared', bobNotice.id)).toBe(`/f/batch/${batch}`)
    // one file of it taken back: the list and the notice say two; all of them: the notice is gone, no push
    const first = (await alice.call('GET', '/api/files/shares' + q(paths[0]!))).link.id
    await share(alice, paths[0]!, [], [user(ids.bob), { subjectType: 'group', subjectId: sales }])
    expect((await bob.call('GET', `/api/files/shared-batch/${batch}`)).files.length).toBe(2)
    expect((await fileNotices(bob))[0].fileShare.count).toBe(2)
    expect(first).toBeTruthy()
    for (const p of paths.slice(1)) await share(alice, p, [], [user(ids.bob), { subjectType: 'group', subjectId: sales }])
    expect((await fileNotices(bob))[0].fileShare.gone).toBe(true)
    expect(fileSharePushWanted(h.ctx, bobNotice.id)).toBe(false)
  })

  test('a single file in a press reads as before; a file refused is listed with the server\'s words and the rest go', async () => {
    const mine = `users/${ids.alice}/single.txt`
    await put(alice, mine, 'single')
    await put(bob, 'shared/not-alices.txt', 'bob')
    const r = await many(alice, [mine, 'shared/not-alices.txt'], [user(ids.carl)])
    expect(r.shared).toEqual([mine])
    expect(r.failed).toEqual([{ path: 'shared/not-alices.txt', message: FILE_SHARE_TEXT.notOwner!.ko, reason: 'file_share_not_owner' }])
    const n = (await fileNotices(carl))[0]
    expect(n.fileShare).toMatchObject({ by: 'ALICE', name: 'single.txt' })
    expect(n.fileShare.batchId).toBeUndefined()
    const row = h.ctx.db.query('SELECT id, source_id FROM file_share_notices WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(ids.carl) as { id: string; source_id: string }
    expect(pushPathOf(h.ctx, 'file.shared', row.id)).toBe(`/f/${row.source_id}`)
  })

  test('the whole team in one press: every member one notice, none pushed (not by name); a guest none', async () => {
    const paths = ['x.txt', 'y.txt'].map((n) => `users/${ids.carl}/team/${n}`)
    for (const p of paths) await put(carl, p, p)
    const r = await many(carl, paths, [ALL])
    expect(r.failed).toEqual([])
    for (const id of [ids.alice, ids.bob, ids.olga, ids.adam]) {
      const rows = h.ctx.db.query("SELECT named FROM file_share_notices WHERE user_id = ? AND source_id LIKE 'b:%' ORDER BY created_at DESC LIMIT 1").all(id) as { named: number }[]
      expect(rows).toEqual([{ named: 0 }])
    }
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM file_share_notices WHERE user_id = ?").get(ids.gina)).toEqual({ n: 0 })
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM file_share_notices WHERE user_id = ?").get(ids.carl)).toEqual({ n: expect.any(Number) })
  })

  test('a press costs one send token per 10 files: 25 files go through in one press where 25 single shares would hit the budget', async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `users/${ids.bob}/bulk/f${i}.txt`)
    for (const p of paths) await put(bob, p, p)
    const r = await many(bob, paths, [user(ids.carl)])
    expect(r.shared.length).toBe(25)
    expect(r.failed).toEqual([])
  })

  test('at most 100 files and a guest or an unknown group refused before anything is written', async () => {
    expect((await alice.raw('POST', '/api/files/shares/batch', { paths: Array.from({ length: 101 }, (_, i) => `users/${ids.alice}/n${i}.txt`), add: [user(ids.bob)] })).status).toBe(400)
    const p = `users/${ids.alice}/guarded.txt`
    await put(alice, p, 'guarded')
    expect((await alice.raw('POST', '/api/files/shares/batch', { paths: [p], add: [user(ids.gina)] })).status).toBe(400)
    expect((await alice.raw('POST', '/api/files/shares/batch', { paths: [p], add: [{ subjectType: 'group', subjectId: 'no-such-group' }] })).status).toBe(400)
    expect((await alice.call('GET', '/api/files/shares' + q(p))).link).toBeNull()
    expect((await gina.raw('POST', '/api/files/shares/batch', { paths: [p], add: [user(ids.bob)] })).status).toBeGreaterThanOrEqual(400)
  })

  test('a deleted sharer: the account removal takes their presses; the list answers 404', async () => {
    const e = await addMember(h, owner, { username: 'erin' })
    const paths = ['1.txt', '2.txt'].map((n) => `users/${e.id}/go/${n}`)
    for (const p of paths) await put(e.client, p, p)
    await many(e.client, paths, [user(ids.bob)])
    const batch = (h.ctx.db.query('SELECT id FROM file_share_batches WHERE by_user = ?').get(e.id) as { id: string }).id
    expect((await bob.call('GET', `/api/files/shared-batch/${batch}`)).files.length).toBe(2)
    await runAccountCleanups(h.ctx, e.id)
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM file_share_batches WHERE id = ?').get(batch)).toEqual({ n: 0 })
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM file_share_batch_items WHERE batch_id = ?').get(batch)).toEqual({ n: 0 })
    expect((await bob.raw('GET', `/api/files/shared-batch/${batch}`)).status).toBe(404)
    const n = (await fileNotices(bob)).find((x) => x.sourceId === `b:${batch}`)
    expect(n?.fileShare?.gone ?? true).toBe(true)
  })
})

describe('no free probe of who exists; the budget by size (security review of #1038)', () => {
  test('a press of paths the caller may not share never checks the people: a guest and a member answer the same, and the tries end in 429', async () => {
    const p = await addMember(h, owner, { username: 'pia' })
    const bogus = ['shared/nope-1.txt', 'shared/nope-2.txt']
    const asGuest = await p.client.raw('POST', '/api/files/shares/batch', { paths: bogus, add: [user(ids.gina)] })
    const asMember = await p.client.raw('POST', '/api/files/shares/batch', { paths: bogus, add: [user(ids.bob)] })
    expect(asGuest.status).toBe(200)
    expect(asMember.status).toBe(200)
    const strip = (r: any) => r.failed.map((f: any) => [f.path, f.reason ?? null])
    expect(strip(await asGuest.json())).toEqual(strip(await asMember.json()))
    let limited = false
    for (let i = 0; i < 40 && !limited; i++) limited = (await p.client.raw('POST', '/api/files/shares/batch', { paths: bogus, add: [user(ids.gina)] })).status === 429
    expect(limited).toBe(true)
  })

  test('the single PUT takes the token before the people are checked: refused names end in 429 too', async () => {
    const q2 = await addMember(h, owner, { username: 'quill' })
    const f = `users/${q2.id}/probe.txt`
    await put(q2.client, f, 'probe')
    const first = await q2.client.raw('PUT', '/api/files/shares', { path: f, add: [user(ids.gina)], remove: [] })
    expect(first.status).toBe(400)
    let limited = false
    for (let i = 0; i < 40 && !limited; i++) limited = (await q2.client.raw('PUT', '/api/files/shares', { path: f, add: [{ subjectType: 'user', subjectId: `nobody-${i}` }], remove: [] })).status === 429
    expect(limited).toBe(true)
    // someone else's file: refused for the file first (403), no word about the people, no token
    expect((await q2.client.raw('PUT', '/api/files/shares', { path: `users/${ids.alice}/handbook.txt`, add: [user(ids.gina)], remove: [] })).status).toBe(404)
  })

  test('one token per 10 files: two presses of 100 use the burst, the third is refused; a press of 20 stays usable', async () => {
    const r = await addMember(h, owner, { username: 'remy' })
    const paths = Array.from({ length: 100 }, (_, i) => `users/${r.id}/hundred/f${i}.txt`)
    for (const p of paths) await put(r.client, p, p)
    expect((await r.client.raw('POST', '/api/files/shares/batch', { paths: paths.slice(0, 20), add: [user(ids.carl)] })).status).toBe(200)
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await r.client.raw('POST', '/api/files/shares/batch', { paths, add: [user(ids.carl)] })).status)
    expect(statuses).toContain(429)
  })
})
