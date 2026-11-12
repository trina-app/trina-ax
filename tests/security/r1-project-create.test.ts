// Security round 1 (sharing-works #5) and docs/DECISIONS.md "Projects live only in projects/": a team project is
// always a new folder projects/<name>, made by the server with its rules (each participant and the creator write,
// everyone else none) in one go; members make them too unless the team lets only admins; a personal project lives only
// in users/<me>/projects/<name>. No other place: an existing team folder, shared/, groups/, the root. Its contents are
// its members' only: the owner and admins list it only with manage=1 unless they are members (docs/DECISIONS.md
// "Project contents only for members").
// Fixture: alice, erin = marketing (group id 'marketing'); bob = finance ('finance'); carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared/api'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { ensureFolderRow, replaceRules } from '../../server/src/admin/folders'
import { updateTeamSettings } from '../../server/src/admin/settings'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r1-project-create') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const create = (who: Who, body: Record<string, unknown>) => A.json('/api/projects', { as: who, ...jsonBody(body) })
const listed = async (who: Who, id: string) => ((await A.json('/api/projects', { as: who })).body.items as { id: string }[]).some((p) => p.id === id)
/** the list with manage=1 (the owner and admins: also the team projects they manage without being a member) */
const managed = async (who: Who, id: string) => ((await A.json('/api/projects?manage=1', { as: who })).body.items as { id: string; member?: false; instructions: string }[]).find((p) => p.id === id)
const save = (who: Who, p: string) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content: `${who}\n`, baseSha256: null }, 'PUT') })
const rulesAt = (p: string) => (A.ctx.db.query('SELECT r.subject_type AS t, r.subject_id AS s, r.access AS a FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? ORDER BY t, s').all(p) as { t: string; s: string | null; a: string }[])
const projectDirs = () => fs.readdirSync(path.join(A.team, 'projects')).sort()
const floor = { t: 'everyone', s: null, a: 'none' }

