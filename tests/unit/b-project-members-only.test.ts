// Project contents only for members (docs/DECISIONS.md): the zone rule of the permission function, the activity log's
// cut of paths inside projects, the joins trail, and the steps that run once at the first start. The end-to-end rows (a
// non-member owner and admin through every path) are tests/security/project-members-only.test.ts.
// Fixture (tests/lib/b-harness.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { atLeast, inProjectZone, RuleSet, SYSTEM_PRINCIPAL, type Principal } from '../../server/src/policy/access'
import { cutInsideProject, insideProject, inZone } from '../../server/src/policy/zone'
import { listAudit } from '../../server/src/admin/audit'
import { auditSight } from '../../server/src/admin/audit-sight'
import { membersOnlyOnce } from '../../server/src/chat/members-only-once'
import { setSetting } from '../../server/src/admin/settings'
import { ruleFolderOf } from '../../server/src/admin/access-rows'

setDefaultTimeout(60_000)
const P = (id: string, role: Principal['role'], groups: string[] = []): Principal => ({ id, name: id, role, groups })
const rules = (rows: [string, 'everyone' | 'role' | 'group' | 'user', string | null, 'none' | 'read' | 'write'][]) =>
  new RuleSet(rows.map(([path, subject_type, subject_id, access]) => ({ path, subject_type, subject_id, access })))
const segs = (p: string) => p.split('/')

