// Server configuration: ONE JSON file + environment overrides (tab 6: config/server.json holds port, team folder,
// connection mode, update channel; team settings live in the DB `settings` table).
//
// Where the file is:   --config <path>  >  $MYCEL_CONFIG  >  dev: <repo>/.dev/server.json (optional)
//                                                           prod: /Library/Application Support/mycel/config/server.json
// Env overrides (win over the file): MYCEL_MODE, MYCEL_HOST, MYCEL_PORT, MYCEL_TEAM_ROOT, MYCEL_DATA_DIR,
// MYCEL_LOG_DIR, MYCEL_LOG_LEVEL, MYCEL_PUBLIC_ORIGINS (comma separated), MYCEL_SETUP_TOKEN,
// MYCEL_RELAY_URL (ws(s)://<relay>/connect, '' = off), MYCEL_RELAY_TEAM (team name at the relay).
// Relative paths in the file are resolved against the file's folder.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { AuthMode, PRODUCT } from '@mycel/shared'

export const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
export const DEV_DIR = path.join(REPO_ROOT, '.dev')
export const PROD_BASE = `/Library/Application Support/${PRODUCT.id}`
/** Foundation dev server port (component port ranges: docs/WORKPLAN.md). */
export const DEV_PORT = 19100
/** model proxy port when server.json names none (the installer's default --proxy-port) */
export const DEFAULT_PROXY_PORT = 47821
export const ANTHROPIC_API = 'https://api.anthropic.com'
/** same port under its production name (installer --proxy-port; pf and the engine sandbox allow the engine account only this) */
export const PROD_PROXY_PORT = DEFAULT_PROXY_PORT

export const AppConfigFile = z.object({
  mode: z.enum(['dev', 'prod']).optional(),
  listen: z.object({
    /** 127.0.0.1 in dev; prod HTTP is only reachable through the relay client (in-process app.fetch) and the TLS port */
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(DEV_PORT),
  }).default({ host: '127.0.0.1', port: DEV_PORT }),
  /** office-network direct connection (TLS, tab 4: 8443); null = off. managed: the server keeps the self-signed
   * certificate naming every LAN address of this Mac (system/lan-cert.ts; the installer sets it) */
  tls: z.object({ port: z.number().int().default(8443), certFile: z.string(), keyFile: z.string(), managed: z.boolean().default(false) }).nullable().default(null),
  /** extra allowed Origins for CSRF / WebSocket checks, e.g. https://acme.treesoop.com. Same host is always allowed. */
  publicOrigins: z.array(z.string()).default([]),
  teamRoot: z.string().optional(),
  dataDir: z.string().optional(),
  logDir: z.string().nullable().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  engine: z.object({
    /** local-login: owner's own CLI login, engine runs as the current user (dev). subscription: the owner's
     * `claude setup-token` token in <install>/secrets/claude-oauth-token behind the model proxy (production, written
     * by scripts/install-macos.sh). proxy: company key (code only, refused). */
    authMode: AuthMode.default('local-login'),
    /** the model proxy's port on 127.0.0.1 (the installer's --proxy-port), the engine account's only network path:
     * Claude requests and Codex tunnels. pf and the launcher's sandbox allow the engine account only this port, so
     * another value here only makes the engine fail closed. */
    proxyPort: z.number().int().min(1).max(65535).optional(),
    /** where the model proxy sends requests (tests point it at a fake upstream). The owner's token goes there, so
     * HTTPS only; plain HTTP only to this Mac (a fake upstream in tests); no user:password in the address. */
    modelUpstream: z.string().url().refine((u) => {
      try {
        const x = new URL(u)
        if (x.username || x.password) return false
        return x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname))
      } catch { return false }
    }, 'modelUpstream must be https:// (http:// only for 127.0.0.1 / localhost)').optional(),
    claudeBin: z.string().optional(),
    codexBin: z.string().optional(),
    /** installed layout (tab 6, written by scripts/install-macos.sh): sockets <runDir>/tools.sock + private/, per-chat
     * engine folders, the LaunchDaemon launcher socket and the engine account uid. Dev: derived from dataDir. */
    runDir: z.string().optional(),
    agentRoot: z.string().optional(),
    launcherSock: z.string().optional(),
    agentUid: z.number().int().nonnegative().optional(),
  }).default({ authMode: 'local-login' }),
  relay: z.object({
    /** wss://relay.example/connect; null = no relay */
    url: z.string().nullable().default(null),
    teamName: z.string().nullable().default(null),
  }).default({ url: null, teamName: null }),
  update: z.object({
    channel: z.enum(['stable', 'beta']).default('stable'),
    feedUrl: z.string().nullable().default(null),
  }).default({ channel: 'stable', feedUrl: null }),
  /** check every JSON response against the contract (default: on in dev) */
  validateResponses: z.boolean().optional(),
})
export type AppConfigFile = z.infer<typeof AppConfigFile>

