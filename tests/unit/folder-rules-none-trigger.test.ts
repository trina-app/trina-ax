// Migration 121's triggers (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"): "no access" rows only as
// the legacy marker on a limited folder, a person's own on projects/<name> (any letter case of "projects", depth 2), a
// parked copy under .system/ or a row under users/; the only role row is the managed marker role admin: write. They
// hold for raw SQL too, and name only folders and folder_rules (a fresh database works).
import { expect, test } from 'bun:test'
import { openDb } from '../../server/src/db'
import { folderAccessProblems } from '../../server/src/policy/invariants'

const db = openDb(':memory:')
db.query("INSERT INTO users (id, username, name, role) VALUES ('u', 'u', 'u', 'member')").run()
let n = 0
const folder = (p: string, limited = 0) => { const id = `f${++n}`; db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, ?)').run(id, p, limited); return id }
const ins = (f: string, t: string, s: string | null, a: string) => db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, ?, ?, ?)').run(`r${++n}`, f, t, s, a)
const refused = (fn: () => unknown) => expect(fn).toThrow(/folder_rules: /)

test('"no access" rows: only the allowed forms', () => {
  const plain = folder('shared/x'), lim = folder('shared/y', 1)
  refused(() => ins(plain, 'everyone', null, 'none'))
  ins(lim, 'everyone', null, 'none')
  refused(() => ins(lim, 'group', 'g', 'none'))
  refused(() => ins(plain, 'user', 'u', 'none'))
  ins(folder('projects/p'), 'user', 'u', 'none')
  ins(folder('Projects/q'), 'user', 'u', 'none')
  refused(() => ins(folder('projects/p/inner'), 'user', 'u', 'none'))
  refused(() => ins(folder('projects'), 'user', 'u', 'none'))
  refused(() => ins(folder('myprojects/p'), 'user', 'u', 'none'))
  ins(folder('.system/trash/m/t/x'), 'user', 'u', 'none')
  ins(folder('users/u/x'), 'user', 'u', 'none')
  // an update that makes a "no access" row is refused the same way
  ins(plain, 'user', 'u', 'read')
  refused(() => db.query("UPDATE folder_rules SET access = 'none' WHERE folder_id = ? AND subject_type = 'user'").run(plain))
})

test('role rows: only the managed marker', () => {
  const f = folder('shared/z')
  ins(f, 'role', 'admin', 'write')
  refused(() => ins(folder('shared/w'), 'role', 'member', 'read'))
  refused(() => ins(folder('shared/v'), 'role', 'admin', 'read'))
  refused(() => ins(folder('shared/u'), 'role', 'owner', 'write'))
  refused(() => db.query("UPDATE folder_rules SET subject_id = 'member' WHERE folder_id = ? AND subject_type = 'role'").run(f))
})

test('the invariants check names what is wrong', () => {
  const d = openDb(':memory:')
  expect(folderAccessProblems(d)).toEqual([])
  d.query("INSERT INTO folders (id, path, limited) VALUES ('a', 'shared/a', 1)").run()
  expect(folderAccessProblems(d).map((x) => x.slice(0, 2))).toEqual(['1:'])
  d.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r', 'a', 'everyone', NULL, 'none')").run()
  expect(folderAccessProblems(d)).toEqual([])
  d.query("UPDATE folders SET limited = 0 WHERE id = 'a'").run()
  expect(folderAccessProblems(d).map((x) => x.slice(0, 2))).toContain('2:')
  d.query("INSERT INTO users (id, username, name, role) VALUES ('c', 'c', 'c', 'member')").run()
  d.query("INSERT INTO projects (id, name, folder_path) VALUES ('p', 'p', 'projects/p')").run()
  expect(folderAccessProblems(d).map((x) => x.slice(0, 2))).toContain('5:')
  d.query("DELETE FROM settings WHERE key = 'folder_access_model'").run()
  expect(folderAccessProblems(d).map((x) => x.slice(0, 2))).toContain('6:')
})
