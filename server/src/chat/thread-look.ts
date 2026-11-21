// A thread as the person asking may see it now (chat/share-words.ts threadOptionWords, QA TC-4054): who started it and
// its first words, read from the room's own record with the rooms' own checks (a room they are in, a message they see,
// one that can have a thread, not deleted). Anything else reads as nothing: the option keeps the AI's label.
import type { AppContext } from '../context'
import { roomsOf } from '../rooms/service'
import type { ThreadLook } from './share-words'

export function threadLook(ctx: AppContext, userId: string): ThreadLook {
  return (roomId, id) => {
    try {
      const rooms = roomsOf(ctx)
      const { me } = rooms.mine(userId, roomId)
      const root = rooms.threadRootOf(roomId, id, me)
      if (!root) return null
      // a person's message by its author; an AI answer someone sent here by the person who sent it
      const who = root.author_kind === 'user' ? root.author_id : root.asked_by
      const name = who ? (ctx.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(who) as { name: string } | null)?.name : null
      if (!name) return null
      return { author: name.replace(/\s+/g, ' ').trim().slice(0, 60), body: root.body.slice(root.answer_at ?? 0) || root.body }
    } catch {
      return null
    }
  }
}
