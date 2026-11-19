// A scheduled run in a shared chat (docs/decisions/20261118-shared-schedules-any-frequency.md, security review of #1353):
// the run is a turn of its maker in that chat, and nobody watches it. Other people's messages on its branch are in its
// transcript and could steer it, so such a run gets none of the maker's standing yeses (Always allow), sends nothing to a
// connected service, and writes files only in the task's save folder or the maker's own folder. When every user message
// on the run's branch is the maker's own, nobody else could have steered it, and it runs like any of their runs.
import type { Database } from 'bun:sqlite'
import { isSharedRow } from './shared'

/** A scheduled run in a shared chat whose branch holds a message someone other than its maker wrote (by the run's
 * turn id). Fails closed: a turn or chat it cannot read counts as steerable when the turn is a scheduled one. */
export function steerableRun(db: Database, turnId: string | null | undefined): boolean {
  if (!turnId) return false
  const t = db.query(`SELECT t.client_kind, t.user_id, t.user_message_id, c.shared_at, c.project_id, c.people_shared_at
    FROM turns t LEFT JOIN chats c ON c.id = t.chat_id WHERE t.id = ?`).get(turnId) as
    { client_kind: string | null; user_id: string; user_message_id: string | null; shared_at: string | null; project_id: string | null; people_shared_at: string | null } | null
  if (!t || t.client_kind !== 'schedule') return false
  // (a chat made private again keeps the earlier messages of the people it was shared with: weighed the same way, so
  // the chat's state now does not matter; a chat nobody else ever wrote in has none)
  void isSharedRow
  // the branch from the run's own message up to the first one (its parents)
  const seen = new Set<string>()
  let id = t.user_message_id
  for (let i = 0; id && i < 100_000; i++) {
    if (seen.has(id)) return true
    seen.add(id)
    const m = db.query('SELECT parent_id, role, author_id FROM messages WHERE id = ?').get(id) as { parent_id: string | null; role: string; author_id: string | null } | null
    if (!m) return true
    if (m.role === 'user' && m.author_id !== t.user_id) return true
    id = m.parent_id
  }
  return !t.user_message_id
}

/** The in-place file changers: with no write-target argument given, the file they name is the one they change. */
const MOVES: ReadonlySet<string> = new Set(['move_files', 'rename_file'])

/**
 * Where a steerable run (steerableRun) may write (security review of #1353, M1): only in its task's save folder (as its
 * card showed it, while it has not lapsed) and the maker's own folder. Returns the refusal for the AI, or null to go on.
 * A call's write targets are its WRITE_TARGET_ARGS (a tool that names none of them changes the files it names in place);
 * a move or rename also changes where its sources were, so those count too. Not a write tool: null.
 */
export function steerableWriteRefusal(db: Database, turnId: string | null | undefined, tool: string, input: unknown,
  o: { writeArgs: Readonly<Record<string, readonly string[]>>; named: (tool: string, input: unknown) => { key: string; value: string }[]; inPlace: ReadonlySet<string> }): string | null {
  const keys = o.writeArgs[tool]
  if (!keys && !o.inPlace.has(tool)) return null
  if (!steerableRun(db, turnId)) return null
  const named = o.named(tool, input)
  const targets = MOVES.has(tool) || !keys || !named.some((n) => keys.includes(n.key)) ? named : named.filter((n) => keys.includes(n.key))
  const run = db.query(`SELECT t.user_id, s.save_folder, s.save_lapsed_at FROM turns t LEFT JOIN schedules s ON s.id = t.schedule_id WHERE t.id = ?`).get(turnId!) as
    { user_id: string; save_folder: string | null; save_lapsed_at: string | null } | null
  if (!run) return 'Not written: this run could not be checked.'
  const norm = (p: string) => p.normalize('NFC').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.')
  const roots = [norm(`users/${run.user_id}`), ...(run.save_folder && !run.save_lapsed_at ? [norm(run.save_folder)] : [])]
  const fold = (x: string) => x.toLowerCase()
  const inside = (p: string) => {
    const segs = norm(p)
    if (segs.includes('..')) return false
    return roots.some((r) => r.length && r.length <= segs.length && r.every((x, i) => fold(x) === fold(segs[i]!)))
  }
  // rename_file's new name is a name in the same folder, not a path
  const outside = targets.filter((n) => !(tool === 'rename_file' && n.key === 'new_name') && !inside(n.value))
  if (!outside.length && targets.length) return null
  if (!targets.length) return null
  const where = run.save_folder && !run.save_lapsed_at ? `the task's save folder ${run.save_folder} or the user's own folder users/${run.user_id}/` : `the user's own folder users/${run.user_id}/`
  return `Not written (${tool}): this scheduled run is in a shared chat where other people wrote, so it writes only in ${where}. Nothing was changed. Save there instead, and say in the summary where the result is.`
}
