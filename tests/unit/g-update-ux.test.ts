// Updates need nothing from the team (Admin Home says when an automatic update installs, offers "install now" when it
// will not, and lists what a release left to do): the next opening of the update window in the team's zone, the update
// status fields that carry it, and the after-update to-dos with their check and their dismissal.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { HWP_PLUGIN_ID } from '@mycel/shared/hwp'
import { getSetting } from '../../server/src/admin/settings'
import { AFTER_UPDATE_DISMISSED, AFTER_UPDATE_ACTIONS, dismissAfterUpdate, hwpPluginNeeded, pendingAfterUpdate } from '../../server/src/system/after-update'
import { nextWindow } from '../../server/src/system/update-job'
import { installHwpPlugin, removeHwpPlugin, setHwpPlugin } from '../lib/hwp-plugin'
import { makeCApp, type CApp } from '../lib/c-app'

const at = (iso: string) => new Date(iso)
const iso = (r: ReturnType<typeof nextWindow>) => (r ? { at: r.at.toISOString(), day: r.day } : null)

describe('nextWindow: when the update window opens next', () => {
  test('before the window, the same day (UTC team)', () => {
    expect(iso(nextWindow('03:00-05:00', at('2026-11-04T01:00:00Z'), 'UTC'))).toEqual({ at: '2026-11-04T03:00:00.000Z', day: 'today' })
  })
  test('after the window, the next day', () => {
    expect(iso(nextWindow('03:00-05:00', at('2026-11-04T09:00:00Z'), 'UTC'))).toEqual({ at: '2026-11-05T03:00:00.000Z', day: 'tomorrow' })
    // the end is not inside: 05:00 is already past
    expect(nextWindow('03:00-05:00', at('2026-11-04T05:00:00Z'), 'UTC')?.day).toBe('tomorrow')
  })
  test('inside the window it is now', () => {
    const now = at('2026-11-04T03:30:00Z')
    const r = nextWindow('03:00-05:00', now, 'UTC')
    expect(r?.day).toBe('now')
    expect(r?.at.getTime()).toBe(now.getTime())
  })
  test('the default window when the team has none (null)', () => {
    expect(iso(nextWindow(null, at('2026-11-04T01:00:00Z'), 'UTC'))).toEqual({ at: '2026-11-04T03:00:00.000Z', day: 'today' })
  })
  test('a window that passes midnight: in the evening part, the early part, and between', () => {
    // 23:00-01:00
    expect(nextWindow('23:00-01:00', at('2026-11-04T23:30:00Z'), 'UTC')?.day).toBe('now')
    expect(nextWindow('23:00-01:00', at('2026-11-05T00:30:00Z'), 'UTC')?.day).toBe('now')
    expect(iso(nextWindow('23:00-01:00', at('2026-11-04T12:00:00Z'), 'UTC'))).toEqual({ at: '2026-11-04T23:00:00.000Z', day: 'today' })
    expect(iso(nextWindow('23:00-01:00', at('2026-11-05T01:00:00Z'), 'UTC'))).toEqual({ at: '2026-11-05T23:00:00.000Z', day: 'today' })
  })
  test("the team's zone, not UTC: Asia/Seoul is +9", () => {
    // 2026-11-04 20:00 UTC = 2026-11-05 05:00 in Seoul: the window (03:00-05:00 there) closed, next is Seoul's Nov 6 03:00
    expect(iso(nextWindow('03:00-05:00', at('2026-11-04T20:00:00Z'), 'Asia/Seoul'))).toEqual({ at: '2026-11-05T18:00:00.000Z', day: 'tomorrow' })
    // 2026-11-04 16:00 UTC = Seoul Nov 5 01:00: the window opens later the same Seoul day, though it is "yesterday" in UTC
    expect(iso(nextWindow('03:00-05:00', at('2026-11-04T16:00:00Z'), 'Asia/Seoul'))).toEqual({ at: '2026-11-04T18:00:00.000Z', day: 'today' })
    // in the window in Seoul (Nov 5 03:30) is now
    expect(nextWindow('03:00-05:00', at('2026-11-04T18:30:00Z'), 'Asia/Seoul')?.day).toBe('now')
    // a zone behind UTC: America/Los_Angeles is -8 in November; 2026-11-04 12:00 UTC = 04:00 there, so inside
    expect(nextWindow('03:00-05:00', at('2026-11-04T12:00:00Z'), 'America/Los_Angeles')?.day).toBe('now')
  })
  test('a window that never opens, or an invalid one: null', () => {
    expect(nextWindow('04:00-04:00', at('2026-11-04T01:00:00Z'), 'UTC')).toBeNull()
    expect(nextWindow('00:00-00:00', at('2026-11-04T01:00:00Z'), 'UTC')).toBeNull()
    expect(nextWindow('25:00-26:00', at('2026-11-04T01:00:00Z'), 'UTC')).toBeNull()
  })
})

describe('after-update to-dos', () => {
  let A: CApp
  beforeAll(async () => { A = await makeCApp('g-update-ux') })
  afterAll(async () => { await A.close() })

  const ids = () => pendingAfterUpdate(A.ctx).map((a) => a.id)

  test('HWP plugin: shown while it is not installed (when the list offers it) or not on, gone once it is on', () => {
    removeHwpPlugin(A.ctx)
    // not installed: shown iff this host can get the plugin from the official list
    const offered = hwpPluginNeeded(A.ctx)
    expect(ids().includes('hwp-plugin')).toBe(offered)
    installHwpPlugin(A.ctx, { on: false })
    expect(hwpPluginNeeded(A.ctx)).toBe(true)
    expect(pendingAfterUpdate(A.ctx).find((a) => a.id === 'hwp-plugin')).toEqual({ id: 'hwp-plugin', since: '0.4.0-beta.2', to: `/admin/plugins?focus=${HWP_PLUGIN_ID}` })
    setHwpPlugin(A.ctx, true)
    expect(hwpPluginNeeded(A.ctx)).toBe(false)
    expect(ids()).not.toContain('hwp-plugin')
    setHwpPlugin(A.ctx, false)
    expect(ids()).toContain('hwp-plugin')
  })

  test('dismissing is remembered for the team in settings, once, and survives a fresh read of the database', () => {
    installHwpPlugin(A.ctx, { on: false })
    expect(ids()).toContain('hwp-plugin')
    expect(dismissAfterUpdate(A.ctx, 'hwp-plugin')).toBe(true)
    expect(dismissAfterUpdate(A.ctx, 'hwp-plugin')).toBe(true)
    expect(getSetting<string[]>(A.ctx.db, AFTER_UPDATE_DISMISSED)).toEqual(['hwp-plugin'])
    expect(ids()).not.toContain('hwp-plugin')
    // a new server process reads the same row (nothing is kept in memory)
    const row = A.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(AFTER_UPDATE_DISMISSED) as { value: string }
    expect(JSON.parse(row.value)).toEqual(['hwp-plugin'])
    // an id nobody knows is refused and writes nothing
    expect(dismissAfterUpdate(A.ctx, 'nope')).toBe(false)
    expect(getSetting<string[]>(A.ctx.db, AFTER_UPDATE_DISMISSED)).toEqual(['hwp-plugin'])
  })

  test('every entry has a stable id, a version and an admin path', () => {
    for (const a of AFTER_UPDATE_ACTIONS) {
      expect(a.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(a.since).toMatch(/^\d+\.\d+\.\d+/)
      expect(a.to.startsWith('/admin/')).toBe(true)
    }
    expect(API.afterUpdateActions.path).toBe('/api/admin/after-update')
  })
})
