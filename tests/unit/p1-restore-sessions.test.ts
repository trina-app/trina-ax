// Engine session stashes after a DB restore. A chat's session keeps its id across resumed turns and its stash
// (<data>/sessions/<chatId>/<sid>.jsonl) is overwritten after every turn, but the stashes are not part of the DB
// backup. After restoring yesterday's DB, the chat still pointed at that session id with yesterday's leaf, the stash
// file of that id existed (today's), so the next turn resumed a session that held today's conversation, which the
// restored chat no longer shows: the AI went on from messages the person can't see. The restore now moves the stashes
// aside with the replaced DB; every chat starts a fresh session from its (restored) history.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { applyPendingRestore, BackupManager } from '../../server/src/system/backup'
import { resolveLayout } from '../../server/src/system/layout'
import { WORK } from '../lib/env'

test('a DB restore takes the engine session stashes away with the replaced DB', async () => {
  const base = path.join(WORK, 'p1-restore-sessions')
  fs.rmSync(base, { recursive: true, force: true })
  const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
  fs.mkdirSync(cfg.teamRoot, { recursive: true })
  const dbFile = path.join(cfg.dataDir, 'app.db')
  const db = openDb(dbFile)
  const layout = resolveLayout(cfg)
  const mgr = new BackupManager({ db, dbFile, layout, log: silentLogger, version: '0.1.0' })
  const stash = path.join(cfg.dataDir, 'sessions', 'chat-1', 'sid-1.jsonl')
  fs.mkdirSync(path.dirname(stash), { recursive: true })
  fs.writeFileSync(stash, '{"yesterday":true}\n')
  const m = await mgr.run({ kind: 'manual', scope: 'db' })
  fs.writeFileSync(stash, '{"yesterday":true}\n{"today":"rolled back by the restore"}\n')
  await mgr.stageDbRestore(m.id, null)
  db.close()
  const r = applyPendingRestore(cfg.dataDir, silentLogger)
  expect(r.applied).toBe(true)
  expect(fs.existsSync(path.join(cfg.dataDir, 'sessions', 'chat-1'))).toBe(false)
  // kept next to the replaced DB, like the DB itself
  const kept = fs.readdirSync(layout.dbBackupsDir).find((n) => n.startsWith('before-restore-'))!
  expect(fs.readFileSync(path.join(layout.dbBackupsDir, kept, 'sessions', 'chat-1', 'sid-1.jsonl'), 'utf8')).toContain('today')
})
