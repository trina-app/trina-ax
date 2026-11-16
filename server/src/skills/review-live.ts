// What waits for a person's review in Team skills changed without them doing anything: another reviewer registered or
// turned down a suggestion, a share proposal to their group was applied, dismissed or moved. Their open windows read
// the count and the lists again (web/src/store/live.ts: skillsChanged). Quiet, like integrations_changed: no text, no
// banner, no inbox entry, no push. Nothing is asked of them.
import type { AppContext } from '../context'

export const SKILLS_CHANGED = { type: 'notice', data: { level: 'info', code: 'skills_changed', message: '' } } as const

/** Each person once; a failure to publish never fails the review that caused it. */
export function tellSkillsChanged(ctx: AppContext, userIds: Iterable<string>): void {
  for (const id of new Set(userIds)) {
    try { ctx.services.realtime.publish(id, SKILLS_CHANGED) } catch (err) { ctx.log.warn('skills changed notice failed', { err: err instanceof Error ? err.message : String(err) }) }
  }
}
