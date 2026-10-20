// Which engine binaries / profiles chat turns use. Dev and the owner-subscription setup run "local-login":
// Claude Code with the owner's own CLI login, Codex CLI with the owner's ChatGPT login (locked profile, stage 1).
// Company-key mode ("proxy") exists as code only (stage 1 model proxy) and is refused here with a clear message.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineId } from '@mycel/shared/api'
import type { ClaudeConf } from '../engine/claude'
import { writeLockedCatalog, type CodexConf } from '../engine/codex'
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
    const bin = findCodexBin(config.engine.codexBin)
    const codexHome = path.join(config.dataDir, 'codex-home')
    const sources = [path.join(codexHome, 'models_cache.json'), path.join(os.homedir(), '.codex', 'models_cache.json')]
    const src = sources.find((p) => fs.existsSync(p))
    if (bin && src) {
      try {
        const catalog = path.join(config.dataDir, 'codex-catalog.json')
        codexModels = writeLockedCatalog(src, catalog)
        // dev / owner subscription: the engine's CODEX_HOME holds a link to the owner's ChatGPT login (stage 1
        // "dev-owner-symlink"); a role-account install logs the engine account in itself ("agent-own", stage 3)
        codex = { bin, codexHome, agentHome: path.join(config.dataDir, 'codex-agent-home'), catalog, model: codexModels[0] ?? 'gpt-5', auth: config.mode === 'prod' ? 'agent-own' : 'dev-owner-symlink' }
      } catch (e) {
        this.ctx.log.warn('codex catalog could not be prepared', { err: e })
        problems.codex = 'engine_missing'
      }
    } else problems.codex = 'engine_missing'
    this.cached = { claude, codex, problems, codexModels }
    this.cachedAt = this.now()
    return this.cached
  }
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
