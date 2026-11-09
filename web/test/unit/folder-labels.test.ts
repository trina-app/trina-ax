// The team's top folders in words on screen (docs/DECISIONS.md "Team folder basics"; src/lib/folderLabels.ts over
// shared/src/folder-labels.ts): rows and breadcrumbs by their word, paths with their top folder in words, the person's
// own folder as 내 폴더; anything else as it is.
import { describe, expect, test } from 'bun:test'
import { folderWords, topFoldersFirst } from '../../src/lib/folderLabels'

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

describe('the team root in a fixed order', () => {
  const folder = (path: string) => ({ path, type: 'folder' as const })
  const file = (path: string) => ({ path, type: 'file' as const })
  // the server's order: folders first, by name, then files
  const root = [folder('docs'), folder('groups'), folder('marketing'), folder('projects'), folder('shared'), folder('skills'), folder('users'), file('readme.md')]
  test('at the root: 전사 공유, 부서, 프로젝트, 팀 스킬, 개인 first, then the rest as the server listed it', () => {
    expect(topFoldersFirst(root, '').map((e) => e.path)).toEqual(['shared', 'groups', 'projects', 'skills', 'users', 'docs', 'marketing', 'readme.md'])
    // the words on screen in that order
    const ko = folderWords('ko', 'olga')
    expect(topFoldersFirst(root, '').slice(0, 5).map((e) => ko.name(e.path, e.path))).toEqual(['전사 공유', '부서', '프로젝트', '팀 스킬', '개인'])
    // only the ones that are there (a member sees fewer), never a file of the same name
    expect(topFoldersFirst([folder('a'), folder('skills'), folder('shared'), file('users')], '').map((e) => e.path)).toEqual(['shared', 'skills', 'a', 'users'])
  })
  test('a deeper folder keeps the server\'s order, and nothing to move gives the same list', () => {
    const deep = [folder('shared/b'), folder('shared/a'), file('shared/x.md')]
    expect(topFoldersFirst(deep, 'shared')).toBe(deep)
    const plain = [folder('docs'), file('a.md')]
    expect(topFoldersFirst(plain, '')).toBe(plain)
    // folders named like top folders deeper down are ordinary folders there
    const inner = [folder('groups/shared'), folder('groups/users')]
    expect(topFoldersFirst(inner, 'groups')).toBe(inner)
  })
})
