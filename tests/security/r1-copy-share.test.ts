// Security round 1 (sharing-works #4): sharing a personal file or project by copying (design tab 2 rule 3, tab 4
// POST /api/files/copy and POST /api/projects/:id/share, tab 5 [팀 폴더로 복사해 공유]) did not exist: the only way was to
// move the private original (no "who will see it" warning) or download and upload again. The copy goes through the
// same permission function: read on the source (a hidden source answers exactly like a missing one), write on the
// target folder; dryRun counts how many more people would see it, never who.
// Fixture: alice, erin = marketing; bob = finance; carol = admin; dana = owner; shared/ everyone write; skills/ read.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r1-copy-share') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const copy = (who: Who, body: Record<string, unknown>) => A.json('/api/files/copy', { as: who, ...jsonBody(body) })
const read = (who: Who, p: string) => A.json('/api/files/content' + q({ path: p }), { as: who })

describe('POST /api/files/copy', () => {
  test('a personal file shared into shared/: dryRun counts the new viewers, the copy is readable, the original stays', async () => {
    const dry = await copy('alice', { from: 'users/alice/todo.md', to: 'shared/todo.md', dryRun: true })
    expect(dry.status).toBe(201)
    expect(dry.body).toEqual({ viewersAdded: 4 }) // bob, carol, dana, erin
    expect(fs.existsSync(path.join(A.team, 'shared/todo.md'))).toBe(false)
    const r = await copy('alice', { from: 'users/alice/todo.md', to: 'shared/todo.md' })
    expect(r.status).toBe(201)
    expect(r.body.path).toBe('shared/todo.md')
    expect(r.body.sha256).toBe(sha256hex(fs.readFileSync(path.join(A.team, 'users/alice/todo.md'))))
    expect((await read('bob', 'shared/todo.md')).body.content).toContain('Alice todo')
    expect(fs.existsSync(path.join(A.team, 'users/alice/todo.md'))).toBe(true)
    const ev = A.ctx.db.query("SELECT action, detail FROM file_events WHERE path = 'shared/todo.md' ORDER BY id DESC LIMIT 1").get() as { action: string; detail: string }
    expect(ev.action).toBe('create')
    expect(JSON.parse(ev.detail)).toMatchObject({ sourcePaths: ['users/alice/todo.md'], widened: true })
    // the name is taken: "todo (2).md", like an upload
    expect((await copy('alice', { from: 'users/alice/todo.md', to: 'shared/todo.md' })).body.path).toBe('shared/todo (2).md')
  })

  test('a source the caller cannot read looks exactly like a missing one', async () => {
    const hidden = await copy('alice', { from: 'users/bob/notes.md', to: 'shared/stolen.md' })
    const missing = await copy('alice', { from: 'users/alice/nope.md', to: 'shared/stolen.md' })
    expect(hidden.status).toBe(404)
    expect(missing.status).toBe(404)
    expect({ ...hidden.body.error, requestId: null }).toEqual({ ...missing.body.error, requestId: null })
    expect((await copy('alice', { from: 'groups/finance/budget.md', to: 'shared/b.md', dryRun: true })).status).toBe(404) // dryRun too
    expect((await copy('alice', { from: 'groups/marketing/salaries/2026.md', to: 'shared/s.md' })).status).toBe(404)
    expect(fs.existsSync(path.join(A.team, 'shared/stolen.md'))).toBe(false)
  })

  test('the target folder needs write access; folders, links and hard links are not copied', async () => {
    expect((await copy('alice', { from: 'users/alice/todo.md', to: 'groups/finance/todo.md' })).status).toBe(404) // hidden folder
    expect((await copy('alice', { from: 'users/alice/todo.md', to: 'skills/todo.md' })).status).toBe(403) // read-only
    expect((await copy('alice', { from: 'users/alice/todo.md', to: 'users/bob/todo.md' })).status).toBe(404)
    expect((await copy('alice', { from: 'users/alice/drafts', to: 'shared/drafts' })).status).toBe(400)
    for (const from of ['groups/marketing/budget-link.md', 'groups/marketing/margin-copy.md']) {
      const r = await copy('alice', { from, to: 'shared/leak.md' })
      expect(r.status).not.toBe(201)
    }
    expect(fs.readdirSync(path.join(A.team, 'shared')).some((n) => n.startsWith('leak'))).toBe(false)
  })

  test('replace keeps the old content as a version; a stale baseSha256 saves a conflict copy instead', async () => {
    expect((await A.json('/api/files/content', { as: 'erin', ...jsonBody({ path: 'shared/plan.md', content: 'erin v1\n', baseSha256: null }, 'PUT') })).status).toBe(200)
    const base = sha256hex('erin v1\n')
    const ok = await copy('alice', { from: 'users/alice/todo.md', to: 'shared/plan.md', onExists: 'replace', baseSha256: base })
    expect(ok.body.path).toBe('shared/plan.md')
    expect((await A.json('/api/files/history' + q({ path: 'shared/plan.md' }), { as: 'erin' })).body.items.length).toBe(1)
    const stale = await copy('alice', { from: 'users/alice/drafts/newsletter-oct.md', to: 'shared/plan.md', onExists: 'replace', baseSha256: base })
    expect(stale.status).toBe(201)
    expect(stale.body.path).not.toBe('shared/plan.md')
    expect(stale.body.path).toContain('shared/plan (')
    expect((await read('erin', 'shared/plan.md')).body.content).toContain('Alice todo')
  })
})

