// Server entry point: `bun run dev:server` (dev) or the LaunchDaemon (prod, `--prod`).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { websocket } from 'hono/bun'
import { PRODUCT } from '@mycel/shared'
import { SMALL_UPLOAD_MAX } from '@mycel/shared/api'
import { ConfigError, loadAppConfig, type AppConfig } from './app-config'
import { buildApp } from './app'
import { directFetch } from './http/tunnel'
import { createContext, socketPathProblems, type AppContext } from './context'
import { SchemaTooNewError, openDb } from './db'
import { syncFollowingLocales } from './admin/settings'
import { createLogger, type Logger } from './log'
import { applyPendingRestore } from './system/backup'
import { ensureLanCert } from './system/lan-cert'
import { resolveLayout } from './system/layout'
import { reloadManagedFiles } from './system/managed'
import { socketPathMessage, underSandboxDeniedTmp } from './system/sockets'
import { guardOfficeClaudeJson } from './engine/claude-json-guard'
import { setupServerCgroups } from './system/cgroups'
import { exitAddressCheckOff, startEgressLearning } from './tools/egress'

/** how often the installed server checks that its office TLS certificate still names every LAN address */
const LAN_CERT_CHECK_MS = 60_000

/** Exit codes the menubar app / launchd wrapper understand. */
export const EXIT = { ok: 0, config: 78, schemaTooNew: 75, startFailed: 1 } as const

/** First-run setup token: env, else <dataDir>/setup-token (0600, created when no user exists yet). */
export function ensureSetupToken(cfg: AppConfig, db: AppContext['db']): string | null {
  const users = (db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  const file = path.join(cfg.dataDir, 'setup-token')
  if (users > 0) { try { fs.unlinkSync(file) } catch {} return null }
  if (cfg.setupToken) return cfg.setupToken
  try { return fs.readFileSync(file, 'utf8').trim() } catch {}
  const t = crypto.randomBytes(24).toString('base64url')
  fs.writeFileSync(file, t + '\n', { mode: 0o600 })
  return t
}

/** The socket peer as rate limits and the audit log see it: an IPv4 client of a dual-stack ('::') listener arrives
 * as ::ffff:a.b.c.d and is written a.b.c.d, the same address an IPv4-only listener reports. */
export function peerIp(addr: string | null | undefined): string | null {
  if (!addr) return null
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr)
  return m ? m[1]! : addr
}

/**
 * Say at start, in plain words, when the engine cannot work because of where the data lives: a socket path that does
 * not fit in a Unix socket address (long data folder), or (macOS dev) a data folder under /tmp, which the engine
 * sandbox denies. The server still starts (files, settings and the web app work); Diagnostics shows the same.
 */
export function checkSocketPaths(ctx: AppContext, log: Logger): string | null {
  const long = socketPathProblems(ctx.config, ctx.engineConfig)
  if (long.length) {
    const m = socketPathMessage(long, ctx.config.mode === 'dev')
    log.error(m, { sockets: long.map((x) => ({ name: x.name, path: x.path, bytes: x.bytes, max: x.max })) })
    return m
  }
  if (process.platform === 'darwin' && ctx.config.mode === 'dev' && underSandboxDeniedTmp(ctx.engineConfig.runDir)) {
    const m = `the data folder ${ctx.config.dataDir} is under a temporary folder (/tmp, /private/var/folders): the engine sandbox denies it, so chats can fail. Use a short folder in your home (the default ~/.team-ax-dev).`
    log.warn(m)
    return m
  }
  return null
}

export interface Started { ctx: AppContext; servers: ReturnType<typeof Bun.serve>[]; url: string; stop(): Promise<void> }

