// lib/bulkFiles: several items of the file screen at once. Which rows a checkbox click selects (Shift: a range, the
// header: every row listed), and the batch rules: a move that would hide items from other people is asked about once
// for the whole batch and only those are retried with confirm; a share asks once (people counted once, not per file).
import { describe, expect, test } from 'bun:test'
import { ApiError, type FileEntry } from '@mycel/shared/api'
import { canChange, canShare, clickSelect, failureList, moveMany, narrowedBy, selectable, selectionState, shareMany, toggleAll, trashMany } from '../../src/lib/bulkFiles'

const entry = (path: string, o: Partial<FileEntry> = {}): FileEntry => ({ name: path.slice(path.lastIndexOf('/') + 1), path, type: 'file', size: 1, mtime: '2026-10-28T00:00:00.000Z', mime: null, access: 'write', ...o })
const narrowing = (lost: number) => new ApiError(409, { code: 'conflict', message: 'narrowed', params: { reason: 'audience_narrowed', lostViewers: lost } })
const order = ['a', 'b', 'c', 'd', 'e']
const sorted = (s: Set<string>) => [...s].sort()

describe('selection', () => {
  test('a click toggles one row; Shift+click selects from the row clicked last, either way', () => {
    let s = clickSelect(new Set(), order, 'b', null, false)
    expect(sorted(s)).toEqual(['b'])
    s = clickSelect(s, order, 'd', 'b', true)
    expect(sorted(s)).toEqual(['b', 'c', 'd'])
    // upwards from the anchor
    expect(sorted(clickSelect(new Set(['d']), order, 'a', 'd', true))).toEqual(['a', 'b', 'c', 'd'])
    // a plain click on a selected row clears only that row
    expect(sorted(clickSelect(s, order, 'c', 'd', false))).toEqual(['b', 'd'])
  })

  test('Shift+click on a selected row clears the range; without an anchor (or one no longer listed) it is a plain click', () => {
    expect(sorted(clickSelect(new Set(order), order, 'd', 'b', true))).toEqual(['a', 'e'])
    expect(sorted(clickSelect(new Set(), order, 'c', null, true))).toEqual(['c'])
    expect(sorted(clickSelect(new Set(), order, 'c', 'gone', true))).toEqual(['c'])
  })

  test('the header checkbox: none / some / all of the rows listed; all, then none', () => {
    expect(selectionState(new Set(), order)).toBe('none')
    expect(selectionState(new Set(['a']), order)).toBe('some')
    expect(selectionState(new Set(order), order)).toBe('all')
    expect(selectionState(new Set(), [])).toBe('none')
    expect(sorted(toggleAll(new Set(['a']), order))).toEqual(order)
    expect(toggleAll(new Set(order), order).size).toBe(0)
  })

  test('what may be selected and acted on follows the row menu', () => {
    expect(selectable(entry('x', { type: 'folder', access: 'none' }))).toBe(false)
    expect(canChange(entry('x', { access: 'read' }))).toBe(false)
    expect(canShare(entry('x', { access: 'read' }))).toBe(true)
    expect(canShare(entry('x', { type: 'folder' }))).toBe(false)
  })
})

