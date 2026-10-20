// Component G: backups (VACUUM INTO + team-folder manifest-diff tar.zst), retention, team-folder restore, staged DB
// restore applied at start, export.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { applyPendingRestore, BackupManager } from '../../server/src/system/backup'
import { chatMarkdown, chatPath, memoriesCsv, runExport } from '../../server/src/system/export'
import { resolveLayout } from '../../server/src/system/layout'
import { diffManifest, toManifest, walkTree } from '../../server/src/system/manifest'
import { ageDecrypt, readFileChunks, zstdDecompress } from '../../server/src/system/streams'
import { extractTar } from '../../server/src/system/tar'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-backup')
fs.rmSync(W, { recursive: true, force: true })

function setup(name: string) {
  const base = path.join(W, name)
  const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(path.join(cfg.teamRoot, 'shared'), { recursive: true })
  fs.mkdirSync(path.join(cfg.teamRoot, 'users', 'olga'), { recursive: true })
  fs.writeFileSync(path.join(cfg.teamRoot, 'shared', 'plan.md'), '# 계획\n')
  fs.writeFileSync(path.join(cfg.teamRoot, 'shared', 'big.bin'), Buffer.alloc(1_500_000, 3))
  fs.writeFileSync(path.join(cfg.teamRoot, 'users', 'olga', 'note.txt'), 'private')
  const dbFile = path.join(cfg.dataDir, 'app.db')
  const db = openDb(dbFile)
  db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner')").run()
  let clock = new Date('2026-10-01T04:00:00Z')
  const layout = resolveLayout(cfg)
  const mgr = new BackupManager({ db, dbFile, layout, log: silentLogger, version: '0.1.0', now: () => clock })
  return { cfg, db, dbFile, layout, mgr, setClock: (d: Date) => { clock = d } }
}

describe('manifest diff', () => {
  test('new, changed and deleted files', () => {
    const a = { 'x.md': { s: 1, m: 10 }, 'y.md': { s: 2, m: 20 }, 'gone.md': { s: 3, m: 30 } }
    const b = { 'x.md': { s: 1, m: 10 }, 'y.md': { s: 2, m: 21 }, 'new.md': { s: 4, m: 40 } }
    expect(diffManifest(a, b)).toEqual({ changed: ['y.md', 'new.md'], deleted: ['gone.md'] })
  })
})

