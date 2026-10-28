// The update path on Linux (L20): one release key (also the server feed's), the unsigned-bundle default that keeps a
// Mac's staging and roll-back working, staged roll-out, the team's update window, releases that need root, Team AX
// Cloud's managed updates, and the decision of a self-host's automatic update.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { TeamSettings } from '@mycel/shared/api'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { OFFICE_RELEASE_KEYS } from '../../server/src/office/release'
import { silentLogger } from '../../server/src/log'
import { writeManifest } from '../../server/src/system/bundle'
import { RELEASE_PUBLIC_KEYS, UpdateManager, inRollout, type ReleaseFeed } from '../../server/src/system/update'
import { autoUpdateDecision, inWindow } from '../../server/src/system/update-job'
import { resolveLayout } from '../../server/src/system/layout'
import { getOps, systemTestHooks } from '../../server/src/routes/system'
import { OWNER_PW, harness, testConfig, withOwner, type Client, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-update-auto')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })

async function version(app: string, v: string) {
  const dir = path.join(app, 'versions', v)
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'server', 'main.js'), `// ${v}`)
  await writeManifest(dir, v)
  return dir
}
const feed = (o: Partial<ReleaseFeed> = {}): ReleaseFeed => ({ version: '1.1.0', minFrom: null, urgent: false, needsRoot: false, notes: '', publishedAt: new Date().toISOString(), bundles: [], ...o })

describe('release key and unsigned bundles', () => {
  test('one release key for the office feed and the server feed', () => {
    expect(RELEASE_PUBLIC_KEYS.length).toBeGreaterThan(0)
    expect(RELEASE_PUBLIC_KEYS).toEqual(OFFICE_RELEASE_KEYS)
  })
  test('unsigned bundles: allowed while the running version is unsigned (every Mac install), refused once it is signed, allowed with MYCEL_ALLOW_UNSIGNED=1', async () => {
    const app = path.join(W, 'app')
    await version(app, '1.0.0')
    await version(app, '1.1.0')
    fs.symlinkSync(path.join('versions', '1.0.0'), path.join(app, 'current'))
    const mgr = (env: Record<string, string> = {}) => new UpdateManager({ appDir: app, dataDir: path.join(W, 'data'), version: '1.0.0', channel: 'stable', feedUrl: null, log: silentLogger, env })
    expect(mgr().runningSigned()).toBe(false)
    await expect(mgr().switchTo('1.1.0')).resolves.toEqual({ from: '1.0.0', to: '1.1.0' })
    // roll back to the unsigned previous version works the same way
    fs.rmSync(path.join(app, 'current')); fs.symlinkSync(path.join('versions', '1.0.0'), path.join(app, 'current'))
    fs.writeFileSync(path.join(app, 'versions', '1.0.0', 'manifest.sig'), JSON.stringify({ keyId: '0000000000000000', sig: 'x' }))
    expect(mgr().runningSigned()).toBe(true)
    await expect(mgr().switchTo('1.1.0')).rejects.toThrow(/not signed/)
    await expect(mgr({ MYCEL_ALLOW_UNSIGNED: '1' }).switchTo('1.1.0')).resolves.toMatchObject({ to: '1.1.0' })
  })
})

