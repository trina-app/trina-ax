// The one loader (RuleSet.fromDb) and the sets derived from it keep the limit, origins and project exceptions
// (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"; review 1 items 1, 2, 17). A limited folder with no
// rules is a boundary everywhere: access, canList, listing, the navigator and the sandbox's folder view.
import { describe, expect, test } from 'bun:test'
import { openDb } from '../../server/src/db'
import { ensureFolderRow, setProjectException, writeFolderAccess } from '../../server/src/admin/folders'
import { RuleSet, inPlace, type Principal } from '../../server/src/policy/access'
import { folderView } from '../../server/src/devenv/srt/access'

const P = (id: string, groups: string[] = [], role: Principal['role'] = 'member'): Principal => ({ id, name: id, role, groups })

function world() {
  const db = openDb(':memory:')
  for (const id of ['m', 'kim', 'lee']) db.query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')").run(id, id, id)
  db.query("INSERT INTO groups (id, name) VALUES ('mk', 'mk')").run()
  db.transaction(() => {
    writeFolderAccess(db, ensureFolderRow(db, 'shared').id, { rules: [{ subjectType: 'everyone', subjectId: null, access: 'write' }] }, null)
    writeFolderAccess(db, ensureFolderRow(db, 'shared/hr').id, { rules: [], limited: true }, null)
    writeFolderAccess(db, ensureFolderRow(db, 'projects/p').id, { rules: [{ subjectType: 'group', subjectId: 'mk', access: 'write' }], limited: true }, null)
    setProjectException(db, ensureFolderRow(db, 'projects/p').id, 'kim', true, null)
  })()
  db.query("UPDATE folder_rules SET origin = '{\"v\":1}' WHERE subject_type = 'group'").run()
  return db
}

describe('a limited folder with no rules (B1)', () => {
  test('members get none there and below, it is not listed, the navigator skips it, the sandbox denies reading it', () => {
    const db = world()
    const rs = RuleSet.load(db)
    expect(rs.boundaryFolders()).toContain('shared/hr')
    expect(rs.limitedAt('shared/hr')).toBe(true)
    expect(rs.access(P('m'), ['shared', 'hr'])).toBe('none')
    expect(rs.access(P('m'), ['shared', 'hr', 'x', 'y'])).toBe('none')
    expect(rs.access(P('m'), ['shared', 'other'])).toBe('write')
    expect(rs.canList(P('m'), ['shared', 'hr'])).toBe(false)
    expect(rs.listing(P('m'), ['shared']).listable(['shared', 'hr'])).toBe(false)
    expect(rs.navigator(['shared', 'hr'], 10)(P('m'))).toEqual({ listable: false, via: [], more: false })
    expect(rs.access(P('o', [], 'owner'), ['shared', 'hr'])).toBe('write')
    const v = folderView(rs, P('m'))
    expect(v.denyRead).toContain('shared/hr')
    expect(rs.explain(P('m'), ['shared', 'hr', 'x'])).toEqual({ access: 'none', reason: { kind: 'no-rule', cutAt: 'shared/hr' } })
  })
})

describe('derived sets keep limited, origin and the project exceptions', () => {
  test('replacing: limited omitted keeps it; false lifts it; exceptions stay unless named; same access keeps origin', () => {
    const rs = RuleSet.load(world())
    expect(rs.replacing('shared/hr', { rules: [] }).limitedAt('shared/hr')).toBe(true)
    expect(rs.replacing('shared/hr', { rules: [], limited: false }).access(P('m'), ['shared', 'hr'])).toBe('write')
    const p = rs.replacing('projects/p', { rules: [{ subjectType: 'group', subjectId: 'mk', access: 'write' }] })
    expect(p.exceptionsAt('projects/p')).toEqual(['kim'])
    expect(p.access(P('kim', ['mk']), ['projects', 'p'])).toBe('none')
    expect(p.rulesAt('projects/p')).toEqual([{ subjectType: 'group', subjectId: 'mk', access: 'write', origin: '{"v":1}' }])
    expect(rs.replacing('projects/p', { rules: [{ subjectType: 'group', subjectId: 'mk', access: 'read' }] }).rulesAt('projects/p')[0]!.origin).toBeUndefined()
    // named again by name: the exception goes
    const back = rs.replacing('projects/p', { rules: [{ subjectType: 'group', subjectId: 'mk', access: 'write' }, { subjectType: 'user', subjectId: 'kim', access: 'write' }] })
    expect(back.exceptionsAt('projects/p')).toEqual([])
    expect(back.access(P('kim', ['mk']), ['projects', 'p'])).toBe('write')
  })

  test('relocated: the limit moves with the folder (a move re-evaluates under the new parent, item 17)', () => {
    const rs = RuleSet.load(world())
    const moved = rs.relocated('shared/hr', 'open/hr')
    expect(moved.limitedAt('open/hr')).toBe(true)
    expect(moved.limitedAt('shared/hr')).toBe(false)
    expect(moved.access(P('m'), ['shared', 'hr'])).toBe('write')
    expect(moved.access(P('m'), ['open', 'hr'])).toBe('none')
  })

  test('parkedInPlace and fromDb with mapPath: a trashed folder judged at its old path with its limit', () => {
    const db = world()
    db.query("UPDATE folders SET path = '.system/trash/m/t1' WHERE path = 'shared/hr'").run()
    const rs = RuleSet.load(db)
    expect(rs.access(P('m'), ['shared', 'hr'])).toBe('write')
    expect(rs.parkedInPlace('.system/trash/m/t1', 'shared/hr').access(P('m'), ['shared', 'hr'])).toBe('none')
    expect(RuleSet.fromDb(db, { mapPath: inPlace('.system/trash/m/t1', 'shared/hr') }).access(P('m'), ['shared', 'hr'])).toBe('none')
  })

  test('the project exception holds from the rule alone: no project row, no leaver row', () => {
    const db = world()
    const rs = RuleSet.load(db)
    expect(rs.access(P('kim', ['mk']), ['projects', 'p', 'deep'])).toBe('none')
    expect(rs.explain(P('kim', ['mk']), ['projects', 'p']).reason).toEqual({ kind: 'left', folder: 'projects/p' })
    expect(rs.access(P('lee', ['mk']), ['projects', 'p'])).toBe('write')
    // rulesAt leaves out the exception and the legacy marker; exceptionsAt has the exception
    expect(rs.rulesAt('projects/p').map((r) => r.subjectType)).toEqual(['group'])
    expect(rs.exceptionsAt('projects/p')).toEqual(['kim'])
  })
})

test('without the conversion marker the loader fails closed: no rule applies, the owner and admins keep their fixed branches', () => {
  const db = world()
  db.query("DELETE FROM settings WHERE key = 'folder_access_model'").run()
  const rs = RuleSet.load(db)
  expect(rs.failedClosed).toBe(true)
  expect(rs.access(P('m'), ['shared', 'x'])).toBe('none')
  expect(rs.access(P('a', [], 'admin'), ['shared', 'x'])).toBe('write')
  expect(rs.access(P('m'), ['users', 'm'])).toBe('write')
})
