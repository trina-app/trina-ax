// The file listing marks folders the caller may write but may not rename, move or trash (FileEntry.fixed, QA TC-224):
// a member's group folder, shared/ and a folder holding a project's folder are 'admin' (the owner and admins are not
// told: they may), a personal folder is 'always'; a plain folder is not marked. Each mark matches what the move and
// trash checks do: a marked folder's rename is refused, an unmarked one's is not. Fixture (tests/lib/c-app.ts): alice
// = member (marketing), carol = admin, dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { FileEntry } from '@mycel/shared/api'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => {
  A = await makeCApp('c-files-fixed')
  for (const d of ['groups/marketing/plain', 'shared/notes', 'users/carol']) fs.mkdirSync(path.join(A.team, d), { recursive: true })
  // a project's folder inside a plain one: the plain one holds a managed folder
  fs.mkdirSync(path.join(A.team, 'groups/marketing/holder/proj'), { recursive: true })
  A.ctx.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('p_fixed', 'Fixed', 'groups/marketing/holder/proj')").run()
})
afterAll(async () => { await A.close() })
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
type Who = 'alice' | 'carol' | 'dana'
const listing = async (p: string, as: Who) => {
  const r = await A.json('/api/files/tree' + q({ path: p }), { as })
  expect(r.status).toBe(200)
  return new Map((r.body.entries as FileEntry[]).map((e) => [e.path, e]))
}

describe('FileEntry.fixed', () => {
  test("a member: their group's folder, shared/ and a folder holding a project's are admin-only; a plain folder is not", async () => {
    const groups = await listing('groups', 'alice')
    expect(groups.get('groups/marketing')).toMatchObject({ access: 'write', fixed: 'admin' })
    const root = await listing('', 'alice')
    expect(root.get('shared')).toMatchObject({ access: 'write', fixed: 'admin' })
    // read-only and pass-through folders are not marked: they are off as read-only already
    expect(root.get('skills')?.fixed).toBeUndefined()
    expect(root.get('groups')?.fixed).toBeUndefined()
    const mk = await listing('groups/marketing', 'alice')
    expect(mk.get('groups/marketing/holder')).toMatchObject({ access: 'write', fixed: 'admin' })
    expect(mk.get('groups/marketing/plain')?.fixed).toBeUndefined()
    expect(mk.get('groups/marketing/holder/proj')).toBeUndefined()
    const shared = await listing('shared', 'alice')
    expect(shared.get('shared/notes')?.fixed).toBeUndefined()
    // files are never marked
    expect([...mk.values()].filter((e) => e.type === 'file').every((e) => e.fixed === undefined)).toBe(true)
  })

  test('a personal folder never moves: marked for its owner, admin or not', async () => {
    expect((await listing('users', 'alice')).get('users/alice')).toMatchObject({ access: 'write', fixed: 'always' })
    expect((await listing('users', 'carol')).get('users/carol')).toMatchObject({ access: 'write', fixed: 'always' })
  })

  test('the top projects/ folder never moves (members-only zone): marked for the owner and admins who may write it, and refused', async () => {
    for (const who of ['carol', 'dana'] as const) {
      const top = (await listing('', who)).get('projects')
      expect(top).toMatchObject({ access: 'write', fixed: 'always' })
      expect((await A.json('/api/files/move', { ...jsonBody({ from: 'projects', to: 'projects-old' }), as: who })).status).toBe(403)
    }
  })

  test('the owner and admins see no admin-only mark', async () => {
    for (const who of ['carol', 'dana'] as const) {
      expect((await listing('groups', who)).get('groups/marketing')?.fixed).toBeUndefined()
      expect((await listing('', who)).get('shared')?.fixed).toBeUndefined()
      expect((await listing('groups/marketing', who)).get('groups/marketing/holder')?.fixed).toBeUndefined()
    }
  })

  test('the mark says what the server does: a marked folder is refused, an unmarked one is renamed', async () => {
    for (const [from, to] of [['groups/marketing', 'groups/marketing-2'], ['shared', 'shared-2'], ['groups/marketing/holder', 'groups/marketing/holder-2'], ['users/alice', 'users/alice-2']]) {
      expect((await A.json('/api/files/move', { ...jsonBody({ from, to }), as: 'alice' })).status).toBe(403)
    }
    expect((await A.json('/api/files' + q({ path: 'groups/marketing' }), { method: 'DELETE', as: 'alice' })).status).toBe(403)
    const ok = await A.json('/api/files/move', { ...jsonBody({ from: 'groups/marketing/plain', to: 'groups/marketing/plain-2' }), as: 'alice' })
    expect(ok.status).toBe(200)
  })
})