describe('a new team project folder', () => {
  test('an admin makes projects/<name> with participants: they see it and write there, nobody else', async () => {
    A.hub.clear()
    const r = await create('carol', { name: '하반기 전략', folderPath: 'projects/하반기-전략', participants: [{ subjectType: 'group', subjectId: 'marketing' }] })
    expect(r.status).toBe(201)
    expect(r.body.folderPath).toBe('projects/하반기-전략')
    expect(rulesAt('projects/하반기-전략')).toEqual([floor, { t: 'group', s: 'marketing', a: 'write' }, { t: 'user', s: 'carol', a: 'write' }])
    for (const who of ['alice', 'erin', 'carol'] as const) expect(await listed(who, r.body.id)).toBe(true)
    expect(await listed('bob', r.body.id)).toBe(false)
    // the owner is not one of its members: she manages it, she does not read it
    expect(await listed('dana', r.body.id)).toBe(false)
    expect(await managed('dana', r.body.id)).toMatchObject({ member: false, instructions: '' })
    expect((await A.json('/api/files/content' + q({ path: 'projects/하반기-전략/memo.md' }), { as: 'dana' })).status).toBe(404)
    expect((await save('alice', 'projects/하반기-전략/memo.md')).status).toBe(200)
    expect((await A.json('/api/files/content' + q({ path: 'projects/하반기-전략/memo.md' }), { as: 'bob' })).status).toBe(404)
    // audited, and the people who gained access are told (access_changed): carol too now, who reads it by her creator's
    // rule like any creator (no longer by her role); never the owner, who does not read it
    expect(A.ctx.db.query("SELECT 1 AS x FROM audit_log WHERE action = 'project.create' AND target = ?").get(r.body.id)).toEqual({ x: 1 })
    expect(A.hub.events.filter((e) => e.ev.type === 'notice' && (e.ev.data as any).code === 'access_changed').map((e) => e.userId).sort()).toEqual(['alice', 'carol', 'erin'])
  })

  test('without a folder: projects/<name>; a taken name (on disk or kept by a project) is never reused', async () => {
    const r = await create('dana', { name: 'Q1 plan', participants: [{ subjectType: 'user', subjectId: 'bob' }] })
    expect(r.status).toBe(201)
    expect(r.body.folderPath).toBe('projects/Q1 plan')
    expect(await listed('bob', r.body.id)).toBe(true)
    expect(await listed('alice', r.body.id)).toBe(false)
    expect((await create('dana', { name: 'Q1 plan' })).body.folderPath).toBe('projects/Q1 plan-2')
    // an existing folder named by folderPath is not taken over: the project gets a new one beside it, with its own rules
    const falcon = await create('alice', { name: 'Falcon', folderPath: 'projects/falcon' })
    expect(falcon.status).toBe(201)
    expect(falcon.body.folderPath).toBe('projects/falcon-2')
    expect(rulesAt('projects/falcon')).toEqual([{ t: 'group', s: 'finance', a: 'read' }, { t: 'user', s: 'alice', a: 'write' }])
    expect(await listed('bob', falcon.body.id)).toBe(false)
  })

  test('members make team projects with their own groups and active people; another group is refused', async () => {
    const r = await create('alice', { name: 'Launch', participants: [{ subjectType: 'group', subjectId: 'marketing' }, { subjectType: 'user', subjectId: 'bob' }] })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ folderPath: 'projects/Launch', canEdit: true })
    expect(rulesAt('projects/Launch')).toEqual([floor, { t: 'group', s: 'marketing', a: 'write' }, { t: 'user', s: 'alice', a: 'write' }, { t: 'user', s: 'bob', a: 'write' }])
    for (const who of ['alice', 'bob', 'erin'] as const) expect(await listed(who, r.body.id)).toBe(true)
    // the owner and admins are not members: in their manage list only
    for (const who of ['carol', 'dana'] as const) {
      expect(await listed(who, r.body.id)).toBe(false)
      expect(await managed(who, r.body.id)).toMatchObject({ member: false })
    }
    // the folder was made by the server: alice has no write on projects/ itself
    expect((await save('alice', 'projects/stray.md')).status).not.toBe(200)
    const before = projectDirs()
    const other = await create('alice', { name: 'Fin', participants: [{ subjectType: 'group', subjectId: 'finance' }] })
    expect([other.status, other.body.error.fields]).toEqual([400, { 'body.participants.0.subjectId': 'not a group you can choose' }])
    expect((await create('alice', { name: 'Nobody', participants: [{ subjectType: 'user', subjectId: 'ghost' }] })).status).toBe(400)
    expect(projectDirs()).toEqual(before)
  })

  test('the admin switch: members get 403 (create and share), admins still make them', async () => {
    updateTeamSettings(A.ctx.db, { projectCreators: 'admins' })
    try {
      const before = projectDirs()
      const r = await create('alice', { name: 'mine' })
      expect([r.status, r.body.error.params?.reason]).toEqual([403, 'projects_admins_only'])
      expect((await create('alice', { name: 'mine', folderPath: 'projects/mine' })).status).toBe(403)
      expect((await A.json('/api/projects/access-preview', { as: 'alice', ...jsonBody({ participants: [] }) })).status).toBe(403)
      const personal = await create('alice', { name: 'to share', scope: 'personal' })
      expect(personal.status).toBe(201)
      expect((await A.json(`/api/projects/${personal.body.id}/share`, { as: 'alice', ...jsonBody({ participants: [] }) })).status).toBe(403)
      expect(projectDirs()).toEqual(before)
      expect((await create('carol', { name: 'admins only' })).status).toBe(201)
    } finally { updateTeamSettings(A.ctx.db, { projectCreators: 'members' }) }
    // members may again
    expect((await create('alice', { name: 'mine again' })).status).toBe(201)
  })

  test('the "everyone: none" floor: an admin opening the team root does not open a project folder (to herself neither)', async () => {
    const r = await create('alice', { name: 'Secret plan' })
    expect(rulesAt('projects/Secret plan')).toEqual([floor, { t: 'user', s: 'alice', a: 'write' }])
    const root = ensureFolderRow(A.ctx.db, '')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, root.id, [{ subjectType: 'everyone', subjectId: null, access: 'read' }], 'carol'))()
    try {
      expect(await listed('bob', r.body.id)).toBe(false)
      expect(await listed('erin', r.body.id)).toBe(false)
      expect((await A.json('/api/files/tree' + q({ path: 'projects/Secret plan' }), { as: 'bob' })).status).toBe(404)
      // the root's rule never reaches into a project for the owner and admins either: they manage it, they do not read it
      for (const who of ['carol', 'dana'] as const) {
        expect(await listed(who, r.body.id)).toBe(false)
        expect(await managed(who, r.body.id)).toMatchObject({ member: false })
        expect((await A.json('/api/files/tree' + q({ path: 'projects/Secret plan' }), { as: who })).status).toBe(404)
      }
    } finally { A.ctx.db.transaction(() => replaceRules(A.ctx.db, root.id, [], 'carol'))() }
  })

  test('deleting the group that was a project folder\'s last rule keeps the floor (older folders too)', async () => {
    const g = 'g-temp'
    A.ctx.db.query("INSERT INTO groups (id, name) VALUES (?, 'Temp')").run(g)
    A.ctx.db.query("INSERT INTO group_members VALUES (?, 'erin')").run(g)
    // an older build's project folder: one group rule, no floor
    fs.mkdirSync(path.join(A.team, 'projects/old-one'), { recursive: true })
    const row = ensureFolderRow(A.ctx.db, 'projects/old-one')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, row.id, [{ subjectType: 'group', subjectId: g, access: 'write' }], 'carol'))()
    const old = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'Old', 'projects/old-one', '', 'carol', '2026-01-01T00:00:00Z')").run(old)
    expect((await A.json(`/api/admin/groups/${g}`, { as: 'carol', method: 'DELETE' })).status).toBe(204)
    expect(rulesAt('projects/old-one')).toEqual([floor])
    expect(await listed('erin', old)).toBe(false)
    // nobody reads it now; its creator, an admin, still manages it
    expect(await listed('carol', old)).toBe(false)
    expect(await managed('carol', old)).toMatchObject({ member: false })
  })

  test('an unknown participant is refused and no folder is left behind', async () => {
    const before = projectDirs()
    const r = await create('carol', { name: 'bad', folderPath: 'projects/bad', participants: [{ subjectType: 'group', subjectId: 'nope' }] })
    expect(r.status).toBe(400)
    expect(projectDirs()).toEqual(before)
  })
})

