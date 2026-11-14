// Steps that run after every pending migration file, inside the same write-lock transaction (db.ts migrate()). Each is
// gated by what the database holds (a column, a trigger's SQL, a marker) and does nothing when its gate is closed, so
// running them again, or on a database built from only some migrations (tests), is safe. A step that throws rolls the
// whole transaction back, pending migration files included: the server does not start, and the database is as it was.
//
// Why steps and not migration files: they read and rewrite tables of several components (folders and rules are A's,
// schedules and trash B's and C's, the safe-ops triggers C's), which a numbered file of one range may not depend on
// (docs/WORKPLAN.md §4).
import type { Database } from 'bun:sqlite'
import { FOLDER_ACCESS_MODEL_KEY } from './policy/access'
import { runFolderAccessConversion } from './policy/convert-additive'

export interface PostMigrationStep {
  name: string
  /** the step has work to do on this database */
  gate(db: Database): boolean
  run(db: Database): void
}

const columnExists = (db: Database, table: string, col: string) =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) && (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)
const triggerSql = (db: Database, name: string) => (db.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | null)?.sql ?? null
const settingOf = (db: Database, key: string) => {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()) return null
  return (db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null)?.value ?? null
}

/** The safe-ops policy generation (316/319) must also advance when Limit access or a rule's origin changes: the
 * "access changed meanwhile" guard of safe-ops/source.ts and publication.ts reads it. */
function safeOpsFoldersSql(): string {
  return `CREATE TRIGGER safe_ops_folders_update AFTER UPDATE ON folders
WHEN OLD.id IS NOT NEW.id
 OR OLD.path IS NOT NEW.path
 OR OLD.limited IS NOT NEW.limited
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END`
}
function safeOpsRulesSql(): string {
  return `CREATE TRIGGER safe_ops_folder_rules_update AFTER UPDATE ON folder_rules
WHEN OLD.id IS NOT NEW.id
 OR OLD.folder_id IS NOT NEW.folder_id
 OR OLD.subject_type IS NOT NEW.subject_type
 OR OLD.subject_id IS NOT NEW.subject_id
 OR OLD.access IS NOT NEW.access
 OR OLD.origin IS NOT NEW.origin
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END`
}

export const POST_MIGRATION_STEPS: readonly PostMigrationStep[] = [
  {
    // the one-time conversion to additive folder access (policy/convert-additive.ts). A fresh database has no rules: it
    // only gets the marker
    name: 'folderAccessAdditive',
    gate: (db) => columnExists(db, 'folders', 'limited') && columnExists(db, 'folder_rules', 'origin') && settingOf(db, FOLDER_ACCESS_MODEL_KEY) === null && columnExists(db, 'settings', 'value'),
    run: (db) => { runFolderAccessConversion(db) },
  },
  {
    // the safe-ops triggers see Limit access and origin (only where both the triggers and the columns exist: a test
    // database built from some migrations may have one without the other)
    name: 'safeOpsFolderLimited',
    gate: (db) => {
      if (!columnExists(db, 'folders', 'limited') || !columnExists(db, 'folder_rules', 'origin')) return false
      const f = triggerSql(db, 'safe_ops_folders_update'), r = triggerSql(db, 'safe_ops_folder_rules_update')
      return (f !== null && !/\blimited\b/.test(f)) || (r !== null && !/\borigin\b/.test(r))
    },
    run: (db) => {
      const f = triggerSql(db, 'safe_ops_folders_update'), r = triggerSql(db, 'safe_ops_folder_rules_update')
      if (f !== null && !/\blimited\b/.test(f)) { db.exec('DROP TRIGGER safe_ops_folders_update'); db.exec(safeOpsFoldersSql()) }
      if (r !== null && !/\borigin\b/.test(r)) { db.exec('DROP TRIGGER safe_ops_folder_rules_update'); db.exec(safeOpsRulesSql()) }
    },
  },
]

/** Some step has work to do (the caller then makes the copy before migrating, as for a pending file). */
export const stepsPending = (db: Database, steps: readonly PostMigrationStep[] = POST_MIGRATION_STEPS): boolean => {
  try { return steps.some((s) => s.gate(db)) } catch { return false }
}

/** Run every step whose gate is open. Call inside the migration transaction. */
export function runPostMigrationSteps(db: Database, steps: readonly PostMigrationStep[] = POST_MIGRATION_STEPS): void {
  for (const s of steps) if (s.gate(db)) s.run(db)
}
