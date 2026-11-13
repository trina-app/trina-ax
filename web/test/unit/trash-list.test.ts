// Files › Trash as people read it (src/lib/trashList.ts, QA TC-1040): names and places in the Files sidebar's words,
// repeats of one original path as one row (also across pages), when "Deleted by me / Everyone" shows, the retention
// line and the "in N days" hint.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setOwnFolderWord } from '@mycel/shared'
import type { TrashItem } from '@mycel/shared/api'
import { folderWords } from '../../src/lib/folderLabels'
import { groupTrash, mergePage, placeWords, purgeIn, retentionDays, showWhoSwitch, trashPlace, type PlaceWords } from '../../src/lib/trashList'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-13T10:00:00Z')
let seq = 0
/** an item deleted `ago` ms before T0 (ids grow with time, as uuidv7 do) */
function item(path: string, o: { by?: string | null; ago?: number; type?: 'file' | 'folder'; days?: number; size?: number } = {}): TrashItem {
  const at = T0 - (o.ago ?? 0)
  seq++
  return {
    id: `0190${String(at).padStart(12, '0')}-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    originalPath: path,
    size: o.size ?? 10,
    deletedBy: o.by === null ? null : { id: o.by ?? 'dana', name: o.by ?? 'dana' },
    turnId: null,
    deletedAt: new Date(at).toISOString(),
    purgeAt: new Date(at + (o.days ?? 30) * DAY).toISOString(),
    ...(o.type ? { type: o.type } : {}),
  }
}

beforeAll(() => setOwnFolderWord('files'))
afterAll(() => setOwnFolderWord('folder'))

describe('names and places', () => {
  const w = (): PlaceWords => ({
    words: folderWords('en', 'dana'),
    me: 'dana',
    projects: [
      { name: 'Hello', folderPath: 'users/dana/projects/Hello' },
      { name: 'Acme launch', folderPath: 'projects/acme' },
    ],
    root: 'Team folder',
    myProjects: 'My projects',
    personal: 'Personal',
  })
  const place = (path: string, type?: 'file' | 'folder') => trashPlace(item(path, { type }), w())

  test("the owner's examples: name, then the place in the sidebar's words", () => {
    expect(place('users/dana/projects/Hello', 'folder')).toEqual({ name: 'Hello', where: 'My projects', kind: 'project' })
    expect(place('groups/QA Sales', 'folder')).toEqual({ name: 'QA Sales', where: 'Groups', kind: 'folder' })
    expect(place('skills/remotion-video.md')).toEqual({ name: 'remotion-video.md', where: 'Team skills', kind: 'file' })
    expect(place('shared/Sales/price-sheet.xlsx')).toEqual({ name: 'price-sheet.xlsx', where: 'Company-wide › Sales', kind: 'file' })
  })
  test('a project folder by its project name, my own folder as My files, the top as the team folder', () => {
    expect(place('projects/acme/docs/brief.md').where).toBe('Acme launch › docs')
    expect(place('projects/acme', 'folder')).toEqual({ name: 'Acme launch', where: 'Projects', kind: 'project' })
    expect(place('users/dana/projects/Hello/brief.md').where).toBe('Hello')
    expect(place('users/dana/projects/Old/a.md').where).toBe('My projects › Old')
    expect(place('users/dana/notes/todo.md').where).toBe('My files › notes')
    expect(place('users/dana/todo.md').where).toBe('My files')
    expect(place('readme.md').where).toBe('Team folder')
    expect(place('docs/a/b.txt').where).toBe('docs › a')
  })
  test('never a storage prefix or someone else’s id', () => {
    const paths = ['users/dana/projects/Hello', 'groups/QA Sales/x.csv', 'projects/acme/x', 'projects/other/x', 'shared/a/b', 'skills/x.md', 'users/olga7/notes/x.md', 'users/dana/x']
    for (const p of paths) {
      const { where } = place(p)
      expect(where).not.toMatch(/(^|\W)(users|groups|projects|shared|skills)\//)
      expect(where).not.toContain('olga7')
    }
    expect(place('users/olga7/notes/x.md').where).toBe('Personal › notes')
    expect(placeWords('', w())).toBe('Team folder')
  })
  test('in another language: the same table', () => {
    expect(trashPlace(item('shared/영업/단가표.xlsx'), { ...w(), words: folderWords('ko', 'dana') }).where).toBe('전사 공유 › 영업')
  })
})

describe('repeats of one path are one row', () => {
  test('grouped by original path, newest copy first, rows in the order of their latest delete', () => {
    const a1 = item('shared/Sales/price-sheet.xlsx', { ago: 1000, by: 'bob' })
    const b = item('skills/x.md', { ago: 2000 })
    const a2 = item('shared/Sales/price-sheet.xlsx', { ago: 3000 })
    const a3 = item('shared/Sales/price-sheet.xlsx', { ago: 4000 })
    const g = groupTrash([a1, b, a2, a3])
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([[a1.id, a2.id, a3.id], [b.id]])
    // the row shows (and its Restore restores) the latest: bob's
    expect(g[0]!.items[0]!.deletedBy?.id).toBe('bob')
  })
  test('a file and a folder of the same path are two rows', () => {
    expect(groupTrash([item('docs/x', { type: 'folder' }), item('docs/x')])).toHaveLength(2)
  })
  test('across pages: a copy on page 2 joins the row of page 1; an item on both pages counts once', () => {
    const p1 = [item('a.txt', { ago: 1 }), item('b.txt', { ago: 2 })]
    const shared = item('c.txt', { ago: 3 })
    p1.push(shared)
    const p2 = [shared, item('a.txt', { ago: 50 }), item('a.txt', { ago: 60 }), item('d.txt', { ago: 70 })]
    const all = mergePage(p1, p2)
    expect(all).toHaveLength(6)
    const g = groupTrash(all)
    expect(g.map((x) => [x.items[0]!.originalPath, x.items.length])).toEqual([['a.txt', 3], ['b.txt', 1], ['c.txt', 1], ['d.txt', 1]])
    // grouping a list with a duplicate id (pages that overlap) gives the same rows
    expect(groupTrash([...p1, ...p2]).map((x) => x.items.length)).toEqual([3, 1, 1, 1])
  })
})

describe('"Deleted by me / Everyone"', () => {
  test('shown only when the list has someone else’s (or the AI’s) delete', () => {
    expect(showWhoSwitch([], 'dana')).toBe(false)
    expect(showWhoSwitch([item('a', { by: 'dana' }), item('b', { by: 'dana' })], 'dana')).toBe(false)
    expect(showWhoSwitch([item('a', { by: 'dana' }), item('b', { by: 'bob' })], 'dana')).toBe(true)
    expect(showWhoSwitch([item('a', { by: null })], 'dana')).toBe(true)
  })
})

describe('how long items stay', () => {
  test('the line: the retention the latest delete was given', () => {
    expect(retentionDays([])).toBeNull()
    expect(retentionDays([item('a', { ago: 5 * DAY, days: 30 }), item('b', { ago: 1000, days: 10 })])).toBe(10)
    expect(retentionDays([item('a', { days: 1 })])).toBe(1)
  })
  test('each row: "in N days" (hours, then minutes, at the end)', () => {
    expect(purgeIn(new Date(T0 + 18 * DAY).toISOString(), 'en', T0)).toBe('in 18 days')
    expect(purgeIn(new Date(T0 + 1 * DAY).toISOString(), 'en', T0)).toBe('in 1 day')
    expect(purgeIn(new Date(T0 + 5 * 3_600_000).toISOString(), 'en', T0)).toBe('in 5 hours')
    expect(purgeIn(new Date(T0 + 60_000).toISOString(), 'en', T0)).toBe('in 1 minute')
    expect(purgeIn(new Date(T0 + 18 * DAY).toISOString(), 'ko', T0)).toBe('18일 후')
  })
})
