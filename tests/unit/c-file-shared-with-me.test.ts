// Files › Shared with me and opening a shared file marks its notice read (file sharing P2, PR 1; server/src/files/
// shares.ts sharedWithMe, sharerFor, pinState; docs/decisions/20261116-files-shared-with-me.md).
// Fixture: olga = owner, adam = admin; alice, carl = Sales; bob; gina is a guest. `sales/` only Sales (and staff) read.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FILE_SHARE_EVERYONE } from '@mycel/shared/api'
import { encodeSharedCursor, FILE_SHARES_CHANGED, fileSharesOf, SHARED_WITH_ME_LSTATS } from '../../server/src/files/shares'
import { runAccountCleanups } from '../../server/src/auth/account-removal'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client, gina: Client
let ids: Record<'olga' | 'adam' | 'alice' | 'bob' | 'carl' | 'gina', string>
let sales: string
const ALL = { subjectType: 'group' as const, subjectId: FILE_SHARE_EVERYONE }
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
const group = (id: string) => ({ subjectType: 'group' as const, subjectId: id })
const put = (c: Client, p: string, content = 'x') => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })
const share = (c: Client, p: string, add: { subjectType: 'user' | 'group'; subjectId: string }[], remove: typeof add = []) => c.call('PUT', '/api/files/shares', { path: p, add, remove })
const list = async (c: Client, q = '') => (await c.call('GET', `/api/files/shared-with-me${q}`)) as { items: { linkId: string; name: string; sharedBy: string | null; sharedAt: string }[]; next: string | null }
const ids_ = async (c: Client) => (await list(c)).items.map((i) => i.linkId)
const page = (c: Client, id: string) => c.call('GET', `/api/files/shared/${id}`)
const abs = (p: string) => path.join(h.ctx.files.fx.root, ...p.split('/'))
const changedEvents = () => h.hub.events.filter((e) => (e.data as { data?: { code?: string } })?.data?.code === 'file_shares_changed')
/** file_shares_changed goes from a timer (at most one a second): wait for one more than `before` */
async function waitChanged(before: number) {
  for (let i = 0; i < 40 && changedEvents().length <= before; i++) await Bun.sleep(50)
  return changedEvents().length
}

beforeAll(async () => {
  h = await harness('c-file-shared-with-me')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  admin = a.client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  const al = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl', groupIds: [sales] })
  const g = await addMember(h, owner, { username: 'gina' })
  alice = al.client; bob = b.client; carl = c.client; gina = g.client
  const olga = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  ids = { olga, adam: a.id, alice: al.id, bob: b.id, carl: c.id, gina: g.id }
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'sales'), { recursive: true })
  await admin.call('POST', '/api/admin/folders', { path: 'sales', limited: true, rules: [{ subjectType: 'group', subjectId: sales, access: 'write' }] })
  // a guest last (an access change switches off a guest in no place: the first test asks while gina is still on)
  h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(g.id)
}, 60_000)
afterAll(() => h.close())

