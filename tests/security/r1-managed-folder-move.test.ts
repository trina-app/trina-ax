// Security round 1 (sharing-works #1): a member who could write a group or project folder could move the whole folder
// into users/<me>/ (rules are not read there: it became private to them, and the owner and admins could not even see it
// to move it back), rename it, or trash it for the whole group. Design tab 4 move/delete: a folder that is or contains a
// folders row (group / project / rule folder, shared/, skills/) moves, is renamed and goes to the trash only by an admin
// or the owner, and never under users/ (400 invalid_path, owner included). Moving an ordinary item into users/<me>/
// that others can read answers 409 audience_narrowed unless confirm:true.
// Fixture: alice, erin = marketing members (groups/marketing write); bob = finance; carol = admin; dana = owner;
// projects/falcon: alice write, finance read; shared/: everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { exists, jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => {
  A = await makeCApp('sec-r1-managed-move')
  for (const u of ['carol', 'dana', 'erin']) fs.mkdirSync(path.join(A.team, 'users', u), { recursive: true, mode: 0o700 }) // personal folders
})
afterAll(async () => { await A.close() })
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const move = (who: Who, from: string, to: string, extra: Record<string, unknown> = {}) => A.json('/api/files/move', { as: who, ...jsonBody({ from, to, ...extra }) })
const del = (who: Who, p: string) => A.json('/api/files' + q({ path: p }), { as: who, method: 'DELETE' })
const read = (who: Who, p: string) => A.json('/api/files/content' + q({ path: p }), { as: who })
const folderRows = () => (A.ctx.db.query('SELECT path FROM folders ORDER BY path').all() as { path: string }[]).map((r) => r.path)

describe('group / project / rule folders: members cannot move, rename or trash them', () => {
  test('a member moving their group folder into their personal folder gets 403 and nothing moves', async () => {
    const rows = folderRows()
    // groups/finance has no hidden subfolder, so nothing but this rule stops bob (the original exploit's shape)
    const r = await move('bob', 'groups/finance', 'users/bob/finance')
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('forbidden')
    expect(exists(A.team, 'groups/finance/budget.md')).toBe(true)
    expect(exists(A.team, 'users/bob/finance')).toBe(false)
    expect((await read('carol', 'groups/finance/budget.md')).status).toBe(200)
    expect((await move('alice', 'groups/marketing', 'users/alice/marketing')).status).toBe(403)
    expect(exists(A.team, 'groups/marketing/campaign-brief.md')).toBe(true)
    expect(folderRows()).toEqual(rows)
    expect((await read('erin', 'groups/marketing/campaign-brief.md')).status).toBe(200)
  })

  test('the same for a project folder, a rename in place, and a move to another group path', async () => {
    expect((await move('alice', 'projects/falcon', 'users/alice/falcon')).status).toBe(403)
    expect((await move('alice', 'projects/falcon', 'projects/falcon-mine')).status).toBe(403)
    expect((await move('alice', 'groups/marketing', 'groups/marketing-renamed')).status).toBe(403)
    expect((await move('bob', 'groups/finance', 'groups/marketing/finance')).status).toBe(403)
    expect(exists(A.team, 'projects/falcon/plan.md')).toBe(true)
    expect((A.ctx.db.query("SELECT COUNT(*) AS n FROM folders WHERE path IN ('projects/falcon', 'groups/marketing', 'groups/finance')").get() as { n: number }).n).toBe(3)
  })

  test('a plain folder that holds a folders row (even one without rules) is managed too', async () => {
    fs.mkdirSync(path.join(A.team, 'shared/team-x/inner'), { recursive: true })
    A.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_team_x_inner', 'shared/team-x/inner')").run()
    expect((await move('alice', 'shared/team-x', 'users/alice/team-x')).status).toBe(403)
    expect((await move('alice', 'shared/team-x', 'shared/team-y')).status).toBe(403)
    expect((await del('alice', 'shared/team-x')).status).toBe(403)
    expect(exists(A.team, 'shared/team-x/inner')).toBe(true)
  })

  test('members cannot trash group, project or shared folders', async () => {
    const d1 = await del('alice', 'groups/marketing')
    expect(d1.status).toBe(403)
    expect((await del('bob', 'shared')).status).toBe(403)
    expect((await del('alice', 'projects/falcon')).status).toBe(403)
    expect(exists(A.team, 'groups/marketing')).toBe(true)
    expect(exists(A.team, 'shared/glossary.md')).toBe(true)
    expect((await A.json('/api/files/trash', { as: 'erin' })).body.items).toEqual([])
  })

  test('members still move, rename and trash ordinary items inside their group folder', async () => {
    expect((await move('alice', 'groups/marketing/campaigns', 'groups/marketing/campaigns-2025')).status).toBe(200)
    expect((await read('erin', 'groups/marketing/campaigns-2025/naver-plan.md')).status).toBe(200)
    expect((await del('erin', 'groups/marketing/campaigns-2025/email-plan.md')).status).toBe(200)
  })
})

