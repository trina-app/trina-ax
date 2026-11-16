// Stopping a file share (docs/decisions/20261116-ai-share-card-and-stop.md; server/src/files/shares.ts): a file's owner
// can always take people off their own share (the team's member-sharing switch off, edit access lost) while adding stays
// gated; whoever was taken off reads "<name> stopped sharing this file" on the link page; after a stop the server says
// who can still open the file and through what (stillOpens); the AI card's live state (POST /api/files/shares/cards).
// Fixture: olga = owner, adam = admin; alice, carl = Sales; bob.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileSharesOf } from '../../server/src/files/shares'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client
let ids: Record<'olga' | 'adam' | 'alice' | 'bob' | 'carl', string>
let sales: string
let clock = Date.now()
const q = (p: string) => '?path=' + encodeURIComponent(p)
const put = (c: Client, p: string, content = 'x') => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })
type Subject = { subjectType: 'user' | 'group'; subjectId: string }
const share = (c: Client, p: string, add: Subject[], remove: Subject[] = []) => c.call('PUT', '/api/files/shares', { path: p, add, remove })
const user = (id: string): Subject => ({ subjectType: 'user', subjectId: id })
const group = (id: string): Subject => ({ subjectType: 'group', subjectId: id })
const page = (c: Client, id: string) => c.call('GET', `/api/files/shared/${id}`)
const nameOf = (id: string) => (h.ctx.db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string }).name

beforeAll(async () => {
  h = await harness('c-file-share-stop')
  owner = await withOwner(h)
  // (the sending budget is not what these tests are about)
  roomsOf(h.ctx).clock = () => (clock += 60_000)
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

describe('the owner can always stop their own share', () => {
  test('the team switch off: the owner takes people off (the dialog says canStop), adding stays refused', async () => {
    const p = `users/${ids.alice}/stop-switch.txt`
    await put(alice, p)
    const { link } = await share(alice, p, [user(ids.bob), user(ids.carl)])
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      const v = await alice.call('GET', '/api/files/shares' + q(p))
      expect(v).toMatchObject({ canShare: false, canStop: true, off: true })
      // the rows are still listed for the owner (they are what ✕ acts on)
      expect(v.people.map((r: { subjectId: string }) => r.subjectId).sort()).toEqual([ids.bob, ids.carl].sort())
      // adding: refused as before
      const add = await alice.try('PUT', '/api/files/shares', { path: p, add: [user(ids.adam)], remove: [] })
      expect(add.status).toBe(403)
      expect(add.body.error.params.reason).toBe('file_shares_off')
      // an add and a removal in one call is an add: refused whole, nothing removed
      const both = await alice.try('PUT', '/api/files/shares', { path: p, add: [user(ids.adam)], remove: [user(ids.bob)] })
      expect(both.status).toBe(403)
      expect((await page(bob, link.id)).status).toBe('open')
      // removing only: passes
      const after = await share(alice, p, [], [user(ids.bob)])
      expect(after.people.map((r: { subjectId: string }) => r.subjectId)).toEqual([ids.carl])
      expect((await page(bob, link.id)).status).toBe('no_access')
      expect((await page(carl, link.id)).status).toBe('open')
      const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'file.unshare' AND actor_id = ? ORDER BY id DESC").get(ids.alice) as { detail: string }
      expect(JSON.parse(a.detail)).toMatchObject({ removed: 1, via: 'dialog', reason: 'removed' })
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })

  test('edit access lost: the owner of a team file still takes people off, and cannot add', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'lockbox'), { recursive: true })
    const p = 'shared/lockbox/plan.txt'
    await put(alice, p)
    await share(alice, p, [user(ids.bob)])
    // the folder becomes read-only for Sales: alice (its file's owner) can read, not edit
    await admin.call('POST', '/api/admin/folders', { path: 'shared/lockbox', limited: true, removeFileLinks: false, rules: [{ subjectType: 'group', subjectId: sales, access: 'read' }] })
    const v = await alice.call('GET', '/api/files/shares' + q(p))
    expect(v).toMatchObject({ canShare: false, canStop: true, mine: true })
    expect(v.people).toHaveLength(1)
    const add = await alice.try('PUT', '/api/files/shares', { path: p, add: [user(ids.adam)], remove: [] })
    expect(add.status).toBe(403)
    expect(add.body.error.params.reason).toBe('file_share_not_owner')
    expect((await share(alice, p, [], [user(ids.bob)])).people).toHaveLength(0)
  })

  test('someone who is not the owner cannot take people off (a member; a reader of the folder)', async () => {
    const p = 'sales/carls.txt'
    await put(carl, p)
    await share(carl, p, [user(ids.bob)])
    // alice reads and edits the folder, but the file is carl's
    const v = await alice.call('GET', '/api/files/shares' + q(p))
    expect(v).toMatchObject({ canShare: false, canStop: false })
    const r = await alice.try('PUT', '/api/files/shares', { path: p, add: [], remove: [user(ids.bob)] })
    expect(r.status).toBe(403)
    expect(r.body.error.params.reason).toBe('file_share_not_owner')
    // an admin may, on a team file
    expect((await admin.call('GET', '/api/files/shares' + q(p))).canStop).toBe(true)
    expect((await share(admin, p, [], [user(ids.bob)])).people).toHaveLength(0)
  })
})

