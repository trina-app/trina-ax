// The update path on Linux (L20): one release key (also the server feed's), the unsigned-bundle default that keeps a
// Mac's staging and roll-back working, staged roll-out, the team's update window, releases that need root, Team AX
// Cloud's managed updates, and the decision of a self-host's automatic update.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { TeamSettings } from '@mycel/shared/api'
import { Database } from 'bun:sqlite'
import { existingInstallId, getSetting, installId, setSetting } from '../../server/src/admin/settings'
import { DEFAULT_RAMP } from '../../server/src/system/rollout'
import { OFFICE_RELEASE_KEYS } from '../../server/src/office/release'
import { silentLogger } from '../../server/src/log'
import { writeManifest } from '../../server/src/system/bundle'
import { RELEASE_PUBLIC_KEYS, UpdateManager, inRollout, releaseNeedsRoot, type ReleaseFeed } from '../../server/src/system/update'
import { autoUpdateDecision, DEFAULT_UPDATE_WINDOW, inWindow, updateWindowAnswer } from '../../server/src/system/update-job'
import { resolveLayout } from '../../server/src/system/layout'
import { getOps, systemTestHooks } from '../../server/src/routes/system'
import { M } from '../../server/src/system/messages'
import { OWNER_PW, addMember, harness, testConfig, withOwner, type Client, type Harness } from './a-lib'
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

