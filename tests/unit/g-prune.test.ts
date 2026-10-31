// Component G: old version and engine folders (server/src/system/prune.ts). What roll-back and the bootstrap need
// stays (app/current, the running version, state.json's current and previous, the newest staged version newer than
// current, anything changed in the last day); every other version folder, day-old .staging-* / *.partial leftovers and
// engine folders current no longer points to are removed, without ever following a link. A pending update skips the
// run. Roll-back to `previous` still works afterwards; the diagnostics show what is kept.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { setSetting, teamTimeZone } from '../../server/src/admin/settings'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { writeManifest } from '../../server/src/system/bundle'
import { resolveLayout } from '../../server/src/system/layout'
import { OpsService } from '../../server/src/system/ops'
import { lastPrune, parseMountinfo, PRUNE_FIRST_MS, PRUNE_RECORD, pruneVersions, type PruneResult } from '../../server/src/system/prune'
import { zonedParts } from '../../server/src/system/time-zone'
import { UpdateManager, verifyBundleDir } from '../../server/src/system/update'

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-prune-')))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const DAY = 86_400_000
/** two days from now: everything made by the test is older than the one-day grace */
const later = () => new Date(Date.now() + 2 * DAY)
/** a folder that looks freshly changed even at `later()` (mtime in the future; ctime cannot be set back) */
const fresh = (p: string) => { const t = new Date(Date.now() + 3 * DAY); fs.utimesSync(p, t, t) }

let n = 0
/** an install: app/versions/<v> for each version (with a verifiable manifest), app/current, state.json */
async function install(o: { versions: string[]; current: string; previous?: string | null; pending?: string | null; stateCurrent?: string | null }) {
  const app = path.join(ROOT, `i${++n}`, 'app')
  fs.mkdirSync(path.join(app, 'versions'), { recursive: true })
  for (const v of o.versions) await version(app, v)
  fs.symlinkSync(`versions/${o.current}`, path.join(app, 'current'))
  writeState(app, { current: o.stateCurrent === undefined ? o.current : o.stateCurrent, previous: o.previous ?? null, pending: o.pending ?? null })
  fs.mkdirSync(path.join(app, '..', 'data'), { recursive: true })
  return app
}
async function version(app: string, v: string) {
  const dir = path.join(app, 'versions', v)
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'server', 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'server', 'src', 'main.js'), `// ${v}\n${'x'.repeat(5000)}\n`)
  await writeManifest(dir, v)
  return dir
}
function writeState(app: string, s: { current: string | null; previous: string | null; pending: string | null }) {
  fs.writeFileSync(path.join(app, 'state.json'), JSON.stringify({ format: 1, ...s, pendingSince: s.pending ? new Date().toISOString() : null, attempts: 0, history: [] }))
}
const left = (app: string) => fs.readdirSync(path.join(app, 'versions')).sort()
const kept = (r: PruneResult) => Object.fromEntries(r.kept.map((k) => [k.version, k.why]))
const prune = (app: string, o: { running?: string; dryRun?: boolean; now?: () => Date } = {}) =>
  pruneVersions({ appDir: app, running: o.running ?? (() => { try { return path.basename(fs.readlinkSync(path.join(app, 'current'))) } catch { return '0.0.0' } })(), dataDir: path.join(app, '..', 'data'), dryRun: o.dryRun, now: o.now ?? later })

