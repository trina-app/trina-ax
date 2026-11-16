// Files › Shared with me (file sharing P2, PR 1; server/src/files/shares.ts sharedWithMe; docs/decisions/
// 20261116-files-shared-with-me.md). What must hold:
//  1. Soundness: every file the list names opens for the caller now (open() answers 'open'), except a file replaced
//     outside the app with the same size, which only a hash can tell (listed under the name it already had; a click
//     answers no access).
//  2. Completeness: every live share that a grant gives the caller (by name; through a group or the whole team when the
//     folder does not already let them read it), whose owner still edits it and that is not theirs, is listed.
//  3. Nothing about where a file lives: no path, folder, owner, size or type in the answer.
//  4. Guests: 403 at the route (never in the guest endpoints); a switched-off account gets nothing; the whole team never
//     reaches a guest.
//  5. The list writes nothing (no dead row, no re-pin) and hashes nothing.
//  6. Group subjects are the server's; the cursor is a time and a link id, validated.
// Fixture: olga = owner, adam = admin; alice, bob = Sales; carl; gina is a guest.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FILE_SHARE_EVERYONE } from '@mycel/shared/api'
import { GUEST_ENDPOINTS } from '../../server/src/auth/guest-endpoints'
import { API } from '@mycel/shared/api'
import { atLeast, loadPrincipal, RuleSet } from '../../server/src/policy/access'
import { fileSharesOf } from '../../server/src/files/shares'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client, gina: Client
let ids: Record<'olga' | 'adam' | 'alice' | 'bob' | 'carl' | 'gina', string>
let sales: string
const ALL = { subjectType: 'group' as const, subjectId: FILE_SHARE_EVERYONE }
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
const group = (id: string) => ({ subjectType: 'group' as const, subjectId: id })
const put = (c: Client, p: string, content = 'x') => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })
const share = (c: Client, p: string, add: { subjectType: 'user' | 'group'; subjectId: string }[], remove: typeof add = []) => c.call('PUT', '/api/files/shares', { path: p, add, remove })
const abs = (p: string) => path.join(h.ctx.files.fx.root, ...p.split('/'))
/** every page of the caller's list */
async function listAll(c: Client): Promise<{ linkId: string; name: string; sharedBy: string | null; sharedAt: string }[]> {
  const out = []
  let cursor: string | null = null
  for (let i = 0; i < 20; i++) {
    const r: any = await c.call('GET', `/api/files/shared-with-me${cursor ? `?cursor=${cursor}` : ''}`)
    out.push(...r.items)
    cursor = r.next
    if (!cursor) break
  }
  return out
}
let needsHash = ''

