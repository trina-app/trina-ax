// A member shares their own file with chosen people (QA TC-3093, server/src/files/shares.ts; docs/DECISIONS.md "A member
// shares their own files"). Who owns a file (the event walk), the link's life with its file (move, trash, restore,
// purge, a different file at the same path), the dialog's rules, requests and their limits, the Activity rows, a move
// that narrows the audience, and the team owner's Remove all. The leak paths are in tests/security/file-shares.test.ts.
// Fixture: olga = owner, adam = admin; alice, carl = Sales; bob.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { creatorOf, fileSharesOf } from '../../server/src/files/shares'
import { fileEvent } from '../../server/src/files/store'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client
let ids: Record<'olga' | 'adam' | 'alice' | 'bob' | 'carl', string>
let sales: string
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const q = (p: string) => '?path=' + encodeURIComponent(p)
const put = (c: Client, p: string, content = 'x') => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })
const link = async (c: Client, p: string) => (await c.call('POST', '/api/files/link', { path: p })) as { id: string; url: string }
const share = (c: Client, p: string, add: { subjectType: 'user' | 'group'; subjectId: string }[], remove: typeof add = []) => c.call('PUT', '/api/files/shares', { path: p, add, remove })
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
const page = (c: Client, id: string) => c.call('GET', `/api/files/shared/${id}`)
const notices = async (c: Client) => ((await c.call('GET', '/api/notifications?limit=50')).items as any[]).filter((n) => String(n.eventType).startsWith('file.'))

beforeAll(async () => {
  h = await harness('c-file-shares')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  admin = a.client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  const al = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl', groupIds: [sales] })
  alice = al.client; bob = b.client; carl = c.client
  const olga = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  ids = { olga, adam: a.id, alice: al.id, bob: b.id, carl: c.id }
  // a folder only Sales (and owner/admins) can open
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'sales'), { recursive: true })
  await admin.call('POST', '/api/admin/folders', { path: 'sales', limited: true, rules: [{ subjectType: 'group', subjectId: sales, access: 'write' }] })
}, 60_000)
afterAll(() => h.close())

describe('who owns a file (creatorOf walks back from the current path)', () => {
  test('a plain save is its saver\'s; a move by someone else, an admin\'s move and a rename keep the owner', async () => {
    await put(alice, 'shared/own-a.txt')
    expect(creatorOf(h.ctx.db, 'shared/own-a.txt')).toBe(ids.alice)
    await bob.call('POST', '/api/files/move', { from: 'shared/own-a.txt', to: 'shared/moved/own-a.txt' }).catch(async () => {
      fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'moved'), { recursive: true })
      await bob.call('POST', '/api/files/move', { from: 'shared/own-a.txt', to: 'shared/moved/own-a.txt' })
    })
    expect(creatorOf(h.ctx.db, 'shared/moved/own-a.txt')).toBe(ids.alice)
    await admin.call('POST', '/api/files/move', { from: 'shared/moved/own-a.txt', to: 'shared/moved/renamed.txt' })
    expect(creatorOf(h.ctx.db, 'shared/moved/renamed.txt')).toBe(ids.alice)
  })

  test('a folder\'s move keeps the owner of the files in it', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'box'), { recursive: true })
    await put(carl, 'shared/box/in.txt')
    await bob.call('POST', '/api/files/move', { from: 'shared/box', to: 'shared/box2' })
    expect(creatorOf(h.ctx.db, 'shared/box2/in.txt')).toBe(ids.carl)
  })

  test('a copy is the copier\'s', async () => {
    await put(alice, 'shared/orig.txt')
    await bob.call('POST', '/api/files/copy', { from: 'shared/orig.txt', to: 'shared/copy.txt' })
    expect(creatorOf(h.ctx.db, 'shared/copy.txt')).toBe(ids.bob)
  })

  test('a reused path is the new file\'s; a trash restore follows the file back', async () => {
    await put(alice, 'shared/reuse.txt')
    const del = await alice.call('DELETE', '/api/files' + q('shared/reuse.txt'))
    await put(bob, 'shared/reuse.txt', 'new')
    expect(creatorOf(h.ctx.db, 'shared/reuse.txt')).toBe(ids.bob)
    // bob's file goes to the trash too, alice's comes back (" (restored)" when the name is taken)
    await bob.call('DELETE', '/api/files' + q('shared/reuse.txt'))
    await alice.call('POST', `/api/files/trash/${del.trashId}/restore`)
    expect(creatorOf(h.ctx.db, 'shared/reuse.txt')).toBe(ids.alice)
  })

  test('no event, or a delete first: nobody', () => {
    fs.writeFileSync(path.join(h.ctx.files.fx.root, 'shared', 'disk.txt'), 'made on the disk')
    expect(creatorOf(h.ctx.db, 'shared/disk.txt')).toBeNull()
    fileEvent(h.ctx.db, { turnId: null, userId: ids.alice, path: 'shared/gone.txt', action: 'create' })
    fileEvent(h.ctx.db, { turnId: null, userId: ids.alice, path: 'shared/gone.txt', action: 'delete', detail: {} })
    expect(creatorOf(h.ctx.db, 'shared/gone.txt')).toBeNull()
  })
})

