// lib/bulkFiles: several items of the file screen at once. Which rows a checkbox click selects (Shift: a range, the
// header: every row listed), and the batch rules: a move that would hide items from other people is asked about once
// for the whole batch and only those are retried with confirm; a share asks once (people counted once, not per file).
// Drag and drop: what a dragged row takes (the selection or itself), what the drag carries (the move, and one file for
// a chat), and where it may be dropped.
import { describe, expect, test } from 'bun:test'
import { ApiError, type FileEntry } from '@mycel/shared/api'
import { canChange, canShare, chatDraggable, clickSelect, dragPayload, dragSet, dropRefusal, failureList, FILES_MOVE_DRAG_TYPE, isFixed, moveMany, narrowedBy, projectSkillsOn, widenedBy, selectable, selectionState, shareMany, toggleAll, trashMany } from '../../src/lib/bulkFiles'
import { TEAM_FILE_DRAG_TYPE } from '../../src/lib/teamAttach'

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

  test("a folder the server marks fixed (a member's group folder, a personal folder) is not moved, trashed or dragged to move (QA TC-224)", () => {
    const group = entry('groups/sales', { type: 'folder', fixed: 'admin' })
    const own = entry('users/mina', { type: 'folder', fixed: 'always' })
    const plain = entry('groups/sales/plain', { type: 'folder' })
    expect(canChange(group)).toBe(false)
    expect(canChange(own)).toBe(false)
    expect(canChange(plain)).toBe(true)
    expect(isFixed(group)).toBe(true)
    expect(isFixed(plain)).toBe(false)
    // read-only stays read-only, not fixed
    expect(isFixed(entry('x', { type: 'folder', access: 'read', fixed: 'admin' }))).toBe(false)
    expect(dragPayload([group], group)).toBeNull()
    expect(dropRefusal([group], { path: 'shared', access: 'write' })).toBe('nothing')
    expect(dropRefusal([group, plain], { path: 'shared', access: 'write' })).toBeNull()
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

  test('out of my personal folder to where more people see it (QA TC-115): askWiden is sent, the person is asked once, then those move with confirm', async () => {
    const widening = (n: number) => new ApiError(409, { code: 'conflict', message: 'widened', params: { reason: 'audience_widened', viewersAdded: n } })
    expect(widenedBy(widening(3))).toBe(3)
    expect(widenedBy(narrowing(3))).toBeNull()
    const calls: { from: string; confirm?: boolean; askWiden?: boolean }[] = []
    const asked: [number, number][] = []
    const r = await moveMany([entry('users/me/a.md'), entry('users/me/b.md'), entry('users/me/c.md')], 'projects/p', {
      move: async (body) => { calls.push(body); if (!body.confirm && body.from !== 'users/me/c.md') throw widening(body.from === 'users/me/a.md' ? 2 : 4); return {} },
      confirmNarrow: async () => { throw new Error('nothing narrows here') },
      confirmWiden: async (count, n) => (asked.push([count, n]), true),
    })
    expect(asked).toEqual([[2, 4]])
    expect(calls.every((c) => c.askWiden === true)).toBe(true)
    expect(r.done.map((e) => e.path).sort()).toEqual(['users/me/a.md', 'users/me/b.md', 'users/me/c.md'])
    // "no": those stay; without confirmWiden (an older caller) askWiden is not sent at all
    const no = await moveMany([entry('users/me/a.md')], 'projects/p', { move: async (body) => { if (!body.confirm) throw widening(1); return {} }, confirmNarrow: async () => true, confirmWiden: async () => false })
    expect(no.declined.map((e) => e.path)).toEqual(['users/me/a.md'])
    const plain: { askWiden?: boolean }[] = []
    await moveMany([entry('users/me/a.md')], 'projects/p', { move: async (body) => (plain.push(body), {}), confirmNarrow: async () => true })
    expect(plain[0]!.askWiden).toBeUndefined()
  })

  test('a project\'s folder into projects/: its skills switch on, so that item is asked about by name, then moved with skillsOk', async () => {
    const on = new ApiError(409, { code: 'conflict', message: 'skills', params: { reason: 'project_skills_on', skills: 'margin\nquote', count: 2 } })
    expect(projectSkillsOn(on)).toEqual(['margin', 'quote'])
    expect(projectSkillsOn(new ApiError(409, { code: 'conflict', message: 'exists' }))).toBeNull()
    const calls: { from: string; skillsOk?: boolean }[] = []
    const asked: string[][] = []
    const r = await moveMany([entry('shared/pricing'), entry('shared/other')], 'projects', {
      move: async (body) => { calls.push(body); if (body.from === 'shared/pricing' && !body.skillsOk) throw on; return {} },
      confirmNarrow: async () => true,
      confirmSkills: async (names) => (asked.push(names), true),
    })
    expect(asked).toEqual([['margin', 'quote']])
    expect(calls.map((c) => [c.from, !!c.skillsOk])).toEqual([['shared/pricing', false], ['shared/pricing', true], ['shared/other', false]])
    expect(r.done.map((e) => e.path)).toEqual(['shared/pricing', 'shared/other'])
    // "no": left where it was
    const no = await moveMany([entry('shared/pricing')], 'projects', { move: async (body) => { if (!body.skillsOk) throw on; return {} }, confirmNarrow: async () => true, confirmSkills: async () => false })
    expect(no.declined.map((e) => e.path)).toEqual(['shared/pricing'])
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

describe('drag and drop', () => {
  const folder = (path: string, o: Partial<FileEntry> = {}) => entry(path, { type: 'folder', size: null, ...o })
  // m/ as listed: two folders (one read-only, one navigation-only) and three files, one read-only
  const company = folder('m/company')
  const archive = folder('m/archive')
  const locked = folder('m/locked', { access: 'read' })
  const passage = folder('m/passage', { access: 'none' })
  const a = entry('m/a.png')
  const b = entry('m/b.pdf')
  const ro = entry('m/ro.pdf', { access: 'read' })
  const listed = [company, archive, locked, passage, a, b, ro]
  const paths = (xs: readonly FileEntry[]) => xs.map((e) => e.path)

  test('a selected row drags the whole selection (as listed); a row outside it drags itself alone', () => {
    const selected = new Set(['m/b.pdf', 'm/a.png', 'm/archive'])
    expect(paths(dragSet(listed, selected, b))).toEqual(['m/archive', 'm/a.png', 'm/b.pdf'])
    expect(paths(dragSet(listed, selected, company))).toEqual(['m/company'])
    expect(paths(dragSet(listed, new Set(), a))).toEqual(['m/a.png'])
  })

  test('allowed: a folder row the person can write, an ancestor (move up), the team root', () => {
    expect(dropRefusal([a, b], { path: 'm/company', access: 'write' })).toBeNull()
    expect(dropRefusal([archive, a], { path: 'm/company', access: 'write' })).toBeNull()
    expect(dropRefusal([a], { path: '', access: 'write' })).toBeNull()
    // a breadcrumb whose access is not known yet: the server decides per item
    expect(dropRefusal([a], { path: 'x', access: null })).toBeNull()
    // read-only items in the selection are skipped at the drop, as the selection's "move" skips them
    expect(dropRefusal([a, ro], { path: 'm/company', access: 'write' })).toBeNull()
  })

  test('refused: read-only and navigation-only folders, the item itself, its current folder, nothing movable', () => {
    expect(dropRefusal([a, b], { path: 'm/locked', access: 'read' })).toBe('readOnly')
    expect(dropRefusal([a, b], { path: 'm/passage', access: 'none' })).toBe('readOnly')
    expect(dropRefusal([a], { path: 'x', access: 'read' })).toBe('readOnly')
    // onto one of the dragged rows (the folder grabbed, or another folder of the selection)
    expect(dropRefusal([company], { path: 'm/company', access: 'write' })).toBe('self')
    expect(dropRefusal([company, archive, a], { path: 'm/archive', access: 'write' })).toBe('self')
    // the breadcrumb of the folder they are in
    expect(dropRefusal([a, b], { path: 'm', access: 'write' })).toBe('here')
    expect(dropRefusal([folder('top')], { path: '', access: 'write' })).toBe('here')
    // only read-only items: nothing to move (such a drag carries no move at all, see dragPayload)
    expect(dropRefusal([ro], { path: 'm/company', access: 'write' })).toBe('nothing')
  })

  test('a folder never goes into itself or its own subfolders; a sibling whose name starts the same is fine', () => {
    expect(dropRefusal([company], { path: 'm/company/2026', access: 'write' })).toBe('inside')
    expect(dropRefusal([a, company], { path: 'm/company/2026/q3', access: 'write' })).toBe('inside')
    expect(dropRefusal([company], { path: 'm/company-old', access: 'write' })).toBeNull()
    // a file is not a folder: a path under its name is no reason
    expect(dropRefusal([a], { path: 'm/a.png/x', access: 'write' })).toBeNull()
  })

  test('the drag carries the move and, for a file the AI may read, that one file for a chat', () => {
    const both = dragPayload([a, b], a)!
    expect(both.data).toEqual([
      [FILES_MOVE_DRAG_TYPE, JSON.stringify(['m/a.png', 'm/b.pdf'])],
      [TEAM_FILE_DRAG_TYPE, 'm/a.png'],
      ['text/plain', 'm/a.png'],
    ])
    expect(both.effectAllowed).toBe('copyMove')
    // a folder: the move only
    expect(dragPayload([company], company)).toEqual({ data: [[FILES_MOVE_DRAG_TYPE, JSON.stringify(['m/company'])]], effectAllowed: 'move' })
    // a download-only file can be moved, not dragged into a chat
    const dl = entry('m/deck.pptx', { downloadOnly: true })
    expect(chatDraggable(dl)).toBe(false)
    expect(dragPayload([dl], dl)!.data.map(([type]) => type)).toEqual([FILES_MOVE_DRAG_TYPE])
    // a read-only file: into a chat only, as before
    expect(dragPayload([ro], ro)).toEqual({ data: [[TEAM_FILE_DRAG_TYPE, 'm/ro.pdf'], ['text/plain', 'm/ro.pdf']], effectAllowed: 'copy' })
    // a read-only folder outside any movable selection: nothing to drag
    expect(dragPayload([locked], locked)).toBeNull()
    expect(chatDraggable(passage)).toBe(false)
  })
})
