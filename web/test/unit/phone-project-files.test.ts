// A project's files on a phone (QA TC-254; pages/Projects.tsx ProjectFiles, lib/screens.ts): a screen of the 트리나 tab
// under the project's page, its folders under each other (?dir= in the project's folder), so Back goes up a
// folder and then to the project, never into the team folder; a folder's address is one screen however it is written.
import { describe, expect, test } from 'bun:test'
import { chainOf, parentOf, rootTab, sameScreen, screenOf } from '../../src/lib/screens'
import { projectDir } from '../../src/pages/Projects'

describe('the project files screen', () => {
  test('in the 트리나 tab, under its project; a folder under the folder above', () => {
    expect(screenOf('/projects/p1/files').tab).toBe('ai')
    expect(parentOf('/projects/p1/files')).toBe('/projects/p1')
    expect(parentOf('/projects/p1/files?dir=sub')).toBe('/projects/p1/files')
    expect(parentOf('/projects/p1/files?dir=a%2Fb')).toBe('/projects/p1/files?dir=a')
    expect(parentOf('/projects/p1/files?dir=a%2Fb%2Fc')).toBe(`/projects/p1/files?dir=${encodeURIComponent('a/b')}`)
    expect(chainOf('/projects/p1/files?dir=a%2Fb')).toEqual(['/', '/projects/p1', '/projects/p1/files', '/projects/p1/files?dir=a', '/projects/p1/files?dir=a%2Fb'])
    expect(rootTab('/projects/p1/files')).toBeNull()
    // the project's own page and 모든 프로젝트 are under 트리나's list, the tab's root
    expect(parentOf('/projects/p1')).toBe('/')
    expect(parentOf('/projects')).toBe('/')
    expect(rootTab('/projects')).toBeNull()
    expect(rootTab('/')).toBe('ai')
  })

  test('one screen however the folder is written; another folder or project is another', () => {
    expect(sameScreen('/projects/p1/files?dir=a%2Fb', '/projects/p1/files?dir=a/b')).toBe(true)
    expect(sameScreen('/projects/p1/files?dir=a/b/', '/projects/p1/files?dir=a/b')).toBe(true)
    expect(sameScreen('/projects/p1/files', '/projects/p1/files?dir=')).toBe(true)
    expect(sameScreen('/projects/p1/files?dir=a', '/projects/p1/files?dir=b')).toBe(false)
    expect(sameScreen('/projects/p1/files', '/projects/p2/files')).toBe(false)
    expect(sameScreen('/projects/p1/files', '/projects/p1')).toBe(false)
  })

  test('the folder from the address stays inside the project folder', () => {
    expect(projectDir(null)).toBe('')
    expect(projectDir('sub')).toBe('sub')
    expect(projectDir('/a//b/')).toBe('a/b')
    expect(projectDir('../../users/kim')).toBe('users/kim')
    expect(projectDir('a/./../b')).toBe('a/b')
  })
})
