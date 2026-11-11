// Start-up on a database an update must migrate (QA TC-278).
//
// Before migrating a database with data, openDb copies it (VACUUM INTO) and then applies the pending migrations; on a
// database of several GB that takes minutes. The server used to listen only after both, so mycel-bootstrap (health
// timeout 120 s) and mycel-ctl update took the new version for broken, killed it and rolled back on every try.
//
// Now, when the database has data and migrations are pending, the server listens first with a stand-in on its main
// address and runs openDb in a child process (bun:sqlite is synchronous: in this process it would block the event loop,
// and nothing would answer). Meanwhile:
//   GET /api/health  503 {ok: false, status: "migrating", version, migrating: {since, pending, copiedBytes, dbBytes},
//                    time}; a signed-out caller through the office internet address gets no version and no
//                    progress (the /api/health rule, routes/system.ts)
//   anything else    503 {error: {code: "unavailable", ...}}
// The bootstrap and mycel-ctl update keep waiting while they see "migrating" with the version they started, up to their
// own limit (native/cmd/mycel-bootstrap --migrate-timeout). When the child is done the stand-in stops and the server
// starts as before: openDb then finds nothing left to do.
//
// The child is this server's own entry (main.ts / the bundle's main.js) with MYCEL_MIGRATE_DB set (runMigrateChild).
// It exits 0 (done), 75 (SchemaTooNewError: the caller's openDb then throws it again at once, before any copy) or 1.
// It writes its warnings and its error as JSON lines on stdout; this process logs them.
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../app-config'
import { openDb, pendingMigrationCount, SchemaTooNewError } from '../db'
import { directFetch } from '../http/tunnel'
import type { Logger } from '../log'

export const MIGRATING_STATUS = 'migrating'
/** the environment variable that makes the server entry a migrator (runMigrateChild) */
export const MIGRATE_DB_ENV = 'MYCEL_MIGRATE_DB'
const EXIT_SCHEMA_TOO_NEW = 75

export interface MigrateBeforeStartOptions {
  cfg: Pick<AppConfig, 'listen' | 'tunnel'>
  /** the database file (<data>/app.db) */
  file: string
  version: string
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** the script the child runs: the server's entry (main.ts in dev, main.js in a bundle) */
  entry: string
  migrationsDir?: string
  /** the socket peer as main.ts sees it */
  peerIp: (addr: string | null | undefined) => string | null
}

/** Run the pending migrations of a database with data in a child process while a stand-in answers /api/health
 * "migrating". Returns false when there was nothing slow to do (openDb does the rest). */
export async function migrateBeforeStart(o: MigrateBeforeStartOptions): Promise<boolean> {
  const pending = pendingMigrationCount(o.file, o.migrationsDir)
  if (!pending) return false
  const since = new Date().toISOString()
  const size = (f: string) => { try { return fs.statSync(f).size } catch { return 0 } }
  const dbBytes = size(o.file) + size(`${o.file}-wal`)
  const backups = path.join(path.dirname(o.file), 'backups')
  let childPid = 0
  // the copy in progress: <data>/backups/.pending-migration-<child pid>-*/snapshot.db (db.ts backupBeforeMigrate)
  const copiedBytes = () => {
    if (!childPid) return 0
    try {
      const d = fs.readdirSync(backups).find((n) => n.startsWith(`.pending-migration-${childPid}-`))
      return d ? size(path.join(backups, d, 'snapshot.db')) : 0
    } catch { return 0 }
  }
  o.log.info('updating the database before the server starts; /api/health answers "migrating" until it is done', { pending, dbBytes })
  const standIn = Bun.serve({
    hostname: o.cfg.listen.host,
    port: o.cfg.listen.port,
    fetch: directFetch(o.cfg, (req, env) => {
      const time = new Date().toISOString()
      if (new URL(req.url).pathname === '/api/health') {
        const body = env.tunnel
          ? { ok: false, status: MIGRATING_STATUS, time }
          : { ok: false, status: MIGRATING_STATUS, version: o.version, migrating: { since, pending, copiedBytes: copiedBytes(), dbBytes }, time }
        return Response.json(body, { status: 503, headers: { 'retry-after': '10', 'cache-control': 'no-store' } })
      }
      return Response.json({ error: { code: 'unavailable', message: 'The server is updating its database after an update. Try again in a few minutes.' } },
        { status: 503, headers: { 'retry-after': '30', 'cache-control': 'no-store' } })
    }, o.peerIp),
  })
  let removeHandlers = () => {}
  try {
    const child = Bun.spawn([process.execPath, o.entry], {
      env: { ...process.env, [MIGRATE_DB_ENV]: o.file, ...(o.migrationsDir ? { MYCEL_MIGRATE_DIR: o.migrationsDir } : {}) },
      stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
    })
    childPid = child.pid
    // main.ts sets its signal handlers only after start(). Until then: SIGHUP (mycel-ctl apply-plan / notices-set,
    // passed on by the bootstrap to this pid only) must not end this process and leave the migrator running alone;
    // SIGTERM / SIGINT stop the migrator too (its transaction rolls back) and end the start.
    const onHup = () => o.log.info('SIGHUP while the database is updated: plan and notices are read when the server has started')
    const onStop = (sig: NodeJS.Signals) => { child.kill('SIGTERM'); standIn.stop(true); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)) }
    process.on('SIGHUP', onHup)
    process.on('SIGTERM', onStop)
    process.on('SIGINT', onStop)
    removeHandlers = () => { process.off('SIGHUP', onHup); process.off('SIGTERM', onStop); process.off('SIGINT', onStop) }
    let error = ''
    const lines = (async () => {
      let buf = ''
      const dec = new TextDecoder()
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          let m: { warn?: string; error?: string; fields?: Record<string, unknown> } | null = null
          try { m = JSON.parse(line) } catch { if (line.trim()) o.log.info(line.trim()) }
          if (m?.warn) o.log.warn(m.warn, m.fields)
          if (m?.error) error = m.error
        }
      }
    })()
    const code = await child.exited
    await lines.catch(() => {})
    if (code === EXIT_SCHEMA_TOO_NEW) return false // openDb throws SchemaTooNewError again before any copy
    if (code !== 0) throw new Error(`database update failed${error ? `: ${error}` : ` (migrator exited ${code})`}`)
    o.log.info('database updated', { pending, seconds: Math.round((Date.now() - Date.parse(since)) / 1000) })
    return true
  } finally {
    removeHandlers()
    standIn.stop(true)
  }
}

/** The child (MYCEL_MIGRATE_DB set): open and migrate the database, close it. Returns the exit code. */
export function runMigrateChild(file: string, migrationsDir = process.env.MYCEL_MIGRATE_DIR || undefined): number {
  const out = (m: object) => process.stdout.write(JSON.stringify(m) + '\n')
  try {
    openDb(file, { migrationsDir, log: { warn: (warn: string, fields?: Record<string, unknown>) => out({ warn, fields }) } }).close()
    return 0
  } catch (e) {
    out({ error: (e as Error).message })
    return e instanceof SchemaTooNewError ? EXIT_SCHEMA_TOO_NEW : 1
  }
}