describe('roll-out, window, decision', () => {
  test('roll-out buckets are stable per install and follow the percent', () => {
    expect(inRollout(feed(), 'a')).toBe(true)
    expect(inRollout(feed({ rollout: { percent: 0, salt: 's' } }), 'a')).toBe(false)
    expect(inRollout(feed({ rollout: { percent: 100, salt: 's' } }), 'a')).toBe(true)
    const ids = Array.from({ length: 400 }, (_, i) => `install-${i}`)
    const in30 = ids.filter((id) => inRollout(feed({ rollout: { percent: 30, salt: 'r1' } }), id)).length
    expect(in30).toBeGreaterThan(80)
    expect(in30).toBeLessThan(160)
    expect(ids.map((id) => inRollout(feed({ rollout: { percent: 30, salt: 'r1' } }), id))).toEqual(ids.map((id) => inRollout(feed({ rollout: { percent: 30, salt: 'r1' } }), id)))
  })
  test('the window is the team\'s wall clock; it may pass midnight', () => {
    expect(inWindow(null, new Date('2026-10-21T18:30:00Z'), 'Asia/Seoul')).toBe(true) // 03:30 KST, default 03:00-05:00
    expect(inWindow(null, new Date('2026-10-21T18:30:00Z'), 'UTC')).toBe(false)
    expect(inWindow('23:00-01:00', new Date('2026-10-21T23:30:00Z'), 'UTC')).toBe(true)
    expect(inWindow('23:00-01:00', new Date('2026-10-21T00:30:00Z'), 'UTC')).toBe(true)
    expect(inWindow('23:00-01:00', new Date('2026-10-21T01:30:00Z'), 'UTC')).toBe(false)
  })
  test('window starts are inclusive, ends exclusive, including midnight and the null default', () => {
    const at = (time: string) => new Date(`2026-10-21T${time}:00Z`)
    for (const [window, start, end] of [['00:00-23:59', '00:00', '23:59'], ['23:59-00:00', '23:59', '00:00'], ['23:00-01:00', '23:00', '01:00'], [null, '03:00', '05:00']] as const) {
      expect(inWindow(window, at(start), 'UTC')).toBe(true)
      expect(inWindow(window, at(end), 'UTC')).toBe(false)
    }
  })
  test('invalid stored windows and equal endpoints stay closed throughout the day', () => {
    for (const window of ['25:00-26:00', '25:00-01:00', '00:00-25:00', '23:60-01:00', '00:00-23:60', '24:00-00:00', '00:00-24:00', '', 'bad', '00:00-00:00', '12:34-12:34']) {
      for (let minute = 0; minute < 1440; minute++) {
        expect(inWindow(window, new Date(Date.UTC(2026, 9, 21, 0, minute)), 'UTC'), window).toBe(false)
      }
    }
  })
  test('take it only when newer, app-only, in the roll-out, not held, in the window, nothing running', () => {
    const now = new Date('2026-10-21T18:30:00Z')
    const base = { feed: feed(), current: '1.0.0', installId: 'i', now, tz: 'Asia/Seoul', window: null, running: 0, history: [] }
    expect(autoUpdateDecision(base)).toEqual({ go: true, version: '1.1.0' })
    expect(autoUpdateDecision({ ...base, feed: null })).toMatchObject({ why: 'no_feed' })
    expect(autoUpdateDecision({ ...base, current: '1.1.0' })).toMatchObject({ why: 'up_to_date' })
    expect(autoUpdateDecision({ ...base, feed: feed({ needsRoot: true }) })).toMatchObject({ why: 'needs_root' })
    expect(autoUpdateDecision({ ...base, feed: feed({ rollout: { percent: 0, salt: 'x' } }) })).toMatchObject({ why: 'rollout' })
    const rolledBack = [{ at: new Date(now.getTime() - 86_400_000).toISOString(), from: '1.0.0', to: '1.1.0', result: 'rolled_back' as const, detail: null }]
    expect(autoUpdateDecision({ ...base, history: rolledBack })).toMatchObject({ why: 'held' })
    expect(autoUpdateDecision({ ...base, history: [{ ...rolledBack[0]!, at: new Date(now.getTime() - 8 * 86_400_000).toISOString() }] })).toEqual({ go: true, version: '1.1.0' })
    expect(autoUpdateDecision({ ...base, lastAttempt: { version: '1.1.0', at: now.toISOString() } })).toMatchObject({ why: 'held' })
    expect(autoUpdateDecision({ ...base, window: '00:00-25:00' })).toMatchObject({ go: false, why: 'outside_window' })
    expect(autoUpdateDecision({ ...base, tz: 'UTC' })).toMatchObject({ why: 'outside_window' })
    expect(autoUpdateDecision({ ...base, running: 1 })).toMatchObject({ why: 'busy' })
  })
})

