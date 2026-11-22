// The Trina history's view kept per person (docs/decisions/20261122-history-view-per-person.md): Group by: Date by
// default, the account keeps only what differs from a surface's default, and a value this version does not know reads
// as absent (never hiding the other choices).
import { describe, expect, test } from 'bun:test'
import { HistoryView, UserPrefs } from '@mycel/shared/api'
import { DEFAULT_RECENTS_VIEW, viewFrom } from '../../src/components/nav/HistoryList'
import { translate } from '../../src/i18n'

describe('the history view', () => {
  test('Group by: Date by default (the owner, 2026-11-22)', () => {
    expect(DEFAULT_RECENTS_VIEW).toEqual({ status: 'all', activity: 'all', group: 'date', sort: 'updated' })
  })
  test("a kept choice over the surface's default", () => {
    expect(viewFrom({ group: 'none' }, DEFAULT_RECENTS_VIEW)).toEqual({ ...DEFAULT_RECENTS_VIEW, group: 'none' })
    expect(viewFrom({}, DEFAULT_RECENTS_VIEW)).toEqual(DEFAULT_RECENTS_VIEW)
  })
  test('the account keeps it; an unknown value reads as absent, the others stay', () => {
    const v = HistoryView.parse({ panel: { group: 'status', sort: 'title' }, drawer: { group: 'none' } })
    expect(v).toEqual({ panel: { group: undefined, sort: 'title' }, drawer: { group: 'none' } })
    const p = UserPrefs.parse({ theme: 'dark', historyView: 'nonsense' })
    expect(p.theme).toBe('dark')
    expect(p.historyView).toBeUndefined()
  })
  test('Reset to defaults in every language', () => {
    for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) expect(translate(l, 'sidebar.filter.reset')).not.toBe('sidebar.filter.reset')
    expect(translate('en', 'sidebar.filter.reset')).toBe('Reset to defaults')
  })
})
