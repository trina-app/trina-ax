// The phone's screens and what a navigation does to a tab's stack (lib/screens.ts, lib/screenHistory.ts planFor; QA
// TC-244): parents, one screen whatever its passing query says, Files as a tree, back to a screen already in the stack
// instead of a second copy of it.
import { describe, expect, test } from 'bun:test'
import { chainOf, parentOf, rootTab, sameScreen, screenOf } from '../../src/lib/screens'
import { isOverlay, planFor, type Item } from '../../src/lib/screenHistory'

const items = (...ps: string[]): Item[] => ps.map((p, i) => ({ k: `k${i}`, p }))
const f = (p: string) => `/files?path=${encodeURIComponent(p)}`
/** a plan without its new keys: how far back, what replaces, the addresses pushed */
const plan = (trail: Item[], to: string, kind: 'push' | 'replace' = 'push') => {
  const p = planFor(trail, { k: 'new', p: to }, kind)
  return { back: p.back, replace: p.replace?.p, push: p.push.map((x) => x.p) }
}

describe('the table', () => {
  test('parents: a tab\'s root has none; pages under ☰ and 나 go to their list', () => {
    expect(parentOf('/')).toBeNull()
    expect(parentOf('/rooms')).toBeNull()
    expect(parentOf('/files')).toBeNull()
    expect(parentOf('/settings')).toBeNull()
    expect(parentOf('/projects')).toBe('/')
    expect(parentOf('/projects/p1')).toBe('/projects')
    expect(parentOf('/?project=p1')).toBe('/projects/p1')
    expect(parentOf('/c/x')).toBe('/')
    expect(parentOf('/scheduled/s1')).toBe('/scheduled')
    expect(parentOf('/skills/share/s1')).toBe('/skills')
    expect(parentOf('/connectors/google-drive')).toBe('/connectors')
    expect(parentOf('/connectors/mcp/i1')).toBe('/connectors')
    expect(parentOf('/rooms/r1')).toBe('/rooms')
    expect(parentOf('/rooms/r1/t/m1')).toBe('/rooms/r1')
    expect(parentOf('/settings/memory')).toBe('/settings')
    expect(parentOf('/settings/account/delete')).toBe('/settings/profile')
    expect(parentOf('/activity')).toBe('/settings')
    expect(parentOf('/admin')).toBe('/settings')
    expect(parentOf('/admin/members')).toBe('/admin')
    expect(parentOf('/admin/settings/ai')).toBe('/admin/settings')
  })

  test('Files: a folder\'s parent is the folder above it, a file\'s its folder', () => {
    expect(parentOf(f('groups/leads/회사'))).toBe(f('groups/leads'))
    expect(parentOf(f('groups'))).toBe('/files')
    expect(parentOf(`/files/view?path=${encodeURIComponent('groups/leads/a.txt')}`)).toBe(f('groups/leads'))
    expect(chainOf(f('groups/leads'))).toEqual(['/files', f('groups'), f('groups/leads')])
    expect(chainOf('/admin/settings/ai')).toEqual(['/settings', '/admin', '/admin/settings', '/admin/settings/ai'])
  })

  test('one screen: the Trash view and a picked-out row are the folder still; elsewhere the whole address counts', () => {
    expect(sameScreen('/files', '/files?view=trash')).toBe(true)
    expect(sameScreen(f('a'), `${f('a')}&select=x&access=1`)).toBe(true)
    expect(sameScreen(f('a'), f('b'))).toBe(false)
    expect(sameScreen('/admin/folders', '/admin/folders?view=people')).toBe(false)
    expect(sameScreen('/skills', '/skills?catalog=open')).toBe(true)
    expect(sameScreen('/settings/memory', '/settings/memory#x')).toBe(true)
  })

  test('tabs: the stack an address starts, and the roots', () => {
    expect(screenOf('/connectors').tab).toBe('ai')
    expect(screenOf('/activity').tab).toBe('me')
    expect(screenOf('/welcome').tab).toBeNull()
    expect(rootTab('/files?view=trash')).toBe('files')
    expect(rootTab('/?project=p1')).toBeNull()
    expect(rootTab('/settings')).toBe('me')
    expect(rootTab('/settings/memory')).toBeNull()
  })
})

describe('a navigation on a phone', () => {
  test('down: a push', () => {
    expect(plan(items('/', '/projects'), '/projects/p1')).toEqual({ back: 0, replace: undefined, push: ['/projects/p1'] })
  })

  test('to a screen already in the stack: back to it, replaced only when its address differs', () => {
    // the chat's project link when the chat was opened from the project: no ping-pong
    expect(plan(items('/', '/projects', '/projects/p1', '/c/x'), '/projects/p1')).toEqual({ back: 1, replace: undefined, push: [] })
    // Admin's editor closing back to the folder with its panel to open again
    expect(plan(items('/files', f('a'), '/admin/folders?edit=a&from=files'), `${f('a')}&access=1`)).toEqual({ back: 1, replace: `${f('a')}&access=1`, push: [] })
    // a replace to a list under the page goes back to it (the list Admin puts under a page)
    expect(plan(items('/settings', '/admin', '/admin/members', '/connectors/x', '/admin/groups'), '/admin', 'replace')).toEqual({ back: 3, replace: undefined, push: [] })
  })

  test('the same screen: a replace (Team folder ↔ Trash, a row picked out)', () => {
    expect(plan(items('/files', f('a')), `${f('a')}&view=trash`)).toEqual({ back: 0, replace: `${f('a')}&view=trash`, push: [] })
    expect(plan(items('/files', f('a')), `${f('a')}&select=x`)).toEqual({ back: 0, replace: `${f('a')}&select=x`, push: [] })
  })

  test('Files is a tree: a folder deeper gets the folders between; another branch goes back to where they meet', () => {
    expect(plan(items('/files'), f('a/b/c'))).toEqual({ back: 0, replace: undefined, push: [f('a'), f('a/b'), f('a/b/c')] })
    expect(plan(items('/files', f('a'), f('a/b'), f('a/b/c')), f('a/x'))).toEqual({ back: 2, replace: undefined, push: [f('a/x')] })
    expect(plan(items('/files', f('a'), f('a/b')), f('z'))).toEqual({ back: 2, replace: undefined, push: [f('z')] })
    // a breadcrumb: back to the folder
    expect(plan(items('/files', f('a'), f('a/b'), f('a/b/c')), f('a'))).toEqual({ back: 2, replace: undefined, push: [] })
  })

  test('Files entered from a chat: the folders shown since are replaced by one above where it was entered', () => {
    expect(plan(items('/', '/c/x', f('a/b')), f('a'))).toEqual({ back: 0, replace: f('a'), push: [] })
    expect(plan(items('/', '/c/x', f('a/b')), f('a/b/c'))).toEqual({ back: 0, replace: undefined, push: [f('a/b/c')] })
    // a file from a chat is pushed on the chat's stack: Back goes to the chat
    expect(plan(items('/', '/c/x'), `/files/view?path=${encodeURIComponent('a/b.txt')}`).push).toHaveLength(1)
  })

  test('overlay entries are the ones marked with a "__" field', () => {
    expect(isOverlay({ usr: null, key: 'k', idx: 1, __backCloses: 3 })).toBe(true)
    expect(isOverlay({ usr: null, key: 'k', idx: 1, __imageViewer: 1 })).toBe(true)
    expect(isOverlay({ usr: null, key: 'k', idx: 1, scr: {} })).toBe(false)
    expect(isOverlay(null)).toBe(false)
  })
})
