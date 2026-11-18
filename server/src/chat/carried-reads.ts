// The AI's file reads last for the chat, not one answer (docs/decisions/20261118-read-state-for-the-chat.md).
// Claude Code keeps the files it read for the whole session; here every answer started with none, so "change the report
// you read" in a later message had to read it again, write/edit refused with "read it first" and make_file saved
// "report (2).docx" next to it. A turn's reads (TurnFiles.allReads: path -> the sha256 of the version its AI last saw,
// sub-agents included) are kept under its answer; the next turn of the SAME person gets the ones of the answers above
// its message on that branch (newest first wins). They are used only while the file is still that version and the
// person may read it now (files/service.ts ReadHashes; a changed file asks for a new read).
import type { Database } from 'bun:sqlite'
import type { FileService, CarriedReads } from '../files/service'
import { authorize } from '../policy/authorize'
import { sha256Regular } from '../files/store'
import { readMaxBytes } from '../system/limits'

/** the most paths one answer keeps; past it the next answer reads the others again, as before */
export const CARRIED_READS_PER_ANSWER = 2000

/** Keep what a finished turn's AI read or saved, under its answer (a turn that goes on with the same answer adds to
 * it; a path's newer hash replaces the older one). */
export function saveReads(db: Database, o: { chatId: string; messageId: string; userId: string }, reads: ReadonlyMap<string, string>) {
  db.transaction(() => {
    let n = 0
    const ins = db.query('INSERT OR REPLACE INTO chat_reads (chat_id, message_id, user_id, path, sha256) VALUES (?,?,?,?,?)')
    for (const [p, sha] of reads) {
      if (n++ >= CARRIED_READS_PER_ANSWER) break
      ins.run(o.chatId, o.messageId, o.userId, p, sha)
    }
  })()
}

/**
 * The person's reads of the answers above a new message, for its turn. `answers`: the ids of the assistant messages on
 * the branch above it, oldest first (a regenerated or edited branch never sees the other branch's reads). Only rows of
 * `userId`'s own turns: in a shared chat one person's reads never stand in for another's (their access differs).
 */
export function carriedReads(db: Database, files: FileService, o: { chatId: string; userId: string; answers: readonly string[] }): CarriedReads | null {
  if (!o.answers.length) return null
  const order = new Map(o.answers.map((id, i) => [id, i]))
  const rows = db.query('SELECT message_id, path, sha256 FROM chat_reads WHERE chat_id = ? AND user_id = ?').all(o.chatId, o.userId) as { message_id: string; path: string; sha256: string }[]
  const best = new Map<string, { at: number; sha: string }>()
  for (const r of rows) {
    const at = order.get(r.message_id)
    if (at === undefined) continue
    const b = best.get(r.path)
    if (!b || at > b.at) best.set(r.path, { at, sha: r.sha256 })
  }
  if (!best.size) return null
  const hashes = new Map([...best].map(([p, b]) => [p, b.sha]))
  return {
    hashes,
    // now, with the person's current permissions and folder rules: one who lost the file gets nothing from the read
    current(rel) {
      try {
        const r = authorize(files.fx, files.rules(), files.principal(o.userId), rel, 'read', { mustExist: true })
        if (!r.st!.isFile() || r.st!.size > readMaxBytes()) return null
        return sha256Regular(r.abs, r.st)
      } catch { return null }
    },
  }
}
