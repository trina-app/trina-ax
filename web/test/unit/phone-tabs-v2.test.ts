// The phone's tabs (docs/DECISIONS.md "Phone tabs: 트리나 · 대화 · 파일 · 나"): which tab an address belongs to, the
// parents (lib/screens.ts), the stacks of the old 프로젝트 tab kept across an update (knownTab), the new-chat address
// (lib/newChat.ts newChatPath) and what Home does with its address (homeRoute).
import { describe, expect, test } from 'bun:test'
import { homeRoute, newChatPath } from '../../src/lib/newChat'
import { chainOf, parentOf, rootTab, sameScreen, screenOf } from '../../src/lib/screens'
import { knownTab, planFor, type Item } from '../../src/lib/screenHistory'
import { hidesTabs, isTabNow, PHONE_TABS, tabOf } from '../../src/lib/tabs'

const f = (p: string) => `/files?path=${encodeURIComponent(p)}`
const items = (...ps: string[]): Item[] => ps.map((p, i) => ({ k: `k${i}`, p }))

describe('the tabs', () => {
  test('the five tabs: 트리나 · 대화 · 프로젝트 · 파일 · 나', () => {
    expect(PHONE_TABS).toEqual(['ai', 'chats', 'projects', 'files', 'me'])
    expect(isTabNow('projects')).toBe(true)
    for (const p of ['/', '/new', '/c/x', '/scheduled', '/skills', '/trash']) expect(tabOf(p)).toBe('ai')
    for (const p of ['/projects', '/projects/p1', '/projects/p1/files']) expect(tabOf(p)).toBe('projects')
    for (const p of ['/files', '/files/view']) expect(tabOf(p)).toBe('files')
    expect(tabOf('/rooms/r1')).toBe('chats')
    for (const p of ['/settings', '/activity', '/admin']) expect(tabOf(p)).toBe('me')
    // the new chat has the box at the bottom: no tab bar there
    expect(hidesTabs('/new')).toBe(true)
    expect(hidesTabs('/')).toBe(false)
  })

  test('parents: a project under 프로젝트\'s list, a new chat under the list or its project', () => {
    expect(parentOf('/')).toBeNull()
    expect(parentOf('/new')).toBe('/')
    expect(parentOf('/new?prompt=hi')).toBe('/')
    expect(parentOf('/new?project=p1')).toBe('/projects/p1')
    expect(parentOf('/?project=p1')).toBe('/projects/p1')
    expect(screenOf('/?project=p1').tab).toBe('projects')
    expect(parentOf('/projects')).toBeNull()
    expect(parentOf('/projects/p1')).toBe('/projects')
    expect(screenOf('/projects/p1/files').tab).toBe('projects')
    // one screen, whatever its question
    expect(sameScreen('/new', '/new?prompt=hi')).toBe(true)
    expect(rootTab('/')).toBe('ai')
    expect(rootTab('/projects')).toBe('projects')
  })

  test('파일: the places are the root; their own folders, the trash, recent files and the team folder\'s top under them', () => {
    expect(parentOf('/files')).toBeNull()
    expect(rootTab('/files')).toBe('files')
    expect(parentOf('/files?view=trash')).toBe('/files')
    expect(parentOf('/files?view=recent')).toBe('/files')
    expect(parentOf('/files?team=1')).toBe('/files')
    expect(sameScreen('/files', '/files?team=1')).toBe(false)
    expect(parentOf(f('shared'))).toBe('/files')
    expect(parentOf(f('projects/launch'))).toBe('/files')
    expect(parentOf(f('users/u1'))).toBe('/files')
    expect(parentOf(f('shared/a'))).toBe(f('shared'))
    expect(parentOf(`/files/view?path=${encodeURIComponent('projects/launch/plan.md')}`)).toBe(f('projects/launch'))
    expect(chainOf(f('projects/launch/a'))).toEqual(['/files', f('projects/launch'), f('projects/launch/a')])
    // from the places into a project's folder and down: Back is the folder above, then the places
    expect(planFor(items('/files', f('projects/launch')), { k: 'n', p: f('projects/launch/a') }, 'push').push.map((x) => x.p)).toEqual([f('projects/launch/a')])
  })

  test('an entry of the old 프로젝트 tab (its first screen the team folder, kept across an update) takes its first screen\'s tab', () => {
    expect(knownTab({ tab: 'projects', root: { k: 'a', p: '/projects' } })).toBe('projects')
    expect(knownTab({ tab: 'projects', root: { k: 'a', p: '/files' } })).toBe('files')
    expect(knownTab({ tab: 'files', root: { k: 'a', p: '/files' } })).toBe('files')
  })

  test('the new-chat address: /new on a phone, / on a computer, with its question and project', () => {
    expect(newChatPath({}, true)).toBe('/new')
    expect(newChatPath({ prompt: 'a b' }, true)).toBe('/new?prompt=a%20b')
    expect(newChatPath({ project: 'p1', prompt: 'x' }, true)).toBe('/new?project=p1&prompt=x')
    expect(newChatPath({}, false)).toBe('/')
    expect(newChatPath({ prompt: 'a' }, false)).toBe('/?prompt=a')
  })
})

describe('Home and its address (homeRoute)', () => {
  test('a phone: / is the list; / with a question or a project goes to /new with it', () => {
    expect(homeRoute('/', '', true)).toEqual({ list: true })
    expect(homeRoute('/', '?prompt=hi', true)).toEqual({ to: '/new?prompt=hi' })
    expect(homeRoute('/', '?project=p1', true)).toEqual({ to: '/new?project=p1' })
    expect(homeRoute('/new', '?prompt=hi', true)).toEqual({ list: false })
  })
  test('a computer: /new goes to / with the same query; / is the box', () => {
    expect(homeRoute('/new', '?prompt=hi', false)).toEqual({ to: '/?prompt=hi' })
    expect(homeRoute('/new', '', false)).toEqual({ to: '/' })
    expect(homeRoute('/', '?prompt=hi', false)).toEqual({ list: false })
  })
})
