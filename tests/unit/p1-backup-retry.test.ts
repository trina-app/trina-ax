// The nightly backup is checked every 10 minutes. When it failed for a reason other than disk space (a team folder
// that can't be read, a damaged previous list), the check found no daily backup again and re-ran the whole thing every
// 10 minutes, all day: a full team-folder read and compression six times an hour. A failed nightly backup now waits an
// hour before the next try.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { createContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { OpsService } from '../../server/src/system/ops'
import { WORK } from '../lib/env'

test('a failed nightly backup is retried after an hour, not at every 10-minute check', () => {
  const dir = path.join(WORK, 'p1-backup-retry')
  fs.rmSync(dir, { recursive: true, force: true })
  const cfg = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null,
  } as AppConfig
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  let now = new Date(2026, 9, 21, 3, 5)
  const ops = new OpsService(createContext({ config: cfg, db, log: silentLogger }), { now: () => now, engines: async () => [] })
  expect(ops.shouldRunDailyBackup()).toBe(true)
  fs.mkdirSync(ops.layout.dbBackupsDir, { recursive: true })
  fs.writeFileSync(path.join(ops.layout.dbBackupsDir, 'last-error.json'), JSON.stringify({ at: now.toISOString(), message: 'team folder unreadable' }))
  now = new Date(2026, 9, 21, 3, 15)
  expect(ops.shouldRunDailyBackup()).toBe(false)
  now = new Date(2026, 9, 21, 4, 6)
  expect(ops.shouldRunDailyBackup()).toBe(true)
  db.close()
})