describe('the members-only zone of the permission function', () => {
  const r = rules([
    ['', 'everyone', null, 'read'],
    ['', 'user', 'carol', 'write'],
    ['projects', 'role', 'admin', 'write'],
    ['projects/plan', 'user', 'alice', 'write'],
    ['projects/plan', 'role', 'admin', 'read'],
    ['projects/plan', 'everyone', null, 'none'],
    ['projects/plan/open', 'everyone', null, 'read'],
    ['projects/hr', 'user', 'alice', 'write'],
    ['projects/hr', 'everyone', null, 'none'],
    ['projects/hr/pay', 'group', 'finance', 'read'],
  ])
  const carol = P('carol', 'admin'), dana = P('dana', 'owner'), alice = P('alice', 'member'), bob = P('bob', 'member')
  test('inside projects/<name> the owner and admins are judged as members, by the rules at or below it only', () => {
    // a role rule for admins and their own rule on the root or on projects/ never reach in
    for (const p of [carol, dana]) {
      expect(r.access(p, segs('projects/plan'))).toBe('none')
      expect(r.access(p, segs('projects/plan/a.md'))).toBe('none')
      // not even a folder inside that everyone reads: inside a project they read only as its members
      expect(r.access(p, segs('projects/plan/open/x.md'))).toBe('none')
    }
    expect(r.access(bob, segs('projects/plan/open/x.md'))).toBe('read') // members of the team: as before
    expect(r.access(alice, segs('projects/plan/a.md'))).toBe('write')
    expect(r.access(bob, segs('projects/plan/a.md'))).toBe('none')
  })
  test('a rule on a folder inside a project never lets the owner or an admin in alone (security review M2)', () => {
    const fin = P('carol', 'admin', ['finance'])
    expect(r.access(fin, segs('projects/hr/pay/2026.md'))).toBe('none')
    expect(r.canList(fin, segs('projects/hr'))).toBe(false)
    expect(r.navigator(segs('projects/hr'), 10)(fin)).toEqual({ listable: false, via: [], more: false })
    // a member of the team in that group: as before (the folder inside is theirs to read)
    expect(r.access(P('bob', 'member', ['finance']), segs('projects/hr/pay/2026.md'))).toBe('read')
    // the owner or an admin who is a member of the project: the rules inside decide, as for anyone
    const both = rules([['projects/hr', 'user', 'carol', 'read'], ['projects/hr', 'everyone', null, 'none'], ['projects/hr/pay', 'everyone', null, 'none']])
    expect(both.access(carol, segs('projects/hr/x.md'))).toBe('read')
    expect(both.access(carol, segs('projects/hr/pay/x.md'))).toBe('none')
  })
  test('a project folder without rules of its own: closed to the owner and admins, as it was for members by the rules above', () => {
    expect(r.access(carol, segs('projects/bare/x.md'))).toBe('none')
    expect(r.access(dana, segs('projects/bare'))).toBe('none')
    expect(r.access(bob, segs('projects/bare/x.md'))).toBe('read') // members: unchanged (the root's everyone: read)
  })
  test('outside the zone nothing changes; projects/ itself stays theirs', () => {
    expect(r.access(carol, segs('shared/x.md'))).toBe('write')
    expect(r.access(dana, segs('groups/finance/budget.md'))).toBe('write')
    expect(r.access(carol, segs('projects'))).toBe('write')
  })
  test('letter case and Unicode form of projects/ change nothing', () => {
    expect(inProjectZone(segs('Projects/plan'))).toBe(true)
    expect(inProjectZone(segs('PROJECTS/x/y'))).toBe(true)
    expect(r.access(carol, segs('Projects/plan/a.md'))).toBe('none')
  })
  test('the system principal writes everywhere outside users/ and .system/; nobody becomes it by role', () => {
    expect(r.access(SYSTEM_PRINCIPAL, segs('projects/plan/a.md'))).toBe('write')
    expect(r.access(SYSTEM_PRINCIPAL, segs('users/alice/a.md'))).toBe('none')
    expect(r.access({ ...dana, id: '\u0000system' }, segs('projects/plan/a.md'))).toBe('none')
  })
  test('listing: an admin lists projects/ but no project folder they are not in, nor what is inside it', () => {
    expect(r.canList(carol, segs('projects'))).toBe(true)
    expect(r.canList(carol, segs('projects/bare'))).toBe(false)
    // projects/plan: its open folder below does not make it passable for them (they are not members)
    expect(r.canList(carol, segs('projects/plan'))).toBe(false)
    expect(r.canList(carol, segs('projects/plan/secret'))).toBe(false)
    const nav = r.navigator(segs('projects/plan'), 10)
    expect(nav(carol)).toEqual({ listable: false, via: [], more: false })
    expect(nav(bob)).toEqual({ listable: true, via: ['projects/plan/open'], more: false })
    expect(r.listing(carol).listable(segs('projects/bare'))).toBe(false)
  })
  test('explain() agrees with access() for an admin in the zone and never says owner-admin there', () => {
    for (const p of ['projects/plan', 'projects/plan/a.md', 'projects/bare/x.md', 'projects/plan/open/x.md']) {
      const e = r.explain(carol, segs(p))
      expect(e.access).toBe(r.access(carol, segs(p)))
      expect(e.reason.kind).not.toBe('owner-admin')
    }
  })
  test('the path helpers', () => {
    expect(inZone('projects/a')).toBe(true); expect(inZone('projects')).toBe(false); expect(inZone('shared/projects/a')).toBe(false)
    expect(insideProject('projects/a/b')).toBe(true); expect(insideProject('projects/a')).toBe(false)
    expect(cutInsideProject('projects/Team plan/notes/x.md')).toBe('projects/Team plan/…')
    expect(cutInsideProject('shared/x.md')).toBe('shared/x.md')
  })
})

let h: Harness
let pid = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b-project-members-only' })
  pid = (await h.api('alice').call(API.createProject, { body: { name: 'Team plan', participants: [{ subjectType: 'user', subjectId: 'erin' }], instructions: 'secret steps' } })).id
  await h.api('alice').call(API.saveContent, { body: { path: 'projects/Team plan/budget 2026.md', content: 'x\n', baseSha256: null } })
})
afterAll(async () => { await h.close() })