describe('moveMany', () => {
  const items = [entry('m/a.png'), entry('m/b.pdf'), entry('m/c.pdf')]

  test('items that would become private are asked about once, then only those move with confirm', async () => {
    const calls: { from: string; to: string; confirm?: boolean }[] = []
    const asked: [number, number][] = []
    const r = await moveMany(items, 'users/me', {
      move: async (body) => {
        calls.push(body)
        if (!body.confirm && body.from !== 'm/a.png') throw narrowing(body.from === 'm/b.pdf' ? 2 : 3)
        return {}
      },
      confirmNarrow: async (count, lost) => (asked.push([count, lost]), true),
    })
    expect(asked).toEqual([[2, 3]])
    expect(calls.map((c) => [c.from, c.to, !!c.confirm])).toEqual([
      ['m/a.png', 'users/me/a.png', false],
      ['m/b.pdf', 'users/me/b.pdf', false],
      ['m/c.pdf', 'users/me/c.pdf', false],
      ['m/b.pdf', 'users/me/b.pdf', true],
      ['m/c.pdf', 'users/me/c.pdf', true],
    ])
    expect(r.done.map((e) => e.path)).toEqual(['m/a.png', 'm/b.pdf', 'm/c.pdf'])
    expect(r.failed).toEqual([])
  })

  test('"no" leaves those where they were; other errors are failures and ask nothing', async () => {
    let asked = 0
    const forbidden = new ApiError(403, { code: 'forbidden', message: 'no' })
    const r = await moveMany(items, 'users/me', {
      move: async (body) => {
        if (body.from === 'm/a.png') throw forbidden
        if (!body.confirm) throw narrowing(1)
        throw new Error('must not retry after a no')
      },
      confirmNarrow: async () => (asked++, false),
    })
    expect(asked).toBe(1)
    expect(r.done).toEqual([])
    expect(r.declined.map((e) => e.path)).toEqual(['m/b.pdf', 'm/c.pdf'])
    expect(r.failed.map((f) => [f.entry.path, f.error])).toEqual([['m/a.png', forbidden]])
  })

  test('nothing that narrows: nobody is asked', async () => {
    let asked = 0
    const r = await moveMany(items, 'shared', { move: async () => ({}), confirmNarrow: async () => (asked++, true) })
    expect(asked).toBe(0)
    expect(r.done).toHaveLength(3)
    expect(narrowedBy(new ApiError(409, { code: 'conflict', message: 'exists' }))).toBeNull()
  })
})

describe('shareMany and trashMany', () => {
  test('one dry run per file, one question with the most people any copy adds, then the copies', async () => {
    const calls: string[] = []
    const asked: [number, number][] = []
    const r = await shareMany([entry('u/a.png'), entry('u/b.pdf')], 'shared', {
      copy: async (body) => {
        calls.push(`${body.dryRun ? 'dry' : 'copy'} ${body.from} -> ${body.to}`)
        return body.dryRun ? { viewersAdded: body.from === 'u/a.png' ? 4 : 5 } : { path: body.to, sha256: 'x' }
      },
      confirmShare: async (count, n) => (asked.push([count, n]), true),
    })
    expect(asked).toEqual([[2, 5]])
    expect(calls).toEqual(['dry u/a.png -> shared/a.png', 'dry u/b.pdf -> shared/b.pdf', 'copy u/a.png -> shared/a.png', 'copy u/b.pdf -> shared/b.pdf'])
    expect(r.done).toHaveLength(2)
  })

  test('a share the person says no to copies nothing; no one added: no question', async () => {
    let copies = 0
    const declined = await shareMany([entry('u/a.png')], 'shared', { copy: async (b) => (b.dryRun ? { viewersAdded: 1 } : (copies++, { path: b.to, sha256: 'x' })), confirmShare: async () => false })
    expect(copies).toBe(0)
    expect(declined.declined).toHaveLength(1)
    let asked = 0
    const quiet = await shareMany([entry('u/a.png')], 'shared', { copy: async (b) => (b.dryRun ? { viewersAdded: 0 } : { path: b.to, sha256: 'x' }), confirmShare: async () => (asked++, true) })
    expect(asked).toBe(0)
    expect(quiet.done).toHaveLength(1)
  })

  test('trash keeps the ids for undo; failures are listed briefly', async () => {
    const r = await trashMany([entry('a'), entry('b'), entry('c'), entry('d'), entry('e')], {
      remove: async (p) => {
        if (p !== 'a') throw new Error(`no ${p}`)
        return { trashId: 't-a' }
      },
    })
    expect(r.trashIds).toEqual(['t-a'])
    expect(failureList(r.failed, (e) => (e as Error).message, (n) => `+${n}`)).toBe('b (no b), c (no c), d (no d) +1')
  })
})
