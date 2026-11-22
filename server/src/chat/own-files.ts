// The AI's own files of a chat (docs/decisions/20261121-ai-scratch-files.md): what delete_files may put in the trash
// without a card, also in a shared project chat. On potenlab.trina.app the AI made 13,000 scratch files in a project
// folder and then said it could not delete them (delete_files is refused in a shared project chat and stops at 200).
//
// A planned item is the AI's own when the file history and the disk agree that this person's answers in this chat made
// all of it and nobody else touched it:
// - its recorded history (file_events of the item and everything below it) starts with a create, and every row is a
//   create, update or delete by a turn of this chat and of this person, never a move in (movedFrom: someone's file
//   brought here), a restore, an upload, a conflict or a change whose author the server did not know;
// - every file on disk below it has such a history, except files under a folder the dev environment does not record
//   (node_modules, .venv, … : devenv/snapshot.ts skipName) that was born after the item's first recorded create (made
//   by the same commands). An old file whose history was pruned has none, so it keeps the item from being "own".
// Anything else keeps delete_files' normal rules (the card, and no delete in a shared project chat).
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AiTrashPlan } from '../team-files/service'
import { skipName } from '../devenv/snapshot'

/** At most this many entries per delete_files call of the AI's own files (the items and everything in them). */
export const OWN_TRASH_MAX_ENTRIES = 50_000
/** a skipped folder (node_modules …) counts as made by the same commands when born at most this long before the
 * item's first recorded create (a command that made the folder first and its recorded files a moment later) */
const BORN_SLACK_MS = 60_000

type Row = { path: string; action: string; user_id: string; detail: string | null; at: string; chat_id: string | null }

const OWN_ACTIONS = new Set(['create', 'update', 'delete'])

function rowOwn(r: Row, userId: string, chatId: string): boolean {
  if (r.user_id !== userId || r.chat_id !== chatId || !OWN_ACTIONS.has(r.action)) return false
  if (!r.detail) return true
  try {
    const d = JSON.parse(r.detail) as Record<string, unknown>
    // a change found between commands (a job, a dev server: devenv/track.ts) is put on the last command's person, who
    // may not have made it
    return typeof d.movedFrom !== 'string' && !d.actorUnknown && !d.background && typeof d.conflictOf !== 'string' && typeof d.conflictCopyOf !== 'string'
  } catch { return false }
}

/**
 * Is every item of the plan the AI's own in this chat (see the head of this file)? `why`: the first item that is not,
 * for the audit line. Reads the history and lstat only.
 */
/** The recorded history of `rel` and everything below it, when all of it is this person's in this chat (the first half
 * of ownMade, without the disk: cheap, so a path that is not own is told before anything is walked). */
export function ownHistory(db: Database, o: { userId: string; chatId: string }, rel: string): { own: true; firstAt: number; recorded: Set<string> } | { own: false; why: string } {
  // the item and everything below it: "<rel>/" up to "<rel>0" ('0' follows '/')
  const rows = db.query('SELECT e.path, e.action, e.user_id, e.detail, e.at, t.chat_id FROM file_events e LEFT JOIN turns t ON t.id = e.turn_id WHERE e.path = ? OR (e.path >= ? AND e.path < ?) ORDER BY e.id').all(rel, rel + '/', rel + '0') as Row[]
  if (!rows.length) return { own: false, why: `${rel}: no recorded history` }
  if (rows[0]!.action !== 'create') return { own: false, why: `${rel}: its history does not start with a create` }
  const bad = rows.find((r) => !rowOwn(r, o.userId, o.chatId))
  if (bad) return { own: false, why: `${rel}: ${bad.path} was changed by someone else or outside this chat` }
  return { own: true, firstAt: Date.parse(rows[0]!.at), recorded: new Set(rows.map((r) => r.path)) }
}