describe('what the person taken off sees', () => {
  test('the link page says who stopped sharing; a new share ends that; a group\'s stop reaches its members', async () => {
    const p = `users/${ids.alice}/stopped.txt`
    await put(alice, p)
    const { link } = await share(alice, p, [user(ids.bob), group(sales)])
    expect((await page(bob, link.id)).status).toBe('open')
    await share(alice, p, [], [user(ids.bob)])
    // nothing about the file, only who stopped it; asking again stays possible
    expect(await page(bob, link.id)).toEqual({ status: 'no_access', canAsk: true, askedAt: null, stoppedBy: nameOf(ids.alice) })
    // someone it was never shared with gets the plain page
    expect(await page(admin, link.id).then((x: { status: string }) => x.status)).toBeDefined()
    const never = await addMember(h, owner, { username: 'nell' })
    expect(await page(never.client, link.id)).toEqual({ status: 'no_access', canAsk: true, askedAt: null })
    // carl had it through Sales: the group's stop tells him too
    expect((await page(carl, link.id)).status).toBe('open')
    await share(alice, p, [], [group(sales)])
    expect(await page(carl, link.id)).toMatchObject({ status: 'no_access', stoppedBy: nameOf(ids.alice) })
    // shared again: open, and a later look after another stop names the newest
    await share(alice, p, [user(ids.bob)])
    expect((await page(bob, link.id)).status).toBe('open')
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM file_share_stops WHERE share_id = ? AND subject_type = 'user' AND subject_id = ?").get(link.id, ids.bob)).toEqual({ n: 0 })
  })
})

describe('who can still open it after a stop (stillOpens)', () => {
  test('through a group still on the file, through the whole team, through the folder; nobody when nothing is left', async () => {
    const shares = fileSharesOf(h.ctx)
    // a personal file: carl by name and through Sales
    const p = `users/${ids.alice}/still.txt`
    await put(alice, p)
    const { link } = await share(alice, p, [user(ids.carl), group(sales), user(ids.adam)])
    await share(alice, p, [], [user(ids.carl), user(ids.adam)])
    const row = shares.row(link.id)!
    const still = shares.stillOpens(row, [user(ids.carl), user(ids.adam)])
    expect(still).toEqual([{ userId: ids.carl, name: nameOf(ids.carl), through: { kind: 'group', name: 'Sales' } }])
    // the whole team on it: everyone taken off by name can still open it
    await share(alice, p, [group('*')])
    await share(alice, p, [], [group(sales)])
    expect(shares.stillOpens(shares.row(link.id)!, [group(sales)]).map((s) => [s.userId, s.through.kind]).sort()).toEqual([[ids.carl, 'everyone']])
    await share(alice, p, [], [group('*')])
    expect(shares.stillOpens(shares.row(link.id)!, [group('*')])).toEqual([])

    // a team file in a folder Sales can open: carl taken off by name still opens it through the folder; bob does not
    const t = 'sales/still-team.txt'
    await put(alice, t)
    const l2 = (await share(alice, t, [user(ids.carl), user(ids.bob)])).link
    await share(alice, t, [], [user(ids.carl), user(ids.bob)])
    expect(shares.stillOpens(shares.row(l2.id)!, [user(ids.carl), user(ids.bob)])).toEqual([{ userId: ids.carl, name: nameOf(ids.carl), through: { kind: 'folder' } }])
  })
})

describe('the AI card\'s live state (POST /api/files/shares/cards)', () => {
  test('the owner gets the path, the people and what they may do; someone the folder does not let in gets `gone`', async () => {
    const p = `users/${ids.alice}/card.txt`
    await put(alice, p)
    const { link } = await share(alice, p, [user(ids.bob)])
    const mine = await alice.call('POST', '/api/files/shares/cards', { ids: [link.id, 'A'.repeat(22)] })
    expect(mine.items[0]).toMatchObject({ id: link.id, path: p, name: 'card.txt', canShare: true, canStop: true })
    expect(mine.items[0].people.map((r: { subjectId: string }) => r.subjectId)).toEqual([ids.bob])
    expect(mine.items[1]).toEqual({ id: 'A'.repeat(22), gone: true })
    // bob opens it by the grant, not by the folder's rules: the card state gives him nothing (no path, no people)
    expect((await bob.call('POST', '/api/files/shares/cards', { ids: [link.id] })).items).toEqual([{ id: link.id, gone: true }])
    // a team file: someone who reads its folder but may not change its people gets nothing either; its owner and an admin do
    const t = 'sales/card-team.txt'
    await put(alice, t)
    const l2 = (await share(alice, t, [user(ids.bob)])).link
    expect((await carl.call('POST', '/api/files/shares/cards', { ids: [l2.id] })).items).toEqual([{ id: l2.id, gone: true }])
    expect((await admin.call('POST', '/api/files/shares/cards', { ids: [l2.id] })).items[0]).toMatchObject({ path: t, canShare: true, canStop: true })
    // more than 10 ids, or a bad id: 400
    expect((await alice.try('POST', '/api/files/shares/cards', { ids: Array.from({ length: 11 }, () => link.id) })).status).toBe(400)
    expect((await alice.try('POST', '/api/files/shares/cards', { ids: ['../x'] })).status).toBe(400)
  })
})
