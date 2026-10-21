// Server entry point: `bun run dev:server` (dev) or the LaunchDaemon (prod, `--prod`).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { websocket } from 'hono/bun'
import { PRODUCT } from '@mycel/shared'
import { SMALL_UPLOAD_MAX } from '@mycel/shared/api'
import { ConfigError, loadAppConfig, type AppConfig } from './app-config'
import { buildApp } from './app'
import { createContext, socketPathProblems, type AppContext } from './context'
import { SchemaTooNewError, openDb } from './db'
import { syncFollowingLocales } from './admin/settings'
import { createLogger, type Logger } from './log'
import { applyPendingRestore } from './system/backup'
import { ensureLanCert } from './system/lan-cert'
import { resolveLayout } from './system/layout'
import { socketPathMessage, underSandboxDeniedTmp } from './system/sockets'

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
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 })
  applyPendingRestore(cfg.dataDir, log) // a DB restore staged by POST /api/admin/restore (component G) swaps in here
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  syncFollowingLocales(db) // people without their own language see the current team default (a restored DB may differ)
  const ctx = createContext({ config: cfg, db, log })
  ctx.onClose(() => db.close())
  cfg.setupToken = ensureSetupToken(cfg, db)
  checkSocketPaths(ctx, log)
  const app = await buildApp(ctx)

  const servers: ReturnType<typeof Bun.serve>[] = []
  const base = { websocket, maxRequestBodySize: SMALL_UPLOAD_MAX + 1024 * 1024, idleTimeout: 120 }
  const http = Bun.serve({
    ...base,
    hostname: cfg.listen.host,
    port: cfg.listen.port,
    fetch: (req, server) => app.fetch(req, { ip: peerIp(server.requestIP(req)?.address), via: 'direct', port: server.port, server }),
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
      fetch: (req, server) => app.fetch(req, { ip: peerIp(server.requestIP(req)?.address), via: 'direct', port: server.port, server }),
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
  log.info('server started', { version: ctx.version, mode: cfg.mode, url, tlsPort: cfg.tls?.port ?? null, teamRoot: cfg.teamRoot, dataDir: cfg.dataDir, config: cfg.configFile })
  // production: bring the engine core up now (tools gate, launcher connection, model proxy) so the engine account's
  // network path exists before the first turn (the codex-login CLI tunnels through the proxy). A failure is logged
  // and retried on first use.
  if (cfg.mode === 'prod') void ctx.core().catch(() => {})
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
}
