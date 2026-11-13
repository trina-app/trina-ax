// 되돌리기 after "move to a new project" (docs/DECISIONS.md "Making a project", owner 2026-11-13): DELETE
// /api/projects/:id?ifEmpty=1 deletes only the caller's own personal project that is still as it was made, with its
// empty folder. Anything in it (a chat of anyone's, in the trash too; a file or folder; instructions; a scheduled task),
// or a project that is shared, is kept as it is: 409 project_not_empty, nothing changes (never the trash either).
// Fixture: alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-project-undo-delete') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const make = async (name: string, who: Who = 'alice') => {
  const r = await A.json('/api/projects', { as: who, ...jsonBody({ name, scope: 'personal' }) })
  expect(r.status).toBe(201)
  return r.body as { id: string; folderPath: string }
}
const undo = (id: string, who: Who = 'alice') => A.json(`/api/projects/${id}?ifEmpty=1`, { as: who, method: 'DELETE' })
const there = (id: string) => !!A.ctx.db.query('SELECT 1 FROM projects WHERE id = ?').get(id)
const onDisk = (rel: string) => fs.existsSync(path.join(A.team, ...rel.split('/')))
const trashCount = () => (A.ctx.db.query('SELECT COUNT(*) AS n FROM trash_items').get() as { n: number }).n

describe('DELETE /api/projects/:id?ifEmpty=1', () => {
  test('a project as it was made goes, with its empty folder', async () => {
    const p = await make('Undo me')
    expect(onDisk(p.folderPath)).toBe(true)
    const chat = A.chat('alice')
    // the chat was moved back first: it no longer names the project
    expect(A.ctx.db.query('SELECT project_id FROM chats WHERE id = ?').get(chat)).toEqual({ project_id: null })
    const before = trashCount()
    expect((await undo(p.id)).status).toBe(204)
    expect(there(p.id)).toBe(false)
    expect(onDisk(p.folderPath)).toBe(false)
    expect(onDisk(p.folderPath.split('/').slice(0, 3).join('/'))).toBe(true) // my projects folder stays
    expect(trashCount()).toBe(before)
  })

  test('kept when anything is in it: a chat (in the trash too), a file, a folder, instructions, a scheduled task', async () => {
    const cases: [string, (p: { id: string; folderPath: string }) => void | Promise<void>][] = [
      ['chat', (p) => { A.ctx.db.query('UPDATE chats SET project_id = ? WHERE id = ?').run(p.id, A.chat('alice')) }],
      ['trashed chat', (p) => { A.ctx.db.query("UPDATE chats SET project_id = ?, deleted_at = '2026-11-13T00:00:00.000Z' WHERE id = ?").run(p.id, A.chat('alice')) }],
      ['someone else\'s chat', (p) => { A.ctx.db.query('UPDATE chats SET project_id = ? WHERE id = ?').run(p.id, A.chat('erin')) }],
      ['file', (p) => fs.writeFileSync(path.join(A.team, p.folderPath, 'notes.md'), 'n\n')],
      ['hidden file', (p) => fs.writeFileSync(path.join(A.team, p.folderPath, '.notes'), 'n\n')],
      ['folder', (p) => fs.mkdirSync(path.join(A.team, p.folderPath, 'sub'))],
      ['instructions', async (p) => { expect((await A.json(`/api/projects/${p.id}`, { as: 'alice', ...jsonBody({ instructions: 'Use Acme tone' }, 'PATCH') })).status).toBe(200) }],
      ['scheduled task', (p) => {
        A.ctx.db.query("INSERT INTO schedules (id, user_id, title, prompt, repeat, time, project_id, next_run_at) VALUES (?, 'alice', 'Acme weekly', 'sum up', 'daily', '09:00', ?, '2026-11-14T00:00:00.000Z')").run(crypto.randomUUID(), p.id)
      }],
    ]
    for (const [what, fill] of cases) {
      const p = await make(`Keep ${what}`)
      await fill(p)
      const r = await undo(p.id)
      expect([what, r.status, r.body?.error?.params?.reason]).toEqual([what, 409, 'project_not_empty'])
      expect([what, there(p.id), onDisk(p.folderPath)]).toEqual([what, true, true])
    }
  })

  test('a shared project is kept (not deleted, not put in the trash); another person\'s project is not theirs to touch', async () => {
    const p = await make('Shared now')
    const s = await A.json(`/api/projects/${p.id}/share`, { as: 'alice', ...jsonBody({ participants: [{ subjectType: 'user', subjectId: 'erin' }] }) })
    expect(s.status).toBe(200)
    const before = trashCount()
    const r = await undo(p.id)
    expect(r.status).toBe(409)
    expect(there(p.id)).toBe(true)
    expect(onDisk(s.body.folderPath)).toBe(true)
    expect(A.ctx.db.query('SELECT trashed_with FROM projects WHERE id = ?').get(p.id)).toEqual({ trashed_with: null })
    expect(trashCount()).toBe(before)
    // a member of it, or anyone else, cannot use it on alice's project
    expect((await undo(p.id, 'erin')).status).toBe(403)
    const mine = await make('Alice only')
    for (const who of ['bob', 'carol', 'dana'] as const) expect([who, (await undo(mine.id, who)).status]).not.toEqual([who, 204])
    expect(there(mine.id)).toBe(true)
  })
})
