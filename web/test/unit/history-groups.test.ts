// Trina history by project (docs/DECISIONS.md "Trina history by project"; lib/historyGroups.ts): the groups and their
// order, the other chats last (and the chats of a project the person no longer sees with them), the caps beside the
// rooms with the chat on screen always in sight, and the one mark of chats out of sight.
import { describe, expect, test } from 'bun:test'
import type { Chat } from '@mycel/shared/api'
import { capGroups, groupByProject, hasProjects, OTHER, strongestMark } from '../../src/lib/historyGroups'

const A = '01900000-0000-7000-8000-00000000aaaa'
const B = '01900000-0000-7000-8000-00000000bbbb'
const C = '01900000-0000-7000-8000-00000000cccc'
const GONE = '01900000-0000-7000-8000-00000000dddd'
const chat = (n: number, projectId: string | null = null, o: Partial<Chat> = {}): Chat => ({
  id: `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`, projectId, title: `chat ${n}`, engine: 'claude-code', model: null,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: `2026-11-01T00:${String(n).padStart(2, '0')}:00.000Z`, deletedAt: null, runState: 'idle', ...o,
})
/** newest first, as the sidebar hands them over */
const newestFirst = (list: Chat[]) => [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
const sees = (id: string) => id !== GONE
const titles = (list: Chat[]) => list.map((c) => c.title)

describe('groupByProject', () => {
  test('one group per project, by the newest activity in it; the other chats last, whatever their age', () => {
    const list = newestFirst([chat(1, A), chat(2, B), chat(3, A), chat(9), chat(4, C), chat(5, B)])
    const groups = groupByProject(list, sees)
    expect(groups.map((g) => g.key)).toEqual([B, C, A, OTHER])
    expect(groups.map((g) => titles(g.chats))).toEqual([['chat 5', 'chat 2'], ['chat 4'], ['chat 3', 'chat 1'], ['chat 9']])
    expect(groups.at(-1)!.projectId).toBeNull()
    expect(hasProjects(groups)).toBe(true)
  })

  test('a project the person can no longer see has no group: its chats are with the other chats (never its name)', () => {
    const groups = groupByProject(newestFirst([chat(1, GONE), chat(2, A), chat(3)]), sees)
    expect(groups.map((g) => g.key)).toEqual([A, OTHER])
    expect(titles(groups[1]!.chats)).toEqual(['chat 3', 'chat 1'])
  })

  test('no chat in a project the person sees: one group, no projects (the plain list, no headers)', () => {
    expect(hasProjects(groupByProject([chat(1), chat(2, GONE)], sees))).toBe(false)
    expect(groupByProject([], sees)).toEqual([])
  })

  test('the rows keep the order given (a sort by title), the projects still go by newest activity', () => {
    const list = [chat(1, A, { title: 'a' }), chat(4, B, { title: 'b' }), chat(2, A, { title: 'c' })]
    const groups = groupByProject(list, sees)
    expect(groups.map((g) => g.key)).toEqual([B, A])
    expect(titles(groups[1]!.chats)).toEqual(['a', 'c'])
  })
})

describe('capGroups', () => {
  // seven projects with four chats each, newest project first (P0), and three other chats
  const projects = Array.from({ length: 7 }, (_, p) => `01900000-0000-7000-8000-0000000000${String(p).padStart(2, '0')}`)
  const list = newestFirst([
    ...projects.flatMap((id, p) => Array.from({ length: 4 }, (_, i) => chat(80 - p * 10 - i, id))),
    chat(1), chat(2), chat(3),
  ])
  const groups = groupByProject(list, () => true)

  test('beside the rooms: the latest five projects and the other chats, three rows each, the rest behind "N more"', () => {
    const { shown, behind } = capGroups(groups, { projects: 5, rows: 3 })
    expect(shown.map((g) => g.key)).toEqual([...projects.slice(0, 5), OTHER])
    expect(behind.map((g) => g.key)).toEqual(projects.slice(5))
    expect(shown[0]!.rows.length).toBe(3)
    expect(shown[0]!.hidden.length).toBe(1)
    expect(titles(shown[0]!.rows)).toEqual(['chat 80', 'chat 79', 'chat 78'])
    // the other chats: three, nothing hidden
    expect(shown.at(-1)!.hidden).toEqual([])
  })

  test('"N more" opens a group in place: all its rows', () => {
    const { shown } = capGroups(groups, { projects: 5, rows: 3, opened: new Set([projects[1]!]) })
    expect(shown[1]!.rows.length).toBe(4)
    expect(shown[1]!.hidden).toEqual([])
    expect(shown[0]!.rows.length).toBe(3)
  })

  test('the chat on screen is always in sight: its row past the cap, its project past the five (before the other chats)', () => {
    const deep = list.find((c) => c.projectId === projects[6] && c.title === 'chat 17')!
    const { shown, behind } = capGroups(groups, { projects: 5, rows: 3, open: deep.id })
    expect(shown.map((g) => g.key)).toEqual([...projects.slice(0, 5), projects[6], OTHER])
    expect(behind.map((g) => g.key)).toEqual([projects[5]])
    expect(titles(shown[5]!.rows)).toEqual(['chat 20', 'chat 19', 'chat 18', 'chat 17'])
  })

  test('a whole panel (no caps): every project, every row', () => {
    const { shown, behind } = capGroups(groups)
    expect(shown.length).toBe(8)
    expect(behind).toEqual([])
    expect(shown.every((g) => g.hidden.length === 0)).toBe(true)
  })
})

describe('strongestMark', () => {
  test('"?" first, then the new-answer dot, then the ring: what needs me before what only runs', () => {
    const running = chat(1, A, { runState: 'running' })
    const fresh = chat(2, A, { unseen: true })
    const waits = chat(3, A, { waiting: true })
    expect(strongestMark([running, fresh], () => ({}))).toEqual({ marker: { kind: 'new', reason: 'new' }, chat: fresh })
    expect(strongestMark([running, fresh, waits], () => ({}))!.chat).toBe(waits)
    expect(strongestMark([running], () => ({}))!.marker.kind).toBe('running')
    // a failed answer not seen is a "?"
    expect(strongestMark([fresh, chat(4, A, { unseen: true, lastOutcome: 'error' })], () => ({}))!.marker).toEqual({ kind: 'ask', reason: 'error' })
  })

  test('as this window sees them: a card here is a "?", the chat on screen has no dot; idle chats: none', () => {
    const fresh = chat(2, A, { unseen: true })
    expect(strongestMark([fresh], (c) => ({ here: c.id === fresh.id }))).toBeNull()
    expect(strongestMark([chat(5, A)], (c) => ({ card: c.id === chat(5).id }))!.marker.kind).toBe('ask')
    expect(strongestMark([chat(6, A), chat(7, A)], () => ({}))).toBeNull()
  })
})
