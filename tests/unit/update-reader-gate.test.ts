// A release that cannot open this server's database is never installed (QA row: dev build -> stable). A dev build
// (0.5.3-dev.x) migrated the database to reader level 7; the stable 0.5.3 reads level 6 and sorts after it, so the
// updaters took it, it exited 75 three times and the bootstrap rolled back, again after every hold. The feed's
// minReaderRequired (scripts/release/publish-server.ts) or a staged copy's migrations say the release's level; the
// app's own updater compares it with the database's (db.ts requiredReaderLevel). mycel-ctl has the same rule
// (native/cmd/mycel-ctl/readerlevel.go, readerlevel_test.go).
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReleaseFeed as ProtocolReleaseFeed } from '../../shared/src/cloud-protocol/release'
import { silentLogger } from '../../server/src/log'
import { ReleaseFeed, UpdateManager } from '../../server/src/system/update'
import { autoUpdateDecision, runUpdate } from '../../server/src/system/update-job'
import { _resetUpdateWait } from '../../server/src/system/update-wait'
import type { BackupManager } from '../../server/src/system/backup'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'update-reader-gate-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const base = { version: '0.5.3', minFrom: null, urgent: false, needsRoot: false, notes: '', publishedAt: '2026-11-13T00:00:00.000Z', bundles: [] }

/** app/versions/<v> with migrations up to reader level `level` */
function app(name: string, levels: Record<string, number>, running: string) {
  const dir = path.join(T, name, 'app')
  for (const [v, level] of Object.entries(levels)) {
    const d = path.join(dir, 'versions', v)
    fs.mkdirSync(path.join(d, 'server', 'migrations'), { recursive: true })
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ format: 1, version: v, createdAt: '2026-11-13T00:00:00.000Z', files: {} }))
    fs.writeFileSync(path.join(d, 'server', 'migrations', '121_a_x.sql'), `-- min_compatible_reader: ${level}\nSELECT 1;\n`)
  }
  fs.symlinkSync(`versions/${running}`, path.join(dir, 'current'))
  return dir
}
const mgr = (appDir: string | null, dbLevel?: number) => new UpdateManager({ appDir, dataDir: path.join(T, 'data'), version: '0.5.3-dev.4', channel: 'stable', feedUrl: null, log: silentLogger, ...(dbLevel ? { dbReaderLevel: () => dbLevel } : {}) })

describe('the release feed says its reader level', () => {
  test('read when it is a whole number of at least 1; anything else is unknown, never a reason to refuse the feed', () => {
    expect(ReleaseFeed.parse({ ...base, minReaderRequired: 6 }).minReaderRequired).toBe(6)
    for (const bad of ['6', 0, -1, 6.5, null, {}]) {
      const f = ReleaseFeed.parse({ ...base, minReaderRequired: bad })
      expect(f.version).toBe('0.5.3')
      expect(f.minReaderRequired).toBeUndefined()
    }
    expect(ReleaseFeed.parse(base).minReaderRequired).toBeUndefined()
    // the control plane's schema reads the same field
    expect(ProtocolReleaseFeed.parse({ ...base, bundles: [], minReaderRequired: 6 }).minReaderRequired).toBe(6)
  })
})

describe('UpdateManager.releaseCanRead', () => {
  test('the feed level below the database level: no; at or above it: yes', () => {
    const u = mgr(null, 7)
    expect(u.releaseCanRead({ version: '0.5.3', minReaderRequired: 6 })).toBe(false)
    expect(u.releaseCanRead({ version: '0.5.3', minReaderRequired: 7 })).toBe(true)
    expect(u.releaseCanRead({ version: '0.5.4', minReaderRequired: 8 })).toBe(true)
  })
  test('a feed without the level: a staged copy says it; nothing staged: unknown, yes', () => {
    const dir = app('staged', { '0.5.3-dev.4': 7, '0.5.3': 6 }, '0.5.3-dev.4')
    const u = mgr(dir, 7)
    expect(u.releaseCanRead({ version: '0.5.3' })).toBe(false)
    expect(u.releaseCanRead({ version: '0.5.4' })).toBe(true)
    // a feed level that says yes does not overrule a staged copy that says no
    expect(u.releaseCanRead({ version: '0.5.3', minReaderRequired: 7 })).toBe(false)
  })
  test('a staged copy that cannot open the database is not offered as available (its button would only be refused)', () => {
    const dir = app('offered', { '0.5.3-dev.4': 7, '0.5.3': 6 }, '0.5.3-dev.4')
    expect(mgr(dir, 7).status().available).toBeNull()
    expect(mgr(dir, 6).status().available?.version).toBe('0.5.3')
  })
  test('no database check given (older callers, the Mac office): yes', () => {
    expect(mgr(null).releaseCanRead({ version: '0.5.3', minReaderRequired: 1 })).toBe(true)
  })
})

