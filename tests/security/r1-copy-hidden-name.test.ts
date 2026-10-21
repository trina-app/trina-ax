// Security integration (round 1, files-http x sharing-works): the copy paths added by sharing-works (POST
// /api/files/copy with onExists 'rename', and the project/folder share copyFolderTree) picked their " (2)" name with
// freeName() over every entry on disk, hidden ones included. With a visible shared/plan.md and a hidden shared/plan (2).md
// the copy landed at "plan (3).md", telling alice that something she may not see is called "plan (2).md". Like upload,
// move and restore (files-http #1), a name the caller supplied now steps around only siblings they can see; a hidden
// one is refused by authorize() exactly like a path they may not access, and nothing is created.
// Fixture: alice = marketing; carol = admin; dana = owner; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'

let A: CApp
const hidden = [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'user', subjectId: 'carol', access: 'write' }]
beforeAll(async () => {
  A = await makeCApp('sec-r1-copy-hidden-name')
  fs.writeFileSync(path.join(A.team, 'shared', 'plan.md'), 'visible plan\n')
  fs.mkdirSync(path.join(A.team, 'shared', 'drafts'))
  for (const p of ['shared/plan (2).md', 'shared/drafts (2)']) {
    const r = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: p, create: true, rules: hidden }) })
    expect(r.status).toBeLessThan(300)
  }
})
afterAll(async () => { await A.close() })

const names = () => fs.readdirSync(path.join(A.team, 'shared')).filter((n) => /^(plan|drafts)/.test(n)).sort()
const before = ['drafts', 'drafts (2)', 'plan (2).md', 'plan.md']

describe('a copy whose name is taken never steps around a hidden sibling', () => {
  test('setup: the " (2)" entries are hidden from alice', async () => {
    const t = await A.json('/api/files/tree?path=shared', { as: 'alice' })
    expect(JSON.stringify(t.body)).not.toMatch(/\(2\)/)
    expect(names()).toEqual(before)
  })

  test('POST /api/files/copy onExists rename: no "plan (3).md", answered like a hidden path', async () => {
    const r = await A.json('/api/files/copy', { as: 'alice', ...jsonBody({ from: 'users/alice/todo.md', to: 'shared/plan.md', onExists: 'rename' }) })
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).not.toMatch(/\(2\)|\(3\)/)
    expect(names()).toEqual(before)
  })

  test('folder share (copyFolderTree): no "drafts (3)"', () => {
    expect(() => componentC(A.ctx).files.copyFolderTree('alice', 'users/alice/drafts', 'shared')).toThrow()
    expect(names()).toEqual(before)
  })

  test('carol, who sees the " (2)" entries, still gets the next free name', async () => {
    const r = await A.json('/api/files/copy', { as: 'carol', ...jsonBody({ from: 'shared/plan.md', to: 'shared/plan.md', onExists: 'rename' }) })
    expect(r.status).toBe(201)
    expect(r.body.path).toBe('shared/plan (3).md')
  })
})
