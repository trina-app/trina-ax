// Security round 1 (sharing-works #5): a team project an admin created on a new folder was shared with nobody (no
// participants, no rules: only admins could see it), and members could rely on any projects/ write to make new team
// folders. Design tabs 2 / 4 / 5: ① a new projects/<slug> is made by admins with its rules (each participant and the
// creator write, nobody else) in one transaction; ② an existing folder the caller can write keeps its rules (a rule-less
// folders row is added); ③ a personal project lives in users/<me>/projects/<slug>/.
// Fixture: alice, erin = marketing (group id 'marketing'); bob = finance ('finance'); carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r1-project-create') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const create = (who: Who, body: Record<string, unknown>) => A.json('/api/projects', { as: who, ...jsonBody(body) })
const listed = async (who: Who, id: string) => ((await A.json('/api/projects', { as: who })).body.items as { id: string }[]).some((p) => p.id === id)
const save = (who: Who, p: string) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content: `${who}\n`, baseSha256: null }, 'PUT') })
const rulesAt = (p: string) => (A.ctx.db.query('SELECT r.subject_type AS t, r.subject_id AS s, r.access AS a FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? ORDER BY t, s').all(p) as { t: string; s: string; a: string }[])

describe('① a new team project folder', () => {
  test('an admin creates projects/<slug> with participants: they see it and write there, others do not', async () => {
    A.hub.clear()
    const r = await create('carol', { name: '하반기 전략', folderPath: 'projects/하반기-전략', participants: [{ subjectType: 'group', subjectId: 'marketing' }] })
    expect(r.status).toBe(201)
    expect(r.body.folderPath).toBe('projects/하반기-전략')
    expect(rulesAt('projects/하반기-전략')).toEqual([{ t: 'group', s: 'marketing', a: 'write' }, { t: 'user', s: 'carol', a: 'write' }])
    for (const who of ['alice', 'erin', 'carol', 'dana'] as const) expect(await listed(who, r.body.id)).toBe(true)
    expect(await listed('bob', r.body.id)).toBe(false)
    expect((await save('alice', 'projects/하반기-전략/memo.md')).status).toBe(200)
    expect((await A.json('/api/files/content' + q({ path: 'projects/하반기-전략/memo.md' }), { as: 'bob' })).status).toBe(404)
    // audited, and the people who gained access are told (access_changed)
    expect(A.ctx.db.query("SELECT 1 AS x FROM audit_log WHERE action = 'project.create' AND target = ?").get(r.body.id)).toEqual({ x: 1 })
    expect(A.hub.events.filter((e) => e.ev.type === 'notice' && (e.ev.data as any).code === 'access_changed').map((e) => e.userId).sort()).toEqual(['alice', 'erin'])
  })

  test('without a folder the admin gets projects/<name>; a person can be a participant', async () => {
    const r = await create('dana', { name: 'Q1 plan', participants: [{ subjectType: 'user', subjectId: 'bob' }] })
    expect(r.status).toBe(201)
    expect(r.body.folderPath).toBe('projects/Q1 plan')
    expect(await listed('bob', r.body.id)).toBe(true)
    expect(await listed('alice', r.body.id)).toBe(false)
    const again = await create('dana', { name: 'Q1 plan' }) // the name is taken: a new folder, never the old one
    expect(again.body.folderPath).toBe('projects/Q1 plan-2')
  })

  test('members cannot make a new team project folder', async () => {
    expect((await create('alice', { name: 'mine', folderPath: 'projects/mine' })).status).toBe(403)
    expect((await create('alice', { name: 'mine' })).status).toBe(403)
    expect(fs.existsSync(path.join(A.team, 'projects/mine'))).toBe(false)
  })

  test('an unknown participant is refused and the folder is not left behind; participants only for a new folder', async () => {
    const r = await create('carol', { name: 'bad', folderPath: 'projects/bad', participants: [{ subjectType: 'group', subjectId: 'nope' }] })
    expect(r.status).toBe(400)
    expect(fs.existsSync(path.join(A.team, 'projects/bad'))).toBe(false)
    expect((await create('carol', { name: 'x', folderPath: 'groups/finance', participants: [{ subjectType: 'group', subjectId: 'marketing' }] })).status).toBe(400)
    expect(rulesAt('groups/finance')).toEqual([{ t: 'group', s: 'finance', a: 'write' }])
  })
})

describe('② an existing folder and ③ a personal project', () => {
  test('a member on a folder they can write: rules unchanged, a rule-less folders row marks it', async () => {
    const r = await create('alice', { name: 'Q4 campaign', folderPath: 'groups/marketing/q4' })
    expect(r.status).toBe(201)
    expect(A.ctx.db.query("SELECT 1 AS x FROM folders WHERE path = 'groups/marketing/q4'").get()).toEqual({ x: 1 })
    expect(rulesAt('groups/marketing/q4')).toEqual([])
    expect(await listed('erin', r.body.id)).toBe(true)
    expect(await listed('bob', r.body.id)).toBe(false)
  })

  test('a personal project is the caller\'s alone and leaves no folders row under users/', async () => {
    const r = await create('alice', { name: '내 메모', scope: 'personal' })
    expect(r.status).toBe(201)
    expect(r.body.folderPath).toBe('users/alice/projects/내 메모')
    for (const who of ['bob', 'carol', 'dana', 'erin'] as const) expect(await listed(who, r.body.id)).toBe(false)
    expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM folders WHERE path LIKE 'users/%'").get()).toEqual({ n: 0 })
    expect((await create('alice', { name: 'x', scope: 'personal', folderPath: 'shared/x' })).status).toBe(400)
    expect((await create('alice', { name: 'x', scope: 'personal', participants: [{ subjectType: 'user', subjectId: 'bob' }] })).status).toBe(400)
  })
})
