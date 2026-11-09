// The team's top folders in words on screen (docs/DECISIONS.md "Team folder basics"; src/lib/folderLabels.ts over
// shared/src/folder-labels.ts): rows and breadcrumbs by their word, paths with their top folder in words, the person's
// own folder as 내 폴더; anything else as it is.
import { describe, expect, test } from 'bun:test'
import { folderWords } from '../../src/lib/folderLabels'

describe('folder words', () => {
  const ko = folderWords('ko', 'olga')
  test('a row or a breadcrumb: the top folders and the own folder by their words, the rest by its name', () => {
    expect(['shared', 'groups', 'projects', 'skills', 'users'].map((p) => ko.name(p, p))).toEqual(['전사 공유', '부서', '프로젝트', '팀 스킬', '개인'])
    expect(ko.name('users/olga', 'olga')).toBe('내 폴더')
    expect(ko.name('users/bob', 'bob')).toBe('bob')
    expect(ko.name('groups/영업', '영업')).toBe('영업')
    expect(ko.name('shared/양식', '양식')).toBe('양식')
    expect(ko.name('docs', 'docs')).toBe('docs')
    expect(folderWords('en', 'olga').name('shared', 'shared')).toBe('Company-wide')
    expect(folderWords('ja', null).name('users/olga', 'olga')).toBe('olga')
  })
  test('a path: its top folder in words, the rest as it is; the team root stays empty', () => {
    expect(ko.path('shared/양식')).toBe('전사 공유/양식')
    expect(ko.path('users/olga/메모.md')).toBe('내 폴더/메모.md')
    expect(ko.path('groups/영업/견적서', ' › ')).toBe('부서 › 영업 › 견적서')
    expect(ko.path('marketing/plan.md')).toBe('marketing/plan.md')
    expect(ko.path('')).toBe('')
  })
})
