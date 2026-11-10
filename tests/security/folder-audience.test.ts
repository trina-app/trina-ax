// GET /api/files/audience (docs/DECISIONS.md "Who can see a folder, in place"): who can see a folder, as far as the
// caller may know it. The answers it must never give (the plan's security review):
//  - a count on a folder the caller can only read: below a folder they can only pass through, it told the size of a
//    group they are not in (`user:alice read` on groups/finance/public counted the finance group);
//  - anything the tree does not already tell for the same path (a pass-through folder answers like a hidden one);
//  - a name, an id, a group, a role, how many can write, where a rule is.
// The count it gives, where the caller can write, is the copy dry run's viewersAdded + 1, which they already get.
// Fixture: alice, erin = marketing; bob = finance; carol = admin; dana = owner; shared/ everyone write; skills/ read.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { enumerateRoutes } from './lib/matrix'
import { SPECS } from './lib/cases'
import { jsonBody, makeCApp, type CApp, type Person } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-folder-audience') })
afterAll(async () => { await A.close() })
const q = (p: string) => '?path=' + encodeURIComponent(p)
const audience = (who: Person, p: string) => A.json('/api/files/audience' + q(p), { as: who })
const tree = (who: Person, p: string) => A.json('/api/files/tree' + q(p), { as: who })
/** the request id differs from one answer to the next */
const bare = (b: any) => (b && typeof b === 'object' && b.error ? { ...b, error: { ...b.error, requestId: null } } : b)
const dryRun = async (who: Person, folder: string) => {
  const r = await A.json('/api/files/copy', { as: who, ...jsonBody({ from: `users/${who}/todo.md`, to: `${folder}/audience-probe.md`, dryRun: true }) })
  expect(r.status).toBe(201)
  return r.body.viewersAdded as number
}
const rule = (p: string, t: string, s: string | null, a: string) => {
  const db = A.ctx.db
  let f = db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string } | null
  if (!f) { f = { id: 'f_aud_' + p.replace(/[^a-z0-9]/gi, '_') }; db.query('INSERT INTO folders (id, path) VALUES (?,?)').run(f.id, p) }
  db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), f.id, t, s, a)
}
const dropRules = (p: string) => A.ctx.db.query('DELETE FROM folder_rules WHERE folder_id IN (SELECT id FROM folders WHERE path = ?)').run(p)

describe('the route is there and in the matrix', () => {
  test('registered, with a permanent persona case (the route-coverage check fails on dev for other routes)', () => {
    expect(enumerateRoutes(path.resolve(import.meta.dir, '../..'))).toContain('folderAudience')
    expect(SPECS.folderAudience).toBeDefined()
  })
})

