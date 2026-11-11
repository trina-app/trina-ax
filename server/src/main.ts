// Server entry point: `bun run dev:server` (dev) or the LaunchDaemon (prod, `--prod`).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { websocket } from 'hono/bun'
import { PRODUCT } from '@mycel/shared'
import { SMALL_UPLOAD_MAX } from '@mycel/shared/api'
import { ConfigError, loadAppConfig, OBSOLETE_KEYS, type AppConfig } from './app-config'
import { buildApp } from './app'
import { directFetch } from './http/tunnel'
import { createContext, socketPathProblems, type AppContext } from './context'
import { SchemaTooNewError, openDb } from './db'
import { syncFollowingLocales } from './admin/settings'
import { createLogger, type Logger } from './log'
import { applyPendingRestore, recordRestore } from './system/backup'
import { ensureLanCert } from './system/lan-cert'
import { resolveLayout } from './system/layout'
import { reloadManagedFiles } from './system/managed'
import { socketPathMessage, underSandboxDeniedTmp } from './system/sockets'
import { guardOfficeClaudeJson } from './engine/claude-json-guard'
import { setupServerCgroups } from './system/cgroups'
import { exitAddressCheckOff, startEgressLearning } from './tools/egress'
import { isHosted } from './system/deployment'
import { dropHostedSpeechKey } from './credentials/speech-key'
import { dropHostedChatKey } from './credentials/hosted-chat'
import { settleHostedFallback } from './admin/engine-choice'
import { repointDeckLinks } from './auth/team-links'
import { retireLegacyDefaultSkills } from './onboarding/retired-skills'

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

/** The index of the removed search by meaning tool (`search`): its vectors in <data>/semantic.db, with SQLite's WAL
 * files beside it. Nothing reads them any more, so the first start of a version without it deletes them and says so in
 * one line; later starts find nothing. (The model it downloaded is removed with the knowledge graph's data, below.) */
export function removeOldSemanticIndex(dataDir: string, log: Pick<Logger, 'info' | 'warn'>): boolean {
  let bytes = 0
  const found = ['semantic.db', 'semantic.db-wal', 'semantic.db-shm'].map((n) => path.join(dataDir, n)).filter((f) => {
    // lstat: a link is removed itself, never what it points to
    try { bytes += fs.lstatSync(f).size; return true } catch { return false }
  })
  if (!found.length) return false
  try {
    for (const f of found) fs.rmSync(f, { force: true })
  } catch (e) {
    log.warn('the old search by meaning index (semantic.db) could not be removed', { err: e })
    return false
  }
  log.info('removed the old search by meaning index (semantic.db): nothing uses it', { bytes })
  return true
}

/** What the removed knowledge graph kept in the data folder (docs/DECISIONS.md, 2026-11-11), relative to it: its
 * indexes (copies of the team's document text and code), and the files of its search by meaning model, which nothing
 * else reads (speech-to-text keeps its own models in models/whisper). */
export const KNOWLEDGE_GRAPH_DATA = { index: 'knowledge-graph', model: ['models', 'Xenova', 'multilingual-e5-small'] } as const
/** the index's folder while it is deleted in the background (`<name>-<uuid>`): a start that finds one (the last one
 * stopped before the end) deletes the rest */
const KG_REMOVING = '.knowledge-graph-removing'

/** a real folder, never a link to one (lstat) */
const realDir = (p: string) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink() } catch { return false } }
const isUnder = (p: string, root: string) => p === root || p.startsWith(root + path.sep)

/**
 * The first start of a version without the knowledge graph deletes what it kept (KNOWLEDGE_GRAPH_DATA) and says so in
 * one line; later starts find nothing. The index folder can hold many thousands of files, so it is renamed at once
 * (nothing reads it from then on) and deleted in the background: the start does not wait for the disk, and the returned
 * promise ends when it is gone. The model folder is a few files and goes at once.
 * - Only the server's own data folder: a link in place of a folder is removed itself, never followed, and the model is
 *   removed only through real folders (`models/`, `Xenova/`), so a link to a host's shared models
 *   ($MYCEL_MODELS_DIR, read-only and shared by its teams) is never followed into it; nothing under that folder is
 *   ever removed.
 * - `Xenova/` held only this model: it goes when that leaves it empty.
 */
