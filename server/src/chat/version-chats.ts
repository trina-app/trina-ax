// The AI chat that saved a file's version, for the version history's "Open the chat" (docs/DECISIONS.md "Getting back
// to earlier work, part A"). A version (and the file as it is now) knows the AI turn of the save (file_versions.
// saved_turn_id, file_events.turn_id); the turn knows its chat (turns.chat_id). The chat's id goes out only when the
// viewer may open that chat now, by the rule every chat route uses (chatFor 'view': their own chat, or a shared project
// chat of a project they see now), and not when:
//   - it is in the trash (Deleted history) or gone for good;
//   - it is in a project they do not see now, their own chat too (stricter than opening it: the link stays away from a
//     project they lost; the chat still opens from their history);
//   - it is the server's own draft (chat/internal-chats.ts), or a room's AI (chatFor never opens those);
//   - it is confidential and not theirs (safe operations 1A);
//   - the answer of that turn is hidden from them in a shared chat (chat/shared-answers.ts: nothing of it anywhere).
// Anything else, a failed check included, gives nothing: no id, so the history says no more than it did ("by AI").
import type { ChatRuntime } from './runtime'
import { chatFor, isSharedRow, projectSeenByAll, severalAuthors } from './shared'
import { AnswerSight } from './shared-answers'
import { isInternalChat } from './internal-chats'
import { confidentialChat } from '../safe-ops/confidential'

interface TurnRow { id: string; chat_id: string; user_id: string; message_id: string | null }

/** For each of these turns whose chat `viewer` may open now: turn id -> chat id. Turns of chats they may not open are
 * absent. One read of the turns, one check per chat. */
export function openableTurnChats(rt: ChatRuntime, viewer: string, turnIds: Iterable<string | null | undefined>): Map<string, string> {
  const out = new Map<string, string>()
  const ids = [...new Set([...turnIds].filter((x): x is string => !!x))]
  if (!ids.length) return out
  const turns = rt.db.query('SELECT id, chat_id, user_id, message_id FROM turns WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as TurnRow[]
  const chats = new Map<string, { several: boolean } | null>()
  let sight: AnswerSight | null = null
  for (const t of turns) {
    let c = chats.get(t.chat_id)
    if (c === undefined) chats.set(t.chat_id, (c = opens(rt, viewer, t.chat_id)))
    if (!c) continue
    // a shared chat (or one that was, with other people's answers): the answer of this turn as the viewer sees it. Its
    // runner always sees it; anyone else not when it is hidden from them, or when the turn names no answer (fails closed)
    if (c.several && t.user_id !== viewer) {
      if (!t.message_id) continue
      sight ??= new AnswerSight(rt.db, rt.files)
      // a check that fails gives no link (and never fails the history)
      try { if (sight.withheld(t.chat_id, viewer).has(t.message_id)) continue } catch { continue }
    }
    out.set(t.id, t.chat_id)
  }
  return out
}

/** May `viewer` open this chat now (and is it a chat of several people)? null: no. */
function opens(rt: ChatRuntime, viewer: string, chatId: string): { several: boolean } | null {
  try {
    // not in the trash: chatFor without `deleted`
    const a = chatFor(rt, viewer, chatId, 'view')
    if (isInternalChat(rt.db, a.row.id)) return null
    // a chat of one person in a project: only while they see the project (chatFor checks a shared chat's project)
    if (!a.shared && a.row.project_id) {
      const p = rt.store.projectRow(a.row.project_id)
      if (!p || !projectSeenByAll(rt.db, rt.files, p, [viewer])) return null
    }
    if (a.row.user_id !== viewer && confidentialChat(rt.db, a.row.id)) return null
    return { several: isSharedRow(a.row) || severalAuthors(rt.db, a.row.id) }
  } catch {
    // the route's own refusals, and anything else: no link
    return null
  }
}