describe('what a member learns', () => {
  test('where they can write: the count and whether it is everyone, nothing else', async () => {
    const shared = await audience('alice', 'shared')
    expect(shared.status).toBe(200)
    expect(shared.body).toEqual({ path: 'shared', access: 'write', people: 5, everyone: true })
    const mkt = await audience('alice', 'groups/marketing')
    // alice, erin (marketing), carol (admin), dana (owner)
    expect(mkt.body).toEqual({ path: 'groups/marketing', access: 'write', people: 4, everyone: false })
    expect(Object.keys(mkt.body).sort()).toEqual(['access', 'everyone', 'path', 'people'])
    // no name or id of anyone, and no group, beside the path itself
    const rest = JSON.stringify({ ...mkt.body, path: undefined })
    for (const who of ['alice', 'erin', 'carol', 'dana', 'bob', 'Alice', 'Erin', 'Carol', 'Dana', 'marketing', 'Marketing', 'admin', 'owner']) expect(rest).not.toContain(who)
  })

  test('their own folder: only them', async () => {
    expect((await audience('alice', 'users/alice')).body).toEqual({ path: 'users/alice', access: 'write', people: 1, everyone: false })
    expect((await audience('alice', 'users/alice/drafts')).body).toEqual({ path: 'users/alice/drafts', access: 'write', people: 1, everyone: false })
  })

  test('where they can only read: their access, no count', async () => {
    expect((await audience('alice', 'skills')).body).toEqual({ path: 'skills', access: 'read' })
    // everyone: read below alice's own write on projects/falcon
    expect((await audience('alice', 'projects/falcon/public')).body).toEqual({ path: 'projects/falcon/public', access: 'read' })
    // users/ itself (read for everyone, nobody writes there)
    expect((await audience('alice', 'users')).body).toEqual({ path: 'users', access: 'read' })
  })

  test('the count is the copy dry run plus one, and Admin\'s "can open"', async () => {
    for (const folder of ['shared', 'groups/marketing', 'projects/falcon', 'users/alice/drafts']) {
      const r = await audience('alice', folder)
      expect({ folder, people: r.body.people }).toEqual({ folder, people: (await dryRun('alice', folder)) + 1 })
    }
    for (const folder of ['shared', 'groups/marketing', 'groups/finance', 'projects/falcon', 'projects/atlas', 'skills']) {
      const r = await audience('carol', folder)
      const admin = await A.json('/api/admin/access/folder' + q(folder), { as: 'carol' })
      expect({ folder, people: r.body.people }).toEqual({ folder, people: admin.body.summary.access.read + admin.body.summary.access.write })
    }
  })

  test('a team project: the same number as Project.audience', async () => {
    const made = await A.json('/api/projects', { as: 'alice', ...jsonBody({ name: 'Kite audience', participants: [{ subjectType: 'user', subjectId: 'erin' }] }) })
    expect(made.status).toBe(201)
    const r = await audience('alice', made.body.folderPath)
    // alice (creator), erin, carol, dana
    expect(r.body.people).toBe(4)
    const list = await A.json('/api/projects', { as: 'alice' })
    expect(list.body.items.find((p: { id: string }) => p.id === made.body.id).audience).toBe(r.body.people)
  })
})

describe('the same answers as the tree, except a pass-through folder', () => {
  test('one list of paths, as alice', async () => {
    const paths = [
      '', 'shared', 'shared/nope', 'shared/glossary.md', 'shared/etc-link', 'shared/abs-budget.md', 'users', 'users/bob', 'users/bob/notes.md',
      'users/nobody', '.system', '.system/history', 'groups', 'groups/finance', 'groups/finance/budget.md', 'groups/marketing/salaries',
      'groups/marketing/finance-dir', 'groups/marketing/budget-link.md', 'groups/marketing/margin-copy.md', 'projects/atlas', '../outside',
      'shared/a\u0000b', 'CLAUDE.md', 'skills/team-rules.md',
    ]
    for (const p of paths) {
      const t = await tree('alice', p)
      const a = await audience('alice', p)
      if (t.status === 200) {
        // a folder alice can open answers 200; one she can only pass through answers the tree's 404 for a hidden one
        if (t.body.access === 'none') expect({ p, status: a.status, body: bare(a.body) }).toEqual({ p, status: 404, body: bare((await tree('alice', 'groups/finance')).body) })
        else expect({ p, status: a.status }).toEqual({ p, status: 200 })
      } else expect({ p, status: a.status, body: bare(a.body) }).toEqual({ p, status: t.status, body: bare(t.body) })
    }
  })

  test('a case-insensitive volume: Users/bob and look-alikes answer like a missing path', async () => {
    const fx = A.ctx.files.fx as { caseInsensitive: boolean }
    const before = fx.caseInsensitive
    fx.caseInsensitive = true
    try {
      const control = await audience('alice', 'users/nobody')
      expect(control.status).toBe(404)
      for (const p of ['Users/bob', 'USERS/BOB', 'users/BOB', 'Groups/Finance', 'groups/marketing/SALARIES', '.SYSTEM', 'users/bob'.normalize('NFD')]) {
        const r = await audience('alice', p)
        expect({ p, status: r.status, body: bare(r.body) }).toEqual({ p, status: control.status, body: bare(control.body) })
      }
      // and her own folder by another case still answers as her own
      expect((await audience('alice', 'USERS/alice')).body.people).toBe(1)
    } finally { fx.caseInsensitive = before }
  })

  test('the owner and admins: never another person\'s folder', async () => {
    for (const who of ['carol', 'dana'] as const) {
      const r = await audience(who, 'users/alice')
      expect(r.status).toBe(404)
      expect(bare(r.body)).toEqual(bare((await audience(who, 'users/nobody')).body))
    }
  })
})