describe('the activity log', () => {
  test('an admin who is not a member reads projects/<name>/… for every path inside it, names with spaces, case and old names too', async () => {
    // a file event at a project folder's old name (renamed or deleted since) and a tool summary naming a path inside
    h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action, size, sha256, detail, at) VALUES (NULL, 'alice', 'projects/Old name/plan.md', 'create', 3, 'abc', NULL, ?)").run(new Date().toISOString())
    const items = listAudit(h.ctx.db, { limit: 200 }, 'carol', auditSight(h.ctx, 'carol')).items
    const text = JSON.stringify(items)
    expect(text).not.toContain('budget 2026')
    expect(text).not.toContain('Old name/plan.md')
    expect(text).toContain('projects/Team plan/…')
    expect(text).toContain('projects/Old name/…')
    const file = items.find((x) => x.source === 'file' && x.target?.startsWith('projects/Team plan'))!
    expect(file.detail).toBeNull() // no size, no hash
    // a member of it reads the paths as they are
    const mine = JSON.stringify(listAudit(h.ctx.db, { limit: 200 }, 'alice', auditSight(h.ctx, 'alice')).items)
    expect(mine).toContain('projects/Team plan/budget 2026.md')
    // a filter by a path inside a project the viewer does not read: nothing (existence is not told)
    expect(listAudit(h.ctx.db, { path: 'projects/Team plan/budget 2026.md' }, 'carol', auditSight(h.ctx, 'carol')).items).toEqual([])
    expect(listAudit(h.ctx.db, { path: 'projects/Team plan/nothing.md' }, 'carol', auditSight(h.ctx, 'carol')).items).toEqual([])
  })
  test('a project\'s instructions change is shown without its text to an admin who is not a member', async () => {
    await h.api('alice').call(API.updateProject, { params: { id: pid }, body: { instructions: 'new secret steps' } })
    const row = listAudit(h.ctx.db, { source: 'admin', limit: 200 }, 'carol', auditSight(h.ctx, 'carol')).items.find((x) => x.action === 'project.update')!
    expect(JSON.stringify(row)).not.toContain('secret steps')
    const own = listAudit(h.ctx.db, { source: 'admin', limit: 200 }, 'alice', auditSight(h.ctx, 'alice')).items.find((x) => x.action === 'project.update')!
    expect(JSON.stringify(own)).toContain('new secret steps')
  })
})

describe('the steps that run once at the first start', () => {
  test('owner and admin ids leave shared answers\' audiences; role rules for admins inside projects/ go; schedules there lapse; it runs once', async () => {
    const db = h.ctx.db
    const chat = (await h.api('alice').call(API.createChat, { body: { projectId: pid, title: 'c' } })).id
    const msg = uuidv7()
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, created_at, updated_at) VALUES (?, ?, NULL, 'assistant', 'a', 'done', ?, ?)").run(msg, chat, new Date().toISOString(), new Date().toISOString())
    db.query('INSERT INTO shared_answer_reads (message_id, chat_id, reads) VALUES (?, ?, ?)').run(msg, chat, JSON.stringify([{ c: ['alice', 'carol', 'dana', 'erin'], s: [] }]))
    const folder = db.query("SELECT id FROM folders WHERE path = 'projects/Team plan'").get() as { id: string }
    const rid = uuidv7()
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'role', 'admin', 'read')").run(rid, folder.id)
    const sid = uuidv7()
    db.query("INSERT INTO schedules (id, user_id, title, prompt, repeat, time, save_folder) VALUES (?, 'carol', 't', 'p', 'daily', '09:00', 'projects/Team plan')").run(sid)
    // a folder in projects/ that no project uses (an older build's delete kept it)
    fs.mkdirSync(path.join(h.team, 'projects', 'Left over'), { recursive: true })
    setSetting(db, 'projectsMembersOnly.v1', null)
    db.query("DELETE FROM settings WHERE key = 'projectsMembersOnly.v1'").run()
    await membersOnlyOnce(h.ctx)
    const reads = JSON.parse((db.query('SELECT reads FROM shared_answer_reads WHERE message_id = ?').get(msg) as { reads: string }).reads)
    expect(reads[0].c).toEqual(['alice', 'erin'])
    expect(db.query('SELECT 1 FROM folder_rules WHERE id = ?').get(rid)).toBeNull()
    expect((db.query('SELECT save_lapse_reason FROM schedules WHERE id = ?').get(sid) as { save_lapse_reason: string }).save_lapse_reason).toBe('rules')
    expect(db.query("SELECT 1 FROM audit_log WHERE action = 'projects.members_only'").get()).not.toBeNull()
    // the leftover folder becomes a project of its own when an admin opens the projects they manage (not at start)
    expect(db.query("SELECT 1 FROM projects WHERE folder_path = 'projects/Left over'").get()).toBeNull()
    const m = await h.api('carol').call(API.listProjects, { query: { manage: '1' } })
    const adopted = db.query("SELECT name, created_by FROM projects WHERE folder_path = 'projects/Left over'").get() as { name: string; created_by: string | null } | null
    expect(adopted).toEqual({ name: 'Left over', created_by: null })
    expect(db.query("SELECT 1 FROM audit_log WHERE action = 'project.adopted' AND target = 'projects/Left over'").get()).not.toBeNull()
    expect(m.items.some((x) => x.folderPath === 'projects/Left over' && x.membersEditable)).toBe(true)
    // once: a role rule made after it stays (a second start does nothing)
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'role', 'admin', 'read')").run(rid, folder.id)
    await membersOnlyOnce(h.ctx)
    expect(db.query('SELECT 1 FROM folder_rules WHERE id = ?').get(rid)).not.toBeNull()
    db.query('DELETE FROM folder_rules WHERE id = ?').run(rid)
  })
})