describe('admins and the owner', () => {
  test('nobody moves a managed folder under users/: 400 invalid_path, owner included', async () => {
    for (const who of ['carol', 'dana'] as const) {
      const r = await move(who, 'groups/marketing', `users/${who}/marketing`)
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe('validation')
      expect(r.body.error.fields.to).toContain('invalid_path')
    }
    expect((await move('carol', 'projects/falcon', 'users/carol/falcon')).status).toBe(400)
    expect((await move('dana', 'shared/team-x', 'users/dana/team-x')).status).toBe(400)
    expect(exists(A.team, 'groups/marketing')).toBe(true)
  })

  test('an admin still renames a group folder (the rule follows) and the owner can trash one', async () => {
    expect((await move('carol', 'groups/marketing', 'groups/marketing-team')).status).toBe(200)
    expect(folderRows()).toContain('groups/marketing-team')
    expect((await read('alice', 'groups/marketing-team/campaign-brief.md')).status).toBe(200)
    expect((await read('bob', 'groups/marketing-team/campaign-brief.md')).status).toBe(404)
    expect((await move('carol', 'groups/marketing-team', 'groups/marketing')).status).toBe(200)
    expect((await del('dana', 'shared/team-x')).status).toBe(200)
  })
})

describe('ordinary items into users/<me>/: confirm who loses sight of it', () => {
  test('a shared file: 409 audience_narrowed with a count of people, then confirm:true moves it', async () => {
    const r = await move('alice', 'shared/glossary.md', 'users/alice/glossary.md')
    expect(r.status).toBe(409)
    expect(r.body.error.params).toEqual({ reason: 'audience_narrowed', lostViewers: 4 }) // bob, carol, dana, erin
    expect(JSON.stringify(r.body)).not.toContain('Bob') // counted, never named
    expect(exists(A.team, 'shared/glossary.md')).toBe(true)
    const ok = await move('alice', 'shared/glossary.md', 'users/alice/glossary.md', { confirm: true })
    expect(ok.status).toBe(200)
    expect((await read('bob', 'shared/glossary.md')).status).toBe(404)
    const ev = A.ctx.db.query("SELECT detail FROM file_events WHERE path = 'users/alice/glossary.md' AND action = 'create' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(ev.detail).audienceNarrowed).toBe(4)
  })

  test('a group file counts the group and the admins; an ordinary folder works the same way', async () => {
    const r = await move('alice', 'groups/marketing/campaigns-2025/naver-plan.md', 'users/alice/naver-plan.md')
    expect(r.status).toBe(409)
    expect(r.body.error.params.lostViewers).toBe(3) // erin, carol, dana
    const f = await move('erin', 'shared/policies', 'users/erin/policies')
    expect(f.status).toBe(409)
    expect((await move('erin', 'shared/policies', 'users/erin/policies', { confirm: true })).status).toBe(200)
  })

  test('moves inside one\'s own folder need no confirmation', async () => {
    expect((await move('alice', 'users/alice/todo.md', 'users/alice/drafts/todo.md')).status).toBe(200)
  })
})