describe('what is listed', () => {
  test('a guest: 403 (not in the guest endpoints), and the service refuses too', async () => {
    expect((await gina.raw('GET', '/api/files/shared-with-me')).status).toBe(403)
    expect(() => fileSharesOf(h.ctx).sharedWithMe(ids.gina, undefined)).toThrow()
  })

  test('a file shared by name: its name, who and when; no path, size, type or owner in the answer; never the sharer\'s own list', async () => {
    const p = `users/${ids.alice}/plan.txt`
    await put(alice, p, 'plan')
    const { link } = await share(alice, p, [user(ids.bob)])
    const r = await list(bob)
    const row = r.items.find((i) => i.linkId === link.id)!
    expect(row).toEqual({ linkId: link.id, name: 'plan.txt', sharedBy: 'ALICE', sharedAt: expect.any(String) })
    const raw = JSON.stringify(r)
    expect(raw).not.toContain('/')
    for (const k of ['size', 'mime', 'avatarVersion', 'path', 'owner']) expect(raw).not.toContain(`"${k}"`)
    expect(await ids_(alice)).not.toContain(link.id)
    // not for someone it was not shared with, the owner and admins included
    for (const c of [carl, owner, admin]) expect(await ids_(c)).not.toContain(link.id)
  })

  test('a group\'s share is listed for its people when the folder does not let them read it', async () => {
    const p = `users/${ids.alice}/sales-brief.txt`
    await put(alice, p, 'brief')
    const { link } = await share(alice, p, [group(sales)])
    expect(await ids_(carl)).toContain(link.id)
    for (const c of [bob, owner]) expect(await ids_(c)).not.toContain(link.id)
  })

  test('a file the folder already lets me read: hidden when shared with Everyone or my group, listed when shared with me by name', async () => {
    await put(alice, 'shared/handbook.txt', 'hb')
    const { link } = await share(alice, 'shared/handbook.txt', [ALL])
    for (const c of [bob, carl, admin]) expect(await ids_(c)).not.toContain(link.id)
    await share(alice, 'shared/handbook.txt', [user(ids.bob)])
    expect(await ids_(bob)).toContain(link.id)
    expect(await ids_(carl)).not.toContain(link.id)
    // the link page names the same sharer, though bob opens it by the folder rules
    expect(await page(bob, link.id)).toMatchObject({ status: 'open', sharedBy: 'ALICE' })
  })

  test('Everyone on the team: a personal file is listed for a member who joins later', async () => {
    const p = `users/${ids.alice}/all-hands.txt`
    await put(alice, p, 'ah')
    const { link } = await share(alice, p, [ALL])
    const d = await addMember(h, owner, { username: 'dina' })
    expect(await ids_(d.client)).toContain(link.id)
  })

  test('the newest qualifying grant names the sharer, in the list and on the link page', async () => {
    // a file in sales/ (bob cannot read it): shared with Sales by adam, then with bob by name by olga
    await put(admin, 'sales/q3.txt', 'q3')
    await share(admin, 'sales/q3.txt', [group(sales)])
    await Bun.sleep(5)
    const { link } = await share(owner, 'sales/q3.txt', [user(ids.bob)])
    expect((await list(bob)).items.find((i) => i.linkId === link.id)?.sharedBy).toBe('Olga Owner')
    await Bun.sleep(5)
    // carl (in Sales) is then also named by olga: his newest grant is olga's
    await share(owner, 'sales/q3.txt', [user(ids.carl)])
    expect((await page(carl, link.id)).sharedBy).toBe('Olga Owner')
  })

  test('newest first', async () => {
    const a = `users/${ids.alice}/older.txt`, b = `users/${ids.alice}/newer.txt`
    await put(alice, a, 'o'); await put(alice, b, 'n')
    const la = (await share(alice, a, [user(ids.bob)])).link.id
    await Bun.sleep(5)
    const lb = (await share(alice, b, [user(ids.bob)])).link.id
    const got = await ids_(bob)
    expect(got.indexOf(lb)).toBeLessThan(got.indexOf(la))
    expect(got.indexOf(lb)).toBe(0)
  })

  test('paging returns every row once (55 files shared in one press, the same time); a bad cursor is 400', async () => {
    const e = await addMember(h, owner, { username: 'emil' })
    const paths = Array.from({ length: 55 }, (_, i) => `users/${e.id}/n-${String(i).padStart(2, '0')}.txt`)
    for (const p of paths) await put(e.client, p, p)
    await e.client.call('POST', '/api/files/shares/batch', { paths, add: [user(ids.carl)] })
    const made = (h.ctx.db.query(`SELECT id FROM file_shares WHERE path LIKE 'users/${e.id}/n-%'`).all() as { id: string }[]).map((r) => r.id)
    expect(made.length).toBe(55)
    const first = await list(carl)
    expect(first.items.length).toBe(50)
    expect(first.next).not.toBeNull()
    const second = await list(carl, `?cursor=${first.next}`)
    const all = [...first.items, ...second.items].map((i) => i.linkId)
    expect(new Set(all).size).toBe(all.length)
    for (const id of made) expect(all).toContain(id)
    expect(second.next).toBeNull()
    expect((await carl.raw('GET', '/api/files/shared-with-me?cursor=nope!')).status).toBe(400)
    expect((await carl.raw('GET', `/api/files/shared-with-me?cursor=${Buffer.from('x|y').toString('base64url')}`)).status).toBe(400)
    // a forged cursor pages only through the caller's own grants
    const forged = await list(bob, `?cursor=${encodeSharedCursor('9999-01-01T00:00:00.000Z', 'A'.repeat(22))}`)
    for (const i of forged.items) expect(made).not.toContain(i.linkId)
  })
})

