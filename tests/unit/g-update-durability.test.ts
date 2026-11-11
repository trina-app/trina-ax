// Component G: backups and updates survive a crash or a power loss (QA TC-278 / TC-279 side findings).
// - A DB copy is written as <id>.sqlite.partial and renamed when complete; what an interrupted backup left behind goes
//   at the next backup and at start, never anything of a backup that finished (its <id>.json exists).
// - The copy's integrity check runs in a child process (the server keeps answering during a large backup).
// - A new version (install-linux.sh, the in-app update) is on disk before it gets its name, and app/current is switched
//   by renaming a new link.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { BackupManager, inspectDbCopyAsync, PARTIAL_SUFFIX, UNFINISHED_GRACE_MS, vacuumInto } from '../../server/src/system/backup'
import { resolveLayout } from '../../server/src/system/layout'
import { fsyncPath, fsyncTree } from '../../server/src/system/streams'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-update-durability')
fs.rmSync(W, { recursive: true, force: true })
const REPO = path.resolve(import.meta.dir, '..', '..')

function setup(name: string) {
  const base = path.join(W, name)
  const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(path.join(cfg.teamRoot, 'shared'), { recursive: true })
  fs.writeFileSync(path.join(cfg.teamRoot, 'shared', 'plan.md'), '# plan\n')
  const dbFile = path.join(cfg.dataDir, 'app.db')
  const db = openDb(dbFile)
  const clock = new Date('2026-10-01T04:00:00Z')
  const layout = resolveLayout(cfg)
  const mgr = new BackupManager({ db, dbFile, layout, log: silentLogger, version: '0.1.0', now: () => clock })
  return { cfg, db, dbFile, layout, mgr, clock }
}

const touch = (p: string, at: Date) => fs.utimesSync(p, at, at)
const put = (p: string, body = 'x', at?: Date) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  if (at) touch(p, at)
}

describe('DB copy (vacuumInto)', () => {
  test('written as .partial and renamed: no .partial or journal left, the copy is complete', async () => {
    const e = setup('vacuum')
    const dst = path.join(W, 'vacuum', 'copy.sqlite')
    put(dst + PARTIAL_SUFFIX, 'stale partial from a crash')
    await vacuumInto(e.dbFile, dst)
    expect(fs.existsSync(dst)).toBe(true)
    expect(fs.existsSync(dst + PARTIAL_SUFFIX)).toBe(false)
    expect(fs.existsSync(`${dst}${PARTIAL_SUFFIX}-journal`)).toBe(false)
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
    expect((await inspectDbCopyAsync(dst)).schemaVersion).toBeGreaterThan(0)
    e.db.close()
  })

  test('a failed copy leaves neither the target nor a .partial', async () => {
    const dir = path.join(W, 'vacuum-fail')
    fs.mkdirSync(dir, { recursive: true })
    const src = path.join(dir, 'not-a-db.db')
    fs.writeFileSync(src, 'this is not sqlite '.repeat(200))
    const dst = path.join(dir, 'copy.sqlite')
    await expect(vacuumInto(src, dst)).rejects.toThrow(/database copy failed/)
    expect(fs.readdirSync(dir)).toEqual(['not-a-db.db'])
  })

  test('the integrity check in a child process refuses a damaged copy', async () => {
    const e = setup('damaged')
    const dst = path.join(W, 'damaged', 'copy.sqlite')
    await vacuumInto(e.dbFile, dst)
    // overwrite pages in the middle (the header stays, so SQLite opens it and quick_check finds the damage)
    const fd = fs.openSync(dst, 'r+')
    const size = fs.fstatSync(fd).size
    fs.writeSync(fd, Buffer.alloc(Math.min(64 * 1024, size - 8192), 0xab), 0, undefined, 4096)
    fs.closeSync(fd)
    await expect(inspectDbCopyAsync(dst)).rejects.toThrow(/damaged/)
    e.db.close()
  })
})

