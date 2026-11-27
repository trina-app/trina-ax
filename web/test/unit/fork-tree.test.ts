// Continuations under their chat in the Trina history, like the Claude app's session list (lib/forkTree.ts;
// docs/decisions/20261127-fork-in-history.md): one level of indent (a continuation of a continuation right under the
// first chat), every tree at its first chat's place (nothing moves an older chat up), whatever date each chat is from;
// a chat not in the list hands its continuations up.
import { describe, expect, test } from 'bun:test'
import type { Chat } from '@mycel/shared/api'
import { forkRows } from '../../src/lib/forkTree'
import { dateBucket } from '../../src/lib/format'

const chat = (id: string, forkParents?: string[], updatedAt = '2026-11-26T12:00:00.000Z'): Chat =>
  ({ id, projectId: null, title: id, engine: 'claude-code', model: null, createdAt: updatedAt, updatedAt, deletedAt: null, runState: 'idle', ...(forkParents ? { forkParents } : {}) })
const shape = (list: Chat[]) => forkRows(list).map((r) => `${r.depth ? '-' : ''}${r.chat.id}${r.under ? `(${r.under})` : ''}`)

describe('the rows of one list', () => {
  test('one level: a continuation of a continuation sits right under the first chat; every tree at its first chat\'s place', () => {
    // the list's order (by last activity): F2 is newest, but A keeps its own place (nothing moves it up)
    const list = [chat('F2', ['F1', 'A']), chat('B'), chat('F1', ['A']), chat('A'), chat('G', ['B'])]
    expect(shape(list)).toEqual(['B(1)', '-G', 'A(2)', '-F2', '-F1'])
  })

  test('a continuation used today whose original is 3 days old: under the original, in the original\'s date group', () => {
    const now = new Date()
    const at = (days: number) => { const d = new Date(now); d.setDate(d.getDate() - days); d.setHours(12, 0, 0, 0); return d.toISOString() }
    // newest first, as the history sorts by last activity
    const list = [chat('T', undefined, at(0)), chat('F', ['A'], at(0)), chat('Y', undefined, at(1)), chat('A', undefined, at(3))]
    const rows = forkRows(list)
    expect(shape(list)).toEqual(['T', 'Y', 'A(1)', '-F'])
    // DateGroups files a row under its tree's top row's date (HistoryList.tsx)
    const f = rows.find((r) => r.chat.id === 'F')!
    expect(f.top.id).toBe('A')
    expect(dateBucket(f.top.updatedAt, now)).toBe('week')
    expect(dateBucket(f.chat.updatedAt, now)).toBe('today')
  })

  test('a chat not in the list (deleted, hidden, pinned, in another section, filtered out, not loaded): the nearest one there, or on its own', () => {
    expect(shape([chat('F2', ['F1', 'A']), chat('A')])).toEqual(['A(1)', '-F2'])
    expect(shape([chat('F2', ['F1', 'A']), chat('X')])).toEqual(['F2', 'X'])
  })

  test('a hidden original hands its continuations up: the one it came from, else rows of their own', () => {
    // H (hidden from my list) is not a row: its continuations go to H's own original O, or stand alone without it
    expect(shape([chat('K1', ['H', 'O']), chat('K2', ['H', 'O']), chat('O')])).toEqual(['O(2)', '-K1', '-K2'])
    expect(shape([chat('K1', ['H']), chat('K2', ['H']), chat('Z')])).toEqual(['K1', 'K2', 'Z'])
  })

  test('a missing original read later (GET /api/chats?ids=): the tree forms where the original sits', () => {
    const before = [chat('F', ['A'], '2026-11-27T09:00:00.000Z'), chat('B', undefined, '2026-11-26T09:00:00.000Z')]
    expect(shape(before)).toEqual(['F', 'B'])
    const after = [...before, chat('A', undefined, '2026-10-01T09:00:00.000Z')]
    expect(shape(after)).toEqual(['B', 'A(1)', '-F'])
  })

  test('a chain that loops back (data made by hand) never hangs', () => {
    expect(shape([chat('P', ['Q']), chat('Q', ['P'])]).length).toBe(2)
  })
})