describe('feed check failures', () => {
  const mgr = (name: string, o: Partial<ConstructorParameters<typeof UpdateManager>[0]>) => {
    const dataDir = path.join(W, name)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'update-check.json'), JSON.stringify({ at: '2026-01-01T00:00:00.000Z', error: null, feed: feed({ version: '9.0.0' }) }))
    return new UpdateManager({ appDir: path.join(W, name, 'app'), dataDir, version: '1.0.0', channel: 'stable', feedUrl: 'https://feed.invalid/feed.json', keys: RELEASE_PUBLIC_KEYS, log: silentLogger, env: {}, ...o })
  }
  test('a failed check keeps the last verified feed (the new version stays), records the new time and error, and returns null', async () => {
    const m = mgr('fail-keeps', { fetch: (async () => { throw new Error('network down') }) as unknown as typeof fetch })
    expect(m.status().available?.version).toBe('9.0.0')
    expect(await m.checkFeed()).toBeNull()
    const st = m.status()
    expect(st.available?.version).toBe('9.0.0')
    expect(st.lastCheckedAt).not.toBe('2026-01-01T00:00:00.000Z')
    expect(JSON.parse(fs.readFileSync(path.join(W, 'fail-keeps', 'update-check.json'), 'utf8')).error).toContain('network down')
  })
  test('a fetch that never answers is aborted by the timeout: the check fails fast and records it', async () => {
    let signals = 0
    const hang = ((_u: string, init?: RequestInit) => new Promise((_r, reject) => { signals += init?.signal ? 1 : 0; init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))) })) as unknown as typeof fetch
    const m = mgr('hang', { fetch: hang, feedTimeoutMs: 50 })
    const t0 = Date.now()
    expect(await m.checkFeed()).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(signals).toBe(2)
    expect(m.status().lastCheckedAt).not.toBe('2026-01-01T00:00:00.000Z')
    expect(m.status().available?.version).toBe('9.0.0')
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
  test('the same windows as the root update timer (native/cmd/mycel-ctl testdata/update-window.json)', () => {
    const t = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'native', 'cmd', 'mycel-ctl', 'testdata', 'update-window.json'), 'utf8')) as {
      default: string; cases: { window: string; zone: string; at: string; inside: boolean; why: string }[]
    }
    expect(t.cases.length).toBeGreaterThanOrEqual(10)
    expect(t.default).toBe(DEFAULT_UPDATE_WINDOW)
    for (const c of t.cases) expect({ ...c, got: inWindow(c.window, new Date(c.at), c.zone) }).toEqual({ ...c, got: c.inside })
  })
  test('admin.js update-window: the team\'s window or the default, and the zone', () => {
    expect(updateWindowAnswer({ updateWindow: null }, 'Asia/Seoul')).toEqual({ window: '03:00-05:00', timeZone: 'Asia/Seoul', custom: false })
    expect(updateWindowAnswer({ updateWindow: '01:00-02:00' }, 'UTC')).toEqual({ window: '01:00-02:00', timeZone: 'UTC', custom: true })
    // the install id for the root update timer's staged roll-out (system/rollout.ts); none yet: not said (the last wave)
    expect(updateWindowAnswer({ updateWindow: null }, 'UTC', 'install-0')).toEqual({ window: '03:00-05:00', timeZone: 'UTC', custom: false, installId: 'install-0' })
    expect(updateWindowAnswer({ updateWindow: null }, 'UTC', null)).toEqual({ window: '03:00-05:00', timeZone: 'UTC', custom: false })
  })
  test('the install id admin.js reads (read only): MYCEL_INSTALL_ID, else the settings table, else none; it never makes one', () => {
    const db = new Database(':memory:')
    db.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    expect(existingInstallId(db, {})).toBeNull()
    expect(db.query('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 })
    expect(existingInstallId(db, { MYCEL_INSTALL_ID: 'tenant-7' })).toBe('tenant-7')
    expect(existingInstallId(db, { MYCEL_INSTALL_ID: 'bad id/' })).toBeNull()
    const made = installId(db, {})
    expect(existingInstallId(db, {})).toBe(made)
    expect(installId(db, {})).toBe(made)
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
    const base = { feed: feed(), current: '1.0.0', installId: 'i', now, tz: 'Asia/Seoul', window: null, running: 0, history: [], channel: 'stable' as const }
    expect(autoUpdateDecision(base)).toEqual({ go: true, version: '1.1.0' })
    expect(autoUpdateDecision({ ...base, feed: null })).toMatchObject({ why: 'no_feed' })
    expect(autoUpdateDecision({ ...base, current: '1.1.0' })).toMatchObject({ why: 'up_to_date' })
    expect(autoUpdateDecision({ ...base, feed: feed({ needsRoot: true }) })).toMatchObject({ why: 'needs_root' })
    expect(autoUpdateDecision({ ...base, feed: feed({ rollout: { percent: 0, salt: 'x' } }) })).toMatchObject({ why: 'rollout' })
    const rolledBack = [{ at: new Date(now.getTime() - 86_400_000).toISOString(), from: '1.0.0', to: '1.1.0', result: 'rolled_back' as const, detail: null }]
    expect(autoUpdateDecision({ ...base, history: rolledBack })).toMatchObject({ why: 'held' })
    expect(autoUpdateDecision({ ...base, history: [{ ...rolledBack[0]!, at: new Date(now.getTime() - 8 * 86_400_000).toISOString() }] })).toEqual({ go: true, version: '1.1.0' })
    expect(autoUpdateDecision({ ...base, lastAttempt: { version: '1.1.0', at: now.toISOString() } })).toMatchObject({ why: 'held' })
    // what the bootstrap writes for a roll-back: from the failed version to the previous one (native/cmd/mycel-bootstrap)
    const bootstrap = [{ at: new Date(now.getTime() - 86_400_000).toISOString(), from: '1.1.0', to: '1.0.0', result: 'rolled_back' as const, detail: 'exited 3 times' }]
    expect(autoUpdateDecision({ ...base, history: bootstrap })).toMatchObject({ why: 'held' })
    expect(autoUpdateDecision({ ...base, history: [{ ...bootstrap[0]!, from: '1.0.5' }] })).toEqual({ go: true, version: '1.1.0' })
    // a release root's update failed here (root/update-failed.json) is the root update timer's to try again (0.2.19 review S1)
    expect(autoUpdateDecision({ ...base, rootHold: '1.1.0' })).toMatchObject({ go: false, why: 'held' })
    expect(autoUpdateDecision({ ...base, rootHold: '1.0.9' })).toEqual({ go: true, version: '1.1.0' })
    expect(autoUpdateDecision({ ...base, window: '00:00-25:00' })).toMatchObject({ go: false, why: 'outside_window' })
    expect(autoUpdateDecision({ ...base, tz: 'UTC' })).toMatchObject({ why: 'outside_window' })
    expect(autoUpdateDecision({ ...base, running: 1 })).toMatchObject({ why: 'busy' })
  })
  test('rootSince: root files older than it need root even when needsRoot is false (update audit P4)', () => {
    for (const [needsRoot, rootSince, root, want] of [
      [true, undefined, '9.9.9', true], [false, undefined, '0.0.1', false], [false, '1.0.5', '1.0.4', true], [false, '1.0.5', '1.0.5', false],
      [false, '1.0.5', '1.1.0-pre.1', false], [false, '1.0.5', '1.0.5-pre.1', true], [false, '1.0.5', null, true], [false, '1.0.5', 'not a version!', true],
      // with rootSince, needsRoot is for the updaters of 0.2.18 and older (0.2.19 review S3): rootSince alone decides here
      [true, '1.0.5', '1.0.5', false], [true, '1.0.5', '1.0.4', true], [true, '1.0.5', null, true],
    ] as const) expect({ needsRoot, rootSince, root, got: releaseNeedsRoot({ needsRoot, rootSince }, root) }).toEqual({ needsRoot, rootSince, root, got: want })
    const now = new Date('2026-10-21T18:30:00Z')
    const base = { feed: feed({ rootSince: '1.0.5' }), current: '1.0.4', installId: 'i', now, tz: 'Asia/Seoul', window: null, running: 0, history: [], channel: 'stable' as const }
    expect(autoUpdateDecision({ ...base, rootVersion: '1.0.4' })).toMatchObject({ go: false, why: 'needs_root' })
    expect(autoUpdateDecision({ ...base, rootVersion: null })).toMatchObject({ go: false, why: 'needs_root' })
    expect(autoUpdateDecision({ ...base, rootVersion: '1.0.5' })).toEqual({ go: true, version: '1.1.0' })
    // an app-only release keeps needsRoot for old servers: this server takes it by itself all the same
    expect(autoUpdateDecision({ ...base, feed: feed({ needsRoot: true, rootSince: '1.0.5' }), rootVersion: '1.0.5' })).toEqual({ go: true, version: '1.1.0' })
    // the manager reads root/VERSION
    const rootDir = path.join(W, 'root-since')
    fs.mkdirSync(rootDir, { recursive: true })
    const mgr = new UpdateManager({ appDir: null, dataDir: path.join(W, 'data'), version: '1.0.4', channel: 'stable', feedUrl: null, log: silentLogger, rootDir })
    expect(mgr.rootVersion()).toBeNull()
    expect(mgr.needsRoot(feed({ rootSince: '1.0.5' }))).toBe(true)
    fs.writeFileSync(path.join(rootDir, 'VERSION'), '1.0.5\n')
    expect(mgr.rootVersion()).toBe('1.0.5')
    expect(mgr.needsRoot(feed({ rootSince: '1.0.5' }))).toBe(false)
    expect(mgr.needsRoot(feed({ rootSince: '1.0.6' }))).toBe(true)
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
  test('GET /api/admin/update looks at the feed again when the last check is over an hour old, waits for it briefly, and fetches once at a time', async () => {
    const u = getOps(h.ctx)!.updates
    const rec = (ageMin: number, version: string) => fs.writeFileSync(path.join(h.ctx.config.dataDir, 'update-check.json'), JSON.stringify({ at: new Date(Date.now() - ageMin * 60_000).toISOString(), error: null, feed: feed({ version }) }))
    let calls = 0
    let behaviour: 'new' | 'slow' | 'fail' = 'new'
    let release: () => void = () => {}
    Object.defineProperty(u, 'feedUsable', { value: true, configurable: true })
    u.checkFeed = async () => {
      calls++
      if (behaviour === 'fail') throw new Error('offline')
      if (behaviour === 'slow') await new Promise<void>((r) => { release = r })
      rec(0, '99.0.0')
      return feed({ version: '99.0.0' })
    }
    try {
      // fresh (30 minutes): no fetch, the recorded answer
      rec(30, '98.0.0')
      expect((await owner.call('GET', '/api/admin/update')).available.version).toBe('98.0.0')
      expect(calls).toBe(0)
      // stale (2 hours): fetched and waited for, the answer is the new feed
      rec(120, '98.0.0')
      expect((await owner.call('GET', '/api/admin/update')).available.version).toBe('99.0.0')
      expect(calls).toBe(1)
      // two quick calls on a slow feed: one fetch, both answer with the recorded feed after the wait
      systemTestHooks.updateWaitMs = 50
      behaviour = 'slow'
      rec(120, '98.0.0')
      const both = await Promise.all([owner.call('GET', '/api/admin/update'), owner.call('GET', '/api/admin/update')])
      expect(both.map((x) => x.available.version)).toEqual(['98.0.0', '98.0.0'])
      expect(calls).toBe(2)
      release()
      await new Promise((r) => setTimeout(r, 20))
      // an error: the recorded answer, no failure
      behaviour = 'fail'
      rec(120, '98.0.0')
      expect((await owner.call('GET', '/api/admin/update')).available.version).toBe('98.0.0')
      expect(calls).toBe(3)
    } finally {
      systemTestHooks.updateWaitMs = undefined
      release()
      delete (u as unknown as Record<string, unknown>).checkFeed
      delete (u as unknown as Record<string, unknown>).feedUsable
    }
  })
  test('a release in its staged roll-out: the update status says when this server\'s turn comes (turnAt)', async () => {
    const published = new Date(Date.now() - 3600_000)
    const salt = '3f9a1c7e5b2d4086a1e0c9b8f7d6e5a4'
    const check = (o: Partial<ReleaseFeed>) => fs.writeFileSync(path.join(h.ctx.config.dataDir, 'update-check.json'),
      JSON.stringify({ at: new Date().toISOString(), error: null, feed: feed({ version: '99.0.0', publishedAt: published.toISOString(), rollout: { percent: 100, salt, ramp: [...DEFAULT_RAMP] }, ...o }) }))
    setSetting(h.ctx.db, 'system.installId', 'install-0') // bucket 62 with this salt: the third wave
    const was = process.env.MYCEL_INSTALL_ID
    delete process.env.MYCEL_INSTALL_ID
    try {
      check({})
      // hold 'rollout' (Admin Home: installs when it is this server's turn) and when that turn comes
      expect(await owner.call('GET', '/api/admin/update')).toMatchObject({ hold: 'rollout', turnAt: new Date(published.getTime() + 48 * 3600_000).toISOString() })
      // the first wave, an urgent release, the beta channel, no roll-out: no wait, no field, no hold
      const free = async () => { const s = await owner.call('GET', '/api/admin/update'); expect(s.turnAt).toBeUndefined(); expect(s.hold).toBeNull() }
      setSetting(h.ctx.db, 'system.installId', 'install-4')
      await free()
      setSetting(h.ctx.db, 'system.installId', 'install-0')
      check({ urgent: true })
      await free()
      check({ rollout: undefined })
      await free()
      check({})
      h.ctx.config.update = { ...h.ctx.config.update, channel: 'beta' }
      await free()
      h.ctx.config.update = { ...h.ctx.config.update, channel: 'stable' }
      // a roll-out that leaves this server out (percent alone): null, still held by the roll-out
      check({ rollout: { percent: 30, salt } })
      expect(await owner.call('GET', '/api/admin/update')).toMatchObject({ hold: 'rollout', turnAt: null })
      // "Update now" does not wait for the turn: the release is offered and the update starts (it then stops at the
      // download here, which has no feed); the route never asks the roll-out
      check({})
      const ops = getOps(h.ctx)!
      const r = await owner.try('POST', '/api/admin/update', { password: OWNER_PW })
      expect(r.status).toBe(202)
      expect(r.body.jobId).toBeTruthy()
      for (let i = 0; i < 200 && ops.busyWith; i++) await new Promise((x) => setTimeout(x, 50))
      expect(ops.busyWith).toBeNull()
    } finally {
      if (was !== undefined) process.env.MYCEL_INSTALL_ID = was
      fs.rmSync(path.join(h.ctx.config.dataDir, 'update-check.json'), { force: true })
    }
  })
  test('an update download that stalls mid-body fails within the idle window, removes the partial file and frees the operations lock', async () => {
    // a fake release server that sends the first 64 KB of the bundle and then nothing, without closing the connection
    const size = 1024 * 1024
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: () => new Response(new ReadableStream({
      async pull(c) { c.enqueue(new Uint8Array(64 * 1024)); await new Promise(() => {}) },
    }), { headers: { 'content-length': String(size) } }) })
    const ops = getOps(h.ctx)!
    const u = ops.updates
    const o = (u as unknown as { o: Record<string, unknown> }).o
    const os = process.platform === 'darwin' ? 'darwin' : process.platform
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const f = feed({ version: '99.0.0', bundles: [{ os, arch, url: 'https://releases.test/99.0.0.tar.zst', sha256: '0'.repeat(64), size }] } as Partial<ReleaseFeed>)
    fs.writeFileSync(path.join(h.ctx.config.dataDir, 'update-check.json'), JSON.stringify({ at: new Date().toISOString(), error: null, feed: f }))
    u.checkFeed = async () => f
    o.fetch = ((_u: string, init?: RequestInit) => fetch(`http://127.0.0.1:${srv.port}/bundle`, init)) as typeof fetch
    o.downloadIdleMs = 300
    try {
      const r = await owner.try('POST', '/api/admin/update', { password: OWNER_PW, version: '99.0.0' })
      expect(r.status).toBe(202)
      let job: { status: string; error?: { code: string; message: string } } = { status: 'queued' }
      for (let i = 0; i < 100 && (job.status === 'queued' || job.status === 'running'); i++) {
        await new Promise((x) => setTimeout(x, 100))
        job = await owner.call('GET', `/api/jobs/${r.body.jobId}`)
      }
      expect(job.status).toBe('failed')
      expect(Object.values(M.updateStalled)).toContain(job.error!.message)
      expect(ops.busyWith).toBeNull()
      expect(fs.readdirSync(path.join(h.ctx.config.dataDir, 'updates'))).toEqual([]) // no partial bundle left
    } finally {
      srv.stop(true)
      delete (u as unknown as Record<string, unknown>).checkFeed
      delete o.fetch
      delete o.downloadIdleMs
      fs.rmSync(path.join(h.ctx.config.dataDir, 'update-check.json'), { force: true })
    }
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
  test('the update status carries the window and when it opens next only while automatic updates are on (Admin Home says when)', async () => {
    const ops = getOps(h.ctx)!
    const off = await owner.call('GET', '/api/admin/update')
    expect(off.auto).toBe(false)
    expect(off.window).toBeUndefined()
    expect(off.nextWindow).toBeUndefined()
    h.ctx.config.update = { ...h.ctx.config.update, auto: true }
    try {
      expect(ops.updateWindowStatus()).toMatchObject({ window: DEFAULT_UPDATE_WINDOW, nextWindow: { day: expect.stringMatching(/^(now|today|tomorrow)$/) } })
      await owner.call('PATCH', '/api/admin/settings', { updateWindow: '22:00-01:00', timeZone: 'Asia/Seoul' })
      const on = await owner.call('GET', '/api/admin/update')
      expect(on).toMatchObject({ auto: true, window: '22:00-01:00', timeZone: 'Asia/Seoul' })
      expect(Date.parse(on.nextWindow.at)).toBeGreaterThan(Date.now() - 1000)
      expect(['now', 'today', 'tomorrow']).toContain(on.nextWindow.day)
      await owner.call('PATCH', '/api/admin/settings', { updateWindow: '04:00-04:00' })
      expect((await owner.call('GET', '/api/admin/update')).nextWindow).toBeNull()
    } finally {
      await owner.call('PATCH', '/api/admin/settings', { updateWindow: null })
      h.ctx.config.update = { ...h.ctx.config.update, auto: false }
    }
  })
  test('after-update to-dos: listed for an admin, an unknown id is refused, a dismissed one is gone', async () => {
    const list = await owner.call('GET', '/api/admin/after-update')
    expect(Array.isArray(list.items)).toBe(true)
    expect((await owner.try('POST', '/api/admin/after-update/nope/dismiss', {})).status).toBe(404)
    expect((await owner.try('POST', '/api/admin/after-update/hwp-plugin/dismiss', {})).status).toBe(204)
    expect((await owner.call('GET', '/api/admin/after-update')).items.map((a: { id: string }) => a.id)).not.toContain('hwp-plugin')
  })
  test('the update status says what holds a release back from installing by itself (the automatic update\'s own decision)', async () => {
    const check = (f: Partial<ReleaseFeed>) => fs.writeFileSync(path.join(h.ctx.config.dataDir, 'update-check.json'), JSON.stringify({ at: new Date().toISOString(), error: null, feed: feed({ version: '99.0.0', ...f }) }))
    const auto = path.join(h.ctx.config.dataDir, 'update-auto.json')
    h.ctx.config.update = { ...h.ctx.config.update, auto: true }
    try {
      check({})
      expect((await owner.call('GET', '/api/admin/update')).hold).toBeNull()
      // not this server's turn
      check({ rollout: { percent: 0, salt: 'x' } })
      expect((await owner.call('GET', '/api/admin/update')).hold).toBe('rollout')
      // a try of it a moment ago (failed or rolled back): on hold
      check({})
      fs.writeFileSync(auto, JSON.stringify({ version: '99.0.0', at: new Date().toISOString() }))
      expect((await owner.call('GET', '/api/admin/update')).hold).toBe('failed')
      fs.rmSync(auto)
      expect((await owner.call('GET', '/api/admin/update')).hold).toBeNull()
    } finally {
      fs.rmSync(auto, { force: true })
      h.ctx.config.update = { ...h.ctx.config.update, auto: false }
    }
  })
  test('after-update to-dos are for admins: a member gets 403 on the list and on dismiss', async () => {
    const m = await addMember(h, owner, { username: 'mia' })
    expect((await m.client.try('GET', '/api/admin/after-update')).status).toBe(403)
    expect((await m.client.try('POST', '/api/admin/after-update/hwp-plugin/dismiss', {})).status).toBe(403)
  })
  test('the maintenance lock is the ops service\'s: what the automatic update holds, the buttons wait for', async () => {
    const ops = getOps(h.ctx)!
    expect(ops.tryLock('update')).toBe(true)
    expect(ops.tryLock('backup')).toBe(false)
    const r = await owner.try('POST', '/api/admin/backup', { scope: 'db' })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('busy')
    ops.unlock()
    // the old-version prune (seconds) is named, so the owner knows to try again in a moment
    expect(ops.tryLock('prune')).toBe(true)
    const p = await owner.try('POST', '/api/admin/backup', { scope: 'db' })
    expect(p.status).toBe(409)
    expect(p.body.error).toMatchObject({ code: 'busy', message: '서버가 오래된 버전을 지우는 중이에요. 잠시 뒤에 다시 해 주세요.' })
    ops.unlock()
    expect((await owner.try('POST', '/api/admin/backup', { scope: 'db' })).status).toBe(202)
  })
})