describe('nowhere else', () => {
  test('shared/, groups/, the root, an existing team folder or a deeper path: 400 project_location, nothing made', async () => {
    const before = projectDirs()
    for (const folderPath of ['shared', 'shared/new-one', 'groups/marketing', 'groups/marketing/q4', '', 'projects', 'projects/a/b', 'skills/x', 'users/alice/projects/x']) {
      for (const who of ['alice', 'carol'] as const) {
        const r = await create(who, { name: 'x', folderPath })
        expect([folderPath, r.status, r.body.error?.params?.reason]).toEqual([folderPath, 400, 'project_location'])
      }
    }
    expect(projectDirs()).toEqual(before)
    expect(fs.existsSync(path.join(A.team, 'shared/new-one'))).toBe(false)
    expect(fs.existsSync(path.join(A.team, 'groups/marketing/q4'))).toBe(false)
    expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM projects WHERE name = 'x'").get()).toEqual({ n: 0 })
  })

  test('a personal project only in users/<me>/projects/<name>: the caller\'s alone, no folders row under users/', async () => {
    const r = await create('alice', { name: '내 메모', scope: 'personal' })
    expect(r.status).toBe(201)
    expect(r.body.folderPath).toBe('users/alice/projects/내 메모')
    for (const who of ['bob', 'carol', 'dana', 'erin'] as const) expect(await listed(who, r.body.id)).toBe(false)
    expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM folders WHERE path LIKE 'users/%'").get()).toEqual({ n: 0 })
    const named = await create('alice', { name: 'Named', scope: 'personal', folderPath: 'users/alice/projects/named' })
    expect([named.status, named.body.folderPath]).toEqual([201, 'users/alice/projects/named'])
    for (const folderPath of ['users/alice', 'users/alice/drafts', 'users/alice/projects', 'users/alice/projects/a/b', 'users/bob/projects/x', 'shared/x', 'projects/x', '']) {
      const x = await create('alice', { name: 'x', scope: 'personal', folderPath })
      expect([folderPath, x.status, x.body.error?.params?.reason]).toEqual([folderPath, 400, 'project_location'])
    }
    expect(fs.existsSync(path.join(A.team, 'users/alice/drafts/projects'))).toBe(false)
    expect((await create('alice', { name: 'x', scope: 'personal', participants: [{ subjectType: 'user', subjectId: 'bob' }] })).status).toBe(400)
  })
})
