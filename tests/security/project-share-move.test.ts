// Sharing a personal project moves its folder (docs/DECISIONS.md "Making a project", owner 2026-11-13: "휴지통에
// 들어간다고??"): POST /api/projects/:id/share makes projects/<name> with the members' rules, then moves the personal
// folder onto it in one step (TeamFiles.moveFolderOnto: the database part and the rename in one transaction).
// - Nothing goes to the trash and no second copy is left; the history of its files moves with them.
// - A move that fails leaves the personal folder, its files and the project as they were, and no projects/<name>.
// - Only the members see projects/<name>: its rules are in place before the files arrive; nobody else (the owner and
//   admins included, docs/DECISIONS.md "Project contents only for members") reads it or hears of it.
// - What I deleted from the folder before sharing stays in my own trash, at its personal path.
// Fixture: alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-project-share-move') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const read = (who: Who, p: string) => A.json('/api/files/content' + q({ path: p }), { as: who })
const save = (who: Who, p: string, content: string, baseSha256: string | null) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content, baseSha256 }, 'PUT') })
const personal = async (name: string) => {
  const r = await A.json('/api/projects', { as: 'alice', ...jsonBody({ name, scope: 'personal' }) })
  expect(r.status).toBe(201)
  return r.body as { id: string; folderPath: string }
}
const share = (id: string, participants: unknown[] = [{ subjectType: 'user', subjectId: 'erin' }]) => A.json(`/api/projects/${id}/share`, { as: 'alice', ...jsonBody({ participants }) })
const folderOf = (id: string) => (A.ctx.db.query('SELECT folder_path AS f FROM projects WHERE id = ?').get(id) as { f: string }).f

