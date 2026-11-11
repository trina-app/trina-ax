// A database-only restore keeps the folder permissions as they are now (QA TC-195): the team folder is not restored,
// so a folder closed after the backup must not open again to everyone who reads the folder above it.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { RuleSet, type Principal } from '../../server/src/policy/access'
import { applyPendingRestore, BackupManager, keepFolderAccess } from '../../server/src/system/backup'
import { resolveLayout } from '../../server/src/system/layout'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-restore-folder-rules')
fs.rmSync(W, { recursive: true, force: true })

const mia: Principal = { id: 'mia', name: 'Mia', role: 'member', groups: [] }
const segs = (p: string) => p.split('/')

function setup(name: string) {
  const base = path.join(W, name)
  const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(path.join(cfg.teamRoot, 'shared'), { recursive: true })
  const dbFile = path.join(cfg.dataDir, 'app.db')
  const db = openDb(dbFile)
  db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner'), ('mia', 'mia', 'Mia', 'member')").run()
  folder(db, 'f-shared', 'shared', [['everyone', null, 'write']])
  const mgr = new BackupManager({ db, dbFile, layout: resolveLayout(cfg), log: silentLogger, version: '0.1.0', now: () => new Date('2026-10-01T04:00:00Z') })
  return { cfg, db, dbFile, mgr }
}

let n = 0
function folder(db: Database, id: string, p: string, rules: [string, string | null, string][]) {
  db.query('INSERT INTO folders (id, path, created_at) VALUES (?, ?, ?)').run(id, p, '2026-10-01T00:00:00Z')
  for (const [t, s, a] of rules) db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`r${++n}`, id, t, s, a, '2026-10-01T00:00:00Z')
}

/** back up, change the live DB with `after`, restore the backup and open the result */
async function restoreAfter(name: string, before: (db: Database) => void, after: (db: Database) => void) {
  const e = setup(name)
  before(e.db)
  const m = await e.mgr.run({ kind: 'manual', scope: 'db' })
  after(e.db)
  await e.mgr.stageDbRestore(m.id, 'olga')
  e.db.close()
  const r = applyPendingRestore(e.cfg.dataDir, silentLogger)
  expect(r.applied).toBe(true)
  const db = openDb(e.dbFile)
  const result = JSON.parse(fs.readFileSync(path.join(e.cfg.dataDir, 'restore-result.json'), 'utf8'))
  return { db, rules: RuleSet.load(db), result, e }
}