describe('who starts to read a project is recorded and its members are told', () => {
  test('a new account in a group the project names: audit row and a notice to its members, not to the person', async () => {
    const g = await h.api('dana').call(API.createGroup, { body: { name: 'plan crew', memberIds: [] } })
    const acc = await h.api('alice').call(API.getProjectAccess, { params: { id: pid } })
    const parts = acc.participants.filter((x) => !x.creator).map((x) => ({ subjectType: x.subjectType, subjectId: x.subjectId }))
    await h.api('carol').call(API.putProjectParticipants, { params: { id: pid }, body: { participants: [...parts, { subjectType: 'group', subjectId: g.id }], expectedHash: acc.rulesHash } })
    const made = await h.api('dana').call(API.createUser, { body: { username: 'newbie', name: 'New Bie', role: 'member', groupIds: [g.id], locale: 'en' } })
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'project.member_gained' AND json_extract(detail, '$.userId') = ?").get(made.user.id) as { detail: string } | null
    expect(row).not.toBeNull()
    expect(JSON.parse(row!.detail)).toMatchObject({ projectId: pid, via: 'account' })
    const told = h.ctx.db.query("SELECT user_id FROM project_notices WHERE event_type = 'project.joined'").all() as { user_id: string }[]
    expect(told.map((x) => x.user_id)).toContain('alice')
    expect(told.map((x) => x.user_id)).not.toContain(made.user.id)
    expect(atLeast(h.ctx.files.rules().access(h.ctx.files.principal(made.user.id), segs('projects/Team plan')), 'read')).toBe(true)
  })
})

describe('Admin › Folder permissions answers a project folder as the permission function does', () => {
  test('the deciding folder never goes above projects/<name>', () => {
    const ruleFolders = new Set(['', 'projects', 'projects/plan/open'])
    expect(ruleFolderOf(ruleFolders, segs('projects/oldie'))).toBe('projects/oldie')
    expect(ruleFolderOf(ruleFolders, segs('projects/oldie/a/b'))).toBe('projects/oldie')
    expect(ruleFolderOf(ruleFolders, segs('projects/plan/open/x'))).toBe('projects/plan/open')
    expect(ruleFolderOf(ruleFolders, segs('projects'))).toBe('projects')
    expect(ruleFolderOf(ruleFolders, segs('shared/a'))).toBe('')
  })

  test('an older project folder with no settings of its own: the owner and admins have no access there, by person and by folder', async () => {
    // a project made by an older build whose folder carries no rules: it would answer as projects/ or the root, where
    // the owner and admins read everything, but inside a project they are judged by its own rules only
    const db = h.ctx.db
    fs.mkdirSync(path.join(h.team, 'projects', 'Oldie'), { recursive: true })
    const id = uuidv7()
    db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(id, 'Oldie', 'projects/Oldie', 'alice', new Date().toISOString())
    try {
      for (const who of ['dana', 'carol']) {
        const mine = await h.api('dana').call(API.explainPersonAccess, { params: { id: who }, query: { prefix: 'projects' } })
        const row = mine.folders.find((f) => f.path === 'projects/Oldie')
        expect(row).toMatchObject({ access: 'none' })
        expect(row!.reason.kind).not.toBe('owner-admin')
        expect(atLeast(h.ctx.files.rules().access(h.ctx.files.principal(who), segs('projects/Oldie')), 'read')).toBe(false)
      }
      const at = await h.api('carol').call(API.explainFolderAccess, { query: { path: 'projects/Oldie' } })
      for (const who of ['dana', 'carol']) expect(at.people.find((x) => x.user.id === who)).toMatchObject({ access: 'none' })
      expect(at.people.filter((x) => x.reason.kind === 'owner-admin')).toEqual([])
    } finally {
      db.query('DELETE FROM projects WHERE id = ?').run(id)
      fs.rmSync(path.join(h.team, 'projects', 'Oldie'), { recursive: true, force: true })
    }
  })
})

