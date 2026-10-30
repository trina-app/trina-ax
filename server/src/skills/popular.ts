import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import type { Principal } from '../policy/access'
import { isPersonalSkill, listSkills } from '../chat/skills'

/** Only aggregate counts of team skills the caller can read now; no user identity or prompt content. Personal skills
 * are never counted (admin/skill-usage.ts does not record them), and they are left out here too. */
export function popularSkills(db: Database, files: FileService, user: Principal, now = new Date()) {
  const allowed = listSkills(files, user).filter((s) => !isPersonalSkill(s.path)), byPath = new Map(allowed.map(s => [s.path, s]))
  if (!allowed.length) return { items: [], days: 30 as const }
  const from = new Date(now.getTime() - 30 * 86400_000).toISOString()
  const rows = db.query(`SELECT s.skill_path AS path,COUNT(*) AS uses,COUNT(DISTINCT t.user_id) AS users
    FROM turn_skill_usage s JOIN turns t ON t.id=s.turn_id JOIN users u ON u.id=t.user_id
    WHERE t.started_at>=? AND t.started_at<? AND u.deleted_at IS NULL
      AND s.skill_path IN (${allowed.map(() => '?').join(',')})
    GROUP BY s.skill_path ORDER BY uses DESC,s.skill_path LIMIT 10`)
    .all(from, now.toISOString(), ...allowed.map(s => s.path)) as { path: string; uses: number; users: number }[]
  return { items: rows.map(r => {
    const s = byPath.get(r.path)!
    return { path: s.path, name: s.name, description: s.description, uses: r.uses, users: r.users }
  }), days: 30 as const }
}