describe('sharing a personal project moves its folder', () => {
  test('the files move with their history; nothing in the trash, nothing left behind; only the members read it', async () => {
    const p = await personal('Move me')
    expect((await save('alice', `${p.folderPath}/plan.md`, 'v1\n', null)).status).toBe(200)
    const v1 = (await read('alice', `${p.folderPath}/plan.md`)).body.sha256
    expect((await save('alice', `${p.folderPath}/plan.md`, 'v2\n', v1)).status).toBe(200)
    fs.mkdirSync(path.join(A.team, p.folderPath, 'sub'))
    fs.writeFileSync(path.join(A.team, p.folderPath, 'sub', 'b.md'), 'b\n')
    // deleted before sharing: stays mine, in my trash, at its personal path
    fs.writeFileSync(path.join(A.team, p.folderPath, 'old.md'), 'old\n')
    expect((await A.json('/api/files' + q({ path: `${p.folderPath}/old.md` }), { as: 'alice', method: 'DELETE' })).status).toBe(200)
    const trashBefore = (A.ctx.db.query('SELECT COUNT(*) AS n FROM trash_items').get() as { n: number }).n
    A.hub.clear()
    const r = await share(p.id)
    expect(r.status).toBe(200)
    const to = r.body.folderPath as string
    expect(to).toBe('projects/Move me')
    expect(folderOf(p.id)).toBe(to)
    expect(fs.existsSync(path.join(A.team, p.folderPath))).toBe(false)
    expect(fs.readFileSync(path.join(A.team, to, 'plan.md'), 'utf8')).toBe('v2\n')
    expect(fs.readFileSync(path.join(A.team, to, 'sub', 'b.md'), 'utf8')).toBe('b\n')
    // no trash item came of it; the file deleted before stays in alice's trash where it was
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM trash_items').get() as { n: number }).n).toBe(trashBefore)
    expect(A.ctx.db.query('SELECT 1 FROM trash_items WHERE original_path = ? AND restored_at IS NULL').get(`${p.folderPath}/old.md`)).not.toBeNull()
    expect(fs.existsSync(path.join(A.team, to, 'old.md'))).toBe(false)
    // the history moved with the file
    expect(A.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(`${p.folderPath}/plan.md`)).toEqual({ n: 0 })
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(`${to}/plan.md`) as { n: number }).n).toBeGreaterThan(0)
    // members read it; nobody else does, the owner and admins included
    for (const who of ['alice', 'erin'] as const) expect((await read(who, `${to}/plan.md`)).status).toBe(200)
    for (const who of ['bob', 'carol', 'dana'] as const) {
      expect((await read(who, `${to}/plan.md`)).status).toBe(404)
      expect((await A.json(`/api/projects/${p.id}`, { as: who })).status).toBe(404)
      // and no realtime event told them a path in it
      expect(A.hub.events.filter((e) => e.userId === who && JSON.stringify(e.ev).includes(to)).length).toBe(0)
    }
  })

  test('the members\' rules are on projects/<name> before the files arrive', async () => {
    const p = await personal('Rules first')
    fs.writeFileSync(path.join(A.team, p.folderPath, 'a.md'), 'a\n')
    const real = fs.renameSync
    let seen: { subject_type: string; subject_id: string | null; access: string }[] | null = null
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === path.join(A.team, p.folderPath)) {
        seen = A.ctx.db.query("SELECT r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'projects/Rules first' ORDER BY r.subject_type, r.subject_id").all() as typeof seen
        // the target is there, empty, when the folder goes onto it
        expect(fs.readdirSync(String(to))).toEqual([])
      }
      return real(from, to)
    }) as typeof fs.renameSync
    try { expect((await share(p.id)).status).toBe(200) } finally { fs.renameSync = real }
    expect(seen).toEqual([
      { subject_type: 'everyone', subject_id: null, access: 'none' },
      { subject_type: 'user', subject_id: 'alice', access: 'write' },
      { subject_type: 'user', subject_id: 'erin', access: 'write' },
    ])
  })

  test('a move that fails leaves everything as it was: the folder, its files and history, the project, no projects/<name>', async () => {
    const p = await personal('Fail me')
    expect((await save('alice', `${p.folderPath}/keep.md`, 'keep\n', null)).status).toBe(200)
    fs.writeFileSync(path.join(A.team, p.folderPath, 'b.md'), 'b\n')
    const versions = (A.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path LIKE ?').get(`${p.folderPath}/%`) as { n: number }).n
    const trashBefore = (A.ctx.db.query('SELECT COUNT(*) AS n FROM trash_items').get() as { n: number }).n
    const real = fs.renameSync
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === path.join(A.team, p.folderPath)) throw Object.assign(new Error('EIO: disk said no'), { code: 'EIO' })
      return real(from, to)
    }) as typeof fs.renameSync
    let r
    try { r = await share(p.id) } finally { fs.renameSync = real }
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(fs.readFileSync(path.join(A.team, p.folderPath, 'keep.md'), 'utf8')).toBe('keep\n')
    expect(fs.readFileSync(path.join(A.team, p.folderPath, 'b.md'), 'utf8')).toBe('b\n')
    expect(folderOf(p.id)).toBe(p.folderPath)
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path LIKE ?').get(`${p.folderPath}/%`) as { n: number }).n).toBe(versions)
    expect(fs.existsSync(path.join(A.team, 'projects/Fail me'))).toBe(false)
    expect(A.ctx.db.query("SELECT 1 FROM folders WHERE path = 'projects/Fail me'").get()).toBeNull()
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM trash_items').get() as { n: number }).n).toBe(trashBefore)
    expect(A.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'project.share' AND target = ?").get(p.id)).toBeNull()
    // it is still alice's alone, and sharing again works
    expect((await read('erin', `${p.folderPath}/keep.md`)).status).toBe(404)
    const again = await share(p.id)
    expect(again.status).toBe(200)
    expect(again.body.folderPath).toBe('projects/Fail me')
    expect(fs.readFileSync(path.join(A.team, 'projects/Fail me/keep.md'), 'utf8')).toBe('keep\n')
  })

  test('a name already taken under projects/ steps around it ("-2"); the other folder is untouched', async () => {
    fs.mkdirSync(path.join(A.team, 'projects', 'Taken'), { recursive: true })
    fs.writeFileSync(path.join(A.team, 'projects', 'Taken', 'theirs.md'), 'theirs\n')
    const p = await personal('Taken')
    fs.writeFileSync(path.join(A.team, p.folderPath, 'mine.md'), 'mine\n')
    const r = await share(p.id)
    expect(r.status).toBe(200)
    expect(r.body.folderPath).toBe('projects/Taken-2')
    expect(fs.readdirSync(path.join(A.team, 'projects/Taken'))).toEqual(['theirs.md'])
    expect(fs.readdirSync(path.join(A.team, 'projects/Taken-2'))).toEqual(['mine.md'])
  })
})
