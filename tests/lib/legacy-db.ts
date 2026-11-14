// A database as a build before folder access added up left it (every migration but 121_a_folder_limited.sql and the
// later reader-level raises, 122_a_guests.sql; reader level 6), for the conversion tests: rows are written raw, "no access" and role rows included, then migrate() with this
// build's migrations converts it (server/src/db-steps.ts folderAccessAdditive).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { MIGRATIONS_DIR, migrate } from '../../server/src/db'
import { LegacyRuleSet, type LegacyRow } from '../../server/src/policy/legacy-deepest'

let oldDir: string | null = null
/** The migrations folder without 121 and 122 (made once per process). */
export function oldMigrations(): string {
  if (oldDir) return oldDir
  oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-old-migrations-'))
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (!f.startsWith('121_') && !f.startsWith('122_')) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(oldDir, f))
  process.on('exit', () => { try { fs.rmSync(oldDir!, { recursive: true, force: true }) } catch {} })
  return oldDir
}

export interface LegacyDb {
  db: Database
  user(id: string, role?: 'owner' | 'admin' | 'member', o?: { groups?: string[]; status?: 'active' | 'disabled' }): void
  group(id: string): void
  rule(path: string, subjectType: 'everyone' | 'role' | 'group' | 'user', subjectId: string | null, access: 'none' | 'read' | 'write'): void
  folder(path: string): string
  project(id: string, folderPath: string, o?: { createdBy?: string | null }): void
  /** the rule rows now, for LegacyRuleSet */
  rows(): LegacyRow[]
  legacy(): LegacyRuleSet
  /** migrate with this build's migrations (converts) */
  convert(): void
}

export function legacyDb(): LegacyDb {
  const db = new Database(':memory:', { strict: true })
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, { migrationsDir: oldMigrations(), readerLevel: 6 })
  let n = 0
  const folder = (p: string) => {
    const f = db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string } | null
    if (f) return f.id
    const id = `f${++n}`
    db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(id, p)
    return id
  }
  const self: LegacyDb = {
    db,
    user(id, role = 'member', o = {}) {
      db.query('INSERT INTO users (id, username, name, role, status) VALUES (?, ?, ?, ?, ?)').run(id, id, id, role, o.status ?? 'active')
      for (const g of o.groups ?? []) db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g, id)
    },
    group(id) { db.query('INSERT INTO groups (id, name) VALUES (?, ?)').run(id, id) },
    rule(p, t, s, a) { db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, ?, ?, ?)').run(`r${++n}`, folder(p), t, s, a) },
    folder,
    project(id, folderPath, o = {}) { db.query('INSERT INTO projects (id, name, folder_path, created_by) VALUES (?, ?, ?, ?)').run(id, id, folderPath, o.createdBy ?? null) },
    rows: () => db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as LegacyRow[],
    legacy: () => new LegacyRuleSet(self.rows()),
    convert: () => migrate(db, {}),
  }
  return self
}
