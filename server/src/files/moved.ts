// Where a team file that is not at its path any more went (QA TC-7234, TC-r2b-01, TC-r2b-02): someone moved it on the
// Files screen (or the AI did), moved a folder above it, or put it in the trash. Read from file_events, as the
// references follow a file (uploads/ref-follow.ts) and placeNow follows a place (files/timeline.ts):
//   - a move writes 'delete' {movedTo} at the old path (and of a folder: at the folder's path, {folder: true});
//   - the trash writes 'delete' {trashId}, and a restore 'restore' {trashId} at the place it came back to.
// The newest delete of the path (or of a folder above it) is where it left; each later move of where it went is
// followed. Who may learn what is decided by movedFact: the old folder must be one the person may list now (else a
// hidden place says nothing), and the new path is named only when the person may read the file there.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { authorize, type FsCtx } from '../policy/authorize'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { parseInput } from '../policy/resolve'
import { selfAndAbove } from './timeline'

/** What happened to the file that was at a path: moved (`to`: where the moves lead now) or put in the trash. `by`: the
 * person who did it (their AI's move is theirs), `at`: when (file_events.at). */
export type WhereNow = { kind: 'moved'; to: string; by: string; at: string } | { kind: 'trashed'; by: string; at: string }

interface Ev { id: number; path: string; user_id: string; detail: string | null; at: string }

function parse(detail: string | null): Record<string, unknown> {
  if (!detail) return {}
  try { const v = JSON.parse(detail); return v && typeof v === 'object' ? v as Record<string, unknown> : {} } catch { return {} }
}

/** at most this many moves are followed (a file moved back and forth many times still ends) */
const HOPS = 64

/** Where the file last at `rel` (actual names) went, or null: no move or trash of it (or a folder above) is recorded,
 * or it was deleted for good. */
export function whereNow(db: Database, rel: string): WhereNow | null {
  const delAt = (keys: string[], o: { after?: number; newest?: boolean }) => db.query(`SELECT id, path, user_id, detail, at FROM file_events
    WHERE action = 'delete' AND path IN (${keys.map(() => '?').join(',')})${o.after !== undefined ? ' AND id > ?' : ''}
    ORDER BY id ${o.newest ? 'DESC' : 'ASC'} LIMIT 1`).get(...keys, ...(o.after !== undefined ? [o.after] : [])) as Ev | null
  const restored = (trashId: string, after: number) => db.query(`SELECT id, path FROM file_events WHERE id > ? AND action = 'restore'
    AND CASE WHEN json_valid(detail) THEN json_extract(detail, '$.trashId') END = ? ORDER BY id ASC LIMIT 1`).get(after, trashId) as { id: number; path: string } | null
  // the event that took the file away: its own delete after it was last there (made, saved, uploaded, restored or moved
  // in at this path), else the first move or trash of a folder above after that (a folder trashed after the file had
  // left it says nothing about the file)
  const keys = selfAndAbove(rel)
  const above = keys.slice(0, -1)
  const seen = db.query(`SELECT MAX(id) AS id FROM file_events WHERE path = ? AND action IN ('create', 'update', 'upload', 'restore')`).get(rel) as { id: number | null }
  const own = delAt([rel], { newest: true })
  const first = own && (seen.id === null || own.id > seen.id) ? own
    : above.length ? delAt(above, seen.id === null ? { newest: true } : { after: seen.id }) : null
  if (!first) return null
  let cur = rel
  let ev: Ev | null = first
  let moved: Ev | null = null
  for (let n = 0; ev && n < HOPS; n++) {
    const d = parse(ev.detail)
    const rest = cur.slice(ev.path.length)
    let after = ev.id
    // the newest move is the one named (who put it where it is now)
    if (typeof d.movedTo === 'string') { moved = ev; cur = d.movedTo + rest }
    else if (typeof d.trashId === 'string') {
      const back = restored(d.trashId, ev.id)
      if (!back) return { kind: 'trashed', by: ev.user_id, at: ev.at }
      cur = back.path + rest
      after = back.id
    } else return moved ? { kind: 'moved', to: cur, by: moved.user_id, at: moved.at } : null
    ev = delAt(selfAndAbove(cur), { after })
  }
  return moved ? { kind: 'moved', to: cur, by: moved.user_id, at: moved.at } : null
}