beforeAll(async () => {
  h = await harness('sec-file-shares-p2')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  admin = a.client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  const al = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
  const b = await addMember(h, owner, { username: 'bob', groupIds: [sales] })
  const c = await addMember(h, owner, { username: 'carl' })
  const g = await addMember(h, owner, { username: 'gina' })
  alice = al.client; bob = b.client; carl = c.client; gina = g.client
  const olga = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  ids = { olga, adam: a.id, alice: al.id, bob: b.id, carl: c.id, gina: g.id }
  const A = `users/${ids.alice}`
  fs.mkdirSync(abs(`${A}/private-folder-name`), { recursive: true })
  fs.mkdirSync(abs('shared/narrowed'), { recursive: true })
  // the table: every kind of share, aimed at bob (and seen by carl, adam, olga)
  await put(alice, `${A}/private-folder-name/named.txt`, 'named')
  await share(alice, `${A}/private-folder-name/named.txt`, [user(ids.bob)])
  await put(alice, `${A}/to-sales.txt`, 'sales')
  await share(alice, `${A}/to-sales.txt`, [group(sales)])
  await put(alice, `${A}/to-all.txt`, 'all')
  await share(alice, `${A}/to-all.txt`, [ALL])
  await put(alice, 'shared/all-readable.txt', 'r')
  await share(alice, 'shared/all-readable.txt', [ALL])
  await put(alice, 'shared/named-readable.txt', 'nr')
  await share(alice, 'shared/named-readable.txt', [user(ids.bob), group(sales)])
  await put(alice, `${A}/removed.txt`, 'rm')
  await share(alice, `${A}/removed.txt`, [user(ids.bob)])
  await share(alice, `${A}/removed.txt`, [], [user(ids.bob)])
  await put(alice, 'shared/narrowed/owner-lost.txt', 'ol')
  await share(alice, 'shared/narrowed/owner-lost.txt', [user(ids.bob)])
  await admin.call('POST', '/api/admin/folders', { path: 'shared/narrowed', create: false, limited: true, rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }], removeFileLinks: false })
  await put(alice, `${A}/trashed.txt`, 'tr')
  await share(alice, `${A}/trashed.txt`, [user(ids.bob)])
  await alice.call('DELETE', `/api/files?path=${encodeURIComponent(`${A}/trashed.txt`)}`)
  await put(alice, `${A}/dead.txt`, 'dddd')
  await share(alice, `${A}/dead.txt`, [user(ids.bob)])
  fs.unlinkSync(abs(`${A}/dead.txt`)); fs.writeFileSync(abs(`${A}/dead.txt`), 'another, longer file')
  await put(alice, `${A}/same-size.txt`, 'ssss')
  needsHash = (await share(alice, `${A}/same-size.txt`, [user(ids.bob)])).link.id
  fs.unlinkSync(abs(`${A}/same-size.txt`)); fs.writeFileSync(abs(`${A}/same-size.txt`), 'SSSS')
  await put(bob, `users/${ids.bob}/bobs-own.txt`, 'own')
  await share(bob, `users/${ids.bob}/bobs-own.txt`, [group(sales)])
  // a guest last (an access change switches off a guest in no place)
  h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(g.id)
}, 60_000)
afterAll(() => h.close())

/** The rule written out independently of the server's helpers: does a grant qualify this live share for `uid` now? */
function qualifies(uid: string, s: { id: string; path: string; owner_id: string | null }): boolean {
  const db = h.ctx.db
  const me = loadPrincipal(db, uid)
  if (!me || me.role === 'guest' || s.owner_id === uid) return false
  const rules = RuleSet.load(db)
  const segs = s.path.split('/')
  const named = !!db.query("SELECT 1 FROM file_share_grants WHERE share_id = ? AND subject_type = 'user' AND subject_id = ?").get(s.id, uid)
  const viaGroup = (db.query("SELECT subject_id FROM file_share_grants WHERE share_id = ? AND subject_type = 'group'").all(s.id) as { subject_id: string }[])
    .some((g) => g.subject_id === FILE_SHARE_EVERYONE || me.groups.includes(g.subject_id))
  const readable = atLeast(rules.access(me, segs), 'read')
  if (!(named || (viaGroup && !readable))) return false
  if (s.owner_id) {
    const o = loadPrincipal(db, s.owner_id)
    if (!o || o.role === 'guest' || !atLeast(rules.access(o, segs), 'write')) return false
  }
  // the file still there, the same size as pinned (a plainly other file is not listed)
  let st: fs.Stats
  try { st = fs.lstatSync(abs(s.path)) } catch { return false }
  const pin = db.query('SELECT size FROM file_shares WHERE id = ?').get(s.id) as { size: number | null }
  return st.isFile() && (pin.size === null || pin.size === st.size)
}

