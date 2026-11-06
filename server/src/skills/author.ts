// Who made a team skill (docs/DECISIONS.md "S — The lead's way becomes a team skill"): the person whose save made the
// skill file's first version, read from the file's own history (file_events), never from the file's text, which anyone
// who manages skills can edit. file_versions keeps the content a save REPLACED, so a file nobody edited yet has no row
// there; its first version is the content event that created it.
// A skill a starter pack wrote has no maker (the person who pressed install did not write it): the install marks its
// file event (`tool: 'pack_install'`); an install from before that mark is recognized by its own audit row.
import type { Database } from 'bun:sqlite'
import { CONTENT_KINDS, fileTimeline } from '../files/timeline'
import { packSkillNames } from '../onboarding/skill-packs'

interface Ev { id: number; user_id: string; action: string; path: string; detail: string | null; at: string }
const parse = (d: string | null): Record<string, unknown> => { try { const v = d ? JSON.parse(d) : null; return v && typeof v === 'object' ? v : {} } catch { return {} } }

/**
 * The event that made the file now at `rel`: the first content event at that name after anything else last left it
 * (a delete that was neither a move away nor a trip to the trash it came back from), following the file's own moves
 * back. Direct queries (a few per move), not the whole history. null when the name has no such event (a folder above
 * was moved: the timeline walk then).
 */
function firstEvent(db: Database, rel: string): Ev | null {
  let cur = rel
  let before = Number.MAX_SAFE_INTEGER
  for (let hop = 0; hop < 16; hop++) {
    const gone = db.query(`SELECT MAX(d.id) AS id FROM file_events d WHERE d.path = ? AND d.id < ? AND d.action = 'delete'
      AND NOT (json_valid(d.detail) AND json_extract(d.detail, '$.movedTo') IS NOT NULL)
      AND NOT (json_valid(d.detail) AND json_extract(d.detail, '$.trashId') IS NOT NULL AND EXISTS (SELECT 1 FROM file_events r
        WHERE r.action = 'restore' AND r.id > d.id AND r.id < ? AND json_valid(r.detail) AND json_extract(r.detail, '$.trashId') = json_extract(d.detail, '$.trashId')))`)
      .get(cur, before, before) as { id: number | null } | null
    const first = db.query(`SELECT id, user_id, action, path, detail, at FROM file_events WHERE path = ? AND id > ? AND id < ?
      AND action IN ('create', 'upload', 'update', 'restore') ORDER BY id ASC LIMIT 1`).get(cur, gone?.id ?? 0, before) as Ev | null
    if (!first) return null
    const moved = parse(first.detail).movedFrom
    if (first.action === 'create' && typeof moved === 'string') { cur = moved; before = first.id; continue }
    // back from the trash: the same file, made before it went there
    if (first.action === 'restore' && gone?.id) { before = gone.id; continue }
    return first
  }
  return null
}

/** A pack's install from before the mark: a skill of a pack's name in that pack's folder, made by the person of an
 * `onboarding.pack_install` audit row within a minute of it. */
function packInstallByAudit(db: Database, e: Ev): boolean {
  const m = /^skills\/([^/]+)\/([^/]+)\/SKILL\.md$/.exec(e.path)
  if (!m || !packSkillNames().includes(m[2]!)) return false
  return !!db.query(`SELECT 1 FROM audit_log WHERE action = 'onboarding.pack_install' AND actor_id = ? AND target = ?
    AND ABS(julianday(at) - julianday(?)) * 86400 <= 60 LIMIT 1`).get(e.user_id, `skills/${m[1]}`, e.at)
}

/** The account that made the first version of `rel`, or null: unknown (older than the history, changed outside the
 * app), or a starter pack's install. */
export function skillMakerId(db: Database, rel: string): string | null {
  let e: Ev | null
  try { e = firstEvent(db, rel) } catch { e = null }
  if (!e) {
    // a folder above was moved or renamed: the walk the file screen's history uses
    let t
    try { t = fileTimeline(db, rel, { limit: 1000 }).at(-1) } catch { return null }
    if (!t || !CONTENT_KINDS.has(t.kind)) return null
    e = db.query('SELECT id, user_id, action, path, detail, at FROM file_events WHERE id = ?').get(t.id) as Ev | null
    if (!e) return null
  }
  if (parse(e.detail).tool === 'pack_install' || packInstallByAudit(db, e)) return null
  return e.user_id
}

/**
 * The member whose suggestion became the skill at `rel` (docs/DECISIONS.md "MC": "민준 님이 제안" stays on it): an
 * approved suggestion that resulted in `rel`, sent by someone else than its approver, whose approver's save made the
 * file's first version (`makerId`), so a skill deleted and made again there by someone else is not theirs. Their name
 * while the account is there.
 */
export function skillSuggester(db: Database, rel: string, makerId: string | null = skillMakerId(db, rel)): { id: string; name: string } | null {
  if (!makerId) return null
  let r: { id: string; name: string } | null = null
  try {
    r = db.query(`SELECT s.suggester_id AS id, u.name FROM skill_suggestions s JOIN users u ON u.id = s.suggester_id
      WHERE s.result_path = ? AND s.status = 'approved' AND s.reviewer_id = ? AND s.suggester_id != s.reviewer_id AND u.deleted_at IS NULL
      ORDER BY s.reviewed_at DESC LIMIT 1`).get(rel, makerId) as { id: string; name: string } | null
  } catch { return null }
  return r && r.name.trim() ? { id: r.id, name: r.name.trim() } : null
}

/** skillSuggester for many paths at once (the skills list): only paths that some approved suggestion resulted in are
 * looked at closer. */
export function suggestersOf(db: Database, rels: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!rels.length) return out
  let made: Set<string>
  try { made = new Set((db.query("SELECT DISTINCT result_path AS p FROM skill_suggestions WHERE status = 'approved' AND result_path IS NOT NULL").all() as { p: string }[]).map((x) => x.p)) } catch { return out }
  for (const rel of rels) {
    if (!made.has(rel)) continue
    const s = skillSuggester(db, rel)
    if (s) out.set(rel, s.name)
  }
  return out
}

/** The maker's name as people know them (an account that was deleted has none); a skill a member suggested is theirs
 * (skillSuggester), not its approver's. */
export function skillMakerName(db: Database, rel: string): { id: string; name: string } | null {
  const id = skillMakerId(db, rel)
  if (!id) return null
  const suggested = skillSuggester(db, rel, id)
  if (suggested) return suggested
  const u = db.query('SELECT name, deleted_at FROM users WHERE id = ?').get(id) as { name: string; deleted_at: string | null } | null
  return u && !u.deleted_at && u.name.trim() ? { id, name: u.name.trim() } : null
}