describe('through the app', () => {
  let h: Harness
  let owner: Client
  const app = path.join(W, 'routes-app')
  beforeAll(async () => {
    await version(app, '0.0.1')
    const cfg = testConfig('g-update-routes')
    systemTestHooks.opsOptions = { layout: { ...resolveLayout(cfg), appDir: app }, engines: async () => [] }
    h = await harness('g-update-routes')
    owner = await withOwner(h)
  })
  afterAll(() => { systemTestHooks.opsOptions = null; h.close() })

  test('settings reject invalid windows without storing them and accept valid windows or null', async () => {
    await owner.call('PATCH', '/api/admin/settings', { updateWindow: '23:00-01:00' })
    for (const updateWindow of ['25:00-26:00', '25:00-01:00', '00:00-25:00', '23:60-01:00', '00:00-23:60']) {
      expect((await owner.try('PATCH', '/api/admin/settings', { updateWindow })).status).toBe(400)
      expect(getSetting<string | null>(h.ctx.db, 'updateWindow')).toBe('23:00-01:00')
    }
    for (const updateWindow of ['00:00-23:59', '23:59-00:00', '12:34-12:34', null]) {
      expect((await owner.call('PATCH', '/api/admin/settings', { updateWindow })).updateWindow).toBe(updateWindow)
      expect((await owner.call('GET', '/api/admin/settings')).updateWindow).toBe(updateWindow)
    }
  })
  test('legacy invalid settings remain readable and closed until replaced or cleared', async () => {
    for (const legacy of ['25:00-26:00', '23:60-01:00', '00:00-25:00']) {
      for (const replacement of ['23:00-01:00', null]) {
        setSetting(h.ctx.db, 'updateWindow', legacy)
        const settings = await owner.call('GET', '/api/admin/settings')
        expect(TeamSettings.safeParse(settings).success).toBe(true)
        expect(settings.updateWindow).toBe('00:00-00:00')
        expect(inWindow(settings.updateWindow, new Date('2026-10-21T03:30:00Z'), 'UTC')).toBe(false)
        expect(getSetting<string | null>(h.ctx.db, 'updateWindow')).toBe(legacy) // a read never rewrites the DB
        expect((await owner.call('PATCH', '/api/admin/settings', { updateWindow: replacement })).updateWindow).toBe(replacement)
        expect(getSetting<string | null>(h.ctx.db, 'updateWindow')).toBe(replacement)
      }
    }
  })
  test('corrupt window JSON also stays closed and can be cleared', async () => {
    h.ctx.db.query("UPDATE settings SET value = ? WHERE key = 'updateWindow'").run('{broken')
    const settings = await owner.call('GET', '/api/admin/settings')
    expect(settings.updateWindow).toBe('00:00-00:00')
    expect(inWindow(settings.updateWindow, new Date('2026-10-21T03:30:00Z'), 'UTC')).toBe(false)
    expect((await owner.call('PATCH', '/api/admin/settings', { updateWindow: null })).updateWindow).toBeNull()
  })
  test('a release that needs root is shown (needsRoot) and not installed from here (409)', async () => {
    fs.writeFileSync(path.join(h.ctx.config.dataDir, 'update-check.json'), JSON.stringify({ at: new Date().toISOString(), error: null, feed: feed({ version: '99.0.0', needsRoot: true }) }))
    const st = await owner.call('GET', '/api/admin/update')
    expect(st).toMatchObject({ needsRoot: true, available: { version: '99.0.0' }, auto: false, managed: false })
    const r = await owner.try('POST', '/api/admin/update', { password: OWNER_PW })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('sudo mycel-ctl update')
    const d = await owner.call('GET', '/api/admin/diagnostics')
    expect(d.checks.find((c: { id: string }) => c.id === 'update_root')).toMatchObject({ status: 'warn' })
  })
  test('automatic updates: off unless update.auto on a self-host; never on Team AX Cloud', async () => {
    const ops = getOps(h.ctx)!
    expect(ops.autoUpdates).toBe(false)
    expect(await ops.autoUpdateTick()).toBe('off')
    h.ctx.config.update = { ...h.ctx.config.update, auto: true }
    expect(ops.autoUpdates).toBe(true)
    expect(await ops.autoUpdateTick()).toBe('no_feed') // no feed URL configured
    h.ctx.config.deployment = 'hosted'
    expect(ops.autoUpdates).toBe(false)
    h.ctx.config.deployment = undefined
    h.ctx.config.update = { ...h.ctx.config.update, auto: false }
  })
  test('the maintenance lock is the ops service\'s: what the automatic update holds, the buttons wait for', async () => {
    const ops = getOps(h.ctx)!
    expect(ops.tryLock('update')).toBe(true)
    expect(ops.tryLock('backup')).toBe(false)
    const r = await owner.try('POST', '/api/admin/backup', { scope: 'db' })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('busy')
    ops.unlock()
    expect((await owner.try('POST', '/api/admin/backup', { scope: 'db' })).status).toBe(202)
  })
})