describe('which version folders stay', () => {
  test('current, previous and the newest newer staged version stay; the rest goes; a dry run only lists it', async () => {
    const app = await install({ versions: ['0.2.10', '0.2.11', '0.2.12', '0.2.13', '0.2.14', '0.2.16', '0.2.17'], current: '0.2.14', previous: '0.2.13' })
    const dry = await prune(app, { dryRun: true })
    expect(dry.skipped).toBeNull()
    expect(dry.removed.map((r) => r.path)).toEqual(['versions/0.2.10', 'versions/0.2.11', 'versions/0.2.12', 'versions/0.2.16'])
    expect(dry.removed.every((r) => r.kind === 'version' && r.bytes > 5000)).toBe(true)
    expect(kept(dry)).toEqual({ '0.2.13': ['previous'], '0.2.14': ['current', 'running', 'state-current'], '0.2.17': ['available'] })
    expect(left(app)).toHaveLength(7) // nothing removed
    expect(fs.existsSync(path.join(app, '..', 'data', PRUNE_RECORD))).toBe(false) // a dry run is not recorded

    const r = await prune(app)
    expect(r.removed.map((x) => x.path)).toEqual(dry.removed.map((x) => x.path))
    expect(r.errors).toEqual([])
    expect(left(app)).toEqual(['0.2.13', '0.2.14', '0.2.17'])
    expect(r.removedBytes).toBe(r.removed.reduce((a, x) => a + x.bytes, 0))
    expect(r.keptBytes).toBeGreaterThan(0)
    expect(lastPrune(path.join(app, '..', 'data'))).toEqual(r)
    // the second run has nothing left to do
    expect((await prune(app)).removed).toEqual([])
  })

  test('the running version and state.json current stay even when app/current points elsewhere', async () => {
    const app = await install({ versions: ['1.0.0', '1.1.0', '1.2.0', '1.3.0'], current: '1.3.0', stateCurrent: '1.1.0' })
    const r = await prune(app, { running: '1.0.0' })
    expect(kept(r)).toEqual({ '1.0.0': ['running'], '1.1.0': ['state-current'], '1.3.0': ['current'] })
    expect(left(app)).toEqual(['1.0.0', '1.1.0', '1.3.0'])
  })

  test('a version folder changed in the last day stays (mycel-ctl update copied it and is about to switch)', async () => {
    const app = await install({ versions: ['2.0.0', '2.1.0', '2.2.0', '2.3.0'], current: '2.0.0' })
    fresh(path.join(app, 'versions', '2.1.0'))
    const r = await prune(app)
    expect(kept(r)).toEqual({ '2.0.0': ['current', 'running', 'state-current'], '2.1.0': ['recent'], '2.3.0': ['available'] })
    expect(left(app)).toEqual(['2.0.0', '2.1.0', '2.3.0'])
    // right after staging, nothing is a day old: the real clock removes nothing
    const app2 = await install({ versions: ['2.0.0', '2.1.0', '2.2.0'], current: '2.2.0' })
    expect((await prune(app2, { now: () => new Date() })).removed).toEqual([])
  })

  test('a pending update skips the whole run; so do a missing or unreadable state.json and an odd app/current', async () => {
    const app = await install({ versions: ['3.0.0', '3.1.0', '3.2.0'], current: '3.2.0', previous: '3.1.0', pending: '3.2.0' })
    const r = await prune(app)
    expect(r.skipped).toBe('an update to 3.2.0 is pending')
    expect(r.removed).toEqual([])
    expect(fs.existsSync(path.join(app, '..', 'data', PRUNE_RECORD))).toBe(false) // a skipped run is not recorded
    expect(left(app)).toEqual(['3.0.0', '3.1.0', '3.2.0'])
    fs.writeFileSync(path.join(app, 'state.json'), '{"format":1,')
    expect((await prune(app)).skipped).toBe('app/state.json is unreadable')
    fs.rmSync(path.join(app, 'state.json'))
    expect((await prune(app)).skipped).toBe('app/state.json is missing')
    writeState(app, { current: '3.2.0', previous: '3.1.0', pending: null })
    fs.rmSync(path.join(app, 'current'))
    fs.symlinkSync('../elsewhere/3.2.0', path.join(app, 'current'))
    expect((await prune(app)).skipped).toMatch(/not a version folder/)
    fs.rmSync(path.join(app, 'current'))
    fs.mkdirSync(path.join(app, 'current'))
    expect((await prune(app)).skipped).toBe('app/current is not a link')
    expect(left(app)).toEqual(['3.0.0', '3.1.0', '3.2.0'])
    // a linked app/versions is never walked
    const app2 = await install({ versions: ['3.0.0', '3.2.0'], current: '3.2.0' })
    fs.renameSync(path.join(app2, 'versions'), path.join(app2, 'real-versions'))
    fs.symlinkSync('real-versions', path.join(app2, 'versions'))
    expect((await prune(app2)).skipped).toBe('app/versions is not a folder')
    expect(fs.readdirSync(path.join(app2, 'real-versions'))).toHaveLength(2)
  })
})