describe('unfinished backups (QA TC-278: a reboot during the pre-update backup left 1.4 GB for ever)', () => {
  test('partial copies, meta-less copies, journals, team archives and metadata temp files go; finished backups and recent leftovers stay', async () => {
    const e = setup('unfinished')
    const L = e.layout
    const old = new Date(e.clock.getTime() - UNFINISHED_GRACE_MS - 60_000)
    const recent = new Date(e.clock.getTime() - 60_000)
    // a finished backup, made "long ago": nothing of it may go, not even a journal next to its copy
    const done = await e.mgr.run({ kind: 'manual', scope: 'full' })
    const doneFiles = [path.join(L.dbBackupsDir, `${done.id}.json`), path.join(L.dbBackupsDir, `${done.id}.sqlite`)]
    put(path.join(L.dbBackupsDir, `${done.id}.sqlite-journal`), 'j', old)
    for (const f of doneFiles) touch(f, old)
    touch(path.join(L.teamBackupsDir, done.id), old)
    // the reboot case: the old code's copy written straight to <id>.sqlite with its journal, no .json
    const crashed = '20260930T190056Z-pre-update'
    put(path.join(L.dbBackupsDir, `${crashed}.sqlite`), 'half a database', old)
    put(path.join(L.dbBackupsDir, `${crashed}.sqlite-journal`), 'j', old)
    // the new code's partial copy and its journal
    const partial = '20260930T200000Z-daily'
    put(path.join(L.dbBackupsDir, `${partial}.sqlite${PARTIAL_SUFFIX}`), 'half', old)
    put(path.join(L.dbBackupsDir, `${partial}.sqlite${PARTIAL_SUFFIX}-journal`), 'j', old)
    // a copy that finished, a team archive that did not (stopped while compressing the team folder)
    const teamCut = '20260930T210000Z-daily'
    put(path.join(L.dbBackupsDir, `${teamCut}.sqlite`), 'db', old)
    put(path.join(L.teamBackupsDir, teamCut, '.mycel-tmp-team.tar.zst.partial'), 'tar', old)
    touch(path.join(L.teamBackupsDir, teamCut), old)
    // the metadata's temporary file (writeAtomic) of an id that never got its .json
    put(path.join(L.dbBackupsDir, `.mycel-tmp-${teamCut}.json.partial`), '{', old)
    // recent: another process (mycel-ctl backup) may be writing these right now
    const busy = '20261001T035900Z-manual'
    put(path.join(L.dbBackupsDir, `${busy}.sqlite${PARTIAL_SUFFIX}`), 'being written', recent)
    put(path.join(L.teamBackupsDir, busy, '.mycel-tmp-team.tar.zst.partial'), 'tar', recent)
    touch(path.join(L.teamBackupsDir, busy), old) // the folder is old, a file in it changed a minute ago
    // not ours: other names in data/backups stay
    put(path.join(L.dbBackupsDir, 'notes.sqlite'), 'x', old)

    const removed = e.mgr.removeUnfinished()
    expect(removed.sort()).toEqual([`unfinished:${crashed}`, `unfinished:${partial}`, `unfinished:${teamCut}`].sort())
    const left = fs.readdirSync(L.dbBackupsDir).sort()
    expect(left).toEqual([`${busy}.sqlite${PARTIAL_SUFFIX}`, `${done.id}.json`, `${done.id}.sqlite`, `${done.id}.sqlite-journal`, 'notes.sqlite'].sort())
    expect(fs.readdirSync(L.teamBackupsDir).sort()).toEqual([busy, done.id].sort())
    expect(fs.existsSync(path.join(L.teamBackupsDir, done.id, 'team.tar.zst'))).toBe(true)
    expect(e.mgr.metas().map((m) => m.id)).toEqual([done.id])
    // the backup still restores
    const r = await e.mgr.restoreTeamTo(done.id, path.join(W, 'unfinished-restored'))
    expect(r.files).toBe(1)
    e.db.close()
  })

  test('the next backup removes them (prune), and so does the server start', async () => {
    const e = setup('unfinished-prune')
    const L = e.layout
    const old = new Date(e.clock.getTime() - UNFINISHED_GRACE_MS - 60_000)
    fs.mkdirSync(L.dbBackupsDir, { recursive: true })
    const crashed = '20260930T190056Z-pre-update'
    put(path.join(L.dbBackupsDir, `${crashed}.sqlite`), 'half', old)
    put(path.join(L.dbBackupsDir, `${crashed}.sqlite-journal`), 'j', old)
    await e.mgr.run({ kind: 'pre-update', scope: 'db' })
    expect(fs.readdirSync(L.dbBackupsDir).filter((n) => n.startsWith(crashed))).toEqual([])
    // ops.start() calls removeUnfinished (checked here by source: starting Ops needs a whole server)
    const ops = fs.readFileSync(path.join(REPO, 'server', 'src', 'system', 'ops.ts'), 'utf8')
    const start = ops.slice(ops.indexOf('\n  start() {'), ops.indexOf('\n  start() {') + 800)
    expect(start).toContain('this.backups.removeUnfinished()')
    e.db.close()
  })
})