describe('a database-only restore keeps the folder permissions as they are now', () => {
  test('a folder made and closed after the backup stays closed (QA TC-195)', async () => {
    const { db, rules, result } = await restoreAfter('new-closed', () => {}, (db) => {
      folder(db, 'f-hr', 'shared/HR', [['everyone', null, 'none'], ['user', 'olga', 'write']])
      db.query("INSERT INTO users (id, username, name, role) VALUES ('later', 'later', 'Later', 'member')").run()
    })
    // the rest of the database is the backup's
    expect(db.query("SELECT id FROM users WHERE id = 'later'").get()).toBeNull()
    expect(rules.access(mia, segs('shared/HR/급여명세_2026-11.md'))).toBe('none')
    expect(rules.canList(mia, segs('shared/HR'))).toBe(false)
    expect(rules.access(mia, segs('shared/공지'))).toBe('write')
    expect(result).toMatchObject({ ok: true, folderRules: 'kept' })
    db.close()
  })

  test('a folder open at the backup and closed after it stays closed; one opened after it stays open', async () => {
    const { db, rules } = await restoreAfter('changed', (db) => {
      folder(db, 'f-plans', 'shared/Plans', [['everyone', null, 'read']])
      folder(db, 'f-board', 'shared/Board', [['everyone', null, 'none']])
    }, (db) => {
      db.query("UPDATE folder_rules SET access = 'none' WHERE folder_id = 'f-plans'").run()
      // the board's rules removed (Admin › Folder permissions drops the row): it reads as shared/ now
      db.query("DELETE FROM folder_rules WHERE folder_id = 'f-board'").run()
      db.query("DELETE FROM folders WHERE id = 'f-board'").run()
    })
    expect(rules.access(mia, segs('shared/Plans/q4.md'))).toBe('none')
    expect(rules.access(mia, segs('shared/Board/x.md'))).toBe('write')
    // the backup's row stays (versions and trash items may point at it), without its rules
    expect(db.query("SELECT path FROM folders WHERE id = 'f-board'").get()).toEqual({ path: 'shared/Board' })
    expect(db.query("SELECT COUNT(*) AS n FROM folder_rules WHERE folder_id = 'f-board'").get()).toEqual({ n: 0 })
    db.close()
  })

  test('a folder moved after the backup takes its rules to where it is now', async () => {
    const { db, rules } = await restoreAfter('moved', (db) => {
      folder(db, 'f-hr', 'shared/HR', [['everyone', null, 'none']])
    }, (db) => {
      db.query("UPDATE folders SET path = 'shared/People' WHERE id = 'f-hr'").run()
    })
    expect(rules.access(mia, segs('shared/People/salary.md'))).toBe('none')
    expect(db.query("SELECT path FROM folders WHERE id = 'f-hr'").get()).toEqual({ path: 'shared/People' })
    db.close()
  })

  test('a new group\'s folder stays closed: the group is not in the restored database', async () => {
    const { db, rules } = await restoreAfter('new-group', (db) => {
      folder(db, 'f-groups', 'groups', [['everyone', null, 'none']])
    }, (db) => {
      folder(db, 'f-sales', 'groups/sales', [['group', 'g-sales', 'write']])
      db.query("INSERT INTO groups (id, name, folder_id) VALUES ('g-sales', 'Sales', 'f-sales')").run()
      db.query("INSERT INTO group_members (group_id, user_id) VALUES ('g-sales', 'mia')").run()
    })
    expect(db.query("SELECT id FROM groups WHERE id = 'g-sales'").get()).toBeNull()
    expect(rules.access({ ...mia, groups: [] }, segs('groups/sales/deal.md'))).toBe('none')
    db.close()
  })

  test('another folder at the backup\'s path: the backup\'s row goes and its group has no folder', async () => {
    const { db, rules } = await restoreAfter('path-taken', (db) => {
      folder(db, 'f-old', 'groups/ops', [['group', 'g-ops', 'write'], ['everyone', null, 'read']])
      db.query("INSERT INTO groups (id, name, folder_id) VALUES ('g-ops', 'Ops', 'f-old')").run()
    }, (db) => {
      db.query("DELETE FROM folder_rules WHERE folder_id = 'f-old'").run()
      db.query("UPDATE groups SET folder_id = NULL WHERE folder_id = 'f-old'").run()
      db.query("DELETE FROM folders WHERE id = 'f-old'").run()
      folder(db, 'f-new', 'groups/ops', [['everyone', null, 'none'], ['user', 'olga', 'write']])
    })
    expect(db.query("SELECT id FROM folders WHERE path = 'groups/ops'").get()).toEqual({ id: 'f-new' })
    expect(db.query("SELECT folder_id FROM groups WHERE id = 'g-ops'").get()).toEqual({ folder_id: null })
    expect(rules.access(mia, segs('groups/ops/x.md'))).toBe('none')
    db.close()
  })

  test('a folder parked in the trash only in the backup keeps its rules there', async () => {
    const parked = '.system/trash/2026-10/t1/Secret'
    const { db } = await restoreAfter('parked', (db) => {
      folder(db, 'f-secret', parked, [['everyone', null, 'none']])
    }, (db) => {
      // purged since
      db.query("DELETE FROM folder_rules WHERE folder_id = 'f-secret'").run()
      db.query("DELETE FROM folders WHERE id = 'f-secret'").run()
    })
    expect(db.query("SELECT path FROM folders WHERE id = 'f-secret'").get()).toEqual({ path: parked })
    expect(db.query("SELECT access FROM folder_rules WHERE folder_id = 'f-secret'").all()).toEqual([{ access: 'none' }])
    db.close()
  })

  test('a current database that cannot be read leaves the backup\'s rules, and the result says so', () => {
    const dir = path.join(W, 'unreadable')
    fs.mkdirSync(dir, { recursive: true })
    const staged = path.join(dir, 'staged.db')
    const s = openDb(staged)
    folder(s, 'f-plans', 'shared/Plans', [['everyone', null, 'read']])
    s.close()
    const live = path.join(dir, 'live.db')
    fs.writeFileSync(live, Buffer.alloc(8192, 0x55))
    expect(keepFolderAccess(live, staged)).toBe(false)
    expect(keepFolderAccess(path.join(dir, 'missing.db'), staged)).toBe(false)
    const db = openDb(staged)
    expect(RuleSet.load(db).rulesAt('shared/Plans')).toEqual([{ subjectType: 'everyone', subjectId: null, access: 'read' }])
    db.close()
  })
})
