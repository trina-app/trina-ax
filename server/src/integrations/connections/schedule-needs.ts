// Scheduled tasks and connection templates (docs/INTEGRATIONS.md "Templates", brief R7). A scheduled run uses its
// owner's connections only (store.ts usable): a member's connection made from an admin's template is theirs, with their
// key. When the owner has no key for a template the task needs (never connected, or a new address dropped it), or theirs
// stopped working, the run does not start: it says which template and that the owner connects it in Settings › MCP,
// instead of running without the service. It never falls back to anyone else's key.
// A task needs a template when one of its runs used a tool of the owner's connection made from it (noted here, on the
// call), or when its instruction names the template (a task written before its owner connected the service).
import type { Database } from 'bun:sqlite'
import type { Row } from './store'
import { templateCovers } from './store'

/** A run of a scheduled task called a tool of a connection made from a template: the task's next runs need it. */
export function noteScheduleUse(db: Database, turnId: string, row: Pick<Row, 'template_id'>): void {
  if (!row.template_id) return
  try {
    db.query(`INSERT OR IGNORE INTO schedule_template_needs(schedule_id, template_id, created_at)
      SELECT t.schedule_id, ?, ? FROM turns t WHERE t.id = ? AND t.schedule_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM schedules s WHERE s.id = t.schedule_id) AND EXISTS(SELECT 1 FROM integration_templates WHERE id = ?)`)
      .run(row.template_id, new Date().toISOString(), turnId, row.template_id)
  } catch { /* the call went through; only the note is missed */ }
}

/** The template's name as a whole phrase in the instruction, ignoring case. A name that starts or ends with a Latin
 * letter or digit is not part of a longer Latin word there ("Tasks" is not in "Taskset"); a Korean or Japanese particle
 * right after it is fine ("Wiki에서"). Names under 3 characters are too short to tell apart from ordinary words. */
export function namesTemplate(prompt: string, name: string): boolean {
  const n = name.trim()
  const chars = [...n]
  if (chars.length < 3) return false
  const word = /[\p{Script=Latin}\p{N}]/u
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const before = word.test(chars[0]!) ? '(?<![\\p{Script=Latin}\\p{N}])' : ''
  const after = word.test(chars.at(-1)!) ? '(?![\\p{Script=Latin}\\p{N}])' : ''
  return new RegExp(`${before}${esc}${after}`, 'iu').test(prompt)
}

/** The first template this task needs whose own key its owner does not have (or whose key stopped working), or null.
 * Only templates still for the owner: one they lost does not stop the run (they could not connect it anyway). */
export function missingTemplateKey(db: Database, s: { id: string; user_id: string; prompt: string }): { templateId: string; name: string } | null {
  const templates = db.query('SELECT id, name FROM integration_templates ORDER BY name, id').all() as { id: string; name: string }[]
  if (!templates.length) return null
  const used = new Set((db.query('SELECT template_id FROM schedule_template_needs WHERE schedule_id = ?').all(s.id) as { template_id: string }[]).map((r) => r.template_id))
  for (const t of templates) {
    if (!used.has(t.id) && !namesTemplate(s.prompt, t.name)) continue
    if (!templateCovers(db, t.id, s.user_id)) continue
    const mine = db.query('SELECT status, secret_enc IS NOT NULL AS has FROM integrations WHERE template_id = ? AND owner_user_id = ?').get(t.id, s.user_id) as { status: string; has: number } | null
    if (!mine || !mine.has || mine.status === 'needs_auth') return { templateId: t.id, name: t.name }
  }
  return null
}