export interface AppConfig {
  mode: 'dev' | 'prod'
  configFile: string | null
  listen: { host: string; port: number }
  tls: { port: number; certFile: string; keyFile: string; managed?: boolean } | null
  publicOrigins: string[]
  teamRoot: string
  dataDir: string
  logDir: string | null
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  engine: { authMode: 'local-login' | 'proxy' | 'subscription'; claudeBin?: string; codexBin?: string; runDir?: string; agentRoot?: string; launcherSock?: string; agentUid?: number; proxyPort?: number; modelUpstream?: string }
  relay: { url: string | null; teamName: string | null }
  update: { channel: 'stable' | 'beta'; feedUrl: string | null }
  validateResponses: boolean
  /** first-run setup token (POST /api/setup). Dev: printed at start; prod: written by the installer. */
  setupToken: string | null
}

export class ConfigError extends Error { name = 'ConfigError' }

export interface LoadOptions { argv?: string[]; env?: Record<string, string | undefined>; cwd?: string }

export function loadAppConfig(o: LoadOptions = {}): AppConfig {
  const argv = o.argv ?? process.argv.slice(2)
  const env = o.env ?? process.env
  const cwd = o.cwd ?? process.cwd()
  const P = PRODUCT.envPrefix
  const ai = argv.indexOf('--config')
  const explicit = ai >= 0 ? argv[ai + 1] : env[P + 'CONFIG']
  const modeHint = (env[P + 'MODE'] as 'dev' | 'prod' | undefined) ?? (argv.includes('--prod') ? 'prod' : undefined)
  let file: string | null = null
  if (explicit) file = path.resolve(cwd, explicit)
  else if (modeHint === 'prod') file = path.join(PROD_BASE, 'config', 'server.json')
  else if (fs.existsSync(path.join(DEV_DIR, 'server.json'))) file = path.join(DEV_DIR, 'server.json')

  let raw: unknown = {}
  if (file) {
    if (!fs.existsSync(file)) throw new ConfigError(`config file not found: ${file}`)
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new ConfigError(`config file ${file} is not valid JSON: ${(e as Error).message}`) }
  }
  const parsed = AppConfigFile.safeParse(raw)
  if (!parsed.success) throw new ConfigError(`config file ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const f = parsed.data
  const base = file ? path.dirname(file) : cwd
  const abs = (p: string) => path.resolve(base, p)

  const mode = modeHint ?? f.mode ?? 'dev'
  const def = mode === 'dev'
    ? { teamRoot: path.join(DEV_DIR, 'team'), dataDir: path.join(DEV_DIR, 'data'), logDir: null as string | null }
    : { teamRoot: path.join(PROD_BASE, 'team'), dataDir: path.join(PROD_BASE, 'data'), logDir: `/Library/Logs/${PRODUCT.id}` }

  const port = env[P + 'PORT'] !== undefined ? Number(env[P + 'PORT']) : f.listen.port
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`${P}PORT must be a port number`)
  const level = (env[P + 'LOG_LEVEL'] ?? f.logLevel ?? (mode === 'dev' ? 'debug' : 'info')) as AppConfig['logLevel']
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError(`${P}LOG_LEVEL must be debug, info, warn or error`)
  const origins = env[P + 'PUBLIC_ORIGINS'] !== undefined ? env[P + 'PUBLIC_ORIGINS']!.split(',').map((s) => s.trim()).filter(Boolean) : f.publicOrigins
  const logDirRaw = env[P + 'LOG_DIR'] ?? (f.logDir === undefined ? def.logDir : f.logDir)

  return {
    mode,
    configFile: file,
    listen: { host: env[P + 'HOST'] ?? f.listen.host, port },
    tls: f.tls ? { port: f.tls.port, certFile: abs(f.tls.certFile), keyFile: abs(f.tls.keyFile), managed: f.tls.managed } : null,
    publicOrigins: origins,
    teamRoot: env[P + 'TEAM_ROOT'] ? path.resolve(cwd, env[P + 'TEAM_ROOT']!) : f.teamRoot ? abs(f.teamRoot) : def.teamRoot,
    dataDir: env[P + 'DATA_DIR'] ? path.resolve(cwd, env[P + 'DATA_DIR']!) : f.dataDir ? abs(f.dataDir) : def.dataDir,
    logDir: logDirRaw ? path.resolve(base, logDirRaw) : null,
    logLevel: level,
    engine: {
      authMode: f.engine.authMode, claudeBin: f.engine.claudeBin, codexBin: f.engine.codexBin,
      ...(f.engine.runDir ? { runDir: abs(f.engine.runDir) } : {}),
      ...(f.engine.agentRoot ? { agentRoot: abs(f.engine.agentRoot) } : {}),
      ...(f.engine.launcherSock ? { launcherSock: abs(f.engine.launcherSock) } : {}),
      ...(f.engine.agentUid !== undefined ? { agentUid: f.engine.agentUid } : {}),
      ...(f.engine.proxyPort !== undefined ? { proxyPort: f.engine.proxyPort } : {}),
      ...(f.engine.modelUpstream ? { modelUpstream: f.engine.modelUpstream } : {}),
    },
    relay: {
      url: env[P + 'RELAY_URL'] !== undefined ? (env[P + 'RELAY_URL'] || null) : f.relay.url,
      teamName: env[P + 'RELAY_TEAM'] ?? f.relay.teamName,
    },
    update: f.update,
    validateResponses: f.validateResponses ?? mode === 'dev',
    setupToken: env[P + 'SETUP_TOKEN'] ?? null,
  }
}