describe('POST /api/projects/:id/share', () => {
  let pid = ''
  test('a personal project is copied into a team folder and the project follows the copy', async () => {
    const c = await A.json('/api/projects', { as: 'alice', ...jsonBody({ name: 'launch-notes', scope: 'personal', instructions: 'Use notes.md' }) })
    expect(c.status).toBe(201)
    pid = c.body.id
    const dir = path.join(A.team, ...c.body.folderPath.split('/'))
    fs.writeFileSync(path.join(dir, 'notes.md'), 'launch 2026-11-03\n')
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub/a.md'), 'a\n')
    fs.symlinkSync('../../../bob/notes.md', path.join(dir, 'bob-link.md'))
    expect((await A.json(`/api/projects/${pid}`, { as: 'erin' })).status).toBe(404)
    const dry = await A.json(`/api/projects/${pid}/share`, { as: 'alice', ...jsonBody({ toParent: 'groups/marketing', dryRun: true }) })
    expect(dry.body).toEqual({ viewersAdded: 3 }) // erin, carol, dana
    const r = await A.json(`/api/projects/${pid}/share`, { as: 'alice', ...jsonBody({ toParent: 'groups/marketing' }) })
    expect(r.status).toBe(200)
    expect(r.body.folderPath).toBe('groups/marketing/launch-notes')
    expect((await A.json(`/api/projects/${pid}`, { as: 'erin' })).body.instructions).toBe('Use notes.md')
    expect((await read('erin', 'groups/marketing/launch-notes/notes.md')).status).toBe(200)
    expect((await read('erin', 'groups/marketing/launch-notes/sub/a.md')).status).toBe(200)
    expect(fs.existsSync(path.join(A.team, 'groups/marketing/launch-notes/bob-link.md'))).toBe(false) // links are not copied
    expect(fs.existsSync(path.join(dir, 'notes.md'))).toBe(true) // the personal folder stays
    expect((await A.json(`/api/projects/${pid}`, { as: 'bob' })).status).toBe(404)
  })

  test('only a personal project, only its owner, only into a folder they can write; 413 past the limits', async () => {
    expect((await A.json(`/api/projects/${pid}/share`, { as: 'alice', ...jsonBody({ toParent: 'shared' }) })).status).toBe(400) // now a team project
    const c = await A.json('/api/projects', { as: 'alice', ...jsonBody({ name: 'big', scope: 'personal' }) })
    const dir = path.join(A.team, ...c.body.folderPath.split('/'))
    expect((await A.json(`/api/projects/${c.body.id}/share`, { as: 'erin', ...jsonBody({ toParent: 'shared' }) })).status).toBe(404)
    expect((await A.json(`/api/projects/${c.body.id}/share`, { as: 'alice', ...jsonBody({ toParent: 'groups/finance' }) })).status).toBe(404)
    for (let i = 0; i <= 1000; i++) fs.writeFileSync(path.join(dir, `f${i}.md`), 'x')
    const big = await A.json(`/api/projects/${c.body.id}/share`, { as: 'alice', ...jsonBody({ toParent: 'shared' }) })
    expect(big.status).toBe(413)
    expect(fs.readdirSync(path.join(A.team, 'shared')).some((n) => n === 'big' || n.startsWith('.mycel-tmp-'))).toBe(false)
  })
})