describe('fsync helpers', () => {
  test('fsyncTree syncs files and folders and does not follow links; fsyncPath takes a folder', async () => {
    const d = path.join(W, 'sync')
    put(path.join(d, 'a', 'b', 'f.txt'), 'data')
    put(path.join(d, 'g.txt'), 'data')
    fs.symlinkSync('/nonexistent/target', path.join(d, 'a', 'dangling'))
    await fsyncTree(d)
    await fsyncPath(d)
    await fsyncPath(path.join(d, 'a', 'dangling')) // a link: nothing to sync, no error
    await expect(fsyncPath(path.join(d, 'missing'))).rejects.toThrow()
  })

  test('the in-app update syncs the staged version before its rename and app/current + state.json after the switch', () => {
    const s = fs.readFileSync(path.join(REPO, 'server', 'src', 'system', 'update.ts'), 'utf8')
    const stage = s.slice(s.indexOf('async stage('), s.indexOf('async switchTo('))
    expect(stage.indexOf('await fsyncTree(staging)')).toBeGreaterThan(0)
    expect(stage.indexOf('await fsyncTree(staging)')).toBeLessThan(stage.indexOf('await fsp.rename(staging, dest)'))
    expect(stage.indexOf('await fsyncPath(this.versionsDir())')).toBeGreaterThan(stage.indexOf('await fsp.rename(staging, dest)'))
    const sw = s.slice(s.indexOf('async switchTo('), s.indexOf('async rollBack('))
    expect(sw.indexOf('await fsyncPath(this.o.appDir)')).toBeGreaterThan(sw.indexOf("fs.renameSync(tmp, path.join(this.o.appDir, 'current'))"))
    const ws = s.slice(s.indexOf('private writeState('), s.indexOf('currentLinkTarget(): string'))
    expect(ws).toContain('fs.fsyncSync(fd)')
  })
})

describe('install-linux.sh: the new version is on disk before the switch (QA TC-279)', () => {
  const s = fs.readFileSync(path.join(REPO, 'scripts', 'install-linux.sh'), 'utf8')
  const at = (needle: string) => {
    const i = s.indexOf(needle)
    expect(`${needle}: ${i > 0}`).toBe(`${needle}: true`)
    return i
  }

  test('sync before the version rename, the folder after it, and app/current switched by renaming a new link', () => {
    const syncNew = at('sync -f "$DEST.partial" || die')
    const rename = at('mv -T "$DEST.partial" "$DEST"\n')
    const syncVersions = at('sync "$BASE/app/versions" || die')
    expect(syncNew).toBeLessThan(rename)
    expect(syncVersions).toBeGreaterThan(rename)
    const link = at('ln -s "versions/$VERSION" "$BASE/app/.current-install"')
    const swap = at('mv -f -T "$BASE/app/.current-install" "$BASE/app/current"')
    expect(syncVersions).toBeLessThan(link)
    expect(link).toBeLessThan(swap)
    expect(s).not.toContain('rm -f "$BASE/app/current"')
    expect(at('sync "$BASE/app/state.json" "$BASE/app" || die')).toBeGreaterThan(at('put "$ITMP/state.json" "$SRV_USER" "$SRV_GRP" 640 "$BASE/app/state.json"'))
  })

  test('the engine: its file synced, current switched by renaming a new link', () => {
    expect(at('sync "$dir/$name" "$dir" "$BASE/app/engines/$name" || die')).toBeGreaterThan(at('put "$stage" "$SRV_USER" "$AGT_GRP" 750 "$dir/$name"'))
    expect(at('mv -f -T "$BASE/app/engines/$name/.current-install" "$BASE/app/engines/$name/current"')).toBeGreaterThan(at('ln -s "$sha" "$BASE/app/engines/$name/.current-install"'))
    expect(s).not.toContain('rm -f "$BASE/app/engines/$name/current"')
  })

  test.skipIf(process.platform !== 'linux')('the switch lines run: current always points at a version, never missing', () => {
    // the version step's lines as they are in the script (from the sync to the switch), against a temp folder
    const root = path.join(W, 'switch')
    fs.mkdirSync(path.join(root, 'app', 'versions', '1.0.0'), { recursive: true })
    fs.mkdirSync(path.join(root, 'kit'), { recursive: true })
    fs.writeFileSync(path.join(root, 'kit', 'manifest.json'), '{}')
    fs.symlinkSync('versions/1.0.0', path.join(root, 'app', 'current'))
    const body = s.slice(at('sync -f "$DEST.partial" || die'), at('sync "$BASE/app/versions" || die'))
    const sw = s.slice(at('    rm -f "$BASE/app/.current-install"'), at('    RUNNING=$VERSION'))
    const script = `set -euo pipefail
die() { echo "die: $*" >&2; exit 9; }
BASE="$ROOT"; VERSION=2.0.0; DEST="$BASE/app/versions/$VERSION"
SRV_USER=$(id -un); SRV_GRP=$(id -gn)
cp -a "$ROOT/kit" "$DEST.partial"
${body}
sync "$BASE/app/versions" || die x
${sw}`
    const p = Bun.spawnSync(['/bin/bash', '-c', script], { env: { PATH: '/usr/bin:/bin', ROOT: root }, stdout: 'pipe', stderr: 'pipe' })
    expect(`${p.exitCode} ${p.stderr.toString()}`).toBe('0 ')
    expect(fs.readlinkSync(path.join(root, 'app', 'current'))).toBe('versions/2.0.0')
    expect(fs.existsSync(path.join(root, 'app', '.current-install'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'app', 'versions', '2.0.0', 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'app', 'versions', '2.0.0.partial'))).toBe(false)
  })
})