describe('what leaves the list (and the live notice)', () => {
  test('removed (✕), trashed, restored: the list follows, and file_shares_changed goes to every member, content-free', async () => {
    const p = `users/${ids.alice}/live.txt`
    await put(alice, p, 'live')
    let n = changedEvents().length
    const { link } = await share(alice, p, [user(ids.bob)])
    n = await waitChanged(n)
    const ev = changedEvents().at(-1)!
    expect(ev.target).toBe('*')
    expect(ev.data).toEqual(FILE_SHARES_CHANGED)
    expect(await ids_(bob)).toContain(link.id)
    const del = await alice.call('DELETE', `/api/files?path=${encodeURIComponent(p)}`)
    n = await waitChanged(n)
    expect(await ids_(bob)).not.toContain(link.id)
    await alice.call('POST', `/api/files/trash/${del.trashId}/restore`)
    n = await waitChanged(n)
    expect(await ids_(bob)).toContain(link.id)
    await share(alice, p, [], [user(ids.bob)])
    await waitChanged(n)
    expect(await ids_(bob)).not.toContain(link.id)
  })

  test('at most one notice a second, however many changes', async () => {
    await Bun.sleep(1100)
    const n = changedEvents().length
    for (let i = 0; i < 5; i++) fileSharesOf(h.ctx).changedSoon()
    await Bun.sleep(50)
    expect(changedEvents().length).toBe(n + 1)
    fileSharesOf(h.ctx).changedSoon()
    await Bun.sleep(300)
    expect(changedEvents().length).toBe(n + 1)
    await waitChanged(n + 1)
    expect(changedEvents().length).toBe(n + 2)
  })

  test('someone taken out of the group loses the group\'s file; the save sends the notice', async () => {
    const p = `users/${ids.alice}/group-out.txt`
    await put(alice, p, 'go')
    const { link } = await share(alice, p, [group(sales)])
    expect(await ids_(carl)).toContain(link.id)
    await Bun.sleep(1100)
    const n = changedEvents().length
    await admin.call('PATCH', `/api/admin/users/${ids.carl}`, { groupIds: [] })
    await waitChanged(n)
    expect(changedEvents().length).toBeGreaterThan(n)
    expect(await ids_(carl)).not.toContain(link.id)
    await admin.call('PATCH', `/api/admin/users/${ids.carl}`, { groupIds: [sales] })
  })

  test('a team file whose owner can no longer edit it leaves; the link still opens by the folder rules', async () => {
    fs.mkdirSync(abs('shared/narrow'), { recursive: true })
    await put(alice, 'shared/narrow/x.txt', 'x')
    const { link } = await share(alice, 'shared/narrow/x.txt', [user(ids.bob)])
    expect(await ids_(bob)).toContain(link.id)
    // everyone may read shared/narrow, only the owner and admins write: alice loses edit
    await admin.call('POST', '/api/admin/folders', { path: 'shared/narrow', create: false, limited: true, rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }], removeFileLinks: false })
    expect(await ids_(bob)).not.toContain(link.id)
    expect((await page(bob, link.id)).status).toBe('open')
  })

  test('replaced outside the app: another size is not listed; the same size is listed until a click checks it; the list writes nothing', async () => {
    const a = `users/${ids.alice}/out-a.txt`, b = `users/${ids.alice}/out-b.txt`
    await put(alice, a, 'aaaa')
    await put(alice, b, 'bbbb')
    const la = (await share(alice, a, [user(ids.bob)])).link.id
    const lb = (await share(alice, b, [user(ids.bob)])).link.id
    fs.unlinkSync(abs(a)); fs.writeFileSync(abs(a), 'a much longer file')
    fs.unlinkSync(abs(b)); fs.writeFileSync(abs(b), 'BBBB')
    const before = h.ctx.db.query('SELECT id, state, ino, ctime_ms FROM file_shares WHERE id IN (?, ?) ORDER BY id').all(la, lb)
    const got = await ids_(bob)
    expect(got).not.toContain(la)
    expect(got).toContain(lb)
    expect(h.ctx.db.query('SELECT id, state, ino, ctime_ms FROM file_shares WHERE id IN (?, ?) ORDER BY id').all(la, lb)).toEqual(before)
    expect((await page(bob, lb)).status).toBe('no_access')
    expect(await ids_(bob)).not.toContain(lb)
  })

  test('the lstat cap: a page may come back empty with `next` set; reading on finds the rest', async () => {
    const f = await addMember(h, owner, { username: 'fern' })
    const keep = `users/${f.id}/keep.txt`
    await put(f.client, keep, 'keep')
    const kept = (await share(f.client, keep, [user(ids.adam)])).link.id
    // then more than the cap of newer shares whose files went outside the app (each costs a look on disk)
    await Bun.sleep(5)
    const gone = Array.from({ length: SHARED_WITH_ME_LSTATS + 5 }, (_, i) => `users/${f.id}/gone-${i}.txt`)
    for (const p of gone) await put(f.client, p, 'g')
    for (let i = 0; i < gone.length; i += 100) await f.client.call('POST', '/api/files/shares/batch', { paths: gone.slice(i, i + 100), add: [user(ids.adam)] })
    for (const p of gone) fs.unlinkSync(abs(p))
    let r = await list(admin)
    let found = r.items.map((i) => i.linkId)
    expect(r.items.length).toBe(0)
    expect(r.next).not.toBeNull()
    for (let i = 0; i < 10 && r.next; i++) { r = await list(admin, `?cursor=${r.next}`); found = [...found, ...r.items.map((x) => x.linkId)] }
    expect(found).toContain(kept)
  })
})

