// Chats made with "Continue in a new chat" under the chat they came from in the Trina history, like the Claude app's
// session list (docs/decisions/20261127-fork-in-history.md, which replaced the date rule of 20261126-chat-fork-tree.md),
// kept plain for people who are not developers: one level of indent only (a continuation of a continuation sits at the
// same level, right under the first chat), one small "└" in front, no arrows and no folding. One rule makes the tree of
// any one list (the history by date or in one list, one of my sections, a project's page): a row sits under the nearest
// of its Chat.forkParents that is a row of the same list, whatever date that chat is from, else it is a row of its own
// there. So a chat that is deleted, hidden, pinned (pins are a flat list of their own), in another section, filtered
// out, no longer mine to open or not loaded hands its continuations up, with nothing kept anywhere else.
//
// Order, as the Claude app: a tree sits where its first chat sits in the list's order, in that chat's date group, and
// its continuations follow right under it in the list's own order. Nothing moves an older chat up: a continuation used
// today while its chat is from last week sits under that chat, in last week's group.
import type { Chat } from '@mycel/shared/api'

export interface TreeRow {
  chat: Chat
  /** 0: a row of its own; 1: under the chat it came from */
  depth: 0 | 1
  /** how many rows sit under it (a top row of a tree) */
  under: number
  /** the top row of its tree (itself for a row of its own) */
  top: Chat
}

/**
 * The rows of one list in order, each tree at its first chat's place (a list grouped by date puts a continuation in
 * the group of the row it sits under: DateGroups).
 */
export function forkRows(chats: readonly Chat[]): TreeRow[] {
  const at = new Set(chats.map((c) => c.id))
  const parentOf = new Map<string, string>()
  for (const c of chats) {
    const p = c.forkParents?.find((id) => id !== c.id && at.has(id))
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
    out.push({ chat: c, depth: 0, under: under.length, top: c })
    for (const k of under) out.push({ chat: k, depth: 1, under: 0, top: c })
  }
  return out
}
