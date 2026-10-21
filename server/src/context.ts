// Everything a route module gets: config, DB, logger, file service, services of other components, and the engine
// core (tools gate + launcher), started on first use.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { uuidv7 } from '@mycel/shared'
import { PROD_PROXY_PORT, type AppConfig } from './app-config'
import { defaultConfig, engineSandboxProfile, findCodexBin, type ServerConfig } from './config'
import { CLAUDE_OAUTH_TOKEN_FILE } from './system/engines'
import { resolveLayout } from './system/layout'
import { FileService } from './files/service'
import type { Logger } from './log'
import type { AppBindings } from './http/env'
import { startEngineProxy, startServer, type Running } from './server'
import type { LauncherSandbox } from './native'
import { noSessions, nullRealtime, type Services } from './services'
import pkg from '../package.json'

/** Release builds set the version at bundle time (scripts/build-bundle.ts: --define process.env.MYCEL_BUILD_VERSION). */
export const SERVER_VERSION: string = process.env.MYCEL_BUILD_VERSION || pkg.version

export interface AppContext {
  config: AppConfig
  /** stage-1 engine/file configuration derived from config */
  engineConfig: ServerConfig
  db: Database
  log: Logger
  version: string
  /** random id of this server start (WebSocket resume epoch) */
  epoch: string
  startedAt: number
  /** team folder access through the policy function (stage 1) */
  files: FileService
  services: Services
  /** "METHOD /path" -> route module, filled by RouteKit */
  implemented: Map<string, string>
  /** The finished app's fetch (set by buildApp). The relay client calls it in-process with the real client IP. */
  appFetch(req: Request, env: AppBindings): Promise<Response>
  /** Tools gate + launcher + turn registry (stage 1 core). Started on first call; throws a clear error when the
   * native helpers are not built or the engine can't run. */
  core(): Promise<Running>
  /** run on shutdown, last registered first */
  onClose(fn: () => void | Promise<void>): void
  close(): Promise<void>
}

export interface ContextOptions {
  config: AppConfig
  db: Database
  log: Logger
  /** override the engine core starter (tests) */
  startCore?: (ctx: AppContext) => Promise<Running>
}

export class CoreUnavailableError extends Error { name = 'CoreUnavailableError' }

/** The OS sandbox dev engine turns run under. macOS: scripts/macos/engine.sb with the owner's login opened (LOCAL_LOGIN=1)
 * and no model proxy. Before security audit r1 (os-layer #2) dev ran engines with no OS layer at all: the CLI's own
 * tool lockdown was the only thing between a turn (of any team member, through the relay) and everything the owner
 * can read and write. Missing profile or sandbox-exec = no engine (fail closed). Other platforms: none (no bwrap
 * profile for engines yet; the DEV banner says so). */
export function devEngineSandbox(platform: NodeJS.Platform = process.platform, profile = engineSandboxProfile()): LauncherSandbox | null {
  if (platform !== 'darwin') return null
  if (!fs.existsSync(profile)) throw new CoreUnavailableError(`engine sandbox profile missing (${profile}): engines will not run without it`)
  if (!fs.existsSync('/usr/bin/sandbox-exec')) throw new CoreUnavailableError('/usr/bin/sandbox-exec missing: engines will not run without the OS sandbox')
  return { profile, localLogin: true }
}

/** Dev / local-login: launcher runs as the current user; claude / codex from PATH (or config.engine.*Bin). */
export async function startLocalCore(ctx: AppContext): Promise<Running> {
  const cfg = ctx.engineConfig
  const gate = path.join(cfg.nativeBin, 'mycel-gate')
  if (!fs.existsSync(gate)) throw new CoreUnavailableError(`native helpers not built (${gate} missing): run \`bun run build:native\``)
  if (ctx.config.mode === 'prod') {
    // production: the launcher is a LaunchDaemon as _axagent (component G installs it); we only connect
    const srv = await startServer(cfg, { db: ctx.db, files: ctx.files, externalLauncher: ctx.config.engine.launcherSock ?? path.join(cfg.runDir, 'launcher.sock'), toolsSockMode: '0660' })
    // the model proxy: the engine account's only network path (pf + engine sandbox allow just this port). Codex
    // turns tunnel HTTPS through it (CONNECT); Claude requests get the owner's subscription token swapped in.
    try {
      await startEngineProxy(srv, { port: ctx.config.engine.proxyPort ?? PROD_PROXY_PORT, upstream: prodClaudeUpstream(ctx) })
    } catch (e) {
      srv.proxy = null
      ctx.log.error('model proxy did not start: engine turns of the engine account cannot reach the model', { err: e })
    }
    return srv
  }
  const codex = findCodexBin(ctx.config.engine.codexBin)
  const allowCmds = [cfg.claudeBin, ...(codex ? [codex] : [])]
  const sandbox = devEngineSandbox()
  return startServer(cfg, { db: ctx.db, files: ctx.files, launcher: { allowCmds, sessionRoots: [path.join(os.homedir(), '.claude', 'projects')], ...(sandbox ? { sandbox } : {}) } })
}

/** The owner's long-lived Claude subscription token (`claude setup-token`) in secrets/, if it is there. */
function prodClaudeUpstream(ctx: AppContext): { baseUrl: string; kind: 'oauth'; secret: string } | null {
  try {
    const secret = fs.readFileSync(path.join(resolveLayout(ctx.config).secretsDir, CLAUDE_OAUTH_TOKEN_FILE), 'utf8').trim()
    return secret ? { baseUrl: 'https://api.anthropic.com', kind: 'oauth', secret } : null
  } catch { return null }
}

export function createContext(o: ContextOptions): AppContext {
  const { config, db, log } = o
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(config.teamRoot, { recursive: true, mode: 0o700 })
  const engineConfig = defaultConfig({
    teamRoot: config.teamRoot,
    dataDir: config.dataDir,
    authMode: config.engine.authMode,
    ...(config.engine.claudeBin ? { claudeBin: config.engine.claudeBin } : {}),
    ...(config.engine.runDir ? { runDir: config.engine.runDir } : {}),
    ...(config.engine.agentRoot ? { agentRoot: config.engine.agentRoot } : {}),
    ...(config.engine.agentUid !== undefined ? { agentUid: config.engine.agentUid } : {}),
  })
  const closers: (() => void | Promise<void>)[] = []
  let core: Promise<Running> | null = null
  const ctx: AppContext = {
    config, engineConfig, db, log,
    version: SERVER_VERSION,
    epoch: uuidv7(),
    startedAt: Date.now(),
    files: new FileService(db, engineConfig),
    services: { sessions: noSessions, realtime: nullRealtime, jobs: null, relay: null },
    implemented: new Map(),
    async appFetch() { throw new Error('appFetch used before buildApp finished') },
    core() {
      if (!core) {
        core = (o.startCore ?? startLocalCore)(ctx).then((r) => { closers.push(() => r.close()); return r })
        core.catch((e) => { log.error('engine core failed to start', { err: e }); core = null })
      }
      return core
    },
    onClose(fn) { closers.push(fn) },
    async close() {
      for (const fn of closers.splice(0).reverse()) {
        try { await fn() } catch (e) { log.error('close hook failed', { err: e }) }
      }
    },
  }
  return ctx
}