/** What a person may be told about a path that is not there: null when the path is there, cannot be read as a team
 * path, nothing is recorded, or its folder is not one they may list now (a hidden place tells nothing). `to` is given
 * only when they may read the file where it is now; `byName`: the mover's name as the team sees it. */
export type MovedFact = { kind: 'moved'; to: string | null; by: string; byName: string; at: string } | { kind: 'trashed'; by: string; byName: string; at: string }

export function movedFact(db: Database, fx: FsCtx, rules: RuleSet, user: Principal, input: string, o: { folder?: boolean } = {}): MovedFact | null {
  let segs: string[]
  try { segs = parseInput(input).map((s) => s.normalize('NFC')) } catch { return null }
  if (!segs.length) return null
  const rel = segs.join('/')
  try { fs.lstatSync(path.join(fx.root, ...segs)); return null } catch {}
  // the place it was must be one this person may read by today's rules (the folder above may itself have moved away, so
  // the rules are asked, not the disk; a folder hidden in this call is 'none' there: policy/access.ts hiddenNow)
  if (segs.length > 1 && !rules.canList(user, segs.slice(0, -1))) return null
  if (!atLeast(rules.access(user, segs), 'read')) return null
  const w = whereNow(db, rel)
  if (!w) return null
  const byName = (db.query('SELECT name FROM users WHERE id = ?').get(w.by) as { name: string } | null)?.name ?? ''
  if (w.kind === 'trashed') return { ...w, byName }
  // not where the moves lead (deleted for good there, renamed by a command): nothing is told, rather than a wrong fact
  let st: fs.Stats
  try { st = fs.lstatSync(path.join(fx.root, ...w.to.split('/'))) } catch { return null }
  if (o.folder ? !st.isDirectory() : !st.isFile()) return null
  let to: string | null = null
  try { const r = authorize(fx, rules, user, w.to, 'read'); if (r.exists) to = r.rel } catch {}
  return { kind: 'moved', to, by: w.by, byName, at: w.at }
}

/** The path a "not found" refusal names (policy/authorize.ts: `not found or no access: 'x'`, `not found: 'x'`). */
export function refusedPath(message: string): string | null {
  const m = /not found(?: or no access)?: '([^']+)'/.exec(message)
  return m ? m[1]! : null
}

/** The folder a write's "folder does not exist" names (policy/authorize.ts): a write into a folder that was moved. */
export function refusedFolder(message: string): string | null {
  const m = /folder does not exist: '([^']+)'/.exec(message)
  return m ? m[1]! : null
}

/** The fact for the AI, in its tool result (English, like every tool text): never a guessed cause. */
export function movedNoteForAi(f: MovedFact, old: string, o: { folder?: boolean } = {}): string {
  const who = f.byName || 'someone on the team'
  if (o.folder) {
    if (f.kind === 'trashed') return `the folder '${old}' is not there any more: ${who} put it in the trash on ${f.at.slice(0, 16).replace('T', ' ')} UTC. Say exactly that; do not guess anything else`
    if (f.to) return `the folder '${old}' is not there any more: ${who} moved it to '${f.to}' (moved, not deleted). Its files are there now: use '${f.to}/…' paths`
    return `the folder '${old}' is not there any more: ${who} moved it to a place this person cannot open now. Say that; never say it was deleted`
  }
  const when = f.at.slice(0, 16).replace('T', ' ') + ' UTC'
  if (f.kind === 'trashed') return `'${old}' is not there any more: ${who} put it in the trash on ${when}. Say exactly that; do not guess anything else`
  if (f.to) return `'${old}' is not there any more: ${who} moved it to '${f.to}' on ${when} (moved, not deleted). Use '${f.to}' for this file from now on: an edit there saves a new version of it. Tell the person where it is now`
  return `'${old}' is not there any more: ${who} moved it on ${when} to a place this person cannot open now. Say that it was moved and that they cannot open it where it is; never say it was deleted`
}
