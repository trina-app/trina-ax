// Disk retention for a small team disk (docs/DECISIONS.md "Disk: what is kept and what goes"): the team backup leaves out
// the folders a tool makes again, the migration runner's copies keep the newest 5 and 14 days, the dev environment's
// caches and the build folders of idle chats are cleaned and nothing else, and a 20 GB disk warns early.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { BackupManager } from '../../server/src/system/backup'
import { CACHE_IDLE_DAYS, CACHE_MAX_BYTES, cleanDevenv, TMP_KEEP_DAYS, WORK_IDLE_DAYS } from '../../server/src/system/devenv-clean'
import { resolveLayout } from '../../server/src/system/layout'
import { isRegenerableDir } from '../../server/src/system/regenerable'
import { levelOf, snapshotOf } from '../../server/src/system/storage'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-disk-retention')
fs.rmSync(W, { recursive: true, force: true })
const DAY = 86_400_000
const put = (f: string, body: string | Buffer = 'x', ageDays = 0, now = Date.now()) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, body)
  const t = new Date(now - ageDays * DAY)
  fs.utimesSync(f, t, t)
}
/** age a whole tree (files first, then folders, so a folder's mtime is not moved by its children) */
function age(dir: string, ageDays: number, now: number) {
  const t = new Date(now - ageDays * DAY)
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) age(path.join(dir, e.name), ageDays, now); else fs.utimesSync(path.join(dir, e.name), t, t)
  fs.utimesSync(dir, t, t)
}

function setup(name: string, now: Date) {
  const base = path.join(W, name)
  const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(cfg.teamRoot, { recursive: true })
  const dbFile = path.join(cfg.dataDir, 'app.db')
  const db = openDb(dbFile)
  const layout = resolveLayout(cfg)
  const mgr = new BackupManager({ db, dbFile, layout, log: silentLogger, version: '0.1.0', now: () => now })
  return { base, cfg, db, layout, mgr }
}

describe('team backup leaves out what a tool makes again', () => {
  test('the rule: node_modules and friends by name, a virtual environment by its pyvenv.cfg, never dist / build / out / .git', () => {
    const d = path.join(W, 'rule'); fs.mkdirSync(d, { recursive: true })
    for (const n of ['node_modules', '.next', '.turbo', '.svelte-kit', '.parcel-cache', '__pycache__']) expect(isRegenerableDir(n, path.join(d, n))).toBe(true)
    for (const n of ['dist', 'build', 'out', '.git', '.cache', 'src', 'venv-notes']) expect(isRegenerableDir(n, path.join(d, n))).toBe(false)
    put(path.join(d, '.venv', 'pyvenv.cfg'))
    expect(isRegenerableDir('.venv', path.join(d, '.venv'))).toBe(true)
    fs.mkdirSync(path.join(d, 'venv'))
    expect(isRegenerableDir('venv', path.join(d, 'venv'))).toBe(false) // a folder named venv with no pyvenv.cfg is the person's
  })

  test('a project\'s node_modules, .next and .venv are not in the archive, its files and dist are; a restore has them', async () => {
    const e = setup('backup-skip', new Date('2026-11-14T04:00:00Z'))
    const t = e.cfg.teamRoot
    put(path.join(t, 'projects', 'site', 'package.json'), '{}')
    put(path.join(t, 'projects', 'site', 'src', 'app.ts'), 'export {}')
    put(path.join(t, 'projects', 'site', 'dist', 'index.html'), '<p>result</p>')
    put(path.join(t, 'projects', 'site', 'node_modules', 'react', 'index.js'), Buffer.alloc(300_000, 1))
    put(path.join(t, 'projects', 'site', 'src', 'node_modules', 'deep', 'a.js'), 'x') // at any depth
    put(path.join(t, 'projects', 'site', '.next', 'cache', 'c.bin'), Buffer.alloc(300_000, 2))
    put(path.join(t, 'projects', 'py', '.venv', 'pyvenv.cfg'), 'home = /usr/bin')
    put(path.join(t, 'projects', 'py', '.venv', 'lib', 'x.py'), 'x')
    put(path.join(t, 'projects', 'py', 'main.py'), 'print(1)')
    const m = await e.mgr.run({ kind: 'manual', scope: 'full' })
    // package.json, app.ts, index.html, main.py (+ nothing from the regenerable folders)
    expect(m.team!.files).toBe(4)
    expect(m.team!.archiveSize).toBeLessThan(100_000)
    const dest = path.join(W, 'backup-skip-restored')
    await e.mgr.restoreTeamTo(m.id, dest)
    expect(fs.existsSync(path.join(dest, 'projects', 'site', 'dist', 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'projects', 'site', 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'projects', 'py', '.venv'))).toBe(false)
    // the next backup does not list them as changed, and an old chain that had them sees them as deleted
    const inc = await e.mgr.run({ kind: 'manual', scope: 'full' })
    expect(inc.team!.files).toBe(0)
    e.db.close()
  })
})