export function ownMade(db: Database, teamRoot: string, o: { userId: string; chatId: string }, plan: Pick<AiTrashPlan, 'items'>): { own: true } | { own: false; why: string } {
  if (!plan.items.length) return { own: false, why: 'nothing planned' }
  for (const item of plan.items) {
    const hist = ownHistory(db, o, item.rel)
    if (!hist.own) return hist
    const { firstAt, recorded } = hist
    const born = new Map<string, boolean>()
    const bornLater = (rel: string) => {
      let b = born.get(rel)
      if (b === undefined) {
        try { const st = fs.lstatSync(path.join(teamRoot, ...rel.split('/'))); b = st.isDirectory() && st.birthtimeMs > 0 && st.birthtimeMs >= firstAt - BORN_SLACK_MS } catch { b = false }
        born.set(rel, b)
      }
      return b
    }
    for (const e of item.entries) {
      if (e.kind === 'dir') continue
      const full = e.rel ? `${item.rel}/${e.rel}` : item.rel
      if (recorded.has(full)) continue
      // a file the dev environment does not record: only inside a skipped folder born with the item's files
      const segs = e.rel.split('/')
      const at = segs.findIndex((s, i) => i < segs.length - 1 && skipName(s))
      if (at < 0 || !bornLater(`${item.rel}/${segs.slice(0, at + 1).join('/')}`)) return { own: false, why: `${item.rel}: ${full} has no history of this chat` }
    }
  }
  return { own: true }
}

/**
 * An empty folder this person's answers in this chat made (QA TC-ask2-12: the AI made a folder, moved what it put there
 * elsewhere, and its delete of the empty folder asked "0 files … 16 people will no longer see it"): nothing but folders
 * on disk inside it (no file, link or other entry, at any depth), and the folder itself made here: its own recorded
 * history at its exact path starts with a create and every row there is this person's in this chat (rowOwn: never moved
 * in, never someone's restore or conflict); with no row at its path (a folder `write` made on the way to a file), the
 * first row of anything below it is such a create and the folder was born then (lstat birth time, the ownMade slack).
 * Every folder inside has no row by anyone else at its path. History of files that were inside and are gone is not
 * read: nothing of them goes to the trash. Fails closed.
 */
export function emptyFolderMadeHere(db: Database, teamRoot: string, o: { userId: string; chatId: string }, item: Pick<AiTrashPlan['items'][number], 'rel' | 'kind' | 'files' | 'entries'>): boolean {
  try {
    if (item.kind !== 'folder' || item.files !== 0 || !item.entries.length || item.entries.some((e) => e.kind !== 'dir')) return false
    const at = (p: string) => db.query('SELECT e.path, e.action, e.user_id, e.detail, e.at, t.chat_id FROM file_events e LEFT JOIN turns t ON t.id = e.turn_id WHERE e.path = ? ORDER BY e.id').all(p) as Row[]
    const own = (rows: Row[]) => rows.every((r) => rowOwn(r, o.userId, o.chatId))
    const rows = at(item.rel)
    if (rows.length) {
      if (rows[0]!.action !== 'create' || !own(rows)) return false
    } else {
      const first = db.query('SELECT e.path, e.action, e.user_id, e.detail, e.at, t.chat_id FROM file_events e LEFT JOIN turns t ON t.id = e.turn_id WHERE e.path >= ? AND e.path < ? ORDER BY e.id LIMIT 1').get(item.rel + '/', item.rel + '0') as Row | null
      if (!first || first.action !== 'create' || !rowOwn(first, o.userId, o.chatId)) return false
      const st = fs.lstatSync(path.join(teamRoot, ...item.rel.split('/')))
      if (!(st.isDirectory() && st.birthtimeMs > 0 && st.birthtimeMs >= Date.parse(first.at) - BORN_SLACK_MS)) return false
    }
    for (const e of item.entries) if (e.rel && !own(at(`${item.rel}/${e.rel}`))) return false
    return true
  } catch { return false }
}