describe('what is removed, and how', () => {
  test('links are never followed: a linked version name stays, a link inside a removed folder goes without its target', async () => {
    const app = await install({ versions: ['4.0.0', '4.1.0', '4.2.0'], current: '4.2.0', previous: '4.1.0' })
    const outside = path.join(ROOT, 'outside'); fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'mine')
    fs.symlinkSync(outside, path.join(app, 'versions', '3.9.0'))
    fs.symlinkSync(outside, path.join(app, 'versions', '4.0.0', 'server', 'evil'))
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(app, 'versions', '4.0.0', 'bin', 'evil.txt'))
    const r = await prune(app)
    expect(r.removed.map((x) => x.path)).toEqual(['versions/4.0.0'])
    expect(r.left).toContainEqual({ path: 'versions/3.9.0', why: 'a link (never followed)' })
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('mine')
    expect(left(app)).toEqual(['3.9.0', '4.1.0', '4.2.0'])
  })

  test('.staging-* and *.partial go once a day old; files and other names stay; a read-only folder is still removed', async () => {
    const app = await install({ versions: ['5.0.0', '5.1.0'], current: '5.1.0' })
    const v = path.join(app, 'versions')
    for (const d of ['.staging-aaaaaaaaaaaa', '.staging-bbbbbbbbbbbb', '5.2.0.partial', '5.3.0.partial', 'notes', '.DS_Store']) fs.mkdirSync(path.join(v, d))
    fs.writeFileSync(path.join(v, '.staging-aaaaaaaaaaaa', 'manifest.json'), '{}')
    fs.writeFileSync(path.join(v, 'README'), 'x')
    fresh(path.join(v, '.staging-bbbbbbbbbbbb')); fresh(path.join(v, '5.3.0.partial'))
    // a folder a release archive recorded as 0555 (its owner cannot write it until it is made writable)
    fs.mkdirSync(path.join(v, '5.0.0', 'web', 'ro'), { recursive: true }); fs.writeFileSync(path.join(v, '5.0.0', 'web', 'ro', 'a.js'), 'a')
    fs.chmodSync(path.join(v, '5.0.0', 'web', 'ro'), 0o555)
    const r = await prune(app)
    expect(r.errors).toEqual([])
    expect(r.removed.map((x) => `${x.kind} ${x.path}`).sort()).toEqual(['partial versions/5.2.0.partial', 'staging versions/.staging-aaaaaaaaaaaa', 'version versions/5.0.0'])
    expect(left(app)).toEqual(['.DS_Store', '.staging-bbbbbbbbbbbb', '5.1.0', '5.3.0.partial', 'README', 'notes'])
    expect(r.left.map((x) => x.path).sort()).toEqual(['versions/.DS_Store', 'versions/.staging-bbbbbbbbbbbb', 'versions/5.3.0.partial', 'versions/README', 'versions/notes'])
  })

  test('engines: folders current no longer points to go once both are a day old; current, links and other names stay', async () => {
    const app = await install({ versions: ['6.0.0'], current: '6.0.0' })
    const e = path.join(app, 'engines')
    const sha = (c: string) => c.repeat(12)
    for (const [name, dirs, cur] of [['claude', [sha('a'), sha('b'), sha('c')], sha('c')], ['codex', [sha('d'), sha('e')], sha('e')], ['fresh', [sha('f'), sha('9')], sha('9')]] as const) {
      for (const d of dirs) { fs.mkdirSync(path.join(e, name, d), { recursive: true }); fs.writeFileSync(path.join(e, name, d, name), 'engine') }
      fs.symlinkSync(cur, path.join(e, name, 'current'))
    }
    fs.writeFileSync(path.join(e, 'codex', sha('e'), 'model_catalog.json'), '{}')
    fs.mkdirSync(path.join(e, 'claude', 'not-a-sha'))
    fs.symlinkSync(path.join(ROOT, 'outside'), path.join(e, 'claude', sha('0')))
    // just installed: the link moved minutes ago (a turn on the old engine may still run)
    fs.lutimesSync(path.join(e, 'fresh', 'current'), new Date(Date.now() + 3 * DAY), new Date(Date.now() + 3 * DAY))
    // an engine folder the installer is filling now (current not switched yet)
    fs.mkdirSync(path.join(e, 'codex', sha('7'))); fresh(path.join(e, 'codex', sha('7')))
    // an engine whose current names nothing usable is left alone entirely
    fs.mkdirSync(path.join(e, 'broken', sha('1')), { recursive: true }); fs.symlinkSync('../../elsewhere', path.join(e, 'broken', 'current'))
    const r = await prune(app)
    expect(r.errors).toEqual([])
    expect(r.removed.map((x) => x.path).sort()).toEqual([`engines/claude/${sha('a')}`, `engines/claude/${sha('b')}`, `engines/codex/${sha('d')}`])
    expect(r.removed.every((x) => x.kind === 'engine')).toBe(true)
    expect(fs.readdirSync(path.join(e, 'claude')).sort()).toEqual([sha('0'), sha('c'), 'current', 'not-a-sha'])
    expect(fs.readdirSync(path.join(e, 'codex')).sort()).toEqual([sha('7'), 'current', sha('e')])
    expect(fs.readdirSync(path.join(e, 'fresh')).sort()).toEqual([sha('9'), 'current', sha('f')])
    expect(fs.existsSync(path.join(e, 'broken', sha('1')))).toBe(true)
    expect(r.left).toContainEqual({ path: 'engines/broken', why: 'current names no engine folder' })
    expect(r.left).toContainEqual({ path: `engines/claude/${sha('0')}`, why: 'a link (never followed)' })
  })

  test('a folder that cannot be removed is reported, not counted as removed, and the run goes on; a later run finishes it', async () => {
    // an unremovable file without root: macOS's user immutable flag (Linux needs root for chattr)
    if (process.platform !== 'darwin') return
    const app = await install({ versions: ['7.0.0', '7.1.0', '7.2.0'], current: '7.2.0' })
    const flag = (f: 'uchg' | 'nouchg') => { for (const d of fs.readdirSync(path.join(app, 'versions'))) { const p = path.join(app, 'versions', d, 'server', 'src', 'main.js'); if (fs.existsSync(p)) Bun.spawnSync(['/usr/bin/chflags', f, p]) } }
    expect(Bun.spawnSync(['/usr/bin/chflags', 'uchg', path.join(app, 'versions', '7.0.0', 'server', 'src', 'main.js')]).exitCode).toBe(0)
    try {
      const r = await pruneVersions({ appDir: app, running: '7.2.0', now: later, dataDir: null })
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]!.path).toBe('versions/7.0.0')
      // taken out of its version name first: what is left is no version any more, and says where it is
      expect(r.errors[0]!.error).toMatch(/what is left is versions\/\.prune-[0-9a-f]{12}, removed by a later run/)
      expect(r.removed.map((x) => x.path)).toEqual(['versions/7.1.0'])
      const rest = left(app)
      expect(rest).toHaveLength(2)
      expect(rest[0]).toMatch(/^\.prune-[0-9a-f]{12}$/)
      expect(rest[1]).toBe('7.2.0')
      expect(new UpdateManager({ appDir: app, dataDir: path.join(app, '..', 'data'), version: '7.2.0', channel: 'stable', feedUrl: null, log: silentLogger, allowUnsigned: true }).stagedVersions()).toEqual(['7.2.0'])
      // once the file can go, a run a day after the rename removes the rest
      flag('nouchg')
      expect((await pruneVersions({ appDir: app, running: '7.2.0', now: () => new Date(), dataDir: null })).left).toContainEqual({ path: `versions/${rest[0]}`, why: 'renamed for removal in the last 24 hours (a run may still be removing it)' })
      const r2 = await pruneVersions({ appDir: app, running: '7.2.0', now: later, dataDir: null })
      expect(r2.removed.map((x) => `${x.kind} ${x.path}`)).toEqual([`trash versions/${rest[0]}`])
      expect(left(app)).toEqual(['7.2.0'])
    } finally { flag('nouchg') }
  })
})