// ---------------- the adversarial review of the built PR (2026-11-11) ----------------
const errOf = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return e as { status: number; body: { params?: { reason?: string } } } }
  throw new Error('expected a refusal')
}

describe('an account enabled again is a join like any other (adversarial review, must-fix)', () => {
  test('a member and an admin disabled, their group made a project\'s people, enabled again: recorded and told', async () => {
    const db = h.ctx.db
    const g = await h.api('dana').call(API.createGroup, { body: { name: 'leads', memberIds: [] } })
    const back = (await h.api('dana').call(API.createUser, { body: { username: 'returner', name: 'Re Turner', role: 'member', groupIds: [g.id], locale: 'en' } })).user.id
    const boss = (await h.api('dana').call(API.createUser, { body: { username: 'returnboss', name: 'Re Boss', role: 'admin', groupIds: [g.id], locale: 'en' } })).user.id
    for (const id of [back, boss]) await h.api('dana').call(API.updateUser, { params: { id }, body: { status: 'disabled' } })
    // while they are off, carol (an admin) makes the group her project's people: nobody active joins through it
    const pr = (await h.api('carol').call(API.createProject, { body: { name: 'Comeback', participants: [{ subjectType: 'group', subjectId: g.id }], instructions: '' } })).id
    const joined = (who: string) => db.query("SELECT detail FROM audit_log WHERE action = 'project.member_gained' AND target = ? AND json_extract(detail, '$.userId') = ?").all(pr, who) as { detail: string }[]
    expect(joined(back)).toEqual([])
    const toldBefore = (db.query("SELECT COUNT(*) AS n FROM project_notices WHERE user_id = 'carol'").get() as { n: number }).n
    // enabled again with nothing else: each now reads the project, so it is a join (the admin without "Add me")
    for (const id of [back, boss]) await h.api('dana').call(API.updateUser, { params: { id }, body: { status: 'active' } })
    for (const id of [back, boss]) {
      expect(atLeast(h.ctx.files.rules().access(h.ctx.files.principal(id), segs('projects/Comeback')), 'read')).toBe(true)
      const rows = joined(id)
      expect(rows.length).toBe(1)
      expect(JSON.parse(rows[0]!.detail)).toMatchObject({ projectId: pr, userId: id, via: 'account' })
    }
    // carol, its member, is told of both
    expect((db.query("SELECT COUNT(*) AS n FROM project_notices WHERE user_id = 'carol'").get() as { n: number }).n).toBe(toldBefore + 2)
  })

  test('a disabled account joins no new group; a group keeps one already in it; enabling it in the same change may', async () => {
    const g = await h.api('dana').call(API.createGroup, { body: { name: 'crew two', memberIds: [] } })
    const other = await h.api('dana').call(API.createGroup, { body: { name: 'crew three', memberIds: [] } })
    const off = (await h.api('dana').call(API.createUser, { body: { username: 'offline', name: 'Off Line', role: 'member', groupIds: [g.id], locale: 'en' } })).user.id
    await h.api('dana').call(API.updateUser, { params: { id: off }, body: { status: 'disabled' } })
    // into a new group, or added to one, through the group screens (and the connector, which uses them)
    expect(await errOf(h.api('dana').call(API.createGroup, { body: { name: 'crew four', memberIds: [off] } }))).toMatchObject({ status: 400, body: { params: { reason: 'account_disabled' } } })
    expect(await errOf(h.api('dana').call(API.updateGroup, { params: { id: other.id }, body: { memberIds: [off] } }))).toMatchObject({ status: 400, body: { params: { reason: 'account_disabled' } } })
    // a group it is in already keeps it (its screen sends the whole list back)
    await h.api('dana').call(API.updateGroup, { params: { id: g.id }, body: { name: 'crew two b', memberIds: [off] } })
    // through the person's own edit: a new group is refused, the groups it has are fine
    expect(await errOf(h.api('dana').call(API.updateUser, { params: { id: off }, body: { groupIds: [g.id, other.id] } }))).toMatchObject({ status: 400, body: { params: { reason: 'account_disabled' } } })
    await h.api('dana').call(API.updateUser, { params: { id: off }, body: { groupIds: [g.id] } })
    // enabled in the same change: the new group is taken
    const on = await h.api('dana').call(API.updateUser, { params: { id: off }, body: { status: 'active', groupIds: [g.id, other.id] } })
    expect(on.groupIds.sort()).toEqual([g.id, other.id].sort())
  })
})

