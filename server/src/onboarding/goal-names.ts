// How the 7-day team goal names a skill to people (onboarding/goal.ts, the owners' inbox in notifications/service.ts).
import { skillTitle } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { readSkill } from '../chat/skills'

/** The plain name people know a skill by: its metadata `title` ("광고 문구"), else its name (shared skillTitle, the same
 * rule as every screen). */
export { skillTitle }

/** A team skill's plain name as `userId` may read it now; `recorded` (the name the usage rows keep, which Admin ›
 * Usage shows admins already) when they cannot or it is gone. */
export function titleFor(ctx: AppContext, userId: string, path: string, recorded: string): string {
  try {
    const skill = readSkill(ctx.files, ctx.files.principal(userId), path)
    return skill ? skillTitle(skill) : recorded
  } catch { return recorded }
}

/** The skill's plain name for an owner's inbox entry: as they may read it now, else the name last recorded for it. */
export function goalSkillTitle(ctx: AppContext, viewerId: string, path: string): string {
  const r = ctx.db.query('SELECT skill_name AS name FROM turn_skill_runs WHERE skill_path = ? ORDER BY recorded_at DESC LIMIT 1').get(path) as { name: string } | null
  return titleFor(ctx, viewerId, path, r?.name ?? path)
}