describe('another process at work during the run', () => {
  const REPLACED = 'replaced since the first look (another process brought a folder in under this name)'
  test('a folder brought in again under the same name before the second look stays', async () => {
    const app = await install({ versions: ['9.0.0', '9.1.0', '9.2.0'], current: '9.2.0' })
    // the installer or `mycel-ctl update --version 9.0.0`: the old folder moved away, a fresh one made under the name (the
    // old one stays allocated, so the new folder cannot get its inode number; for that case see the next test)
    const r = await pruneVersions({ appDir: app, running: '9.2.0', now: later, dataDir: null, race: (rel, step) => {
      if (rel !== 'versions/9.0.0' || step !== 'check') return
      fs.renameSync(path.join(app, 'versions', '9.0.0'), path.join(app, 'old-9.0.0'))
      void version(app, '9.0.0')
    } })
    await Bun.sleep(50)
    expect(r.removed.map((x) => x.path)).toEqual(['versions/9.1.0'])
    expect(r.left).toContainEqual({ path: 'versions/9.0.0', why: REPLACED })
    await verifyBundleDir(path.join(app, 'versions', '9.0.0'), { keys: [], allowUnsigned: true })
  })

  test('what keeps a fresh copy is its ctime of now, even when it got the old inode number (ext4 reuses them)', async () => {
    const app = await install({ versions: ['9.0.0', '9.1.0', '9.2.0'], current: '9.2.0' })
    const r = await pruneVersions({ appDir: app, running: '9.2.0', now: later, dataDir: null, race: (rel, step) => {
      if (rel !== 'versions/9.0.0' || step !== 'check') return
      fs.rmSync(path.join(app, 'versions', '9.0.0'), { recursive: true })
      void version(app, '9.0.0').then(() => {})
      // this test's clock is two days ahead: what "changed just now" means to it
      fresh(path.join(app, 'versions', '9.0.0'))
    } })
    await Bun.sleep(50)
    expect(r.removed.map((x) => x.path)).toEqual(['versions/9.1.0'])
    const why = r.left.find((x) => x.path === 'versions/9.0.0')?.why
    expect([REPLACED, 'changed in the last 24 hours (an update may be using it)']).toContain(why!)
    await verifyBundleDir(path.join(app, 'versions', '9.0.0'), { keys: [], allowUnsigned: true })
  })

  test('a folder that changes between the second look and the rename is renamed back and left', async () => {
    const app = await install({ versions: ['9.0.0', '9.1.0', '9.2.0'], current: '9.2.0' })
    const r = await pruneVersions({ appDir: app, running: '9.2.0', now: later, dataDir: null, race: (rel, step) => {
      if (rel !== 'versions/9.0.0' || step !== 'renamed') return
      // someone wrote into it just before the rename (its mtime moved): not the folder that was looked at any more
      const trash = fs.readdirSync(path.join(app, 'versions')).find((n) => n.startsWith('.prune-'))!
      fs.writeFileSync(path.join(app, 'versions', trash, 'new-file'), 'x')
      const t = new Date(Date.now() + 5 * DAY); fs.utimesSync(path.join(app, 'versions', trash), t, t)
    } })
    expect(r.removed.map((x) => x.path)).toEqual(['versions/9.1.0'])
    expect(r.left).toContainEqual({ path: 'versions/9.0.0', why: REPLACED })
    expect(left(app)).toEqual(['9.0.0', '9.2.0'])
    expect(fs.readFileSync(path.join(app, 'versions', '9.0.0', 'new-file'), 'utf8')).toBe('x')
  })

  test('a folder that changed after the rename and whose old name is taken again is held, never removed, and reported', async () => {
    const app = await install({ versions: ['9.0.0', '9.1.0', '9.2.0'], current: '9.2.0' })
    const data = path.join(app, '..', 'data')
    const r = await pruneVersions({ appDir: app, running: '9.2.0', now: later, dataDir: data, race: (rel, step) => {
      if (rel !== 'versions/9.0.0' || step !== 'renamed') return
      // written into just before the rename, and a new 9.0.0 made at once: renaming back is no longer possible
      const trash = fs.readdirSync(path.join(app, 'versions')).find((n) => n.startsWith('.prune-'))!
      fs.writeFileSync(path.join(app, 'versions', trash, 'new-file'), 'x')
      const t = new Date(Date.now() + 5 * DAY); fs.utimesSync(path.join(app, 'versions', trash), t, t)
      fs.mkdirSync(path.join(app, 'versions', '9.0.0'))
    } })
    const held = fs.readdirSync(path.join(app, 'versions')).filter((n) => n.startsWith('.prune-'))
    expect(held).toHaveLength(1)
    expect(held[0]).toMatch(/^\.prune-hold-[0-9a-f]{12}$/)
    expect(fs.readFileSync(path.join(app, 'versions', held[0]!, 'new-file'), 'utf8')).toBe('x')
    expect(r.errors).toEqual([{ path: `versions/${held[0]}`, error: expect.stringMatching(/never removed by a run; look at it.*\(it was versions\/9\.0\.0\)$/) }])
    expect(r.removed.map((x) => x.path)).toEqual(['versions/9.1.0'])
    // later runs (days later) never remove it and keep reporting it (Diagnostics shows the record's errors)
    for (const days of [4, 30]) {
      const again = await pruneVersions({ appDir: app, running: '9.2.0', now: () => new Date(Date.now() + days * DAY), dataDir: data })
      expect(again.errors).toContainEqual({ path: `versions/${held[0]}`, error: expect.stringContaining('never removed by a run') })
      expect(again.removed.map((x) => x.path)).not.toContain(`versions/${held[0]}`)
      expect(fs.existsSync(path.join(app, 'versions', held[0]!, 'new-file'))).toBe(true)
      expect(lastPrune(data)?.errors.map((e) => e.path)).toContain(`versions/${held[0]}`)
    }
  })

  test('a folder that holds a mount point (a bind mount has its parent\'s device) is never removed', async () => {
    expect(parseMountinfo('22 1 8:1 / / rw - ext4 /dev/sda1 rw\n36 22 8:1 /srv/a\\040b /var/lib/x/app/versions/0.1.0/web/my\\040data rw - ext4 /dev/sda1 rw\nbroken\n'))
      .toEqual(['/', '/var/lib/x/app/versions/0.1.0/web/my data'])
    const app = await install({ versions: ['9.0.0', '9.1.0', '9.2.0', '9.3.0'], current: '9.3.0' })
    fs.mkdirSync(path.join(app, 'versions', '9.0.0', 'web', 'data'), { recursive: true }); fs.writeFileSync(path.join(app, 'versions', '9.0.0', 'web', 'data', 'team.db'), 'not ours')
    const line = (p: string) => `40 22 8:1 /team ${p.replace(/ /g, '\\040')} rw - ext4 /dev/sda1 rw`
    let looks = 0
    const r = await pruneVersions({ appDir: app, running: '9.3.0', now: later, dataDir: null, mountinfo: () => {
      // 9.0.0 holds one from the start; one appears in 9.1.0 between the first look and the second
      const m = [line('/'), line(path.join(app, 'versions', '9.0.0', 'web', 'data'))]
      if (++looks > 1) m.push(line(path.join(app, 'versions', '9.1.0')))
      return m.join('\n')
    } })
    expect(r.removed.map((x) => x.path)).toEqual(['versions/9.2.0'])
    expect(r.left).toContainEqual({ path: 'versions/9.0.0', why: 'holds a mount point: never removed' })
    expect(r.left).toContainEqual({ path: 'versions/9.1.0', why: 'holds a mount point: never removed' })
    expect(fs.readFileSync(path.join(app, 'versions', '9.0.0', 'web', 'data', 'team.db'), 'utf8')).toBe('not ours')
    expect(left(app)).toEqual(['9.0.0', '9.1.0', '9.3.0'])
    // no mountinfo (macOS): the device check only
    expect((await pruneVersions({ appDir: app, running: '9.3.0', now: later, dataDir: null, mountinfo: () => null })).removed.map((x) => x.path)).toEqual(['versions/9.0.0', 'versions/9.1.0'])
  })

  test('a folder brought in under the same name while the old one is being removed loses nothing', async () => {
    const app = await install({ versions: ['9.0.0', '9.1.0', '9.2.0'], current: '9.2.0' })
    const r = await pruneVersions({ appDir: app, running: '9.2.0', now: later, dataDir: null, race: (rel, step) => {
      if (rel === 'versions/9.0.0' && step === 'renamed') void version(app, '9.0.0')
    } })
    await Bun.sleep(50)
    expect(r.errors).toEqual([])
    expect(r.removed.map((x) => x.path)).toEqual(['versions/9.0.0', 'versions/9.1.0'])
    expect(left(app)).toEqual(['9.0.0', '9.2.0'])
    await verifyBundleDir(path.join(app, 'versions', '9.0.0'), { keys: [], allowUnsigned: true })
  })

  test('a switch during the run: the version it needs again stays, and a pending update stops the run', async () => {
    const app = await install({ versions: ['9.0.0', '9.1.0', '9.2.0', '9.3.0'], current: '9.3.0' })
    // Admin (or `admin.js switch 9.1.0`) between the first look and the removal: 9.1.0 is now what current points to
    const r = await pruneVersions({ appDir: app, running: '9.3.0', now: later, dataDir: null, race: (rel, step) => {
      if (rel !== 'versions/9.1.0' || step !== 'check') return
      fs.rmSync(path.join(app, 'current')); fs.symlinkSync('versions/9.1.0', path.join(app, 'current'))
      writeState(app, { current: '9.1.0', previous: '9.3.0', pending: null })
    } })
    expect(r.removed.map((x) => x.path)).toEqual(['versions/9.0.0', 'versions/9.2.0'])
    expect(r.left).toContainEqual({ path: 'versions/9.1.0', why: 'needed again (app/current or state.json changed during the run)' })
    expect(left(app)).toEqual(['9.1.0', '9.3.0'])
    const app2 = await install({ versions: ['9.0.0', '9.1.0', '9.2.0'], current: '9.2.0' })
    fs.mkdirSync(path.join(app2, 'versions', '.staging-0123456789ab'))
    const r2 = await pruneVersions({ appDir: app2, running: '9.2.0', now: later, dataDir: null, race: (rel, step) => {
      if (rel === 'versions/9.1.0' && step === 'check') writeState(app2, { current: '9.2.0', previous: '9.2.0', pending: '9.1.0' })
    } })
    expect(r2.skipped).toBe('stopped: an update to 9.1.0 is pending')
    expect(r2.removed.map((x) => x.path)).toEqual(['versions/9.0.0'])
    expect(left(app2)).toEqual(['.staging-0123456789ab', '9.1.0', '9.2.0'])
  })

  test('an engine current points to again during the run stays', async () => {
    const app = await install({ versions: ['9.0.0'], current: '9.0.0' })
    const e = path.join(app, 'engines', 'claude')
    for (const d of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) { fs.mkdirSync(path.join(e, d), { recursive: true }); fs.writeFileSync(path.join(e, d, 'claude'), d) }
    fs.symlinkSync('cccccccccccc', path.join(e, 'current'))
    // an installer run with the older engine again: current -> aaaaaaaaaaaa (a fresh link)
    const r = await pruneVersions({ appDir: app, running: '9.0.0', now: later, dataDir: null, race: (rel, step) => {
      if (rel !== 'engines/claude/aaaaaaaaaaaa' || step !== 'check') return
      fs.rmSync(path.join(e, 'current')); fs.symlinkSync('aaaaaaaaaaaa', path.join(e, 'current'))
      const t = new Date(Date.now() + 3 * DAY); fs.lutimesSync(path.join(e, 'current'), t, t)
    } })
    expect(r.removed.map((x) => x.path)).toEqual([])
    expect(r.left).toContainEqual({ path: 'engines/claude/aaaaaaaaaaaa', why: 'the engine\'s current changed during the run' })
    expect(r.left).toContainEqual({ path: 'engines/claude/bbbbbbbbbbbb', why: 'the engine\'s current changed during the run' })
    expect(fs.readdirSync(e).sort()).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'current'])
  })
})

