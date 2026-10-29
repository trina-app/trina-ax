// The real author of each file version and the file's changes (QA TEAM-03 / B-W7-6, R2-ETC-06 / B-W24-2,
// AITOOL-13 / B-W3-1). Before: a stored version carried the name of the person whose save REPLACED it, the current
// version was not listed, and AI moves / copies / renames left nothing in the history.
// Now: GET /api/files/history gives `current` (the content as it is now, with the person who saved it), each item's
// `savedBy` / `savedTurnId` (the save that produced it) next to `author` (who replaced it), and `events` (created,
// edited, moved, renamed, copied, restored; who, when, which AI turn), with moves followed back to earlier paths.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { fileEvent } from '../../server/src/files/store'
import { jsonBody, makeCApp, sha256hex, type CApp, type Person } from '../lib/c-app'

setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-version-authors') })
afterAll(async () => { await A.close() })
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const read = (rel: string) => fs.readFileSync(path.join(A.team, ...rel.split('/')), 'utf8')
const save = (as: Person, p: string, content: string, base: string | null) =>
  A.json('/api/files/content', { ...jsonBody({ path: p, content, baseSha256: base === null ? null : sha256hex(base) }, 'PUT'), as })
const history = async (as: Person, p: string) => {
  const h = await A.json('/api/files/history' + q({ path: p }), { as })
  expect(h.status).toBe(200)
  return h.body
}
let rpcId = 0
async function tool(user: Person, name: string, args: unknown, confirm?: string[]) {
  const turnId = A.turn(user, A.chat(user))
  const tc = A.toolCtx(user, turnId)
  if (confirm) tc.person = { locale: 'ko', async confirm(q) { confirm.push(q); return true }, *turnUrls() {} }
  const h = makeHandler(A.ctx.files, A.ctx.db, tc)
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  expect(r.result.isError ?? false).toBe(false)
  return turnId
}

describe('version authors', () => {
  const p = 'shared/authors/plan.md'
  test('created by A, edited by B, edited by A: v3 A (current), v2 B, v1 A', async () => {
    expect((await save('alice', p, 'one', null)).status).toBe(200)
    expect((await save('bob', p, 'two', 'one')).status).toBe(200)
    expect((await save('alice', p, 'three', 'two')).status).toBe(200)
    const h = await history('carol', p)
    expect(h.current).toMatchObject({ version: 3, sha256: sha256hex('three'), size: 5, turnId: null })
    expect(h.current.author.id).toBe('alice')
    expect(h.items.map((v: any) => [v.version, v.savedBy?.id, v.sha256])).toEqual([[2, 'bob', sha256hex('two')], [1, 'alice', sha256hex('one')]])
    // `author` keeps its old meaning for older clients: the person whose save replaced the content
    expect(h.items.map((v: any) => v.author?.id)).toEqual(['alice', 'bob'])
    expect(h.events.map((e: any) => [e.kind, e.by.id, e.turnId])).toEqual([['edited', 'alice', null], ['edited', 'bob', null], ['created', 'alice', null]])
  })

  test('restore still works; the restorer is the author of the restored content, the replaced version keeps its author', async () => {
    const h = await history('bob', p)
    const v1 = h.items.find((v: any) => v.version === 1)
    expect((await A.json('/api/files/restore', { ...jsonBody({ path: p, versionId: v1.id }), as: 'bob' })).status).toBe(200)
    expect(read(p)).toBe('one')
    const h2 = await history('bob', p)
    expect(h2.current).toMatchObject({ version: 4, sha256: sha256hex('one') })
    expect(h2.current.author.id).toBe('bob')
    expect(h2.items.map((v: any) => [v.version, v.kind, v.savedBy?.id])).toEqual([[3, 'restore', 'alice'], [2, 'edit', 'bob'], [1, 'edit', 'alice']])
    expect(h2.events[0]).toMatchObject({ kind: 'restored', from: null })
    expect(h2.events[0].by.id).toBe('bob')
  })

  test('an AI save is marked with its turn on the version it produced', async () => {
    const f = 'shared/authors/ai.md'
    expect((await save('alice', f, 'by hand', null)).status).toBe(200)
    const turnId = A.turn('bob', A.chat('bob'))
    const tc = A.toolCtx('bob', turnId)
    tc.files.readHashes.set(f, sha256hex('by hand'))
    A.ctx.files.writeBytes(tc, f, Buffer.from('by ai'), tc.files.readHashes, 'write')
    expect((await save('alice', f, 'by hand again', 'by ai')).status).toBe(200)
    const h = await history('alice', f)
    expect(h.items.map((v: any) => [v.version, v.savedBy?.id, v.savedTurnId])).toEqual([[2, 'bob', turnId], [1, 'alice', null]])
    expect(h.events.map((e: any) => [e.kind, e.turnId])).toEqual([['edited', null], ['edited', turnId], ['created', null]])
  })

  test('a version stored before authors were recorded: savedBy null (the screen says "replaced by")', async () => {
    const f = 'shared/authors/legacy.md'
    expect((await save('alice', f, 'a', null)).status).toBe(200)
    expect((await save('bob', f, 'b', 'a')).status).toBe(200)
    A.ctx.db.query('UPDATE file_versions SET saved_by = NULL, saved_turn_id = NULL WHERE path = ?').run(f)
    const h = await history('alice', f)
    expect(h.items).toHaveLength(1)
    expect(h.items[0].savedBy).toBeNull()
    expect(h.items[0].author.id).toBe('bob')
  })

  test('content changed outside the app: the current author is not known', async () => {
    const f = 'shared/authors/outside.md'
    expect((await save('alice', f, 'a', null)).status).toBe(200)
    fs.writeFileSync(path.join(A.team, ...f.split('/')), 'changed in Finder')
    const h = await history('alice', f)
    expect(h.current.sha256).toBe(sha256hex('changed in Finder'))
    expect(h.current.author).toBeNull()
  })
})