describe('backups', () => {
  test('full, then incremental with changes and deletions; restore rebuilds the folder exactly', async () => {
    const e = setup('chain')
    const full = await e.mgr.run({ kind: 'manual', scope: 'full' })
    expect(full.scope).toBe('full')
    expect(full.team!.files).toBe(3)
    expect(fs.existsSync(path.join(e.cfg.teamRoot, '.system', 'backups', full.id, 'team.tar.zst'))).toBe(true)
    expect(fs.statSync(path.join(e.cfg.teamRoot, '.system', 'backups')).mode & 0o777).toBe(0o700)

    // changes after the full backup
    e.setClock(new Date('2026-10-02T04:00:00Z'))
    fs.writeFileSync(path.join(e.cfg.teamRoot, 'shared', 'plan.md'), '# 계획 v2\n')
    fs.utimesSync(path.join(e.cfg.teamRoot, 'shared', 'plan.md'), new Date(), new Date(Date.now() + 5000))
    fs.writeFileSync(path.join(e.cfg.teamRoot, 'shared', '새 문서.md'), 'new')
    fs.rmSync(path.join(e.cfg.teamRoot, 'users', 'olga', 'note.txt'))
    const inc = await e.mgr.run({ kind: 'daily', scope: 'full' })
    expect(inc.scope).toBe('incremental')
    expect(inc.team!.base).toBe(full.id)
    expect(inc.team!.files).toBe(2)
    expect(inc.team!.deleted).toBe(1)
    expect(e.mgr.chain(inc.id)).toEqual([full.id, inc.id])

    // the backup folder itself is never archived
    const inc2 = await e.mgr.run({ kind: 'manual', scope: 'full' })
    expect(inc2.team!.files).toBe(0)

    const dest = path.join(W, 'chain-restored')
    const r = await e.mgr.restoreTeamTo(inc.id, dest)
    expect(r.files).toBe(3)
    expect(fs.readFileSync(path.join(dest, 'shared', 'plan.md'), 'utf8')).toBe('# 계획 v2\n')
    expect(fs.existsSync(path.join(dest, 'users', 'olga', 'note.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(dest, 'shared', '새 문서.md'), 'utf8')).toBe('new')
    const live = toManifest((await walkTree(e.cfg.teamRoot, { exclude: ['.system'] })).files)
    const got = toManifest((await walkTree(dest)).files)
    expect(got).toEqual(live)

    // restoring the full one gives the old state
    const dest0 = path.join(W, 'chain-restored-0')
    await e.mgr.restoreTeamTo(full.id, dest0)
    expect(fs.readFileSync(path.join(dest0, 'users', 'olga', 'note.txt'), 'utf8')).toBe('private')
    await expect(e.mgr.restoreTeamTo(full.id, dest0)).rejects.toThrow(/already exists/)

    const list = e.mgr.list()
    expect(list.map((b) => b.scope)).toEqual(['incremental', 'incremental', 'full'])
    expect(list[0]!.size).toBeGreaterThan(0)
    e.db.close()
  })

  test('DB copy is consistent while the server keeps writing', async () => {
    const e = setup('vacuum')
    e.db.query("INSERT INTO settings (key, value) VALUES ('n', '0')").run()
    let writes = 0
    const iv = setInterval(() => { e.db.query("UPDATE settings SET value = ? WHERE key = 'n'").run(String(++writes)) }, 1)
    const m = await e.mgr.run({ kind: 'manual', scope: 'db' })
    clearInterval(iv)
    expect(m.scope).toBe('db')
    expect(m.team).toBeNull()
    const copy = openDb(path.join(e.layout.dbBackupsDir, m.db.file))
    expect((copy.query('PRAGMA integrity_check').get() as Record<string, string>).integrity_check).toBe('ok')
    expect(Number((copy.query("SELECT value FROM settings WHERE key = 'n'").get() as { value: string }).value)).toBeLessThanOrEqual(writes)
    copy.close()
    e.db.close()
  })

  test('retention: 14 days, but a kept incremental keeps its base and the newest backup is never removed', async () => {
    const e = setup('prune')
    e.setClock(new Date('2026-10-01T04:00:00Z'))
    const full = await e.mgr.run({ kind: 'daily', scope: 'full' })
    e.setClock(new Date('2026-10-05T04:00:00Z'))
    const inc = await e.mgr.run({ kind: 'daily', scope: 'full' })
    expect(inc.team!.base).toBe(full.id)
    e.setClock(new Date('2026-10-17T04:00:00Z')) // full is 16 days old, inc 12
    expect(e.mgr.prune()).toEqual([])
    e.setClock(new Date('2026-10-30T04:00:00Z')) // both old: the newest stays (and its base)
    expect(e.mgr.prune()).toEqual([])
    const fresh = await e.mgr.run({ kind: 'daily', scope: 'full' }) // > 7 days since the full: new chain
    expect(fresh.scope).toBe('full')
    expect(e.mgr.metas().map((m) => m.id)).toEqual([fresh.id])
    expect(fs.existsSync(path.join(e.layout.teamBackupsDir, full.id))).toBe(false)
    e.db.close()
  })

  test('not enough disk space: the backup refuses and the failure is reported', async () => {
    const e = setup('disk')
    const { BackupManager: BM } = await import('../../server/src/system/backup')
    const layout = { ...e.layout }
    const mgr = new BM({ db: e.db, dbFile: e.dbFile, layout, log: silentLogger, version: '0.1.0' })
    const orig = fs.statfsSync
    ;(fs as unknown as { statfsSync: unknown }).statfsSync = () => ({ bavail: 10, bsize: 4096, blocks: 1e6 })
    try {
      await expect(mgr.run({ kind: 'manual', scope: 'full' })).rejects.toThrow(/disk space/)
    } finally {
      ;(fs as unknown as { statfsSync: unknown }).statfsSync = orig
    }
    expect(mgr.lastError()?.message).toMatch(/disk space/)
    e.db.close()
  })
})

describe('DB restore (staged, applied at the next start)', () => {
  test('rows written after the backup are gone after the restore; the old DB is kept aside', async () => {
    const e = setup('restore')
    const t = new Date().toISOString()
    e.db.query("INSERT INTO sessions (id, user_id, token_hash, client, created_at, last_seen_at, expires_at) VALUES ('s-old', 'olga', 'h-old', 'web', ?, ?, ?)").run(t, t, '2099-01-01T00:00:00Z')
    const m = await e.mgr.run({ kind: 'manual', scope: 'db' })
    e.db.query("INSERT INTO users (id, username, name, role) VALUES ('later', 'later', 'Later', 'member')").run()
    const p = await e.mgr.stageDbRestore(m.id, 'olga')
    expect(p.backupId).toBe(m.id)
    e.db.close()
    const r = applyPendingRestore(e.cfg.dataDir, silentLogger)
    expect(r.applied).toBe(true)
    const db = openDb(e.dbFile)
    expect(db.query("SELECT id FROM users WHERE id = 'later'").get()).toBeNull()
    expect(db.query("SELECT id FROM users WHERE id = 'olga'").get()).not.toBeNull()
    // a sign-in that existed at backup time (and may have been revoked since) does not come back: everyone signs in again
    expect(db.query('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    db.close()
    expect(fs.readdirSync(e.layout.dbBackupsDir).some((n) => n.startsWith('before-restore-'))).toBe(true)
    expect(fs.existsSync(path.join(e.cfg.dataDir, 'restore-pending.json'))).toBe(false)
    expect(applyPendingRestore(e.cfg.dataDir, silentLogger).applied).toBe(false)
  })

  test('a damaged staged copy is refused and the live DB stays', async () => {
    const e = setup('restore-bad')
    const m = await e.mgr.run({ kind: 'manual', scope: 'db' })
    await e.mgr.stageDbRestore(m.id, null)
    const staged = path.join(e.cfg.dataDir, 'restore-staged.db')
    const b = fs.readFileSync(staged)
    b.fill(0x55, 0, 100) // header destroyed
    fs.writeFileSync(staged, b)
    e.db.query("INSERT INTO users (id, username, name, role) VALUES ('keep', 'keep', 'Keep', 'member')").run()
    e.db.close()
    const r = applyPendingRestore(e.cfg.dataDir, silentLogger)
    expect(r.applied).toBe(false)
    const db = openDb(e.dbFile)
    expect(db.query("SELECT id FROM users WHERE id = 'keep'").get()).not.toBeNull()
    db.close()
    expect(JSON.parse(fs.readFileSync(path.join(e.cfg.dataDir, 'restore-result.json'), 'utf8')).ok).toBe(false)
  })

  test('unknown backup ids are refused', async () => {
    const e = setup('restore-unknown')
    await expect(e.mgr.stageDbRestore('20990101T000000Z-manual', null)).rejects.toThrow(/not found/)
    expect(e.mgr.dbFileOf('../../etc/passwd')).toBeNull()
    e.db.close()
  })
})

describe('export', () => {
  test('own chats as Markdown (visible branch), own memories as CSV, the team folder; encrypted with a password', async () => {
    const e = setup('export')
    e.db.query("INSERT INTO users (id, username, name, role) VALUES ('bob', 'bob', 'Bob', 'member')").run()
    e.db.query("INSERT INTO chats (id, user_id, title, active_leaf_id) VALUES ('c1', 'olga', '분기 계획', 'm3')").run()
    e.db.query("INSERT INTO chats (id, user_id, title) VALUES ('c2', 'bob', 'Bob private')").run()
    const msg = e.db.query('INSERT INTO messages (id, chat_id, role, content, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    msg.run('m1', 'c1', 'user', '질문', null, '2026-10-01T00:00:00Z')
    msg.run('m2', 'c1', 'assistant', '버린 답', 'm1', '2026-10-01T00:00:01Z')
    msg.run('m3', 'c1', 'assistant', '고른 답', 'm1', '2026-10-01T00:00:02Z')
    msg.run('b1', 'c2', 'user', 'bob secret', null, '2026-10-01T00:00:00Z')
    e.db.query("INSERT INTO memories (id, user_id, text) VALUES ('mem1', 'olga', 'likes \"tables\", short answers')").run()
    e.db.query("INSERT INTO memories (id, user_id, text) VALUES ('mem2', 'bob', 'bob memory')").run()
    const r = await runExport(e.db, e.cfg.teamRoot, { ownerId: 'olga', what: ['chats', 'memories', 'files'], password: 'export-pass-1' })
    expect(r.path).toMatch(/^users\/olga\/exports\/.+\.tar\.zst\.age$/)
    const out = path.join(W, 'export-out')
    fs.mkdirSync(out)
    await extractTar(zstdDecompress(ageDecrypt(readFileChunks(path.join(e.cfg.teamRoot, r.path)), 'export-pass-1')), out)
    const root = path.join(out, fs.readdirSync(out)[0]!)
    const chats = fs.readdirSync(path.join(root, 'chats'))
    expect(chats).toHaveLength(1)
    const md = fs.readFileSync(path.join(root, 'chats', chats[0]!), 'utf8')
    expect(md).toContain('고른 답')
    expect(md).not.toContain('버린 답')
    const csv = fs.readFileSync(path.join(root, 'memories.csv'), 'utf8')
    expect(csv).toContain('"likes ""tables"", short answers"')
    expect(csv).not.toContain('bob memory')
    expect(fs.readFileSync(path.join(root, 'files', 'shared', 'plan.md'), 'utf8')).toBe('# 계획\n')
    expect(fs.existsSync(path.join(root, 'files', 'users', 'olga', 'exports'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'files', '.system'))).toBe(false)
    // a second export does not contain the first one
    const r2 = await runExport(e.db, e.cfg.teamRoot, { ownerId: 'olga', what: ['files'] })
    expect(r2.path).toMatch(/\.tar\.zst$/)
    e.db.close()
  }, 30_000)

  test('markdown and CSV helpers', () => {
    const rows = [
      { id: 'a', parent_id: null, role: 'user' as const, content: 'q', created_at: '1', status: 'done', engine: null, model: null },
      { id: 'b', parent_id: 'a', role: 'assistant' as const, content: 'x', created_at: '2', status: 'stopped', engine: null, model: 'opus' },
    ]
    expect(chatPath(rows, 'b').map((r) => r.id)).toEqual(['a', 'b'])
    expect(chatPath(rows, null).map((r) => r.id)).toEqual(['a', 'b'])
    const md = chatMarkdown({ id: 'c', title: '', created_at: '1', updated_at: '2', engine: 'claude-code', active_leaf_id: 'b' }, rows)
    expect(md).toContain('(stopped)')
    expect(memoriesCsv([{ id: '1', text: 'a,b\nc', created_at: 't', source_chat_id: null }])).toContain('"a,b\nc"')
  })
})

describe('review fixes (component G)', () => {
  test('export leaves out other people\'s private users/<id>/ folders but keeps the owner\'s own', async () => {
    const e = setup('export-privacy')
    fs.mkdirSync(path.join(e.cfg.teamRoot, 'users', 'bob'), { recursive: true })
    fs.writeFileSync(path.join(e.cfg.teamRoot, 'users', 'bob', 'diary.txt'), 'bob private')
    const r = await runExport(e.db, e.cfg.teamRoot, { ownerId: 'olga', what: ['files'] })
    const out = path.join(W, 'export-privacy-out')
    fs.mkdirSync(out)
    await extractTar(zstdDecompress(readFileChunks(path.join(e.cfg.teamRoot, r.path))), out)
    const root = path.join(out, fs.readdirSync(out)[0]!)
    expect(fs.existsSync(path.join(root, 'files', 'users', 'bob'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'files', 'users', 'olga', 'note.txt'), 'utf8')).toBe('private')
    expect(fs.existsSync(path.join(root, 'files', 'shared', 'plan.md'))).toBe(true)
    await expect(runExport(e.db, e.cfg.teamRoot, { ownerId: '../bob', what: ['files'] })).rejects.toThrow(/owner id/)
    e.db.close()
  })

  test('incremental restore: a file that became a folder, and a folder that became a file', async () => {
    const e = setup('kind-change')
    const T = e.cfg.teamRoot
    fs.writeFileSync(path.join(T, 'shared', 'thing'), 'a file')
    fs.mkdirSync(path.join(T, 'shared', 'dir'))
    fs.writeFileSync(path.join(T, 'shared', 'dir', 'inner.txt'), 'inner')
    const full = await e.mgr.run({ kind: 'manual', scope: 'full' })
    e.setClock(new Date('2026-10-02T04:00:00Z'))
    fs.rmSync(path.join(T, 'shared', 'thing'))
    fs.mkdirSync(path.join(T, 'shared', 'thing'))
    fs.writeFileSync(path.join(T, 'shared', 'thing', 'now-a-folder.txt'), 'x')
    fs.rmSync(path.join(T, 'shared', 'dir'), { recursive: true })
    fs.writeFileSync(path.join(T, 'shared', 'dir'), 'now a file')
    const inc = await e.mgr.run({ kind: 'daily', scope: 'full' })
    expect(inc.team!.base).toBe(full.id)
    const dest = path.join(W, 'kind-change-restored')
    await e.mgr.restoreTeamTo(inc.id, dest)
    expect(fs.readFileSync(path.join(dest, 'shared', 'thing', 'now-a-folder.txt'), 'utf8')).toBe('x')
    expect(fs.readFileSync(path.join(dest, 'shared', 'dir'), 'utf8')).toBe('now a file')
    e.db.close()
  })

  test('a file that vanishes between listing and archiving is neither expected on restore nor brought back', async () => {
    const e = setup('vanish')
    const T = e.cfg.teamRoot
    fs.writeFileSync(path.join(T, 'shared', 'temp.txt'), 'v1')
    const full = await e.mgr.run({ kind: 'manual', scope: 'full' })
    e.setClock(new Date('2026-10-02T04:00:00Z'))
    fs.writeFileSync(path.join(T, 'shared', 'temp.txt'), 'v2 longer') // changed -> in the next archive's list
    fs.writeFileSync(path.join(T, 'shared', 'brand-new.txt'), 'new')
    let vanish = true
    const mgr = new BackupManager({ db: e.db, dbFile: e.dbFile, layout: e.layout, log: silentLogger, version: '0.1.0', now: () => new Date('2026-10-02T04:00:00Z'),
      afterWalk: () => { if (vanish) { fs.rmSync(path.join(T, 'shared', 'temp.txt')); fs.rmSync(path.join(T, 'shared', 'brand-new.txt')) } } })
    const inc = await mgr.run({ kind: 'daily', scope: 'full' })
    vanish = false
    expect(inc.team!.base).toBe(full.id)
    const dest = path.join(W, 'vanish-restored')
    await mgr.restoreTeamTo(inc.id, dest) // used to fail: the list expected the vanished files
    expect(fs.existsSync(path.join(dest, 'shared', 'temp.txt'))).toBe(false) // the v1 copy from the full one must not come back
    expect(fs.existsSync(path.join(dest, 'shared', 'brand-new.txt'))).toBe(false)
    // it reappears: the next backup takes it
    fs.writeFileSync(path.join(T, 'shared', 'brand-new.txt'), 'back')
    const inc2 = await mgr.run({ kind: 'manual', scope: 'full' })
    const dest2 = path.join(W, 'vanish-restored-2')
    await mgr.restoreTeamTo(inc2.id, dest2)
    expect(fs.readFileSync(path.join(dest2, 'shared', 'brand-new.txt'), 'utf8')).toBe('back')
    e.db.close()
  })

  test('a restored folder with a file the backup does not have is refused', async () => {
    const e = setup('extra')
    const full = await e.mgr.run({ kind: 'manual', scope: 'full' })
    const man = path.join(e.layout.teamBackupsDir, full.id, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(man, 'utf8'))
    delete m['shared/plan.md']
    fs.writeFileSync(man, JSON.stringify(m))
    const dest = path.join(W, 'extra-restored')
    await expect(e.mgr.restoreTeamTo(full.id, dest)).rejects.toThrow(/does not/)
    expect(fs.existsSync(dest)).toBe(false)
    e.db.close()
  })

  test('applying a staged restore that fails half-way puts the live DB (and its WAL) back', async () => {
    const e = setup('restore-half')
    const m = await e.mgr.run({ kind: 'manual', scope: 'db' })
    e.db.query("INSERT INTO users (id, username, name, role) VALUES ('after', 'after', 'After', 'member')").run()
    await e.mgr.stageDbRestore(m.id, 'olga')
    e.db.close()
    const staged = path.join(e.cfg.dataDir, 'restore-staged.db')
    const r = applyPendingRestore(e.cfg.dataDir, silentLogger, {
      rename: (a, b) => { if (a === staged) throw new Error('disk error'); fs.renameSync(a, b) },
    })
    expect(r.applied).toBe(false)
    expect(fs.existsSync(e.dbFile)).toBe(true)
    const db = openDb(e.dbFile)
    expect(db.query("SELECT id FROM users WHERE id = 'after'").get()).not.toBeNull()
    db.close()
    expect(JSON.parse(fs.readFileSync(path.join(e.cfg.dataDir, 'restore-result.json'), 'utf8')).ok).toBe(false)
  })
})
