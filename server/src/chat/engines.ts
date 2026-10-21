// Which engine binaries / profiles chat turns use. Dev and the owner-subscription setup run "local-login":
// Claude Code with the owner's own CLI login, Codex CLI with the owner's ChatGPT login (locked profile, stage 1).
// Company-key mode ("proxy") exists as code only (stage 1 model proxy) and is refused here with a clear message.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { EngineId } from '@mycel/shared/api'
import type { ClaudeConf } from '../engine/claude'
import { catalogModels, codexCatalogFor, writeLockedCatalog, type CodexConf } from '../engine/codex'
import { findCodexBin } from '../config'
import type { AppContext } from '../context'

export interface EngineConfs {
  claude: ClaudeConf | null
  codex: CodexConf | null
  /** why an engine can't run (shown as the answer error) */
  problems: Partial<Record<EngineId, 'engine_missing' | 'proxy_mode'>>
  /** models the Codex catalog offers (first = default) */
  codexModels: string[]
}

export interface EngineProvider {
  get(): EngineConfs
}

export const RECHECK_MISSING_MS = 30_000

/** Resolve engines from the app config on first use (codex catalog written once). */
export class LocalEngines implements EngineProvider {
  private cached: EngineConfs | null = null
  private cachedAt = 0
  constructor(private ctx: AppContext, private now: () => number = Date.now) {}

  get(): EngineConfs {
    // a missing engine is looked for again after a while (the admin may install it without restarting the server)
    if (this.cached && (!Object.keys(this.cached.problems).length || this.now() - this.cachedAt < RECHECK_MISSING_MS)) return this.cached
    const { config, engineConfig } = this.ctx
    const problems: EngineConfs['problems'] = {}
    let claude: ClaudeConf | null = null
    if (config.engine.authMode === 'proxy') {
      // company key mode: the model proxy has to be configured and started (owner decision: not offered for now)
      problems['claude-code'] = 'proxy_mode'
    } else if (fs.existsSync(engineConfig.claudeBin)) {
      claude = { bin: engineConfig.claudeBin, authMode: 'local-login', agentHome: path.join(config.dataDir, 'agent-home') }
    } else problems['claude-code'] = 'engine_missing'

    let codex: CodexConf | null = null
    let codexModels: string[] = []
    if (config.mode === 'prod') {
      // role-account install ("agent-own"): the installer's engine (engine.codexBin, never a PATH lookup: the launcher
      // allows only that file) and the locked catalog it wrote next to it. The engine account's login lives in
      // <agent root>/codex-auth, which only the launcher touches (it copies it into each turn's chat folder).
      const bin = config.engine.codexBin
      if (bin && fs.existsSync(bin)) {
        const catalog = codexCatalogFor(bin)
        try {
          codexModels = catalogModels(catalog)
          codex = { bin, codexHome: '{CHAT_DIR}/.codex', agentHome: '{CHAT_DIR}/.home', catalog, model: codexModels[0] ?? 'gpt-5', auth: 'agent-own' }
        } catch (e) {
          this.ctx.log.warn('codex catalog missing or not locked: Codex turns are off', { catalog, err: e })
          problems.codex = 'engine_missing'
        }
      } else problems.codex = 'engine_missing'
    } else {
      // dev / owner subscription ("dev-owner-symlink"): each turn's <chat>/.codex holds a link to the owner's ChatGPT
      // login; the catalog is locked from the owner's own models_cache.json
      const bin = findCodexBin(config.engine.codexBin)
      const src = path.join(os.homedir(), '.codex', 'models_cache.json')
      if (bin && fs.existsSync(src)) {
        try {
          const catalog = path.join(config.dataDir, 'codex-catalog.json')
          codexModels = writeLockedCatalog(src, catalog)
          // CODEX_HOME / HOME are per turn in the chat folder (codexTurnPaths)
          codex = { bin, codexHome: '', agentHome: '', catalog, model: codexModels[0] ?? 'gpt-5', auth: 'dev-owner-symlink' }
        } catch (e) {
          this.ctx.log.warn('codex catalog could not be prepared', { err: e })
          problems.codex = 'engine_missing'
        }
      } else problems.codex = 'engine_missing'
    }
    this.cached = { claude, codex, problems, codexModels }
    this.cachedAt = this.now()
    return this.cached
  }
}

/** Codex on the engine account (production) is "beta" until the open checks of design tab 2 "Codex 네트워크" pass
 * (WebSocket transport through the tunnel, token refresh and web search with pf on, the target "proxy swaps the
 * token" setup): it is labelled beta, cannot be the team default, and only the owner plus the people in the setting
 * `codexUsers` (ids; empty by default) may use it. Dev mode (the owner's own login) is not affected. */
export const CODEX_PROD_BETA = true
export const codexIsBeta = (ctx: { config: { mode: 'dev' | 'prod' } }) => CODEX_PROD_BETA && ctx.config.mode === 'prod'
export function codexBetaAllowed(db: Database, user: { id: string; role: string }): boolean {
  if (user.role === 'owner') return true
  try {
    const r = db.query("SELECT value FROM settings WHERE key = 'codexUsers'").get() as { value: string } | null
    const v = r ? JSON.parse(r.value) : []
    return Array.isArray(v) && v.includes(user.id)
  } catch { return false }
}

/** Fixed engines (tests: fake engines). */
export class StaticEngines implements EngineProvider {
  constructor(private confs: EngineConfs) {}
  get() { return this.confs }
}

/** Model names go to the engine's argv (`--model <name>` / `-c model="<name>"`): letters, digits and . _ - : / [ ]
 * only, never starting with "-" (so a model can never read as another option). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/
export const safeModel = (m: unknown): m is string => typeof m === 'string' && MODEL_RE.test(m)