describe('moves, renames and copies in the history', () => {
  test('an AI move appears with its turn, and the history before the move follows the file', async () => {
    const from = 'shared/moves/logo.md'
    expect((await save('alice', from, 'logo', null)).status).toBe(200)
    fs.mkdirSync(path.join(A.team, 'shared/moves/company'), { recursive: true })
    const turnId = await tool('alice', 'move_files', { paths: [from], to_folder: 'shared/moves/company' })
    const to = 'shared/moves/company/logo.md'
    const h = await history('bob', to)
    expect(h.events.map((e: any) => [e.kind, e.turnId, e.from, e.path])).toEqual([['moved', turnId, from, to], ['created', null, null, from]])
    expect(h.current.author.id).toBe('alice')
  })

  test('QA B-W3-1: a chat attachment moved by the AI into a team folder (confirmed on the card) shows the move', async () => {
    const att = 'users/alice/.attachments/c9/logo-QA.png'
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    fs.mkdirSync(path.join(A.team, 'users/alice/.attachments/c9'), { recursive: true })
    fs.writeFileSync(path.join(A.team, ...att.split('/')), png)
    // what POST /api/uploads records (uploads/attachments.ts)
    fileEvent(A.ctx.db, { turnId: null, userId: 'alice', path: att, action: 'upload', size: png.length, sha256: sha256hex(png), detail: { attachment: 'a1', chatId: 'c9' } })
    fs.mkdirSync(path.join(A.team, 'shared/moves/company'), { recursive: true })
    const asked: string[] = []
    const turnId = await tool('alice', 'move_files', { paths: [att], to_folder: 'shared/moves/company' }, asked)
    expect(asked).toHaveLength(1)
    const to = 'shared/moves/company/logo-QA.png'
    const ha = await history('alice', to)
    expect(ha.events.map((e: any) => [e.kind, e.turnId, e.from])).toEqual([['moved', turnId, att], ['uploaded', null, null]])
    expect(ha.current.author.id).toBe('alice')
    const hb = await history('bob', to)
    expect(hb.events.map((e: any) => [e.kind, e.turnId, e.from])).toEqual([['moved', turnId, null]])
  })

  test('rename_file and copy_files appear with their turns', async () => {
    const f = 'shared/moves/notes.md'
    expect((await save('bob', f, 'notes', null)).status).toBe(200)
    const t1 = await tool('alice', 'rename_file', { path: f, new_name: 'notes-2026.md' })
    const renamed = 'shared/moves/notes-2026.md'
    fs.mkdirSync(path.join(A.team, 'shared/moves/copies'), { recursive: true })
    const t2 = await tool('carol', 'copy_files', { paths: [renamed], to_folder: 'shared/moves/copies' })
    const h = await history('alice', renamed)
    expect(h.events.map((e: any) => [e.kind, e.by.id, e.turnId])).toEqual([['renamed', 'alice', t1], ['created', 'bob', null]])
    const c = await history('alice', 'shared/moves/copies/notes-2026.md')
    expect(c.events.map((e: any) => [e.kind, e.by.id, e.turnId, e.from])).toEqual([['copied', 'carol', t2, renamed]])
    expect(c.current.author.id).toBe('carol')
  })

  test('a folder renamed above the file shows as a move of the file; a version made before it keeps its author', async () => {
    const f = 'shared/fold-a/doc.md'
    expect((await save('alice', f, 'x', null)).status).toBe(200)
    expect((await save('bob', f, 'y', 'x')).status).toBe(200)
    const r = await A.json('/api/files/move', { ...jsonBody({ from: 'shared/fold-a', to: 'shared/fold-b' }), as: 'alice' })
    expect(r.status).toBe(200)
    const moved = 'shared/fold-b/doc.md'
    expect((await save('carol', moved, 'z', 'y')).status).toBe(200)
    const h = await history('alice', moved)
    expect(h.events.map((e: any) => [e.kind, e.by.id])).toEqual([['edited', 'carol'], ['moved', 'alice'], ['edited', 'bob'], ['created', 'alice']])
    expect(h.events[1].from).toBe(f)
    // v2 ("y") was made by bob before the folder moved: found by following the move back
    expect(h.items.map((v: any) => [v.version, v.savedBy?.id])).toEqual([[2, 'bob'], [1, 'alice']])
    expect(h.current.author.id).toBe('carol')
  })

  test('moved out of a personal folder: others do not see what happened in there, nor its path', async () => {
    const own = 'users/alice/draft.md'
    expect((await save('alice', own, 'draft', null)).status).toBe(200)
    const r = await A.json('/api/files/move', { ...jsonBody({ from: own, to: 'shared/moves/draft.md' }), as: 'alice' })
    expect(r.status).toBe(200)
    const hb = await history('bob', 'shared/moves/draft.md')
    expect(hb.events.map((e: any) => [e.kind, e.from])).toEqual([['moved', null]])
    const ha = await history('alice', 'shared/moves/draft.md')
    expect(ha.events.map((e: any) => [e.kind, e.from])).toEqual([['moved', own], ['created', null]])
  })
})

