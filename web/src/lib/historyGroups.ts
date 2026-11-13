// Trina history grouped by project (docs/DECISIONS.md "Trina history by project"), like the Claude Code desktop app's
// sidebar: one group per project the person has chats in, newest activity first, and the chats in no project (or in a
// project the person can no longer see: the chat page shows no project for them either) last, as "Other chats". Pure:
// no React, no stores; components/history/HistoryGroups.tsx draws it, test/unit/history-groups.test.ts checks it.
//
// The caps are the caller's: where the list shares a column with the rooms (the computer's sidebar) at most a few
// projects and a few rows each, the rest one press away; as a whole panel (the phone's drawer, "Show all") every project
// and every row.
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

/** One group as shown: the rows in sight and the ones behind its "N more". */
export interface ShownGroup extends HistoryGroup {
  rows: Chat[]
  hidden: Chat[]
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

export interface Caps {
  /** project groups in sight (the other chats always are); undefined: all */
  projects?: number
  /** rows in sight per group before its "N more"; undefined: all */
  rows?: number
  /** the chat on screen: always in sight (its group too), like the flat list's sixth row */
  open?: string | null
  /** groups opened in place by their "N more" */
  opened?: ReadonlySet<string>
}

/**
 * The groups in sight and the ones behind "Show all". The project of the chat on screen is in sight even past the cap
 * (after the others, before the other chats), and so is its row past the group's own cap.
 */
export function capGroups(groups: readonly HistoryGroup[], caps: Caps = {}): { shown: ShownGroup[]; behind: HistoryGroup[] } {
  const holds = (g: HistoryGroup) => !!caps.open && g.chats.some((c) => c.id === caps.open)
  const projects = groups.filter((g) => g.projectId !== null)
  const other = groups.find((g) => g.projectId === null)
  const max = caps.projects ?? Infinity
  const inSight = projects.filter((g, i) => i < max || holds(g))
  const behind = projects.filter((g) => !inSight.includes(g))
  const rowsOf = (g: HistoryGroup): ShownGroup => {
    if (caps.rows === undefined || caps.opened?.has(g.key)) return { ...g, rows: g.chats, hidden: [] }
    const rows = g.chats.filter((c, i) => i < caps.rows! || c.id === caps.open)
    return { ...g, rows, hidden: g.chats.filter((c) => !rows.includes(c)) }
  }
  return { shown: [...inSight, ...(other ? [other] : [])].map(rowsOf), behind }
}

/**
 * The one mark for chats out of sight (a folded group's header, a group's "N more"): "?" first, then the new-answer
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