describe('after a prune', () => {
  test('switching to a staged version touches its folder first, so a prune running meanwhile leaves it', async () => {
    const app = await install({ versions: ['8.0.0', '8.1.0'], current: '8.1.0', previous: '8.0.0' })
    const dir = path.join(app, 'versions', '8.0.0')
    const longAgo = new Date('2020-01-01T00:00:00Z'); fs.utimesSync(dir, longAgo, longAgo)
    const u = new UpdateManager({ appDir: app, dataDir: path.join(app, '..', 'data'), version: '8.1.0', channel: 'stable', feedUrl: null, log: silentLogger, allowUnsigned: true })
    await u.rollBack()
    expect(Date.now() - fs.lstatSync(dir).mtimeMs).toBeLessThan(60_000)
  })

  test('roll back to previous still works: it is there, it verifies, and switching to it is the usual pending switch', async () => {
    const app = await install({ versions: ['8.0.0', '8.1.0', '8.2.0', '8.3.0'], current: '8.3.0', previous: '8.2.0' })
    await prune(app)
    expect(left(app)).toEqual(['8.2.0', '8.3.0'])
    const u = new UpdateManager({ appDir: app, dataDir: path.join(app, '..', 'data'), version: '8.3.0', channel: 'stable', feedUrl: null, log: silentLogger, allowUnsigned: true })
    expect(u.status().previous).toBe('8.2.0')
    await verifyBundleDir(path.join(app, 'versions', '8.2.0'), { keys: [], allowUnsigned: true })
    expect(await u.rollBack()).toEqual({ from: '8.3.0', to: '8.2.0' })
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('versions/8.2.0')
    // while that switch is pending nothing is removed; once the bootstrap confirmed it, 8.3.0 is the new previous
    expect((await prune(app, { running: '8.3.0' })).skipped).toBe('an update to 8.2.0 is pending')
    writeState(app, { current: '8.2.0', previous: '8.3.0', pending: null })
    expect((await prune(app)).removed).toEqual([])
    expect(left(app)).toEqual(['8.2.0', '8.3.0'])
  })
})