export function removeKnowledgeGraphData(dataDir: string, log: Pick<Logger, 'info' | 'warn'>, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const removed: string[] = []
  const index = path.join(dataDir, KNOWLEDGE_GRAPH_DATA.index)
  try {
    if (fs.lstatSync(index).isSymbolicLink()) fs.unlinkSync(index)
    else fs.renameSync(index, path.join(dataDir, `${KG_REMOVING}-${crypto.randomUUID()}`))
    removed.push(KNOWLEDGE_GRAPH_DATA.index)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('the knowledge graph\'s old index could not be removed', { err: e })
  }
  const [models, vendor, name] = KNOWLEDGE_GRAPH_DATA.model
  const model = path.join(dataDir, models, vendor, name)
  let shared: string | null = null
  try { shared = env.MYCEL_MODELS_DIR ? fs.realpathSync(env.MYCEL_MODELS_DIR) : null } catch {}
  const inShared = (p: string) => { try { return !!shared && isUnder(fs.realpathSync(p), shared) } catch { return false } }
  if (realDir(path.join(dataDir, models)) && realDir(path.join(dataDir, models, vendor)) && fs.existsSync(model) && !inShared(model)) {
    try {
      if (fs.lstatSync(model).isSymbolicLink()) fs.unlinkSync(model)
      else fs.rmSync(model, { recursive: true, force: true })
      removed.push(KNOWLEDGE_GRAPH_DATA.model.join('/'))
      try { fs.rmdirSync(path.join(dataDir, models, vendor)) } catch {}
    } catch (e) { log.warn('the knowledge graph\'s old model files could not be removed', { err: e }) }
  }
  // the index folder, now under a temporary name (also any an earlier start left half deleted)
  let removing: string[] = []
  try { removing = fs.readdirSync(dataDir).filter((n) => n === KG_REMOVING || n.startsWith(`${KG_REMOVING}-`)).map((n) => path.join(dataDir, n)) } catch {}
  if (!removing.length) {
    if (removed.length) log.info('removed the knowledge graph\'s old index and model files: the knowledge graph was removed', { removed })
    return Promise.resolve(removed.length > 0)
  }
  return Promise.all(removing.map((p) => fs.promises.rm(p, { recursive: true, force: true }))).then(() => {
    log.info('removed the knowledge graph\'s old index and model files: the knowledge graph was removed', { removed: removed.length ? removed : [KNOWLEDGE_GRAPH_DATA.index] })
    return true
  }, (e: unknown) => {
    log.warn('the knowledge graph\'s old index could not be removed', { err: e })
    return false
  })
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
  const restored = applyPendingRestore(cfg.dataDir, log) // a DB restore staged by POST /api/admin/restore (component G) swaps in here
  removeOldSemanticIndex(cfg.dataDir, log)
  void removeKnowledgeGraphData(cfg.dataDir, log)
  // a config file written for an older version: what this one ignores, said once
  for (const k of cfg.obsoleteKeys ?? []) log.warn(`config file: "${k}" is obsolete and ignored (${OBSOLETE_KEYS[k]})`, { file: cfg.configFile })
  const db = openDb(path.join(cfg.dataDir, 'app.db'), { log }) // log: a warning per migration renamed after this DB ran it
  syncFollowingLocales(db) // people without their own language see the current team default (a restored DB may differ)
  // which backup was put back, when and by whom: in the activity log and Admin › System (QA TC-208)
  try { recordRestore(db, restored) } catch (e) { log.error('could not log the restore', { err: e }) }
  // the hosting service's speech key belongs to its hosted servers only (a hosted team's backup restored here keeps none)
  if (!isHosted(cfg) && dropHostedSpeechKey(db)) log.info('removed the hosting service\'s speech-to-text key: this server is not hosted')
  // the same for its trial AI credit
  if (!isHosted(cfg) && dropHostedChatKey(db)) log.info('removed the hosting service\'s trial AI key: this server is not hosted')
  // a hosted server turns "다른 AI로 대신 답하기" on once (it used to come with the trial key, whatever the switch said)
  if (settleHostedFallback({ db, config: cfg })) log.info('turned on "answer with the other AI" for this hosted server')
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
  // an older build's default-skills seeder, should this server run one again, finds every skill it knew recorded and
  // adds nothing (docs/DECISIONS.md "DS3"; a settings write, no files)
  try { retireLegacyDefaultSkills(ctx.db) } catch (e) { log.warn('the old default skills not recorded as retired', { err: e }) }
  // old open invite links that lead to the intro deck: pointed once at the landing skill (docs/DECISIONS.md "W5")
  try { const n = repointDeckLinks(ctx); if (n) log.info('invite links pointed at the landing skill', { n }) } catch (e) { log.warn('invite links to the intro deck not repointed', { err: e }) }
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
