// The Trina history filter's Status "Confidential" (nav/HistoryList.tsx, QA TC-1031): shown only while Safe operations 1A
// is on for this server (Me.server.allChatsConfidential) or when a chat in the list is confidential (a 1A workflow worked
// in it); a kept "Confidential" whose option is hidden is "Active", and comes back with the option.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_RECENTS_VIEW, rememberedView, shownView, showsConfidential, viewOptions } from '../../src/components/nav/HistoryList'

const ids = (k: Parameters<typeof viewOptions>[0], on: boolean) => viewOptions(k, on).map(([id]) => id)

describe('the Status option "Confidential"', () => {
  test('shown while 1A is on, or when one chat in the list is confidential; hidden otherwise', () => {
    expect(showsConfidential({ safeOps: false, chats: [] })).toBe(false)
    expect(showsConfidential({ safeOps: false, chats: [{}, {}] })).toBe(false)
    expect(showsConfidential({ safeOps: true, chats: [] })).toBe(true)
    expect(showsConfidential({ safeOps: false, chats: [{}, { confidential: true }] })).toBe(true)
  })

  test('the Status choices leave it out when it is hidden; the other menus are the same either way', () => {
    expect(ids('status', true)).toEqual(['all', 'waiting', 'project', 'noProject', 'confidential'])
    expect(ids('status', false)).toEqual(['all', 'waiting', 'project', 'noProject'])
    for (const k of ['activity', 'group', 'sort'] as const) expect(ids(k, false)).toEqual(ids(k, true))
  })

  test('a kept "Confidential" is "Active" while the option is hidden, and itself again once it is shown', () => {
    const kept = { ...DEFAULT_RECENTS_VIEW, status: 'confidential' as const, sort: 'title' as const }
    expect(shownView(kept, false)).toEqual({ ...kept, status: 'all' })
    expect(shownView(kept, true)).toBe(kept)
    const waiting = { ...DEFAULT_RECENTS_VIEW, status: 'waiting' as const }
    expect(shownView(waiting, false)).toBe(waiting)
  })
})

// Group by defaults to Date (the owner, 2026-11-22: docs/decisions/20261122-history-view-per-person.md; None from
// 2026-11-14, QA TC-1080); a view kept while Project was the default (never kept itself: only what differed) must not
// stay grouped by project
describe('Group by defaults to Date, and kept views move to it', () => {
  const store = new Map<string, string>()
  const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() }
  const prev = (globalThis as { localStorage?: unknown }).localStorage
  const withStore = (f: () => void) => {
    ;(globalThis as { localStorage?: unknown }).localStorage = ls
    store.clear()
    try { f() } finally { (globalThis as { localStorage?: unknown }).localStorage = prev }
  }

  test('the default is by date', () => {
    expect(DEFAULT_RECENTS_VIEW.group).toBe('date')
    withStore(() => expect(rememberedView()).toEqual(DEFAULT_RECENTS_VIEW))
  })

  test('a view of the Project-default days keeps its other choices and takes the default grouping', () => {
    withStore(() => {
      store.set('mycel.sidebar.historyView', JSON.stringify({ sort: 'title' }))
      expect(rememberedView()).toEqual({ ...DEFAULT_RECENTS_VIEW, sort: 'title' })
      store.set('mycel.sidebar.historyView', JSON.stringify({ group: 'project', status: 'waiting' }))
      expect(rememberedView()).toEqual({ ...DEFAULT_RECENTS_VIEW, status: 'waiting' })
      // a choice of that time that was not the default stays
      store.set('mycel.sidebar.historyView', JSON.stringify({ group: 'date' }))
      expect(rememberedView().group).toBe('date')
    })
  })

  test('Group by: Project chosen now is kept under the new key; the older keys are not read then', () => {
    withStore(() => {
      store.set('mycel.sidebar.historyView.v2', JSON.stringify({ group: 'project' }))
      store.set('mycel.sidebar.historyView', JSON.stringify({ sort: 'title' }))
      expect(rememberedView()).toEqual({ ...DEFAULT_RECENTS_VIEW, group: 'project' })
    })
  })

  test('the view from before 11-12 (the whole view, "date" its default then) keeps its rule', () => {
    withStore(() => {
      store.set('mycel.sidebar.recentsView', JSON.stringify({ status: 'all', activity: 'all', group: 'date', sort: 'created' }))
      expect(rememberedView()).toEqual({ ...DEFAULT_RECENTS_VIEW, sort: 'created' })
    })
  })
})
