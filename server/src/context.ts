// Everything a route module gets: config, DB, logger, file service, services of other components, and the engine
// core (tools gate + launcher), started on first use.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { uuidv7 } from '@mycel/shared'
import type { AppConfig } from './app-config'
import { defaultConfig, engineSandboxProfile, findCodexBin, type ServerConfig } from './config'
import { FileService } from './files/service'
import type { Logger } from './log'
import type { AppBindings } from './http/env'
import { startServer, type Running } from './server'
import type { LauncherSandbox } from './native'
import { noSessions, nullRealtime, type Services } from './services'
import { engineSockets, socketPathMessage, tooLongSockets, type SocketPathProblem } from './system/sockets'
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

/** Engine sockets of this server whose paths do not fit in a Unix socket address (checked at start and before the
 * engine core starts; Diagnostics shows the same). */
export function socketPathProblems(config: AppConfig, engineConfig: ServerConfig): SocketPathProblem[] {
  const prodLauncher = config.mode === 'prod' ? config.engine.launcherSock ?? path.join(engineConfig.runDir, 'launcher.sock') : null
  return tooLongSockets(engineSockets(engineConfig.runDir, prodLauncher))
}

/** Dev / local-login: launcher runs as the current user; claude / codex from PATH (or config.engine.*Bin). */
export async function startLocalCore(ctx: AppContext): Promise<Running> {
  const cfg = ctx.engineConfig
  const gate = path.join(cfg.nativeBin, 'mycel-gate')
  if (!fs.existsSync(gate)) throw new CoreUnavailableError(`native helpers not built (${gate} missing): run \`bun run build:native\``)
  // without this the gate failed with "bind: invalid argument" and every chat said "the AI engine stopped unexpectedly"
  const long = socketPathProblems(ctx.config, cfg)
  if (long.length) throw new CoreUnavailableError(socketPathMessage(long, ctx.config.mode === 'dev'))
  if (ctx.config.mode === 'prod') {
    // production: the launcher is a LaunchDaemon as _axagent (component G installs it); we only connect
    return startServer(cfg, { db: ctx.db, files: ctx.files, externalLauncher: ctx.config.engine.launcherSock ?? path.join(cfg.runDir, 'launcher.sock'), toolsSockMode: '0660' })
  }
  const codex = findCodexBin(ctx.config.engine.codexBin)
  const allowCmds = [cfg.claudeBin, ...(codex ? [codex] : [])]
  const sandbox = devEngineSandbox()
  return startServer(cfg, { db: ctx.db, files: ctx.files, launcher: { allowCmds, sessionRoots: [path.join(os.homedir(), '.claude', 'projects')], ...(sandbox ? { sandbox } : {}) } })
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