describe('sharing and opening', () => {
  test('the owner shares a personal file; the link opens for the person added and nobody else', async () => {
    const p = `users/${ids.alice}/photo.txt`
    await put(alice, p, 'photo')
    const v = await share(alice, p, [user(ids.bob)])
    expect(v.canShare).toBe(true)
    expect(v.mine).toBe(true)
    expect(v.people.map((r: any) => r.subjectId)).toEqual([ids.bob])
    const id = v.link.id
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(await page(bob, id)).toMatchObject({ status: 'open', name: 'photo.txt', sharedBy: 'ALICE' })
    expect(await (await bob.raw('GET', `/api/files/shared/${id}/download`)).text()).toBe('photo')
    // carl and even the team owner: no access, nothing about the file
    for (const c of [carl, owner]) {
      const r = await page(c, id)
      expect(r).toEqual({ status: 'no_access', canAsk: true, askedAt: null })
      expect((await c.raw('GET', `/api/files/shared/${id}/download`)).status).toBe(404)
    }
    // the same link again: one row
    expect((await link(alice, p)).id).toBe(id)
    // bob got an Activity row naming the file and the sharer
    const n = (await notices(bob)).find((x) => x.eventType === 'file.shared')
    expect(n.fileShare).toMatchObject({ by: 'ALICE', name: 'photo.txt', linkId: id })
  })

  test('removing access takes it away at once', async () => {
    const p = `users/${ids.alice}/photo.txt`
    const { id } = await link(alice, p)
    await share(alice, p, [], [user(ids.bob)])
    expect((await page(bob, id)).status).toBe('no_access')
    expect((await bob.raw('GET', `/api/files/shared/${id}/download`)).status).toBe(404)
  })

  test('a group grant follows the group: someone who leaves it loses the file', async () => {
    const p = `users/${ids.alice}/group.txt`
    await put(alice, p, 'g')
    const v = await share(alice, p, [{ subjectType: 'group', subjectId: sales }])
    expect((await page(carl, v.link.id)).status).toBe('open')
    await admin.call('PATCH', `/api/admin/users/${ids.carl}`, { groupIds: [] }).catch(() => h.ctx.db.query('DELETE FROM group_members WHERE user_id = ?').run(ids.carl))
    expect((await page(carl, v.link.id)).status).toBe('no_access')
    h.ctx.db.query('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(sales, ids.carl)
  })

  test('a member shares only their own file, with edit access; a viewer\'s Copy link never makes them the owner', async () => {
    await put(bob, 'shared/bobs.txt')
    // alice can write shared/ but did not add it
    const r = await alice.try('PUT', '/api/files/shares', { path: 'shared/bobs.txt', add: [user(ids.carl)], remove: [] })
    expect(r.status).toBe(403)
    expect(r.body.error.params.reason).toBe('file_share_not_owner')
    // alice made the link first: the owner is still bob
    expect((await alice.call('GET', '/api/files/shares' + q('shared/bobs.txt'))).owner.id).toBe(ids.bob)
    const v = await share(bob, 'shared/bobs.txt', [user(ids.carl)])
    expect(v.owner.id).toBe(ids.bob)
    // the team owner and admins may share any team file
    expect((await share(admin, 'shared/bobs.txt', [user(ids.alice)])).canShare).toBe(true)
  })

  test('never a folder, never a guest, never oneself, never someone else\'s group (a member)', async () => {
    const p = `users/${ids.alice}/rules.txt`
    await put(alice, p)
    expect((await alice.try('PUT', '/api/files/shares', { path: `users/${ids.alice}`, add: [user(ids.bob)], remove: [] })).status).toBe(400)
    expect((await alice.try('POST', '/api/files/link', { path: 'shared' })).status).toBe(400)
    expect((await alice.try('PUT', '/api/files/shares', { path: p, add: [user(ids.alice)], remove: [] })).status).toBe(400)
    const other = (await admin.call('POST', '/api/admin/groups', { name: 'Ops' })).id
    expect((await alice.try('PUT', '/api/files/shares', { path: p, add: [{ subjectType: 'group', subjectId: other }], remove: [] })).status).toBe(400)
    const g = await addMember(h, owner, { username: 'gina' })
    h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(g.id)
    expect((await alice.try('PUT', '/api/files/shares', { path: p, add: [user(g.id)], remove: [] })).status).toBe(400)
  })

  test('the team switch off: members cannot share or be asked; shares made keep working; admins still share team files', async () => {
    const p = `users/${ids.alice}/switch.txt`
    await put(alice, p, 's')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      const r = await alice.try('PUT', '/api/files/shares', { path: p, add: [user(ids.carl)], remove: [] })
      expect(r.status).toBe(403)
      expect(r.body.error.params.reason).toBe('file_shares_off')
      expect((await alice.call('GET', '/api/files/shares' + q(p))).off).toBe(true)
      expect((await page(bob, l.id)).status).toBe('open')
      expect(await page(carl, l.id)).toEqual({ status: 'no_access', canAsk: false, askedAt: null })
      expect((await carl.try('POST', `/api/files/shared/${l.id}/request`, {})).status).toBe(403)
      await put(alice, 'shared/admin-ok.txt')
      expect((await share(admin, 'shared/admin-ok.txt', [user(ids.bob)])).canShare).toBe(true)
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })
})

describe('the link follows its file', () => {
  test('a rename keeps the link; the trash parks it (owner: trashed; others: no access); a restore brings it back', async () => {
    const p = `users/${ids.alice}/life.txt`
    await put(alice, p, 'life')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    await alice.call('POST', '/api/files/move', { from: p, to: `users/${ids.alice}/life2.txt` })
    expect(await page(bob, l.id)).toMatchObject({ status: 'open', name: 'life2.txt' })
    const del = await alice.call('DELETE', '/api/files' + q(`users/${ids.alice}/life2.txt`))
    expect(await page(alice, l.id)).toEqual({ status: 'trashed' })
    expect((await page(bob, l.id)).status).toBe('no_access')
    await alice.call('POST', `/api/files/trash/${del.trashId}/restore`)
    expect(await page(bob, l.id)).toMatchObject({ status: 'open', name: 'life2.txt' })
  })

  test('a purge deletes the link with its grants', async () => {
    await put(alice, 'shared/purge.txt')
    const { link: l } = await share(alice, 'shared/purge.txt', [user(ids.bob)])
    const del = await alice.call('DELETE', '/api/files' + q('shared/purge.txt'))
    await owner.call('DELETE', `/api/files/trash/${del.trashId}`)
    expect(await page(bob, l.id)).toEqual({ status: 'unknown' })
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM file_share_grants WHERE share_id = ?').get(l.id)).toEqual({ n: 0 })
  })

  test('a save through the app keeps the link; a different file put at the path on the disk does not inherit it', async () => {
    const p = `users/${ids.alice}/pin.txt`
    await put(alice, p, 'v1')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    await alice.call('PUT', '/api/files/content', { path: p, content: 'v2', baseSha256: sha('v1') })
    await Bun.sleep(5)
    expect((await page(bob, l.id)).status).toBe('open')
    expect(await (await bob.raw('GET', `/api/files/shared/${l.id}/download`)).text()).toBe('v2')
    // outside the app: delete and write another file under the same name
    const abs = path.join(h.ctx.files.fx.root, 'users', ids.alice, 'pin.txt')
    fs.rmSync(abs)
    fs.writeFileSync(abs, 'someone else\'s content')
    expect((await page(bob, l.id)).status).toBe('no_access')
    expect((await bob.raw('GET', `/api/files/shared/${l.id}/download`)).status).toBe(404)
  })

  test('BLOCKER (review of #979): a file deleted outside the app and a NEW file uploaded at its path: the new one opens for nobody by the old link or grant', async () => {
    const p = `users/${ids.alice}/reused.txt`
    await put(alice, p, 'A content')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    fs.unlinkSync(path.join(h.ctx.files.fx.root, ...p.split('/')))
    // B, uploaded by alice at the same path (a new file: no "replaced")
    const fd = new FormData()
    fd.set('folder', `users/${ids.alice}`)
    fd.set('file', new File(['B secret content'], 'reused.txt'))
    const up = await h.fetch('/api/files/upload', { method: 'POST', headers: { cookie: alice.cookie!, 'x-mycel-csrf': '1' }, body: fd })
    expect(up.status).toBe(201)
    expect((await page(bob, l.id)).status).toBe('no_access')
    expect((await bob.raw('GET', `/api/files/shared/${l.id}/download`)).status).toBe(404)
    // the old row is dead, its grant gone; B has no link and nobody but alice
    expect(h.ctx.db.query('SELECT state FROM file_shares WHERE id = ?').get(l.id)).toEqual({ state: 'dead' })
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM file_share_grants WHERE share_id = ?').get(l.id)).toEqual({ n: 0 })
    const fresh = await alice.call('GET', '/api/files/shares' + q(p))
    expect(fresh.link).toBeNull()
    expect(fresh.people).toEqual([])
    // and a save at a path whose file went (a plain create) does the same
    const p2 = `users/${ids.alice}/reused2.txt`
    await put(alice, p2, 'A2')
    const l2 = (await share(alice, p2, [user(ids.bob)])).link
    fs.unlinkSync(path.join(h.ctx.files.fx.root, ...p2.split('/')))
    await put(alice, p2, 'B2')
    expect((await page(bob, l2.id)).status).toBe('no_access')
  })

  test('an upload over the file (replace) and a version restore keep the link: the same file', async () => {
    const p = `users/${ids.alice}/same.txt`
    await put(alice, p, 'one')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    const fd = new FormData()
    fd.set('folder', `users/${ids.alice}`)
    fd.set('onExists', 'replace')
    fd.set('file', new File(['two, longer'], 'same.txt'))
    expect((await h.fetch('/api/files/upload', { method: 'POST', headers: { cookie: alice.cookie!, 'x-mycel-csrf': '1' }, body: fd })).status).toBe(201)
    await Bun.sleep(5)
    expect(await (await bob.raw('GET', `/api/files/shared/${l.id}/download`)).text()).toBe('two, longer')
    const hist = await alice.call('GET', '/api/files/history' + q(p))
    await alice.call('POST', '/api/files/restore', { path: p, versionId: hist.items[0].id })
    await Bun.sleep(5)
    expect(await (await bob.raw('GET', `/api/files/shared/${l.id}/download`)).text()).toBe('one')
  })

  test('a new inode with the same size and time is hashed: other bytes are another file; the same bytes keep the link', async () => {
    const p = `users/${ids.alice}/twin.txt`
    await put(alice, p, 'abcd-1')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    const abs = path.join(h.ctx.files.fx.root, ...p.split('/'))
    const st = fs.statSync(abs)
    // the same bytes on a new inode (a copy put back): still the file
    fs.rmSync(abs); fs.writeFileSync(abs, 'abcd-1'); fs.utimesSync(abs, st.atime, st.mtime)
    expect((await page(bob, l.id)).status).toBe('open')
    // other bytes of the same size with the same time: another file
    fs.rmSync(abs); fs.writeFileSync(abs, 'wxyz-2'); fs.utimesSync(abs, st.atime, st.mtime)
    expect((await page(bob, l.id)).status).toBe('no_access')
    expect(h.ctx.db.query('SELECT state FROM file_shares WHERE id = ?').get(l.id)).toEqual({ state: 'dead' })
  })

  test('a file replaced outside the app (same size), then its folder renamed in the app: the link answers no access', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'users', ids.alice, 'ren-box'), { recursive: true })
    const p = `users/${ids.alice}/ren-box/f.txt`
    await put(alice, p, 'original!')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    const abs = path.join(h.ctx.files.fx.root, ...p.split('/'))
    // deleted and written again outside the app, the same size (Linux gives it the same inode)
    fs.unlinkSync(abs)
    fs.writeFileSync(abs, 'replaced!')
    await alice.call('POST', '/api/files/move', { from: `users/${ids.alice}/ren-box`, to: `users/${ids.alice}/ren-box-2` })
    await Bun.sleep(5)
    expect((await page(bob, l.id)).status).toBe('no_access')
    expect((await bob.raw('GET', `/api/files/shared/${l.id}/download`)).status).toBe(404)
  })

  test('an unchanged file in a renamed folder keeps its link (one hash after the rename)', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'users', ids.alice, 'keep-box'), { recursive: true })
    const p = `users/${ids.alice}/keep-box/f.txt`
    await put(alice, p, 'kept as is')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    await alice.call('POST', '/api/files/move', { from: `users/${ids.alice}/keep-box`, to: `users/${ids.alice}/keep-box-2` })
    await Bun.sleep(5)
    expect(await page(bob, l.id)).toMatchObject({ status: 'open', name: 'f.txt' })
    expect(await (await bob.raw('GET', `/api/files/shared/${l.id}/download`)).text()).toBe('kept as is')
  })

  test('a changed file outside the app: the size says so at once (no hash), and the row stays dead', async () => {
    const p = `users/${ids.alice}/size.txt`
    await put(alice, p, 'same size?')
    const { link: l } = await share(alice, p, [user(ids.bob)])
    const abs = path.join(h.ctx.files.fx.root, ...p.split('/'))
    fs.rmSync(abs)
    fs.writeFileSync(abs, 'a different length entirely')
    expect((await page(bob, l.id)).status).toBe('no_access')
    expect(h.ctx.db.query('SELECT state FROM file_shares WHERE id = ?').get(l.id)).toEqual({ state: 'dead' })
    // the same bytes put back do not bring it back: dead stays dead
    fs.writeFileSync(abs, 'same size?')
    expect((await page(bob, l.id)).status).toBe('no_access')
  })

  test('someone else\'s move to where fewer people can open it removes the grants, audits and tells the owner', async () => {
    await put(alice, 'shared/narrow.txt', 'n')
    const { link: l } = await share(alice, 'shared/narrow.txt', [user(ids.bob)])
    // carl (Sales) moves it into sales/, which bob cannot open
    await carl.call('POST', '/api/files/move', { from: 'shared/narrow.txt', to: 'sales/narrow.txt' })
    expect((await page(bob, l.id)).status).toBe('no_access')
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM file_share_grants WHERE share_id = ?').get(l.id)).toEqual({ n: 0 })
    const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'file.unshare' AND target = ? ORDER BY id DESC").get(`file-share:${l.id}`) as { actor_id: string; detail: string }
    expect(a.actor_id).toBe(ids.carl)
    expect(JSON.parse(a.detail)).toMatchObject({ reason: 'moved_narrower', path: 'sales/narrow.txt' })
    const n = (await notices(alice)).find((x) => x.eventType === 'file.unshared_by_move')
    expect(n.fileShare).toMatchObject({ by: 'CARL', name: 'narrow.txt' })
  })

  test('an admin narrowing a folder: the preview says how many have files there by link; "Remove those links too" removes them in the save', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'open-box'), { recursive: true })
    await put(alice, 'shared/open-box/doc.txt', 'd')
    const { link: l } = await share(alice, 'shared/open-box/doc.txt', [user(ids.bob)])
    const rules = [{ subjectType: 'user', subjectId: ids.alice, access: 'write' }]
    const pv = await admin.call('POST', '/api/admin/access/edit-preview', { path: 'shared/open-box', rules, limited: true })
    expect(pv.less).toBeGreaterThan(0)
    expect(pv.linkPeople).toBe(1)
    // a narrowing save that says nothing about the links is refused (review of #979); false keeps them
    const none = await admin.try('POST', '/api/admin/folders', { path: 'shared/open-box', create: false, rules, limited: true, expectedHash: pv.hash })
    expect(none.status).toBe(409)
    expect(none.body.error.params).toMatchObject({ reason: 'file_links_decide', linkPeople: 1 })
    expect(h.ctx.db.query("SELECT limited FROM folders WHERE path = 'shared/open-box'").get() ?? { limited: 0 }).toMatchObject({ limited: 0 })
    const f = await admin.call('POST', '/api/admin/folders', { path: 'shared/open-box', create: false, rules, limited: true, expectedHash: pv.hash, removeFileLinks: false })
    expect((await page(bob, l.id)).status).toBe('open')
    // a save that narrows nobody needs no answer about links
    expect((await admin.try('PUT', `/api/admin/folders/${f.id}/rules`, { rules, limited: true, expectedHash: f.rulesHash })).status).toBe(200)
    const f2 = (await admin.call('GET', '/api/admin/folders')).items.find((x: any) => x.path === 'shared/open-box')
    const pv2 = await admin.call('POST', '/api/admin/access/edit-preview', { path: 'shared/open-box', rules: [], limited: true })
    expect(pv2.linkPeople).toBe(1)
    expect((await admin.try('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [], limited: true, expectedHash: f2.rulesHash })).status).toBe(409)
    await admin.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [], limited: true, expectedHash: f2.rulesHash, removeFileLinks: true })
    expect((await page(bob, l.id)).status).toBe('no_access')
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'file.unshare' AND target = 'shared/open-box' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ reason: 'folder_narrowed', files: 1 })
  })

  test('the narrowing move\'s grant removal is part of the move: a failure undoes both', async () => {
    await put(alice, 'shared/atomic.txt', 'a')
    const { link: l } = await share(alice, 'shared/atomic.txt', [user(ids.bob)])
    // the audit insert fails inside the move's step: the move fails, the file and its grants stay
    h.ctx.db.exec("CREATE TRIGGER fail_unshare BEFORE INSERT ON audit_log WHEN NEW.action = 'file.unshare' BEGIN SELECT RAISE(ABORT, 'boom'); END")
    try {
      const r = await carl.try('POST', '/api/files/move', { from: 'shared/atomic.txt', to: 'sales/atomic.txt' })
      expect(r.status).toBeGreaterThanOrEqual(400)
    } finally { h.ctx.db.exec('DROP TRIGGER fail_unshare') }
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'shared', 'atomic.txt'))).toBe(true)
    expect((await page(bob, l.id)).status).toBe('open')
  })

  test('the owner\'s own move keeps the grants; the move confirm says how many have it by its link', async () => {
    await put(alice, 'shared/mine-move.txt', 'm')
    const { link: l } = await share(alice, 'shared/mine-move.txt', [user(ids.bob)])
    const r = await alice.try('POST', '/api/files/move', { from: 'shared/mine-move.txt', to: `users/${ids.alice}/mine-move.txt` })
    expect(r.status).toBe(409)
    expect(r.body.error.params).toMatchObject({ reason: 'audience_narrowed', linkPeople: 1 })
    await alice.call('POST', '/api/files/move', { from: 'shared/mine-move.txt', to: `users/${ids.alice}/mine-move.txt`, confirm: true })
    expect((await page(bob, l.id)).status).toBe('open')
  })
})

