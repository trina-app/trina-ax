// The runs of a scheduled task folded in 최근 기록 (components/nav/TaskRunsRow.tsx; docs/DECISIONS.md "Scheduled runs
// fold in Recent"): one row per task where its newest run is, whatever group the other runs are in; it opens the task;
// semibold while any run has an answer not seen yet, and not once it was seen; a red dot for a failed newest
// run; a pinned run and an ordinary chat keep their own rows.
import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { foldRuns } from '../../src/components/nav/TaskRunsRow'

const chat = (id: string, at: string, o: Partial<Chat> = {}): Chat => ({ id, projectId: null, title: id, engine: 'claude-code', model: null, createdAt: at, updatedAt: at, deletedAt: null, runState: 'idle', ...o })
const runOf = (task: string, outcome: 'succeeded' | 'problems' | 'failed' | null = 'succeeded') => ({ schedule: { id: task, title: `Task ${task}`, templateId: null, outcome } })
const row = (c: Chat) => <li data-chat={c.id}>{c.title}</li>
const html = (nodes: ReactNode[]) => renderToStaticMarkup(<MemoryRouter><ul>{nodes}</ul></MemoryRouter>)
const rows = (h: string) => [...h.matchAll(/data-chat="([^"]+)"|data-schedule-id="([^"]+)"/g)].map((m) => m[1] ?? `task:${m[2]}`)


describe('runs folded in Recent', () => {
  const list = [
    chat('a1', '2026-11-13T09:00:00Z', runOf('A')),
    chat('x', '2026-11-13T08:00:00Z'),
    chat('b1', '2026-11-12T09:00:00Z', runOf('B', 'failed')),
    chat('a2', '2026-11-12T08:00:00Z', runOf('A')),
    chat('p', '2026-11-11T09:00:00Z', { ...runOf('A'), pinnedAt: '2026-11-11T10:00:00Z' }),
    chat('a3', '2026-11-10T09:00:00Z', runOf('A')),
  ]

  test('one row per task, where its newest run is; ordinary and pinned chats keep their rows', () => {
    const h = html(foldRuns(list, row))
    expect(rows(h)).toEqual(['task:A', 'x', 'task:B', 'p'])
    expect(h).toContain('href="/scheduled/A"')
    expect(h).toContain('Task A')
    // the run chats themselves are no rows
    expect(h).not.toContain('data-chat="a1"')
  })

  test('in groups (dates, projects): the task is in the group of its newest run only', () => {
    const today = list.slice(0, 2), older = list.slice(2)
    expect(rows(html(foldRuns(older, row, { pool: list })))).toEqual(['task:B', 'p'])
    expect(rows(html(foldRuns(today, row, { pool: list })))).toEqual(['task:A', 'x'])
  })

  test('semibold while a run is unread; not once that run was seen', () => {
    const unread = [chat('a1', '2026-11-13T09:00:00Z', runOf('A')), chat('a2', '2026-11-12T09:00:00Z', { ...runOf('A'), unseen: true })]
    const h = html(foldRuns(unread, row))
    expect(h).toContain('data-unread=""')
    expect(h).toContain('font-semibold')
    // the person opened that run: its seen clears `unseen` (the on-screen case, before the server answers, is in
    // e2e/schedule-runs.spec.ts: a server render reads the store's first state)
    const seen = unread.map((c) => ({ ...c, unseen: undefined }))
    expect(html(foldRuns(seen, row))).not.toContain('data-unread')
  })

  test('the newest run failed: a red dot; while one runs: the spinner, no dot', () => {
    const failed = html(foldRuns([chat('b1', '2026-11-12T09:00:00Z', runOf('B', 'failed'))], row))
    expect(failed).toContain('data-testid="task-runs-mark"')
    expect(failed).toContain('bg-danger')
    expect(failed).toContain('data-outcome="failed"')
    const running = html(foldRuns([chat('b2', '2026-11-13T09:00:00Z', { ...runOf('B', null), runState: 'running' }), chat('b1', '2026-11-12T09:00:00Z', runOf('B', 'failed'))], row))
    expect(running).toContain('data-testid="marker-running"')
    expect(running).not.toContain('data-testid="task-runs-mark"')
    expect(html(foldRuns([chat('a1', '2026-11-13T09:00:00Z', runOf('A'))], row))).not.toContain('task-runs-mark')
  })
})
