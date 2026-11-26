// Chats made with "Continue in a new chat" under the chat they came from in the Trina history, like the Claude app's
// session list, kept plain for people who are not developers (docs/decisions/20261126-chat-fork-tree.md): one level of
// indent only (a continuation of a continuation sits at the same level, right under the first chat), no arrows and no
// folding. One rule makes the tree of any one list (the history by date or in one list, one of my sections): a row sits
// under the nearest of its Chat.forkParents that is a row of the same list and the same date group, else it is a row
// of its own there. So a chat that is deleted, hidden, pinned (pins are a flat list of their own), in another section,
// filtered out, no longer mine to open, not loaded yet, or in another date hands its continuations up, with nothing
// kept anywhere else.
//
// Order: every chat keeps its own place. A tree sits where its first chat sits in the list's order, and its
// continuations follow right under it in their own order. Nothing moves an older chat up: using a continuation never
// lifts the chat it came from (a continuation used today while its chat is older simply stands in Today on its own).
import type { Chat } from '@mycel/shared/api'

export interface TreeRow {
  chat: Chat
  /** 0: a row of its own; 1: under the chat it came from */
  depth: 0 | 1
  /** how many rows sit under it (a top row of a tree) */
  under: number
}

/**
 * The rows of one list in order, each tree at its first chat's place. `group(c)`: the date group a chat is in (a chat
 * sits under another only in the same group); none: one group.
 */
export function forkRows(chats: readonly Chat[], o: { group?: (c: Chat) => string } = {}): TreeRow[] {
  const at = new Map<string, number>()
  chats.forEach((c, i) => { if (!at.has(c.id)) at.set(c.id, i) })
  const byId = new Map(chats.map((c) => [c.id, c]))
  const groupOf = (c: Chat) => o.group?.(c) ?? ''
  const parentOf = new Map<string, string>()
  for (const c of chats) {
    const p = c.forkParents?.find((id) => id !== c.id && at.has(id) && groupOf(byId.get(id)!) === groupOf(c))
    if (p) parentOf.set(c.id, p)
  }
  // the first chat of each one's chain (a loop, only from data made by hand, stands on its own)
  const topOf = (id: string): string => {
    const seen = new Set<string>([id])
    let x = id
    for (let p = parentOf.get(x); p; p = parentOf.get(x)) {
      if (seen.has(p)) return id
      seen.add(p)
      x = p
    }
    return x
  }
  const kids = new Map<string, Chat[]>()
  for (const c of chats) {
    const t = topOf(c.id)
    if (t !== c.id) kids.set(t, [...(kids.get(t) ?? []), c])
  }
  const out: TreeRow[] = []
  for (const c of chats) {
    if (topOf(c.id) !== c.id) continue
    const under = kids.get(c.id) ?? []
    out.push({ chat: c, depth: 0, under: under.length })
    for (const k of under) out.push({ chat: k, depth: 1, under: 0 })
  }
  return out
}