describe('the review\'s attacks', () => {
  test('a folder below one the member can only pass through: no count while they only read, whatever the group above', async () => {
    fs.mkdirSync(path.join(A.team, 'groups/finance/public'), { recursive: true })
    rule('groups/finance/public', 'user', 'alice', 'read')
    try {
      // alice passes through groups/finance; she reads groups/finance/public
      expect((await tree('alice', 'groups/finance')).body.access).toBe('none')
      const before = await audience('alice', 'groups/finance/public')
      expect(before.body).toEqual({ path: 'groups/finance/public', access: 'read' })
      // the finance group grows from 1 to 4: the answer does not move
      const db = A.ctx.db
      for (const id of ['fin2', 'fin3', 'fin4']) {
        db.query('INSERT INTO users (id, username, name, role) VALUES (?,?,?,?)').run(id, id, id, 'member')
        db.query("INSERT INTO group_members VALUES ('finance', ?)").run(id)
      }
      try {
        const after = await audience('alice', 'groups/finance/public')
        expect(JSON.stringify(bare(after.body))).toBe(JSON.stringify(bare(before.body)))
        // the pass-through folder itself says nothing either
        expect((await audience('alice', 'groups/finance')).status).toBe(404)
      } finally {
        db.query("DELETE FROM group_members WHERE user_id IN ('fin2','fin3','fin4')").run()
        db.query("DELETE FROM users WHERE id IN ('fin2','fin3','fin4')").run()
      }
      // with write there, she gets the count, which the copy dry run already gives her
      dropRules('groups/finance/public')
      rule('groups/finance/public', 'user', 'alice', 'write')
      const w = await audience('alice', 'groups/finance/public')
      expect(w.body.people).toBe((await dryRun('alice', 'groups/finance/public')) + 1)
    } finally {
      dropRules('groups/finance/public')
      fs.rmSync(path.join(A.team, 'groups/finance/public'), { recursive: true, force: true })
    }
  })

  test('people switched off are not counted; a rule change moves the count', async () => {
    const db = A.ctx.db
    db.query("UPDATE users SET status = 'disabled' WHERE id = 'erin'").run()
    try {
      expect((await audience('alice', 'groups/marketing')).body.people).toBe(3)
      // every active person is there now: alice, carol, dana… and bob is not
      expect((await audience('alice', 'groups/marketing')).body.everyone).toBe(false)
    } finally { db.query("UPDATE users SET status = 'active' WHERE id = 'erin'").run() }
    rule('groups/marketing', 'user', 'bob', 'read')
    try {
      expect((await audience('alice', 'groups/marketing')).body).toEqual({ path: 'groups/marketing', access: 'write', people: 5, everyone: true })
    } finally { A.ctx.db.query("DELETE FROM folder_rules WHERE subject_type = 'user' AND subject_id = 'bob' AND folder_id IN (SELECT id FROM folders WHERE path = 'groups/marketing')").run() }
    expect((await audience('alice', 'groups/marketing')).body.people).toBe(4)
  })

  test('a plugin-managed folder: no count (a write there is refused, so the copy dry run gives none either)', async () => {
    fs.mkdirSync(path.join(A.team, 'shared/plugin-pack'), { recursive: true })
    const fx = A.ctx.files.fx as { managed?: unknown }
    const before = fx.managed
    fx.managed = {
      managerOf: (segs: string[]) => (segs.join('/') === 'shared/plugin-pack' || segs.join('/').startsWith('shared/plugin-pack/') ? 'pack' : null),
      heldBelow: (segs: string[]) => ('shared/plugin-pack'.startsWith(segs.join('/') + '/') || segs.join('/') === 'shared/plugin-pack' ? 'pack' : null),
    }
    try {
      expect((await audience('alice', 'shared/plugin-pack')).body).toEqual({ path: 'shared/plugin-pack', access: 'write' })
      expect((await audience('alice', 'shared')).body.people).toBe(5)
    } finally {
      fx.managed = before
      fs.rmSync(path.join(A.team, 'shared/plugin-pack'), { recursive: true, force: true })
    }
  })
})