describe('migration copies: the newest 5 and the last 14 days, whichever keeps more', () => {
  const NOW = new Date('2026-11-14T04:00:00Z')
  const make = (e: ReturnType<typeof setup>, ages: number[]) => {
    fs.mkdirSync(e.layout.dbBackupsDir, { recursive: true })
    return ages.map((a, i) => {
      const n = `pre-migrate-2026-${String(i).padStart(2, '0')}-x.db`
      put(path.join(e.layout.dbBackupsDir, n), 'db', a, NOW.getTime())
      return n
    })
  }
  const left = (e: ReturnType<typeof setup>) => fs.readdirSync(e.layout.dbBackupsDir).filter((n) => n.startsWith('pre-migrate-')).sort()

  test('eight copies, all older than 14 days: the newest 5 stay', () => {
    const e = setup('pre-old', NOW)
    const names = make(e, [60, 50, 40, 30, 25, 22, 20, 18]) // oldest first
    e.mgr.prune()
    expect(left(e)).toEqual(names.slice(3))
    e.db.close()
  })

  test('more than 5 inside 14 days: all stay; older ones beyond the newest 5 go', () => {
    const e = setup('pre-young', NOW)
    const names = make(e, [40, 30, 13, 12, 10, 8, 5, 3, 1])
    e.mgr.prune()
    expect(left(e)).toEqual(names.slice(2)) // 40 and 30 days go, the 7 from the last 14 days stay
    e.db.close()
  })

  test('the copy before the latest migration is always kept, whatever its age', () => {
    const e = setup('pre-latest', NOW)
    const names = make(e, [90])
    e.mgr.prune()
    expect(left(e)).toEqual(names)
    e.db.close()
  })
})

