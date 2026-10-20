// Folders in incremental backups. An incremental archive carried only changed files, never folders, so a folder that
// was made after the last full backup and is still empty (a new group's folder, a project folder before its first file)
// was missing after a restore, and an empty folder deleted since the full backup came back. The restore check compared
// files only, so it did not notice either.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { BackupManager } from '../../server/src/system/backup'
import { resolveLayout } from '../../server/src/system/layout'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'p1-backup-dirs')
fs.rmSync(W, { recursive: true, force: true })

function setup(name: string) {
  const base = path.join(W, name)
  const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  for (const d of ['shared/old-empty', 'groups', 'users/olga']) fs.mkdirSync(path.join(cfg.teamRoot, d), { recursive: true })
  fs.writeFileSync(path.join(cfg.teamRoot, 'shared', 'plan.md'), '# plan\n')
  const dbFile = path.join(cfg.dataDir, 'app.db')
  const db = openDb(dbFile)
  let clock = new Date('2026-10-01T04:00:00Z')
  const layout = resolveLayout(cfg)
  const mgr = new BackupManager({ db, dbFile, layout, log: silentLogger, version: '0.1.0', now: () => clock })
  return { cfg, db, mgr, layout, setClock: (d: Date) => { clock = d } }
}

const dirsUnder = (root: string): string[] => {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (r === '.system/backups') continue
      out.push(r)
      walk(r)
    }
  }
  walk('')
  return out.sort()
}

test('folders made or removed after the full backup are restored as they were', async () => {
  const e = setup('chain')
  const T = e.cfg.teamRoot
  await e.mgr.run({ kind: 'manual', scope: 'full' })
  e.setClock(new Date('2026-10-02T04:00:00Z'))
  fs.mkdirSync(path.join(T, 'groups', 'design', 'drafts'), { recursive: true }) // new, empty
  fs.rmdirSync(path.join(T, 'shared', 'old-empty')) // was empty, now gone
  const inc = await e.mgr.run({ kind: 'daily', scope: 'full' })
  expect(inc.scope).toBe('incremental')
  e.setClock(new Date('2026-10-03T04:00:00Z'))
  fs.mkdirSync(path.join(T, 'projects', 'atlas'), { recursive: true })
  const inc2 = await e.mgr.run({ kind: 'daily', scope: 'full' })
  expect(inc2.team!.base).toBe(inc.id)

  const dest = path.join(W, 'chain-restored')
  await e.mgr.restoreTeamTo(inc2.id, dest)
  expect(dirsUnder(dest)).toEqual(dirsUnder(T))
  expect(fs.existsSync(path.join(dest, 'groups', 'design', 'drafts'))).toBe(true)
  expect(fs.existsSync(path.join(dest, 'shared', 'old-empty'))).toBe(false)

  // an older point of the chain: as it was then
  const dest1 = path.join(W, 'chain-restored-1')
  await e.mgr.restoreTeamTo(inc.id, dest1)
  expect(fs.existsSync(path.join(dest1, 'projects', 'atlas'))).toBe(false)
  expect(fs.existsSync(path.join(dest1, 'groups', 'design', 'drafts'))).toBe(true)
  e.db.close()
})

test('a restore missing a folder the backup listed is refused', async () => {
  const e = setup('missing')
  const full = await e.mgr.run({ kind: 'manual', scope: 'full' })
  const list = path.join(e.layout.teamBackupsDir, full.id, 'dirs.json')
  fs.writeFileSync(list, JSON.stringify([...JSON.parse(fs.readFileSync(list, 'utf8')), 'shared/never-archived']))
  const dest = path.join(W, 'missing-restored')
  await expect(e.mgr.restoreTeamTo(full.id, dest)).rejects.toThrow(/folder/)
  expect(fs.existsSync(dest)).toBe(false)
  e.db.close()
})
