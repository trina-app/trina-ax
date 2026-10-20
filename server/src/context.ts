// Everything a route module gets: config, DB, logger, file service, services of other components, and the engine
// core (tools gate + launcher), started on first use.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { uuidv7 } from '@mycel/shared'
import type { AppConfig } from './app-config'
import { defaultConfig, which, type ServerConfig } from './config'
import { FileService } from './files/service'
import type { Logger } from './log'
import { startServer, type Running } from './server'
import { noSessions, nullRealtime, type Services } from './services'
import pkg from '../package.json'

export const SERVER_VERSION: string = pkg.version

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

/** Dev / local-login: launcher runs as the current user; claude / codex from PATH (or config.engine.*Bin). */
export async function startLocalCore(ctx: AppContext): Promise<Running> {
  const cfg = ctx.engineConfig
  const gate = path.join(cfg.nativeBin, 'mycel-gate')
  if (!fs.existsSync(gate)) throw new CoreUnavailableError(`native helpers not built (${gate} missing): run \`bun run build:native\``)
  if (ctx.config.mode === 'prod') {
    // production: the launcher is a LaunchDaemon as _axagent (component G installs it); we only connect
    return startServer(cfg, { db: ctx.db, files: ctx.files, externalLauncher: path.join(cfg.runDir, 'launcher.sock'), toolsSockMode: '0660' })
  }
  const codex = ctx.config.engine.codexBin ?? which('codex')
  const allowCmds = [cfg.claudeBin, ...(codex ? [codex] : [])]
  return startServer(cfg, { db: ctx.db, files: ctx.files, launcher: { allowCmds, sessionRoots: [path.join(os.homedir(), '.claude', 'projects')] } })
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