describe('dev environment clean-up', () => {
  const NOW = new Date('2026-11-14T04:00:00Z').getTime()
  const none = () => ({ users: new Set<string>(), chats: new Set<string>() })
  const run = (base: string, o: Partial<Parameters<typeof cleanDevenv>[0]> = {}) => cleanDevenv({ base, now: () => NOW, busy: none, chatActivity: () => NOW - 60 * DAY, ...o })

  test('caches: removed whole when idle for 14 days or over the size cap; a young one, tmp and files stay', async () => {
    const base = path.join(W, 'caches')
    const home = path.join(base, 'devenv', 'home', 'olga')
    put(path.join(home, '.npm', '_cacache', 'a'), 'x', CACHE_IDLE_DAYS + 1, NOW)          // idle
    put(path.join(home, '.cache', 'pip', 'b'), 'x', 1, NOW)                                // young
    put(path.join(home, '.bun', 'install', 'cache', 'big'), Buffer.alloc(8192), 0, NOW)    // young; over the cap only in the second run
    put(path.join(home, 'tmp', 'old.log'), 'x', TMP_KEEP_DAYS + 1, NOW)
    put(path.join(home, 'tmp', 'new.log'), 'x', 1, NOW)
    put(path.join(home, 'notes.txt'), 'mine', 400, NOW) // not a cache: never touched
    for (const d of [path.join(home, '.npm', '_cacache'), path.join(home, 'tmp')]) { const t = new Date(NOW - 20 * DAY); if (d.endsWith('_cacache')) fs.utimesSync(d, t, t) }
    const r = await run(base, { cacheMaxBytes: 1_000_000 })
    expect(r.removed.map((x) => x.path).sort()).toEqual(['devenv/home/olga/.npm/_cacache', 'devenv/home/olga/tmp/old.log'])
    expect((await run(base, { cacheMaxBytes: 4096 })).removed.map((x) => x.path)).toEqual(['devenv/home/olga/.bun/install/cache'])
    expect(fs.existsSync(path.join(home, '.cache', 'pip', 'b'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.bun', 'install', 'cache', 'big'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'tmp', 'new.log'))).toBe(true)
    expect(fs.readFileSync(path.join(home, 'notes.txt'), 'utf8')).toBe('mine')
    expect(CACHE_MAX_BYTES).toBe(1024 ** 3)
  })

  test('a person with a run now keeps their caches; a link is not followed', async () => {
    const base = path.join(W, 'caches-busy')
    const home = path.join(base, 'devenv', 'home', 'olga')
    put(path.join(home, '.npm', '_cacache', 'a'), 'x', 30, NOW)
    age(path.join(home, '.npm', '_cacache'), 30, NOW)
    expect((await run(base, { busy: () => ({ users: new Set(['olga']), chats: new Set() }) })).removed).toEqual([])
    const outside = path.join(W, 'caches-outside'); put(path.join(outside, 'precious'), 'x', 99, NOW)
    fs.rmSync(path.join(home, '.npm', '_cacache'), { recursive: true }); fs.symlinkSync(outside, path.join(home, '.npm', '_cacache'))
    await run(base)
    expect(fs.existsSync(path.join(outside, 'precious'))).toBe(true)
  })

  test('work folders: only the regenerable folders of an idle chat go; the person\'s files and dist/out stay; no folder of a young or running chat', async () => {
    const base = path.join(W, 'work')
    const w = (c: string) => path.join(base, 'devenv', 'work', c)
    for (const c of ['idle', 'young-chat', 'running', 'fresh-file', 'no-chat']) {
      put(path.join(w(c), 'app', 'index.ts'), 'code', 40, NOW)
      put(path.join(w(c), 'app', 'out', 'video.mp4'), 'video', 40, NOW)
      put(path.join(w(c), 'app', 'node_modules', 'x', 'y.js'), 'dep', 40, NOW)
      age(path.join(w(c), 'app', 'node_modules'), 40, NOW)
      age(w(c), 40, NOW)
    }
    put(path.join(w('fresh-file'), 'app', 'index.ts'), 'edited now', 0, NOW) // a file outside the build folders changed
    const act: Record<string, number | null> = { idle: NOW - 30 * DAY, 'young-chat': NOW - 2 * DAY, running: NOW - 30 * DAY, 'fresh-file': NOW - 30 * DAY, 'no-chat': null }
    const r = await run(base, { chatActivity: (id) => act[id] ?? null, busy: () => ({ users: new Set(), chats: new Set(['running']) }) })
    expect(r.removed.map((x) => x.path)).toEqual(['devenv/work/idle/app/node_modules'])
    expect(r.removed[0]!.kind).toBe('build')
    for (const c of ['idle', 'young-chat', 'running', 'fresh-file', 'no-chat']) {
      expect(fs.readFileSync(path.join(w(c), 'app', 'index.ts'), 'utf8')).toMatch(/code|edited/)
      expect(fs.readFileSync(path.join(w(c), 'app', 'out', 'video.mp4'), 'utf8')).toBe('video')
    }
    expect(fs.existsSync(path.join(w('idle'), 'app', 'node_modules'))).toBe(false)
    for (const c of ['young-chat', 'running', 'fresh-file', 'no-chat']) expect(fs.existsSync(path.join(w(c), 'app', 'node_modules'))).toBe(true)
    expect(WORK_IDLE_DAYS).toBe(14)
  })

  test('a dry run removes nothing', async () => {
    const base = path.join(W, 'dry')
    put(path.join(base, 'devenv', 'work', 'c', 'node_modules', 'x'), 'x', 40, NOW)
    age(path.join(base, 'devenv', 'work', 'c'), 40, NOW)
    const r = await run(base, { dryRun: true })
    expect(r.removed.length).toBe(1)
    expect(fs.existsSync(path.join(base, 'devenv', 'work', 'c', 'node_modules', 'x'))).toBe(true)
  })

  test('nothing there is nothing to do', async () => {
    expect((await run(path.join(W, 'empty'))).removed).toEqual([])
  })
})

describe('a 20 GB data disk warns before 3 GB is left', () => {
  test('the 80% notice comes at 4 GB free; 90% (diagnostics warn) at 2 GB; a full backup needs 2 GB', () => {
    const GiB = 1024 ** 3
    const disk = (used: number) => snapshotOf({ bsize: 4096, blocks: (20 * GiB) / 4096, bfree: (20 * GiB - used) / 4096, bavail: (20 * GiB - used) / 4096 })
    const at = (freeGiB: number) => disk((20 - freeGiB) * GiB)
    expect(levelOf(at(4.5).percent)).toBe('ok')
    expect(levelOf(at(4).percent)).toBe('warn') // told here: more than the 3 GB asked for, and room for a 2 GB backup
    expect(levelOf(at(3).percent)).toBe('warn')
    expect(levelOf(at(2).percent)).toBe('high')
  })
})

describe('clean-up never follows a link out of devenv', () => {
  const NOW = new Date('2026-11-14T04:00:00Z').getTime()
  test('tmp, .npm and a build folder that are links leave their targets alone', async () => {
    const base = path.join(W, 'links')
    const victim = path.join(W, 'links-victim')
    put(path.join(victim, 'key.pem'), 'k', 99, NOW); put(path.join(victim, '_cacache', 'a'), 'x', 99, NOW); put(path.join(victim, '_logs', 'a'), 'x', 99, NOW)
    age(victim, 99, NOW)
    const home = path.join(base, 'devenv', 'home', 'u1')
    fs.mkdirSync(home, { recursive: true })
    fs.symlinkSync(victim, path.join(home, 'tmp')); fs.symlinkSync(victim, path.join(home, '.npm'))
    const work = path.join(base, 'devenv', 'work', 'c1'); fs.mkdirSync(work, { recursive: true })
    fs.symlinkSync(victim, path.join(work, 'node_modules'))
    await cleanDevenv({ base, now: () => NOW, busy: () => ({ users: new Set(), chats: new Set() }), chatActivity: () => NOW - 60 * DAY })
    expect(fs.readdirSync(victim).sort()).toEqual(['_cacache', '_logs', 'key.pem'])
  })
})
