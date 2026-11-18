// lib/reorder: the order of the team's AI accounts changed by hand (Admin › AI providers, QA TC-4836). Dragging a row
// and Move up / Move down both take the row out and put it back, then save priorities 10, 20, 30 … for the rows whose
// number changes; where a dragged row lands follows the pointer past the middle of each other row.
import { describe, expect, test } from 'bun:test'
import { dropIndex, moveItem, priorityPatches } from '../../src/lib/reorder'

const rows = (...p: number[]) => p.map((priority, i) => ({ id: String.fromCharCode(97 + i), priority }))

describe('moveItem', () => {
  test('moves down, up, to the ends and nowhere', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c', 'd'], 2, 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 1, 3)).toEqual(['a', 'c', 'd', 'b'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })
  test('clamps the target and ignores a row that is not there; never changes the list it was given', () => {
    const l = ['a', 'b', 'c']
    expect(moveItem(l, 0, 9)).toEqual(['b', 'c', 'a'])
    expect(moveItem(l, 2, -4)).toEqual(['c', 'a', 'b'])
    expect(moveItem(l, 5, 0)).toEqual(['a', 'b', 'c'])
    expect(l).toEqual(['a', 'b', 'c'])
  })
  test('one place up is Move up, one place down is Move down (the ⋯ menu)', () => {
    expect(moveItem(['a', 'b', 'c'], 1, 0)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 1, 2)).toEqual(['a', 'c', 'b'])
  })
})

describe('priorityPatches', () => {
  test('10, 20, 30 … in list order, only for rows whose number changes', () => {
    const next = moveItem(rows(10, 20, 30, 40), 3, 0) // d, a, b, c
    expect(priorityPatches(next)).toEqual([{ id: 'd', priority: 10 }, { id: 'a', priority: 20 }, { id: 'b', priority: 30 }, { id: 'c', priority: 40 }])
    expect(priorityPatches(moveItem(rows(10, 20, 30, 40), 2, 3))).toEqual([{ id: 'd', priority: 30 }, { id: 'c', priority: 40 }])
  })
  test('an untouched, already numbered list sends nothing', () => {
    expect(priorityPatches(rows(10, 20, 30))).toEqual([])
  })
  test('old numbers (equal ones, the default 100) are spread out so the order is exact', () => {
    // equal priorities are ordered by date added on the server; after a move every row has its own number
    expect(priorityPatches(rows(100, 100, 100))).toEqual([{ id: 'a', priority: 10 }, { id: 'b', priority: 20 }, { id: 'c', priority: 30 }])
  })
})

describe('dropIndex', () => {
  // four rows 60 px high: middles at 30, 90, 150, 210
  const mids = [30, 90, 150, 210]
  test('a row stays put until its middle passes the middle of the next row', () => {
    expect(dropIndex(mids, 0, 30)).toBe(0)
    expect(dropIndex(mids, 0, 89)).toBe(0)
    expect(dropIndex(mids, 0, 91)).toBe(1)
    expect(dropIndex(mids, 0, 211)).toBe(3)
  })
  test('upwards too, and past either end lands at the end', () => {
    expect(dropIndex(mids, 3, 210)).toBe(3)
    expect(dropIndex(mids, 3, 149)).toBe(2)
    expect(dropIndex(mids, 3, 29)).toBe(0)
    expect(dropIndex(mids, 3, -500)).toBe(0)
    expect(dropIndex(mids, 1, 9999)).toBe(3)
  })
})
