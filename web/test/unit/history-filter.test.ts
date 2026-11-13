// The Trina history filter's Status "Confidential" (nav/HistoryList.tsx, QA TC-1031): shown only while Safe operations 1A
// is on for this server (Me.server.allChatsConfidential) or when a chat in the list is confidential (a 1A workflow worked
// in it); a kept "Confidential" whose option is hidden is "Active", and comes back with the option.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_RECENTS_VIEW, shownView, showsConfidential, viewOptions } from '../../src/components/nav/HistoryList'

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