describe('Shared with me equals what opens (soundness and completeness)', () => {
  test('bob\'s list: exactly the qualifying shares', async () => {
    const got = (await listAll(bob)).map((i) => i.name).sort()
    expect(got).toEqual(['named-readable.txt', 'named.txt', 'same-size.txt', 'to-all.txt', 'to-sales.txt'])
  })

  for (const who of ['bob', 'carl', 'adam', 'olga', 'alice'] as const) {
    test(`${who}: every listed file opens (but a same-size replacement), and every qualifying share is listed`, async () => {
      const c = { bob, carl, adam: admin, olga: owner, alice }[who]
      const uid = ids[who]
      const listed = (await listAll(c)).map((i) => i.linkId)
      const live = h.ctx.db.query("SELECT id, path, owner_id FROM file_shares WHERE state = 'live'").all() as { id: string; path: string; owner_id: string | null }[]
      // completeness (before any open() below can change a row)
      for (const s of live) if (qualifies(uid, s)) expect({ who, path: s.path, listed: listed.includes(s.id) }).toEqual({ who, path: s.path, listed: true })
      for (const s of live) if (!qualifies(uid, s)) expect({ who, path: s.path, listed: listed.includes(s.id) }).toEqual({ who, path: s.path, listed: false })
      // soundness
      for (const id of listed) {
        const o = fileSharesOf(h.ctx).open(uid, id)
        if (id === needsHash) expect(o.kind).toBe('no_access')
        else expect({ id, kind: o.kind }).toEqual({ id, kind: 'open' })
      }
    })
  }
})

describe('nothing about where a file lives', () => {
  test('no path, folder, owner, size or type in the answer', async () => {
    const r = await carl.call('GET', '/api/files/shared-with-me')
    const all = await bob.call('GET', '/api/files/shared-with-me')
    for (const raw of [JSON.stringify(r), JSON.stringify(all)]) {
      expect(raw).not.toContain('/')
      expect(raw).not.toContain('private-folder-name')
      for (const k of ['path', 'size', 'mime', 'owner', 'avatarVersion', 'id']) expect(raw).not.toContain(`"${k}"`)
    }
    for (const it of all.items) expect(Object.keys(it).sort()).toEqual(['linkId', 'name', 'sharedAt', 'sharedBy'])
  })
})

describe('guests and switched-off accounts', () => {
  test('a guest: 403 at the route, and the endpoint is not in the guest endpoints', async () => {
    expect(GUEST_ENDPOINTS.has(API.sharedWithMe)).toBe(false)
    expect((await gina.raw('GET', '/api/files/shared-with-me')).status).toBe(403)
    expect(() => fileSharesOf(h.ctx).sharedWithMe(ids.gina, undefined)).toThrow()
  })
  test('a switched-off account gets nothing (the service refuses)', async () => {
    const d = await addMember(h, owner, { username: 'dora' })
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(d.id)
    expect(() => fileSharesOf(h.ctx).sharedWithMe(d.id, undefined)).toThrow()
    expect((await d.client.raw('GET', '/api/files/shared-with-me')).status).toBeGreaterThanOrEqual(401)
  })
})

describe('no writes, no hashes, bounded input', () => {
  test('reading the list changes no share row (a needs-hash row stays as it was)', async () => {
    const before = h.ctx.db.query('SELECT id, state, ino, dev, size, mtime_ms, ctime_ms, sha256 FROM file_shares ORDER BY id').all()
    await listAll(bob)
    await listAll(carl)
    expect(h.ctx.db.query('SELECT id, state, ino, dev, size, mtime_ms, ctime_ms, sha256 FROM file_shares ORDER BY id').all()).toEqual(before)
  })
  test('the group subjects are the server\'s: a query naming a group changes nothing; a forged cursor is refused', async () => {
    const r = await carl.call('GET', `/api/files/shared-with-me?groups=${sales}&subjectId=${sales}`)
    expect(r.items.map((i: any) => i.name)).not.toContain('to-sales.txt')
    for (const c of ['%27%20OR%201%3D1', 'x'.repeat(201), Buffer.from(`2026-01-01T00:00:00.000Z|' OR 1=1 --x`).toString('base64url')]) {
      expect((await carl.raw('GET', `/api/files/shared-with-me?cursor=${c}`)).status).toBe(400)
    }
    expect((await carl.raw('GET', '/api/files/shared-with-me?limit=51')).status).toBe(400)
  })
})
