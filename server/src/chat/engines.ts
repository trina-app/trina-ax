// Which engine binaries / profiles chat turns use. Dev runs "local-login": Claude Code with the owner's own CLI login,
// Codex CLI with the owner's ChatGPT login (locked profile, stage 1). Production runs "managed": Claude Code and Codex
// as the engine account behind the model proxy, which puts the real credential of the turn's AI connection on each
// request (docs/DECISIONS.md "AI 연결"; credentials/*). Whether someone has a connection is decided per turn
// (chat/turn.ts: no connection = a clear answer error), not here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { EngineId } from '@mycel/shared/api'
import type { ClaudeConf } from '../engine/claude'
import { readApiEngine, type ApiEngineConf } from '../engine/api-agent'
import { catalogModels, codexCatalogFor, writeLockedCatalog, type CodexConf } from '../engine/codex'
import { findCodexBin } from '../config'
import type { AppContext } from '../context'
import { DEFAULT_PROXY_PORT } from '../app-config'

export interface EngineConfs {
  claude: ClaudeConf | null
  codex: CodexConf | null
  /** the team's OpenAI-compatible API engine (engine/api-agent.ts), when configured */
  api?: ApiEngineConf | null
  /** why an engine can't run (shown as the answer error) */
  problems: Partial<Record<EngineId, 'engine_missing'>>
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

  /** Forget the cached setup (the admin changed the API engine). */
  reset() { this.cached = null }

  get(): EngineConfs {
    // a missing engine is looked for again after a while (the admin may install it without restarting the server)
    if (this.cached && (!Object.keys(this.cached.problems).length || this.now() - this.cachedAt < RECHECK_MISSING_MS)) return this.cached
    const { config, engineConfig } = this.ctx
    const problems: EngineConfs['problems'] = {}
    let claude: ClaudeConf | null = null
    if (config.engine.authMode === 'managed') {
      // the team's AI connections behind the model proxy; a person without one gets a clear error from the turn
      if (!fs.existsSync(engineConfig.claudeBin)) problems['claude-code'] = 'engine_missing'
      else claude = { bin: engineConfig.claudeBin, authMode: 'managed', agentHome: path.join(config.dataDir, 'agent-home'),
        modelProxy: { baseUrl: `http://127.0.0.1:${config.engine.proxyPort ?? DEFAULT_PROXY_PORT}` } }
    } else if (fs.existsSync(engineConfig.claudeBin)) {
      // office mode: through the CONNECT tunnel of the local proxy (startLocalCore starts it, security round 4b)
      claude = { bin: engineConfig.claudeBin, authMode: 'local-login', agentHome: path.join(config.dataDir, 'agent-home'), ...(config.office ? { connectProxy: true } : {}) }
    } else problems['claude-code'] = 'engine_missing'

    let codex: CodexConf | null = null
    let codexModels: string[] = []
    if (config.mode === 'prod') {
      // installed server ("managed"): the installer's engine (engine.codexBin, never a PATH lookup: the launcher allows
      // only that file) and the locked catalog it wrote next to it. Each turn gets a placeholder login in its chat
      // folder (the launcher writes it) and talks to the model proxy, which adds the AI connection's real credential.
      const bin = config.engine.codexBin
      if (bin && fs.existsSync(bin)) {
        const catalog = codexCatalogFor(bin)
        try {
          codexModels = catalogModels(catalog)
          codex = { bin, codexHome: '{CHAT_DIR}/.codex', agentHome: '{CHAT_DIR}/.home', catalog, model: codexModels[0] ?? 'gpt-5', auth: 'managed' }
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
      if (bin && fs.existsSync(bin) && fs.existsSync(src)) {
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
    // the team's API engine (engine/api-agent.ts): runs inside the server, so it works the same in every mode
    const api = readApiEngine(config.dataDir)
    if (!api) problems.api = 'engine_missing'
    this.cached = { claude, codex, api, problems, codexModels }
    this.cachedAt = this.now()
    return this.cached
  }
}

/** Codex on the engine account was "beta" (owner only, never the team default) while its real token sat in the
 * turn's folder. main lifted it after the staging checks (2026-10-22: real turns, team tools, a forced token refresh and
 * web search through the proxy tunnel); with managed mode the engine also holds only a placeholder and the proxy adds
 * the credential (docs/DECISIONS.md "AI 연결" D9/D19). No beta either way; `codexUsers` is not read any more and these
 * stay for one release (removed in the next). */
export const CODEX_PROD_BETA = false
export const codexIsBeta = (ctx: { config: { mode: 'dev' | 'prod' } }) => CODEX_PROD_BETA && ctx.config.mode === 'prod'
export function codexBetaAllowed(_db: Database, _user: { id: string; role: string }): boolean { return true }

/** Fixed engines (tests: fake engines). */
export class StaticEngines implements EngineProvider {
  constructor(private confs: EngineConfs) {}
  get() { return this.confs }
}

/** Model names go to the engine's argv (`--model <name>` / `-c model="<name>"`): letters, digits and . _ - : / [ ]
 * only, never starting with "-" (so a model can never read as another option). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/
export const safeModel = (m: unknown): m is string => typeof m === 'string' && MODEL_RE.test(m)