describe('account removal', () => {
  test('the sharer who owned the file: its row goes; a sharer who did not own it: "a former member"', async () => {
    const m = await addMember(h, owner, { username: 'mina' })
    await put(m.client, 'shared/mina-plan.txt', 'mp')
    const own = (await share(m.client, 'shared/mina-plan.txt', [user(ids.bob)])).link.id
    // an admin (ana) shares leo's team file in sales/ with bob
    const ana = await addMember(h, owner, { username: 'ana', role: 'admin' })
    const leo = await addMember(h, owner, { username: 'leo', groupIds: [sales] })
    await put(leo.client, 'sales/leo-q3.txt', 'q3')
    const other = (await share(ana.client, 'sales/leo-q3.txt', [user(ids.bob)])).link.id
    for (const u of [m.id, ana.id]) {
      h.ctx.db.query("UPDATE users SET deleted_at = ?, status = 'disabled' WHERE id = ?").run(new Date().toISOString(), u)
      await runAccountCleanups(h.ctx, u)
    }
    const r = await list(bob)
    expect(r.items.map((i) => i.linkId)).not.toContain(own)
    expect(r.items.find((i) => i.linkId === other)?.sharedBy).toBeNull()
    expect(await page(bob, other)).toMatchObject({ status: 'open', sharedBy: null, formerSharer: true })
  })
})

describe('opening a file marks its notice read (page() only)', () => {
  test('one file: its Activity row turns read when the link page opens it, not when Activity lists it', async () => {
    const p = `users/${ids.alice}/read-me.txt`
    await put(alice, p, 'r')
    const { link } = await share(alice, p, [user(ids.carl)])
    const row = () => h.ctx.db.query("SELECT read_at FROM file_share_notices WHERE user_id = ? AND event_type = 'file.shared' AND source_id = ?").get(ids.carl, link.id) as { read_at: string | null }
    await carl.call('GET', '/api/notifications?limit=50')
    await list(carl)
    expect(row().read_at).toBeNull()
    const before = h.hub.events.filter((e) => e.target === ids.carl && (e.data as any)?.data?.code === 'notifications.changed').length
    await page(carl, link.id)
    expect(row().read_at).not.toBeNull()
    expect(h.hub.events.filter((e) => e.target === ids.carl && (e.data as any)?.data?.code === 'notifications.changed').length).toBeGreaterThan(before)
  })

  test('a press of several files: opening one marks the press\'s notice read', async () => {
    const paths = ['p1.txt', 'p2.txt', 'p3.txt'].map((n) => `users/${ids.alice}/press/${n}`)
    for (const p of paths) await put(alice, p, p)
    await alice.call('POST', '/api/files/shares/batch', { paths, add: [user(ids.carl)] })
    const n = h.ctx.db.query("SELECT source_id, read_at FROM file_share_notices WHERE user_id = ? AND source_id LIKE 'b:%' ORDER BY created_at DESC LIMIT 1").get(ids.carl) as { source_id: string; read_at: string | null }
    expect(n.read_at).toBeNull()
    const files = (await carl.call('GET', `/api/files/shared-batch/${n.source_id.slice(2)}`)).files
    expect(h.ctx.db.query('SELECT read_at FROM file_share_notices WHERE source_id = ? AND user_id = ?').get(n.source_id, ids.carl)).toEqual({ read_at: null })
    await page(carl, files[0].linkId)
    expect((h.ctx.db.query('SELECT read_at FROM file_share_notices WHERE source_id = ? AND user_id = ?').get(n.source_id, ids.carl) as { read_at: string | null }).read_at).not.toBeNull()
  })

  test('someone else opening it marks nothing of mine', async () => {
    const p = `users/${ids.alice}/two.txt`
    await put(alice, p, 't')
    const { link } = await share(alice, p, [user(ids.carl), user(ids.bob)])
    await page(bob, link.id)
    expect(h.ctx.db.query("SELECT read_at FROM file_share_notices WHERE user_id = ? AND source_id = ?").get(ids.carl, link.id)).toEqual({ read_at: null })
  })
})
