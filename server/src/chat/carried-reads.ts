// The AI's file reads last for the chat, not one answer (docs/decisions/20261118-read-state-for-the-chat.md).
// Claude Code keeps the files it read for the whole session; here every answer started with none, so "change the report
// you read" in a later message had to read it again, write/edit refused with "read it first" and make_file saved
// "report (2).docx" next to it. A turn's reads (TurnFiles.allReads: path -> the sha256 of the version its AI last saw,
// sub-agents included) are kept under its answer, its person and its engine session; the next turn of the SAME person
// gets the ones of the answers above its message on that branch (newest first wins). They are used only while the file
// is still that version and the person may read it now (files/service.ts ReadHashes; a changed file asks for a new
// read). A whole-file replace (write, make_file) counts one only inside the engine session that read it, which still
// holds the text; a fresh session (Codex, a lost or oversized stash, an engine switch) may only edit from it.
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import type { FileService, CarriedReads } from '../files/service'
import { authorize } from '../policy/authorize'
import { sha256Regular } from '../files/store'
import { readMaxBytes } from '../system/limits'
import { isGuestUser } from '../credentials/guest-ai'

/** whether a turn keeps and gets earlier reads: never a guest's (their reads stay per answer, the tighter limits) nor a
 * restricted run's (a profile or skill draft, a share judge: chat/turn.ts restricted) */
export const mayCarryReads = (db: Database, userId: string, restricted: boolean): boolean => !restricted && !isGuestUser(db, userId)

/** the most paths one answer keeps (its newest); past it the next answer reads the others again, as before */
export const CARRIED_READS_PER_ANSWER = 2000
/** the most rows one chat keeps (its newest; older answers' reads are dropped first) */
export const CARRIED_READS_PER_CHAT = 20_000

/** Claude Code's session file marks a compaction with a system line {"subtype":"compact_boundary"} (the text before it
 * is summarized away) and a micro-compaction, which clears old tool results such as file text, with
 * {"subtype":"microcompact_boundary"} (both strings checked in the shipped 2.1.327 binary, 2026-11-18) */
export const compactionsIn = (stash: Uint8Array): number => Buffer.from(stash).toString('latin1').match(/"(?:micro)?compact_boundary"/g)?.length ?? 0

/** The session this turn saves no longer holds all it saw: Claude Code compacted it in this turn (more boundary lines
 * than the stash it resumed), or the stash was slimmed (chat/session-slim.ts took pictures out of older turns) */
export const sessionDroppedText = (o: { bytes: Uint8Array; compactionsBefore: number; slimmed: number }): boolean =>
  o.slimmed > 0 || compactionsIn(o.bytes) > o.compactionsBefore

/** The chat's engine session no longer holds the text of what its earlier answers read (a compaction, a slimmed
 * stash): their reads stay usable for edits, never again for a whole-file replace. */
export function forgetSessionText(db: Database, chatId: string) {
  db.query('UPDATE chat_reads SET session_id = NULL WHERE chat_id = ? AND session_id IS NOT NULL').run(chatId)
}

/** Keep what a finished turn's AI read or saved, under its answer (a turn that goes on with the same answer adds to
 * it; a path's newer hash replaces the older one). `reads` in the order they were last set (newest last). */
export function saveReads(db: Database, o: { chatId: string; messageId: string; userId: string }, reads: ReadonlyMap<string, string>, sessions: ReadonlyMap<string, string | null>) {
  const newest = [...reads].slice(-CARRIED_READS_PER_ANSWER)
  db.transaction(() => {
    const ins = db.query('INSERT OR REPLACE INTO chat_reads (chat_id, message_id, user_id, session_id, path, sha256) VALUES (?,?,?,?,?,?)')
    for (const [p, sha] of newest) ins.run(o.chatId, o.messageId, o.userId, sessions.get(p) ?? null, p, sha)
    db.query('DELETE FROM chat_reads WHERE chat_id = ?1 AND id NOT IN (SELECT id FROM chat_reads WHERE chat_id = ?1 ORDER BY id DESC LIMIT ?2)').run(o.chatId, CARRIED_READS_PER_CHAT)
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
  const rows = db.query('SELECT message_id, session_id, path, sha256 FROM chat_reads WHERE chat_id = ? AND user_id = ? AND message_id IN (SELECT value FROM json_each(?))')
    .all(o.chatId, o.userId, JSON.stringify(o.answers)) as { message_id: string; session_id: string | null; path: string; sha256: string }[]
  const best = new Map<string, { at: number; sha: string; session: string | null }>()
  for (const r of rows) {
    const at = order.get(r.message_id)!
    const b = best.get(r.path)
    if (!b || at > b.at) best.set(r.path, { at, sha: r.sha256, session: r.session_id })
  }
  if (!best.size) return null
  const hashes = new Map([...best].map(([p, b]) => [p, b.sha]))
  // a file's hash now, kept while its lstat stays the same (one call checks it several times: has, then get)
  const memo = new Map<string, { key: string; sha: string }>()
  let session: string | null = null
  return {
    hashes,
    inSession(sid) { session = sid },
    wholeFile(rel) { const b = best.get(rel); return !!b && !!session && b.session === session },
    // now, with the person's current permissions and folder rules: one who lost the file gets nothing from the read
    current(rel) {
      try {
        const r = authorize(files.fx, files.rules(), files.principal(o.userId), rel, 'read', { mustExist: true })
        if (!r.st!.isFile() || r.st!.size > readMaxBytes()) return null
        const st = fs.lstatSync(r.abs, { bigint: true })
        const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
        const m = memo.get(rel)
        if (m?.key === key) return m.sha
        const sha = sha256Regular(r.abs, r.st)
        memo.set(rel, { key, sha })
        return sha
      } catch { return null }
    },
  }
}
