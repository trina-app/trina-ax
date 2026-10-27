// The operator's notices banner (lib/managedNotices.ts; server/src/system/managed.ts): what this browser hid, critical
// notices that cannot be hidden, notices past their time.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ManagedNotice } from '@mycel/shared/api'
import { dismissNotice, dismissedNotices, visibleNotices } from '../../src/lib/managedNotices'

const n = (id: string, level: ManagedNotice['level'], until: string | null = null): ManagedNotice => ({ id, level, text: id, link: null, until, dismissible: level !== 'critical' })
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
})

describe('managed notices', () => {
  test('hidden info / warn stay hidden on this browser; critical ones always show', () => {
    const items = [n('grant', 'critical'), n('billing', 'warn'), n('maint', 'info')]
    expect(visibleNotices(items, []).map((x) => x.id)).toEqual(['grant', 'billing', 'maint'])
    let d = dismissNotice('maint')
    d = dismissNotice('grant', d)
    expect(dismissedNotices()).toEqual(['maint', 'grant'])
    expect(visibleNotices(items, dismissedNotices()).map((x) => x.id)).toEqual(['grant', 'billing'])
  })
  test('past its time: gone even while the page stays open; nothing from an older server', () => {
    const now = Date.parse('2026-10-22T12:00:00Z')
    expect(visibleNotices([n('a', 'info', '2026-10-22T11:00:00Z'), n('b', 'warn', '2026-10-23T00:00:00Z')], [], now).map((x) => x.id)).toEqual(['b'])
    expect(visibleNotices(null, [])).toEqual([])
  })
  test('a broken or missing store: nothing is hidden, nothing throws', () => {
    store.set('teamax.notices.dismissed', '{not json')
    expect(dismissedNotices()).toEqual([])
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(dismissedNotices()).toEqual([])
    expect(dismissNotice('x', [])).toEqual(['x'])
  })
})
