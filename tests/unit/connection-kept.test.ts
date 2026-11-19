// The long connection answers kept for connection_result (integrations/connections/kept.ts; review of #1321): a store is
// made only when an answer is kept and goes when its turn ends; ids are never reused; a running turn's answers are
// never dropped for another turn's.
import { describe, expect, test } from 'bun:test'
import { dropKept, keptGet, keptPut, keptStats, KEPT_ALL_CHARS, KEPT_RESULTS_CHARS } from '../../server/src/integrations/connections/kept'
import type { Row } from '../../server/src/integrations/connections/store'

const row = { id: 'i1', name: 'Svc' } as unknown as Row
const t = (turnId: string, userId = 'alice') => ({ turnId, userId })

describe('kept connection answers', () => {
  test('no store until an answer is kept; a lookup makes none; the turn end removes it', () => {
    const before = keptStats()
    expect(keptGet(t('turn-a'), 'r1')).toBeNull()
    expect(keptStats()).toEqual(before)
    const id = keptPut(t('turn-a'), row, 'x'.repeat(50_000), 'search')!
    expect(keptStats()).toEqual({ stores: before.stores + 1, chars: before.chars + 50_000 })
    expect(keptGet(t('turn-a'), id)!.text.length).toBe(50_000)
    // another person in the same turn id: nothing
    expect(keptGet(t('turn-a', 'bob'), id)).toBeNull()
    dropKept('turn-a')
    expect(keptStats()).toEqual(before)
    expect(keptGet(t('turn-a'), id)).toBeNull()
  })

  test('ids are never reused, also after a turn ends', () => {
    const a = keptPut(t('turn-b'), row, 'a'.repeat(100), 'x')!
    dropKept('turn-b')
    const b = keptPut(t('turn-b'), row, 'b'.repeat(100), 'x')!
    expect(b).not.toBe(a)
    expect(keptGet(t('turn-b'), a)).toBeNull()
    dropKept('turn-b')
  })

  test('the server-wide cap never drops a running turn\'s answers: the new answer is not kept instead', () => {
    // other test files in the same process may hold kept answers: fill what is left, whatever that is
    const big = 'y'.repeat(KEPT_RESULTS_CHARS)
    const ids: string[] = []
    for (let i = 0; i < KEPT_ALL_CHARS / KEPT_RESULTS_CHARS + 1; i++) { const id = keptPut(t(`turn-c${i}`, `u-c${i}`), row, big, 'x'); if (!id) break; ids.push(id) }
    expect(keptStats().chars).toBeGreaterThan(KEPT_ALL_CHARS - KEPT_RESULTS_CHARS)
    const room = KEPT_ALL_CHARS - keptStats().chars
    expect(keptPut(t('turn-d'), row, 'z'.repeat(room + 1), 'x')).toBeNull()
    for (let i = 0; i < ids.length; i++) expect(keptGet(t(`turn-c${i}`, `u-c${i}`), ids[i]!)).not.toBeNull()
    for (let i = 0; i < ids.length; i++) dropKept(`turn-c${i}`)
    expect(keptPut(t('turn-d'), row, 'z'.repeat(100), 'x')).not.toBeNull()
    dropKept('turn-d')
  })

  test('one person\'s turns never take everyone\'s room: alice is full at 16M over her turns, bob\'s answer is still kept', () => {
    const half = 'h'.repeat(KEPT_RESULTS_CHARS / 2)
    const a1 = keptPut(t('turn-e1', 'alice-e'), row, half, 'x')
    const a2 = keptPut(t('turn-e2', 'alice-e'), row, half, 'x')
    expect(a1 && a2).toBeTruthy()
    // a third turn of hers: over her share, not kept
    expect(keptPut(t('turn-e3', 'alice-e'), row, 'z'.repeat(100), 'x')).toBeNull()
    const b = keptPut(t('turn-e4', 'bob-e'), row, 'b'.repeat(100_000), 'x')
    expect(b).not.toBeNull()
    expect(keptGet(t('turn-e4', 'bob-e'), b!)!.text.length).toBe(100_000)
    // her turn ends: her share is free again
    dropKept('turn-e1')
    expect(keptPut(t('turn-e3', 'alice-e'), row, 'z'.repeat(100), 'x')).not.toBeNull()
    for (const x of ['turn-e2', 'turn-e3', 'turn-e4']) dropKept(x)
  })
})
