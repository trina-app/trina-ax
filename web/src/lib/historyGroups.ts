// Trina history grouped by project (docs/DECISIONS.md "Trina history by project"), like the Claude Code desktop app's
// history: one group per project the person has chats in, newest activity first, and the chats in no project (or in a
// project the person can no longer see: the chat page shows no project for them either) last, as "Other chats". Pure:
// no React, no stores; components/history/HistoryGroups.tsx draws it (the Trina panel's filtered history: every project
// and every row), test/unit/history-groups.test.ts checks it.
import type { Chat } from '@mycel/shared/api'
import { markerOf, type Marker, type MarkerView } from './sessionMarkers'

/** the key of the group of chats in no project, and in projects the person cannot see (a project's key is its id) */
export const OTHER = 'other'

export interface HistoryGroup {
  /** the project's id, or OTHER */
  key: string
  /** the project the person sees, or null for the other chats */
  projectId: string | null
  /** in the order they came in (the caller's sort) */
  chats: Chat[]
}

const newest = (g: HistoryGroup) => g.chats.reduce((m, c) => (c.updatedAt > m ? c.updatedAt : m), '')

/**
 * The chats by the project the person sees (`sees`), each group's chats in the order given. Projects by the newest
 * activity in them (whatever the rows' own sort), the other chats last. Pinned chats are the caller's (they stay on
 * top, outside the groups).
 */
export function groupByProject(chats: readonly Chat[], sees: (projectId: string) => boolean): HistoryGroup[] {
  const projects = new Map<string, HistoryGroup>()
  const other: HistoryGroup = { key: OTHER, projectId: null, chats: [] }
  for (const c of chats) {
    const id = c.projectId && sees(c.projectId) ? c.projectId : null
    if (!id) {
      other.chats.push(c)
      continue
    }
    let g = projects.get(id)
    if (!g) projects.set(id, (g = { key: id, projectId: id, chats: [] }))
    g.chats.push(c)
  }
  const sorted = [...projects.values()].map((g) => ({ g, at: newest(g) })).sort((a, b) => b.at.localeCompare(a.at)).map((x) => x.g)
  return other.chats.length ? [...sorted, other] : sorted
}

/** Some group is a project's: else the list has no headers at all (a person who keeps no chat in a project). */
export const hasProjects = (groups: readonly HistoryGroup[]) => groups.some((g) => g.projectId !== null)

/**
 * The one mark for chats out of sight (a folded group's header): "?" first, then the new-answer
 * dot, then the ring. What needs the person comes before what only runs, so a folded group never hides a chat that
 * waits; the chat is returned for the mark's words.
 */
export function strongestMark(chats: readonly Chat[], view: (c: Chat) => MarkerView): { marker: Marker; chat: Chat } | null {
  let best: { marker: Marker; chat: Chat } | null = null
  const rank = (m: Marker) => (m.kind === 'ask' ? 3 : m.kind === 'new' ? 2 : 1)
  for (const c of chats) {
    const m = markerOf(c, view(c))
    if (m && (!best || rank(m) > rank(best.marker))) best = { marker: m, chat: c }
  }
  return best
}
