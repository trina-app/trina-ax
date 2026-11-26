// Continuations under their chat in the Trina history (lib/forkTree.ts; docs/decisions/20261126-chat-fork-tree.md):
// one level of indent (a continuation of a continuation right under the first chat), every chat in its own place (a
// tree where its first chat is; nothing moves an older chat up), a chat sits under another only in the same list and
// the same date group, else on its own.
import { describe, expect, test } from 'bun:test'
import type { Chat } from '@mycel/shared/api'
import { forkRows } from '../../src/lib/forkTree'

const chat = (id: string, forkParents?: string[]): Chat => {
  const at = '2026-11-26T12:00:00.000Z'
  return { id, projectId: null, title: id, engine: 'claude-code', model: null, createdAt: at, updatedAt: at, deletedAt: null, runState: 'idle', ...(forkParents ? { forkParents } : {}) }
}
const shape = (list: Chat[], group?: (c: Chat) => string) => forkRows(list, group ? { group } : {}).map((r) => `${r.depth ? '-' : ''}${r.chat.id}${r.under ? `(${r.under})` : ''}`)

describe('the rows of one list', () => {
  test('one level: a continuation of a continuation sits right under the first chat; every tree at its first chat\'s place', () => {
    // the list's order (by last activity): F2 is newest, but A keeps its own place (nothing moves it up)
    const list = [chat('F2', ['F1', 'A']), chat('B'), chat('F1', ['A']), chat('A'), chat('G', ['B'])]
    expect(shape(list)).toEqual(['B(1)', '-G', 'A(2)', '-F2', '-F1'])
  })

  test('a chat not in the list (deleted, hidden, pinned, in another section, filtered out, not loaded): the nearest one there, or on its own', () => {
    expect(shape([chat('F2', ['F1', 'A']), chat('A')])).toEqual(['A(1)', '-F2'])
    expect(shape([chat('F2', ['F1', 'A']), chat('X')])).toEqual(['F2', 'X'])
  })

  test('another date: a continuation stands on its own in its date, the older chat stays where it is', () => {
    const day: Record<string, string> = { F1: 'today', A: 'older', F2: 'older' }
    expect(shape([chat('F1', ['A']), chat('A'), chat('F2', ['A'])], (c) => day[c.id]!)).toEqual(['F1', 'A(1)', '-F2'])
  })

  test('a chain that loops back (data made by hand) never hangs', () => {
    expect(shape([chat('P', ['Q']), chat('Q', ['P'])]).length).toBe(2)
  })
})
