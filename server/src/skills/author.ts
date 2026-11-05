// Who made a team skill (docs/DECISIONS.md "S — The lead's way becomes a team skill"): the person whose save made the
// skill file's first version, read from the file's own history (files/timeline.ts, the same walk the file screen's
// history shows: back through edits and moves to the event that made the file). Never from the file's text, which
// anyone who manages skills can edit. file_versions keeps the content a save REPLACED, so a file nobody edited yet has
// no row there; its first version is the event that created it, which the timeline reads for both.
// A file whose first version is a starter pack's text (installed by the owner's click, written by us) has no maker:
// "김지훈님의 팀 스킬 '할 일 정리'" would name the person who pressed install as its author.
import type { Database } from 'bun:sqlite'
import { CONTENT_KINDS, fileTimeline } from '../files/timeline'
import { packTextHashes } from '../onboarding/skill-packs'

/** The account that made the first version of `rel`, or null: unknown (older than the history, changed outside the
 * app), or a pack's own text. */
export function skillMakerId(db: Database, rel: string): string | null {
  let first
  try { first = fileTimeline(db, rel, { limit: 1000 }).at(-1) } catch { return null }
  if (!first || !CONTENT_KINDS.has(first.kind)) return null
  if (first.sha256 && packTextHashes().has(first.sha256)) return null
  return first.userId
}

/** The maker's name as people know them (an account that was deleted has none). */
export function skillMakerName(db: Database, rel: string): { id: string; name: string } | null {
  const id = skillMakerId(db, rel)
  if (!id) return null
  const u = db.query('SELECT name, deleted_at FROM users WHERE id = ?').get(id) as { name: string; deleted_at: string | null } | null
  return u && !u.deleted_at && u.name.trim() ? { id, name: u.name.trim() } : null
}