describe('a file moved out of a restricted team folder, then the folder renamed or trashed (review round 1)', () => {
  // shared/sec-fin is the finance group's only (bob is in it, alice is not). The live rules are keyed by the live
  // folder paths: after the folder is renamed or trashed, its old path falls back to shared/ (everyone write), so the
  // old path string alone must not decide who sees what happened in there.
  const inside = 'shared/sec-fin/budget.md'
  const out = 'shared/sec-budget.md'
  const kinds = (h: any) => h.events.map((e: any) => [e.kind, e.from])
  beforeAll(async () => {
    const db = A.ctx.db
    db.query("INSERT INTO folders (id, path) VALUES ('f_sec_fin', 'shared/sec-fin')").run()
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_sec_fin_g', 'f_sec_fin', 'group', 'finance', 'write'), ('r_sec_fin_e', 'f_sec_fin', 'everyone', null, 'none')").run()
    fs.mkdirSync(path.join(A.team, 'shared/sec-fin'), { recursive: true })
    fs.writeFileSync(path.join(A.team, 'shared/sec-fin/keep.md'), 'keep')
    expect((await save('bob', inside, 'b1', null)).status).toBe(200)
    expect((await save('bob', inside, 'b2', 'b1')).status).toBe(200)
    expect((await A.json('/api/files/move', { ...jsonBody({ from: inside, to: out }), as: 'bob' })).status).toBe(200)
  })

  test('while the folder is in place: a non-member sees only the move, with no old path', async () => {
    const h = await history('alice', out)
    expect(kinds(h)).toEqual([['moved', null]])
    expect(h.current.author).toBeNull()
    expect(kinds(await history('bob', out))).toEqual([['moved', inside], ['edited', null], ['created', null]])
  })

  test('renamed: the old path falls back to shared/, still nothing of the folder for a non-member', async () => {
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'shared/sec-fin', to: 'shared/sec-fin-2025' }), as: 'carol' })).status).toBe(200)
    const h = await history('alice', out)
    expect(kinds(h)).toEqual([['moved', null]])
    expect(h.current.author).toBeNull()
    expect(h.events.some((e: any) => e.path === inside)).toBe(false)
    // a member still sees it: the place is now shared/sec-fin-2025, which they can read
    expect(kinds(await history('bob', out))).toEqual([['moved', inside], ['edited', null], ['created', null]])
  })

  test('a new everyone folder with the old name does not open the old one', async () => {
    fs.mkdirSync(path.join(A.team, 'shared/sec-fin'), { recursive: true })
    expect(kinds(await history('alice', out))).toEqual([['moved', null]])
    fs.rmSync(path.join(A.team, 'shared/sec-fin'), { recursive: true, force: true })
  })

  test('trashed: hidden for members too while it is in the trash (its rules are parked); owner and admin see it', async () => {
    const d = await A.json('/api/files' + q({ path: 'shared/sec-fin-2025' }), { method: 'DELETE', as: 'carol' })
    expect(d.status).toBe(200)
    expect(kinds(await history('alice', out))).toEqual([['moved', null]])
    expect(kinds(await history('bob', out))).toEqual([['moved', null]])
    expect(kinds(await history('carol', out))).toEqual([['moved', inside], ['edited', null], ['created', null]])
    // restored with its rules: the member sees it again, the non-member still does not
    expect((await A.json(`/api/files/trash/${d.body.trashId}/restore`, { method: 'POST', as: 'carol' })).status).toBe(200)
    expect(kinds(await history('bob', out))).toEqual([['moved', inside], ['edited', null], ['created', null]])
    expect(kinds(await history('alice', out))).toEqual([['moved', null]])
  })
})