describe('asking for access', () => {
  // the tests above spent alice's send budget on purpose (refused names cost a token since the security review of
  // #1038): a fresh budget for the answers here, as a minute later would give
  beforeAll(() => { (roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear() })
  test('ask, owner sees it with the note, Share grants and answers it; Decline tells the requester without naming the file', async () => {
    const p = `users/${ids.alice}/ask.txt`
    await put(alice, p, 'ask')
    const { id } = await link(alice, p)
    const r = await carl.call('POST', `/api/files/shared/${id}/request`, { message: 'For the deck, thanks' })
    expect(r.status).toBe('sent')
    expect((await carl.call('POST', `/api/files/shared/${id}/request`, {})).status).toBe('already')
    expect((await page(carl, id)).askedAt).toBe(r.askedAt)
    const n = (await notices(alice)).find((x) => x.eventType === 'file.access_requested')
    expect(n.fileShare).toMatchObject({ by: 'CARL', name: 'ask.txt', note: 'For the deck, thanks', state: 'pending', canAnswer: true })
    // only someone the request went to may answer it
    expect((await bob.try('POST', `/api/files/requests/${n.fileShare.requestId}`, { answer: 'approve' })).status).toBe(404)
    expect(await alice.call('POST', `/api/files/requests/${n.fileShare.requestId}`, { answer: 'approve' })).toEqual({ state: 'approved' })
    expect((await page(carl, id)).status).toBe('open')
    expect((await notices(carl)).some((x) => x.eventType === 'file.shared')).toBe(true)
    // bob asks, alice declines
    const b = await bob.call('POST', `/api/files/shared/${id}/request`, {})
    expect(b.status).toBe('sent')
    const nb = (await notices(alice)).find((x) => x.eventType === 'file.access_requested' && x.fileShare?.by === 'BOB')
    expect(await alice.call('POST', `/api/files/requests/${nb.fileShare.requestId}`, { answer: 'decline' })).toEqual({ state: 'declined' })
    const d = (await notices(bob)).find((x) => x.eventType === 'file.access_answered')
    expect(d.fileShare).toEqual({ by: null, name: null, linkId: null, state: 'declined' })
    expect(d.link).toBeNull()
  })

  test('limits: 5 a day to one owner', async () => {
    for (let i = 0; i < 6; i++) await put(alice, `users/${ids.alice}/lim${i}.txt`)
    const links = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => link(alice, `users/${ids.alice}/lim${i}.txt`)))
    // (bob asked alice once above, declined: 1 of today's 5)
    let sent = 1
    for (const l of links) {
      const r = await bob.try('POST', `/api/files/shared/${l.id}/request`, {})
      if (r.status === 429) break
      expect(r.status).toBe(200)
      sent++
    }
    expect(sent).toBe(5)
  })

  test('a team file with no owner known asks the team owner and admins', async () => {
    fs.writeFileSync(path.join(h.ctx.files.fx.root, 'sales', 'nobody.txt'), 'no owner')
    const { id } = await link(admin, 'sales/nobody.txt')
    expect((await bob.call('POST', `/api/files/shared/${id}/request`, {})).status).toBe('sent')
    for (const c of [owner, admin]) expect((await notices(c)).some((x) => x.eventType === 'file.access_requested' && x.fileShare?.canAnswer)).toBe(true)
  })
})

describe('Remove all (the team owner)', () => {
  test('admins see the counts but only the owner removes; afterwards nothing opens by a grant', async () => {
    const c = await admin.call('GET', '/api/admin/file-shares')
    expect(c.files).toBeGreaterThan(0)
    expect((await admin.try('DELETE', '/api/admin/file-shares')).status).toBe(403)
    expect((await alice.try('GET', '/api/admin/file-shares')).status).toBe(403)
    expect(await owner.call('DELETE', '/api/admin/file-shares')).toEqual(c)
    expect(await admin.call('GET', '/api/admin/file-shares')).toEqual({ files: 0, people: 0 })
    expect(h.ctx.db.query("SELECT action FROM audit_log WHERE action = 'file.shares_removed_all'").get()).toBeTruthy()
    void fileSharesOf
  })
})
