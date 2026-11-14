// The invariants of the stored folder access (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"), as one
// check: the tests run it at the end of every security test, and the dry run (scripts/dry-run/folder-additive.ts) on a
// converted copy. Rows under users/ are left out: both resolvers ignore them.
//   1. limited and no everyone rule with access => exactly one everyone: none (the legacy marker)
//   2. not limited => no everyone: none
//   3. "none" rows only as: (1); a person's own on projects/<name>; parked copies under .system/
//   4. the only role rows are role admin: write (the managed marker)
//   5. every live projects/<name> a project uses has a limited folders row
//   6. settings.folder_access_model = 'additive-1'
//   7. origin only on person rules
import type { Database } from 'bun:sqlite'
import { FOLDER_ACCESS_MODEL, FOLDER_ACCESS_MODEL_KEY, isZoneTop } from './access'

const isUsers = (p: string) => p === 'users' || p.startsWith('users/')
const isParked = (p: string) => p === '.system' || p.startsWith('.system/')

/** Every invariant that does not hold, in words (empty: all hold). */
export function folderAccessProblems(db: Database): string[] {
  const out: string[] = []
  const folders = db.query('SELECT id, path, limited FROM folders').all() as { id: string; path: string; limited: number }[]
  const rules = db.query('SELECT folder_id, subject_type, subject_id, access, origin FROM folder_rules').all() as { folder_id: string; subject_type: string; subject_id: string | null; access: string; origin: string | null }[]
  const by = new Map<string, typeof rules>()
  for (const r of rules) by.set(r.folder_id, [...(by.get(r.folder_id) ?? []), r])
  for (const f of folders) {
    if (isUsers(f.path)) continue
    const rs = by.get(f.id) ?? []
    const marker = rs.filter((r) => r.subject_type === 'everyone' && r.access === 'none').length
    const grants = rs.some((r) => r.subject_type === 'everyone' && r.access !== 'none')
    if (f.limited === 1 && !grants && marker !== 1) out.push(`1: ${f.path || '(root)'} is limited without an everyone rule and has ${marker} legacy markers`)
    if (f.limited !== 1 && marker) out.push(`2: ${f.path || '(root)'} is not limited and has a legacy marker`)
    for (const r of rs) {
      if (r.access === 'none' && !(r.subject_type === 'everyone' && f.limited === 1) && !(r.subject_type === 'user' && isZoneTop(f.path)) && !isParked(f.path)) out.push(`3: ${f.path || '(root)'} has ${r.subject_type} ${r.subject_id ?? ''}: none`)
      if (r.subject_type === 'role' && !(r.subject_id === 'admin' && r.access === 'write')) out.push(`4: ${f.path || '(root)'} has role ${r.subject_id}: ${r.access}`)
      if (r.origin !== null && r.subject_type !== 'user') out.push(`7: ${f.path || '(root)'} has an origin on a ${r.subject_type} rule`)
    }
  }
  const hasProjects = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()
  const trashed = hasProjects && !!(db.query('PRAGMA table_info(projects)').all() as { name: string }[]).some((c) => c.name === 'trashed_with')
  if (hasProjects) {
    for (const p of db.query(`SELECT folder_path FROM projects${trashed ? ' WHERE trashed_with IS NULL' : ''}`).all() as { folder_path: string }[]) {
      if (!isZoneTop(p.folder_path)) continue
      const f = folders.find((x) => x.path === p.folder_path)
      if (!f || f.limited !== 1) out.push(`5: the project folder ${p.folder_path} is not limited`)
    }
  }
  let model: string | null = null
  try { model = (db.query('SELECT value FROM settings WHERE key = ?').get(FOLDER_ACCESS_MODEL_KEY) as { value: string } | null)?.value ?? null } catch { /* no table */ }
  if (model !== FOLDER_ACCESS_MODEL) out.push(`6: the marker is ${model ?? 'missing'}`)
  return out
}
