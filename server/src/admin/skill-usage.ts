// Counts the skills actually supplied to a turn. Metadata only: never prompt text, arguments or skill bodies.
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import type { Principal } from '../policy/access'
import { readSkill, SKILL_NAME_MAX, type SkillInfo } from '../chat/skills'

function skillPath(p: string): boolean {
  return p.startsWith('skills/') && p.endsWith('.md') && !p.includes('\\')
    && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !/[\u0000-\u001f]/.test(s))
}

/** Called after a permitted skill is supplied. A retried turn or repeated read stays one usage row. */
export function recordSkillUse(db: Database, input: { turnId: string; userId: string; skill: Pick<SkillInfo, 'path' | 'name'>; source: 'command' | 'read' }): void {
  const { turnId, userId, skill, source } = input
  if (!skillPath(skill.path) || !skill.name.trim() || skill.name.length > SKILL_NAME_MAX) return
  db.query(`INSERT INTO turn_skill_usage (turn_id, skill_path, skill_name, source)
    SELECT t.id, ?, ?, ? FROM turns t JOIN users u ON u.id = t.user_id
    WHERE t.id = ? AND t.user_id = ? AND u.status = 'active'
    ON CONFLICT(turn_id, skill_path) DO NOTHING`).run(skill.path, skill.name, source, turnId, userId)
}

/** After a successful read tool only. Re-authorize the actual path; ordinary rules are not skills. */
export function recordSkillRead(db: Database, files: FileService, user: Principal, turnId: string, inputPath: string): void {
  // readSkill resolves actual disk names before validation (including case/Unicode aliases).
  const skill = readSkill(files, user, inputPath)
  if (skill) recordSkillUse(db, { turnId, userId: user.id, skill, source: 'read' })
}
