// The setup's folder plan as the person edits it (web/src/lib/organize.ts; docs/DECISIONS.md "Setup 팀 파일: the AI
// proposes folders"): the rows grouped by folder, a row into another folder or a new one (at most 8 folders), a new
// folder renamed inline (merging into a folder of that name), a row taken out, what [이대로 정리] sends, and the project
// question's body (the team group as participant) and paths after the moves.
import { describe, expect, test } from 'bun:test'
import type { OrganizePlan } from '@mycel/shared/api'
import { choicesOf, editFromPlan, folderCount, groupsOf, movesOf, newFolderFor, projectBody, projectPaths, removeRow, renameFolder, setFolder } from '../../src/lib/organize'

const plan: Pick<OrganizePlan, 'rows' | 'folders' | 'existing'> = {
  existing: ['양식', '보관'],
  folders: ['양식', '회의록'],
  rows: [
    { path: 'shared/올림/견적서_양식.xlsx', folder: '양식', reason: 'form', form: true },
    { path: 'shared/올림/주간보고_양식.docx', folder: '양식', reason: 'form', form: true },
    { path: 'shared/올림/10월 회의록.docx', folder: '회의록', reason: 'minutes', form: false },
    { path: 'shared/올림/misc.txt', folder: null, reason: null, form: false },
  ],
}

describe('the plan as the person edits it', () => {
  test('rows that move, grouped in the plan\'s order; new folders marked; the picker offers the plan\'s and the existing folders', () => {
    const e = editFromPlan(plan)
    expect(groupsOf(e).map((g) => [g.folder, g.isNew, g.rows.map((r) => r.name)])).toEqual([
      ['양식', false, ['견적서_양식.xlsx', '주간보고_양식.docx']],
      ['회의록', true, ['10월 회의록.docx']],
    ])
    expect(choicesOf(e)).toEqual(['양식', '회의록', '보관'])
  })

  test('a row into another folder, a row taken out, what is sent', () => {
    let e = editFromPlan(plan)
    e = setFolder(e, 'shared/올림/주간보고_양식.docx', '회의록')
    e = removeRow(e, 'shared/올림/견적서_양식.xlsx')
    expect(groupsOf(e).map((g) => [g.folder, g.rows.length])).toEqual([['회의록', 2]])
    expect(movesOf(e)).toEqual([{ from: 'shared/올림/주간보고_양식.docx', folder: '회의록' }, { from: 'shared/올림/10월 회의록.docx', folder: '회의록' }])
    // an existing folder whatever its letter case
    expect(setFolder(editFromPlan(plan), 'shared/올림/10월 회의록.docx', '  보관 ').rows[2]!.folder).toBe('보관')
  })

  test('a new folder of its own, named inline; a name of another folder merges; an existing folder is not renamed', () => {
    let e = newFolderFor(editFromPlan(plan), 'shared/올림/주간보고_양식.docx', '새 폴더')!
    expect(groupsOf(e).map((g) => g.folder)).toEqual(['양식', '회의록', '새 폴더'])
    e = renameFolder(e, '새 폴더', '주간 보고/2026')
    expect(groupsOf(e).map((g) => g.folder)).toEqual(['양식', '회의록', '주간 보고 2026'])
    e = renameFolder(e, '주간 보고 2026', '회의록')
    expect(groupsOf(e).map((g) => [g.folder, g.rows.length])).toEqual([['양식', 1], ['회의록', 2]])
    expect(renameFolder(e, '양식', '서식')).toBe(e)
    expect(renameFolder(e, '회의록', '')).toBe(e)
  })

  test('at most 8 folders: a 9th is refused, unless the row is alone in its folder', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ path: `shared/f${i}.pdf`, folder: `폴더 ${Math.min(i, 7)}`, reason: null, form: false }))
    let e = editFromPlan({ existing: [], folders: Array.from({ length: 8 }, (_, i) => `폴더 ${i}`), rows })
    expect(folderCount(e)).toBe(8)
    expect(newFolderFor(e, 'shared/f8.pdf', '새 폴더')).toBeNull()
    expect(setFolder(e, 'shared/f8.pdf', '아홉째')).toBe(e)
    // f0 is alone in 폴더 0: moving it to a new folder keeps the count
    e = newFolderFor(e, 'shared/f0.pdf', '새 폴더')!
    expect(folderCount(e)).toBe(8)
  })

  test('the project question: a team project with the setup\'s team group as participant; its files where they are now', () => {
    expect(projectBody('A사 리뉴얼', 'g1')).toEqual({ name: 'A사 리뉴얼', scope: 'team', participants: [{ subjectType: 'group', subjectId: 'g1' }], instructions: '' })
    expect(projectBody('A사 리뉴얼', null).participants).toEqual([])
    expect(projectPaths(['shared/올림/a.pdf', 'shared/올림/b.pdf'], { moved: [{ from: 'shared/올림/a.pdf', to: 'shared/A사/a.pdf' }], failed: [] })).toEqual(['shared/A사/a.pdf', 'shared/올림/b.pdf'])
  })
})
