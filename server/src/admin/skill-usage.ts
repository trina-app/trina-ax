// Counts the skills actually supplied to a turn. Metadata only: never prompt text, arguments or skill bodies.
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import type { Principal } from '../policy/access'
import { readSkill, SKILL_NAME_MAX, type SkillInfo } from '../chat/skills'

// Team skills only (skills/...). A personal skill (users/<id>/skills/...) is never recorded: Admin > Usage shows
// skill paths and names to admins, and admins must not see personal files.
function skillPath(p: string): boolean {
  return p.startsWith('skills/') && p.endsWith('.md') && !p.includes('\\')
    && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !/[\u0000-\u001f]/.test(s))
}

/**
 * Called after a permitted skill is supplied. A retried turn or repeated read stays one usage row. `source`: 'command'
 * ("/name", a skill form), 'tool' (the skill tool loaded it) or 'read' (the AI read the SKILL.md with a file tool).
 * The skill tool is stored as 'read' in turn_skill_usage (its CHECK list is fixed; Admin › Usage stays as it was);
 * a command or the skill tool is also a run (turn_skill_runs, migration 223): what the onboarding goal counts
 * (onboarding/goal.ts), never a plain read.
 */
export function recordSkillUse(db: Database, input: { turnId: string; userId: string; skill: Pick<SkillInfo, 'path' | 'name'>; source: 'command' | 'tool' | 'read' }): void {
  const { turnId, userId, skill, source } = input
  if (!skillPath(skill.path) || !skill.name.trim() || skill.name.length > SKILL_NAME_MAX) return
  db.query(`INSERT INTO turn_skill_usage (turn_id, skill_path, skill_name, source)
    SELECT t.id, ?, ?, ? FROM turns t JOIN users u ON u.id = t.user_id
    WHERE t.id = ? AND t.user_id = ? AND u.status = 'active'
    ON CONFLICT(turn_id, skill_path) DO NOTHING`).run(skill.path, skill.name, source === 'tool' ? 'read' : source, turnId, userId)
  if (source === 'read') return
  db.query(`INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source)
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