describe('migration 314 backfill', () => {
  test('a stored version gets the author of the matching earlier save; one with no such save stays unknown', async () => {
    const { MIGRATIONS_DIR, migrate, openDb } = await import('../../server/src/db')
    const os = await import('node:os')
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'))
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (/^\d{3}_/.test(f) && parseInt(f, 10) < 314) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(old, f))
    const db = openDb(':memory:', { migrationsDir: old })
    try {
      const ins = db.query("INSERT INTO file_events (turn_id, user_id, path, action, sha256, at) VALUES (?,?,?,?,?,?)")
      ins.run(null, 'alice', 'shared/x.md', 'create', 'h1', '2026-01-01T00:00:00.000Z')
      ins.run('turn-b', 'bob', 'shared/x.md', 'update', 'h2', '2026-01-02T00:00:00.000Z')
      const v = db.query("INSERT INTO file_versions (id, path, version, sha256, size, author_id, turn_id, kind, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      v.run('v1', 'shared/x.md', 1, 'h1', 1, 'bob', 'turn-b', 'edit', '2026-01-02T00:00:00.000Z')
      v.run('v2', 'shared/x.md', 2, 'h2', 1, 'carol', null, 'edit', '2026-01-03T00:00:00.000Z')
      v.run('v3', 'shared/x.md', 3, 'zz', 1, 'carol', null, 'edit', '2026-01-04T00:00:00.000Z')
      migrate(db)
      const rows = db.query('SELECT id, author_id, saved_by, saved_turn_id FROM file_versions ORDER BY version').all()
      expect(rows).toEqual([
        { id: 'v1', author_id: 'bob', saved_by: 'alice', saved_turn_id: null },
        { id: 'v2', author_id: 'carol', saved_by: 'bob', saved_turn_id: 'turn-b' },
        { id: 'v3', author_id: 'carol', saved_by: null, saved_turn_id: null },
      ])
    } finally {
      db.close()
      fs.rmSync(old, { recursive: true, force: true })
    }
  })
})