describe('the automatic update', () => {
  const o = { tz: 'UTC', window: '00:00-23:59', running: 0, history: [], channel: 'stable' as const, installId: 'x', now: new Date('2026-11-14T00:00:00Z') }
  test('cannot_read: not taken by itself, whatever the window; not a failure (no hold that ends in another try)', () => {
    const f = ReleaseFeed.parse({ ...base, minReaderRequired: 6 })
    expect(autoUpdateDecision({ ...o, feed: f, current: '0.5.3-dev.4', canRead: false })).toEqual({ go: false, why: 'cannot_read' })
    expect(autoUpdateDecision({ ...o, feed: f, current: '0.5.3-dev.4', canRead: false, ignoreWindow: true })).toEqual({ go: false, why: 'cannot_read' })
    // a newer release that can read it: taken as usual; same-version dev -> stable that can: taken
    expect(autoUpdateDecision({ ...o, feed: { ...f, version: '0.5.4' }, current: '0.5.3-dev.4', canRead: true })).toEqual({ go: true, version: '0.5.4' })
    expect(autoUpdateDecision({ ...o, feed: f, current: '0.5.3-dev.4' })).toEqual({ go: true, version: '0.5.3' })
    // up to date first: a release the server already runs is not "cannot read"
    expect(autoUpdateDecision({ ...o, feed: f, current: '0.5.3', canRead: false })).toEqual({ go: false, why: 'up_to_date' })
  })
})

describe('runUpdate ("Update now", the automatic update)', () => {
  const setup = (o: { feedOk: boolean; stagedOk: boolean }) => {
    const did: string[] = []
    const f = ReleaseFeed.parse({ ...base, minReaderRequired: 6 })
    const updates = {
      checkFeed: async () => f, needsRoot: () => false, releaseCanRead: () => o.feedOk, canRead: () => o.stagedOk,
      download: async () => { did.push('download') }, switchTo: async (v: string) => { did.push(`switch ${v}`); return { from: '0.5.3-dev.4', to: v } },
    } as unknown as UpdateManager
    const backups = { run: async () => { did.push('backup') } } as unknown as BackupManager
    return { did, d: { updates, backups, running: () => 0, restart: () => did.push('restart'), locale: 'en' as const, sleep: async () => {} } }
  }
  test('a feed release that cannot open the data: refused before the download, nothing switched', async () => {
    const { did, d } = setup({ feedOk: false, stagedOk: true })
    await expect(runUpdate(d, '0.5.3', { staged: false, rollback: false })).rejects.toThrow(/version 0\.5\.3 cannot open this server's data/)
    expect(did).toEqual(['backup'])
  })
  test('a staged (or downloaded) copy that cannot: refused before the switch', async () => {
    const { did, d } = setup({ feedOk: true, stagedOk: false })
    await expect(runUpdate(d, '0.5.3', { staged: true, rollback: false })).rejects.toThrow(/cannot open this server's data/)
    expect(did).toEqual(['backup'])
  })
  test('one that can: installed as before', async () => {
    const { did, d } = setup({ feedOk: true, stagedOk: true })
    await runUpdate(d, '0.5.3', { staged: false, rollback: false })
    _resetUpdateWait()
    expect(did).toEqual(['backup', 'download', 'switch 0.5.3', 'restart'])
  })
})
