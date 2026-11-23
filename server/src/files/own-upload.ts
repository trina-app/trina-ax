// Is this file the person's own upload? (review of #448.) A signature or seal goes into a document without a card only
// when the person put that very file here themselves; where a file lies now proves nothing, because an AI tool can copy
// the company's seal into users/<them>/ or into the chat first. Decided from what is stored, so it holds across answers.
// Anything else, or an origin that cannot be told, is false: the caller asks on a card.
import type { Database } from 'bun:sqlite'

/** in a file event's detail: the person's own upload from their app (never a connector's or an AI tool's) */
export const BY_PERSON = { byPerson: true } as const

export type OwnUploadRef =
  /** a team file; `sha256` of the bytes about to be used */
  | { team: string; sha256: string }
  /** a file of a chat, by the id of the version about to be used */
  | { chatFile: string }

export function isOwnUpload(db: Database, userId: string, ref: OwnUploadRef): boolean {
  try {
    if ('team' in ref) {
      if (!ref.team.startsWith(`users/${userId}/`)) return false
      const ev = db.query("SELECT action, turn_id, user_id, sha256, detail FROM file_events WHERE path = ? AND action <> 'rejected' ORDER BY id DESC LIMIT 1").get(ref.team) as { action: string; turn_id: string | null; user_id: string; sha256: string | null; detail: string | null } | null
      if (!ev || ev.action !== 'upload' || ev.turn_id !== null || ev.user_id !== userId || ev.sha256 !== ref.sha256) return false
      return (JSON.parse(ev.detail ?? '{}') as { byPerson?: unknown }).byPerson === true
    }
    const f = db.query('SELECT chat_id, user_id, origin, copied_from, root_id, replaces FROM chat_files WHERE id = ?').get(ref.chatFile) as { chat_id: string; user_id: string; origin: string | null; copied_from: string | null; root_id: string | null; replaces: string | null } | null
    if (!f || f.user_id !== userId || f.origin !== null || f.copied_from !== null || f.root_id !== null || f.replaces !== null) return false
    // an AI's file is stored like an upload and told apart by the message that carries it: the person's, and no answer
    const roles = (db.query("SELECT DISTINCT m.role FROM messages m, json_each(m.attachments) j WHERE m.chat_id = ? AND json_valid(m.attachments) AND json_extract(j.value, '$.id') = ?").all(f.chat_id, ref.chatFile) as { role: string }[]).map((r) => r.role)
    return roles.length === 1 && roles[0] === 'user'
  } catch { return false }
}