describe('the server runs it, and says what it keeps', () => {
  let ctx: AppContext
  const base = path.join(ROOT, 'srv')
  beforeAll(async () => {
    for (const d of ['run', 'root', 'config', 'data', 'team', 'secrets', 'status']) fs.mkdirSync(path.join(base, d), { recursive: true })
    const app = path.join(base, 'app')
    fs.mkdirSync(path.join(app, 'versions'), { recursive: true })
    for (const v of ['0.1.0', '0.1.1', '0.1.2']) await version(app, v)
    fs.symlinkSync('versions/0.1.2', path.join(app, 'current'))
    writeState(app, { current: '0.1.2', previous: '0.1.1', pending: null })
    const cfg: AppConfig = {
      mode: 'prod', configFile: path.join(base, 'config', 'server.json'), listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
      teamRoot: path.join(base, 'team'), dataDir: path.join(base, 'data'), logDir: null, logLevel: 'error',
      engine: { authMode: 'managed', runDir: path.join(ROOT, 'r') }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
      validateResponses: false, setupToken: null,
    }
    ctx = createContext({ config: cfg, db: openDb(path.join(cfg.dataDir, 'app.db')), log: silentLogger })
  })
  afterAll(async () => { await ctx.close() })
  const ops = () => new OpsService(ctx, { layout: resolveLayout(ctx.config, { MYCEL_INSTALL_BASE: base, MYCEL_LABEL: 'mycel' }, 'linux'), platform: 'linux', engines: async () => [], launcherStatus: async () => null, now: later })
  const line = async (l: 'en' | 'ko' = 'en') => (await ops().diagnostics(l)).checks.find((c) => c.id === 'versions_kept')

  test('the hourly run is 10 minutes off the automatic update: they never want the lock at the same moment', () => {
    // both hourly from the start, the prune took the lock while the automatic update read the feed: "busy", every hour
    const made: { kind: 'timeout' | 'interval'; ms: number; fn: () => void; at: number }[] = []
    const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval }
    let clock = 0
    const fake = (kind: 'timeout' | 'interval') => ((fn: () => void, ms: number) => { made.push({ kind, ms, fn, at: clock }); return { unref() {} } }) as unknown as typeof setTimeout
    const was = ctx.config.update.auto
    ctx.config.update.auto = true
    const prunes: number[] = []
    const o = ops()
    o.pruneOldVersions = async () => { prunes.push(clock); return null }
    globalThis.setTimeout = fake('timeout'); globalThis.setInterval = fake('interval') as unknown as typeof setInterval
    try {
      o.start()
      expect(o.autoUpdates).toBe(true)
      const hourlyAtStart = made.filter((t) => t.kind === 'interval' && t.ms === 3_600_000)
      const first = made.find((t) => t.kind === 'timeout' && t.ms === PRUNE_FIRST_MS)!
      expect(first).toBeDefined()
      // the hourly prune starts with the first run, 10 minutes after the hourly ticks that started with the server
      clock = PRUNE_FIRST_MS
      const before = made.length
      first.fn()
      expect(prunes).toEqual([PRUNE_FIRST_MS])
      const hourlyPrune = made.slice(before).filter((t) => t.kind === 'interval')
      expect(hourlyPrune.map((t) => [t.ms, t.at])).toEqual([[3_600_000, PRUNE_FIRST_MS]])
      for (const t of hourlyAtStart) expect(t.at).toBe(0)
      hourlyPrune[0]!.fn()
      expect(prunes).toEqual([PRUNE_FIRST_MS, PRUNE_FIRST_MS])
    } finally {
      globalThis.setTimeout = real.setTimeout; globalThis.setInterval = real.setInterval
      ctx.config.update.auto = was
      ;(o as unknown as { timers: unknown[] }).timers.splice(0)
    }
  })

  test('under the maintenance lock, never in office mode; Diagnostics shows the kept versions and their size', async () => {
    expect(await line()).toBeUndefined() // nothing recorded yet
    const o = ops()
    expect(o.tryLock('backup')).toBe(true)
    expect(await o.pruneOldVersions()).toBeNull() // another operation runs
    o.unlock()
    ctx.config.office = true
    expect(await ops().pruneOldVersions()).toBeNull()
    ctx.config.office = undefined
    const r = await ops().pruneOldVersions()
    expect(r?.removed.map((x) => x.path)).toEqual(['versions/0.1.0'])
    expect(fs.readdirSync(path.join(base, 'app', 'versions')).sort()).toEqual(['0.1.1', '0.1.2'])
    expect(await line()).toMatchObject({ group: 'update', status: 'ok', label: 'Kept versions' })
    expect((await line())!.detail).toMatch(/^0\.1\.1, 0\.1\.2 · \d+\.\d GB\. The server removes older versions by itself\.$/)
    expect((await line('ko'))!.detail).toContain('더 오래된 버전은 서버가 알아서 지워요.')
    // a failed removal turns it into a warning that says why
    const rec = lastPrune(path.join(base, 'data'))!
    fs.writeFileSync(path.join(base, 'data', PRUNE_RECORD), JSON.stringify({ ...rec, errors: [{ path: 'versions/0.0.9', error: 'EACCES: permission denied' }] }))
    expect(await line()).toMatchObject({ status: 'warn', detail: expect.stringContaining('Old versions could not be removed: versions/0.0.9: EACCES: permission denied') })
  })

  test('after waiting for the lock the automatic update decides again: past the window, or answers running, it does not go', async () => {
    const tz = teamTimeZone(ctx.db)
    const at = new Date('2026-11-03T03:30:00Z')
    const hm = (d: Date) => { const p = zonedParts(d, tz); return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}` }
    // a window of four minutes around `at` (team time zone); waiting for the prune takes the clock five minutes on
    setSetting(ctx.db, 'updateWindow', `${hm(new Date(at.getTime() - 2 * 60_000))}-${hm(new Date(at.getTime() + 2 * 60_000))}`)
    let clock = at
    const was = ctx.config.update.auto
    ctx.config.update.auto = true
    try {
      for (const after of ['outside_window', 'busy'] as const) {
        clock = at
        const o = new OpsService(ctx, { layout: resolveLayout(ctx.config, { MYCEL_INSTALL_BASE: base, MYCEL_LABEL: 'mycel' }, 'linux'), platform: 'linux', engines: async () => [], launcherStatus: async () => null, now: () => clock })
        Object.defineProperty(o.updates, 'feedUsable', { get: () => true })
        o.updates.checkFeed = async () => ({ version: '999.0.0', minFrom: null, urgent: false, needsRoot: false, notes: '', publishedAt: at.toISOString(), bundles: [] })
        let waited = false
        o.lockAfterPrune = async (name) => {
          waited = true
          if (after === 'outside_window') clock = new Date(at.getTime() + 5 * 60_000)
          else o.queue = () => ({ running: 1, queued: 0, concurrency: 3 }) // an answer started meanwhile
          return o.tryLock(name)
        }
        expect(await o.autoUpdateTick()).toBe(after)
        expect(waited).toBe(true) // the first decision was "go"
        expect(o.busyWith).toBeNull() // and the lock is given back
      }
    } finally {
      ctx.config.update.auto = was
      setSetting(ctx.db, 'updateWindow', null)
    }
  })

  test('an automatic update that finds a prune holding the lock waits for it instead of skipping the hour', async () => {
    const o = ops()
    const running = o.pruneOldVersions()
    expect(o.busyWith).toBe('prune')
    expect(o.tryLock('update')).toBe(false)
    expect(await o.lockAfterPrune('update')).toBe(true)
    expect(o.busyWith).toBe('update')
    await running
    o.unlock()
    // another operation (a backup) is not waited for: busy
    expect(o.tryLock('backup')).toBe(true)
    expect(await o.lockAfterPrune('update')).toBe(false)
    o.unlock()
  })
})