export async function start(cfg: AppConfig, log: Logger): Promise<Started> {
  setupServerCgroups({ log, mode: cfg.mode }) // Linux production: S/main + S/conv before any child process (no-op elsewhere)
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 })
  applyPendingRestore(cfg.dataDir, log) // a DB restore staged by POST /api/admin/restore (component G) swaps in here
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  syncFollowingLocales(db) // people without their own language see the current team default (a restored DB may differ)
  const ctx = createContext({ config: cfg, db, log })
  ctx.onClose(() => db.close())
  guardOfficeClaudeJson(ctx, 'start') // office: no MCP servers in the Mac user's ~/.claude.json (an engine may write it)
  cfg.setupToken = ensureSetupToken(cfg, db)
  checkSocketPaths(ctx, log)
  const app = await buildApp(ctx)

  const servers: ReturnType<typeof Bun.serve>[] = []
  // the largest body (a 50 MB small upload; bigger files go in 8 MB chunks) stays far below Cloudflare's 100 MB request
  // limit on the office public address (and the relay)
  const base = { websocket, maxRequestBodySize: SMALL_UPLOAD_MAX + 1024 * 1024, idleTimeout: 120 }
  // socket peer + listener port; requests through the office public address become https://<host> (http/tunnel.ts)
  const serveDirect = directFetch(cfg, (req, env) => app.fetch(req, env), peerIp)
  const http = Bun.serve({
    ...base,
    hostname: cfg.listen.host,
    port: cfg.listen.port,
    fetch: serveDirect,
  })
  servers.push(http)
  if (cfg.tls) {
    const t = cfg.tls
    const fingerprintFile = cfg.mode === 'prod' ? path.join(resolveLayout(cfg).setupDir, 'lan-cert.sha256') : null
    const certCheck = () => {
      try {
        const r = ensureLanCert({ certFile: t.certFile, keyFile: t.keyFile, fingerprintFile })
        if (r.changed) log.info('office TLS certificate renewed', { reason: r.reason, fingerprint: r.fingerprint, names: r.names })
        return r.changed
      } catch (e) {
        log.warn('office TLS certificate check failed', { err: e })
        return false
      }
    }
    if (t.managed) certCheck()
    const serveTls = () => Bun.serve({
      ...base,
      hostname: t.host ?? '0.0.0.0',
      port: t.port,
      // read now (Bun.file is lazy): a renewed certificate is a new listener with the new files
      tls: { cert: fs.readFileSync(t.certFile, 'utf8'), key: fs.readFileSync(t.keyFile, 'utf8') },
      fetch: serveDirect,
    })
    let tls = serveTls()
    let tlsUp = true
    servers.push(tls)
    if (t.managed) {
      // a new Wi-Fi, DHCP lease or network port: the certificate must name the new address (system/lan-cert.ts);
      // a listener that could not come back is tried again on the next tick instead of taking the server down
      const timer = setInterval(() => {
        if (!certCheck() && tlsUp) return
        const i = servers.indexOf(tls)
        if (tlsUp) { tls.stop(true); tlsUp = false }
        try {
          tls = serveTls()
          servers[i] = tls
          tlsUp = true
        } catch (e) {
          log.warn('office TLS listener restart failed; trying again in a minute', { err: e })
        }
      }, LAN_CERT_CHECK_MS)
      timer.unref?.()
      ctx.onClose(() => clearInterval(timer))
    }
  }
  const url = `http://${cfg.listen.host === '0.0.0.0' ? 'localhost' : cfg.listen.host}:${http.port}`
  log.info('server started', { version: ctx.version, mode: cfg.mode, url, tlsPort: cfg.tls?.port ?? null, publicHost: cfg.tunnel?.host ?? null, teamRoot: cfg.teamRoot, dataDir: cfg.dataDir, config: cfg.configFile })
  // production: bring the engine core up now (tools gate, launcher connection, model proxy) so the engine account's
  // network path exists before the first turn (the codex-login CLI tunnels through the proxy). A failure is logged
  // and retried on first use.
  if (cfg.mode === 'prod') void ctx.core().catch(() => {})
  // this server's public exit address, for web_fetch's hairpin rule (tools/egress.ts): learned from the release feed on
  // every installed kind (production, office); dev learns it from its local relay. Never under `bun test`.
  if ((cfg.mode === 'prod' || cfg.office) && process.env.NODE_ENV !== 'test') {
    if (exitAddressCheckOff()) log.info('exit address check is off (MYCEL_EXIT_ADDRESS_CHECK): unless a relay reports it, every web address the AI opens needs a person')
    else startEgressLearning(ctx)
  }
  if (cfg.setupToken) {
    // office mode: the installer prints the link (`teamax setup-link`); the log stays free of the token
    if (cfg.mode === 'dev' && !cfg.office) log.info(`first-run setup: POST /api/setup with setupToken ${cfg.setupToken} (or open ${url}/setup?token=${cfg.setupToken})`)
    else log.info('first-run setup pending', { tokenFile: path.join(cfg.dataDir, 'setup-token') })
  }
  return {
    ctx, servers, url,
    async stop() {
      for (const s of servers) s.stop(true)
      await ctx.close()
    },
  }
}

if (import.meta.main) {
  let cfg: AppConfig
  try {
    cfg = loadAppConfig()
  } catch (e) {
    console.error(`${PRODUCT.displayName}: ${(e as Error).message}`)
    process.exit(e instanceof ConfigError ? EXIT.config : EXIT.startFailed)
  }
  const log = createLogger({ level: cfg.logLevel, dir: cfg.logDir, name: 'server', pretty: cfg.mode === 'dev' && process.stdout.isTTY })
  let started: Started
  try {
    started = await start(cfg, log)
  } catch (e) {
    if (e instanceof SchemaTooNewError) { log.error('database is newer than this server', { err: e }); process.exit(EXIT.schemaTooNew) }
    log.error('start failed', { err: e })
    process.exit(EXIT.startFailed)
  }
  let stopping = false
  const shutdown = async (sig: string) => {
    if (stopping) return
    stopping = true
    log.info('shutting down', { signal: sig })
    const force = setTimeout(() => process.exit(EXIT.startFailed), 10_000)
    await started.stop()
    clearTimeout(force)
    process.exit(EXIT.ok)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // mycel-ctl apply-plan / notices-set: read plan.json and notices.json again now (system/managed.ts). Without this
  // handler SIGHUP would end the process.
  process.on('SIGHUP', () => { reloadManagedFiles(); log.info('SIGHUP: plan and notices files are read again') })
  // under mycel-bootstrap (production): the server runs in its own process group, so a bootstrap killed outright
  // (launchd's SIGKILL, `launchctl kill 9`) left it running, holding the port with the old version while every new
  // bootstrap failed to start one (found by the medical fork, docs/UPSTREAM-CANDIDATES.md there, item 6)
  watchSupervisor(process.env.MYCEL_SUPERVISOR_PID, processAlive, () => void shutdown('supervisor gone'))
}

/** kill(pid, 0): no such process = gone. (Bun keeps process.ppid from the start: it never changes when the parent
 * exits, which is how a first version of this check missed a killed bootstrap on the staging install.) */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Calls onGone once the process that started us (pid in MYCEL_SUPERVISOR_PID) has exited. */
export function watchSupervisor(pidVar: string | undefined, alive: (pid: number) => boolean, onGone: () => void, everyMs = 2_000): (() => void) | null {
  const supervisor = Number(pidVar)
  if (!Number.isInteger(supervisor) || supervisor <= 1) return null
  const t = setInterval(() => { if (!alive(supervisor)) { clearInterval(t); onGone() } }, everyMs)
  t.unref()
  return () => clearInterval(t)
}