describe('taking an other setting out of a project only narrows (adversarial review)', () => {
  const ruleOn = (folder: string, t: string, sid: string | null, access: string) => {
    const f = h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(folder) as { id: string }
    h.ctx.db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?,?,?,?,?)').run(uuidv7(), f.id, t, sid, access)
  }
  test('a "no access" for someone a member group lets in: refused in the dry run and the save; named as a member: taken', async () => {
    const pr = (await h.api('alice').call(API.createProject, { body: { name: 'Narrow', participants: [{ subjectType: 'group', subjectId: 'marketing' }], instructions: '' } })).id
    // an older build's setting: erin (in marketing) has no access here
    ruleOn('projects/Narrow', 'user', 'erin', 'none')
    ruleOn('projects/Narrow', 'user', 'bob', 'read')
    const erinOut = (w: string) => atLeast(h.ctx.files.rules().access(h.ctx.files.principal('erin'), segs(w)), 'read')
    expect(erinOut('projects/Narrow')).toBe(false)
    const acc = await h.api('alice').call(API.getProjectAccess, { params: { id: pr } })
    const parts = acc.participants.filter((x) => !x.creator).map((x) => ({ subjectType: x.subjectType, subjectId: x.subjectId }))
    const removeRules = [{ subjectType: 'user' as const, subjectId: 'erin' }]
    expect(await errOf(h.api('alice').call(API.previewProjectAccess, { body: { projectId: pr, participants: parts, removeRules } }))).toMatchObject({ status: 409, body: { params: { reason: 'remove_widens' } } })
    expect(await errOf(h.api('carol').call(API.putProjectParticipants, { params: { id: pr }, body: { participants: parts, expectedHash: acc.rulesHash, removeRules } }))).toMatchObject({ status: 409, body: { params: { reason: 'remove_widens' } } })
    expect(erinOut('projects/Narrow')).toBe(false)
    // bob's read taken out: he loses it, which is allowed
    const narrowed = await h.api('alice').call(API.putProjectParticipants, { params: { id: pr }, body: { participants: parts, expectedHash: acc.rulesHash, removeRules: [{ subjectType: 'user', subjectId: 'bob' }] } })
    expect(atLeast(h.ctx.files.rules().access(h.ctx.files.principal('bob'), segs('projects/Narrow')), 'read')).toBe(false)
    // erin named as a member in the same change: her "no access" goes, by that choice
    await h.api('alice').call(API.putProjectParticipants, { params: { id: pr }, body: { participants: [...parts, { subjectType: 'user', subjectId: 'erin' }], expectedHash: narrowed.rulesHash, removeRules } })
    expect(erinOut('projects/Narrow')).toBe(true)
  })
})

describe('a new project never takes a path that old saved versions name (adversarial review)', () => {
  test('a project deleted for good left versions under projects/Ghost: the new "Ghost" gets its own folder', async () => {
    h.ctx.db.query("INSERT INTO file_versions (id, path, version, sha256, size, kind, path_at_save) VALUES (?, 'projects/Ghost/plan.md', 1, ?, 4, 'edit', 'projects/Ghost/plan.md')").run(uuidv7(), 'a'.repeat(64))
    expect(h.ctx.db.query("SELECT 1 FROM folders WHERE path = 'projects/Ghost'").get()).toBeNull()
    const made = await h.api('carol').call(API.createProject, { body: { name: 'Ghost', participants: [], instructions: '' } })
    expect(made.folderPath).toBe('projects/Ghost-2')
  })
})
