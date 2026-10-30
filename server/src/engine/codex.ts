// Codex CLI (`codex exec --json`), locked down as far as this CLI allows (owner decision 2026-10-21).
// Findings that shaped this (codex-cli 0.163.0, see docs/DECISIONS.md):
//  - the default CODEX_HOME/HOME inject the global AGENTS.md and every installed skill -> clean per-engine homes
//  - `--disable <feature>` did not remove tools in exec mode; `-c features.<name>=false` did
//  - the server-side model catalog sets tool_mode "code_mode_only" + shell_type "unified_exec", which gives the
//    model an exec tool regardless of features (it ran `id` and read a file outside the team folder) -> we pass
//    a local catalog (model_catalog_json) with shell_type "disabled", node_repl disabled, no experimental tools.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FILE_TOOLS, PRODUCT, type LaunchRequest } from '@mycel/shared'
import { REPO_ROOT } from '../app-config'
import { engineTimeZone } from '../system/time-zone'

export const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'unified_exec_tty', 'code_mode', 'code_mode_host', 'code_mode_interrupt', 'code_mode_only',
  'multi_agent', 'multi_agent_v2', 'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use',
  'image_generation', 'view_image', 'hooks', 'plugins', 'remote_plugin', 'plugin_sharing', 'skill_mcp_dependency_install', 'skill_search', 'sleep_tool',
  'tool_suggest', 'goals', 'shell_snapshot', 'workspace_dependencies', 'worktrees', 'mentions_v2', 'realtime_conversation', 'daemon_auto_start',
  'tool_call_mcp_elicitation', 'memories']

export interface CodexConf {
  bin: string
  /** engine's CODEX_HOME (no config.toml, no AGENTS.md, no skills). Both modes use the chat folder per turn
   * (codexTurnPaths); this field is only the fallback of tests that pass their own folder. */
  codexHome: string
  /** managed: production, cloud, Linux (docs/DECISIONS.md "AI 연결" D9): the turn's <chat>/.codex/auth.json is a
   * placeholder holding this turn's proxy token; the custom provider "teamax" sends every request to the model proxy,
   * which puts the real credential of the turn's AI connection on it. The engine never sees a real token.
   * agent-own: the older production setup, kept for the F1 fallback: the engine account signed in itself; its
   * auth.json lives in <agent root>/codex-auth, which the launcher copies into the turn and writes back.
   * dev-owner-symlink: dev / stage 1 — <chat>/.codex/auth.json is a symlink to the owner's login. */
  auth: 'managed' | 'agent-own' | 'dev-owner-symlink'
  /** engine's HOME (empty) so ~/.agents/skills etc. are not found: <chat>/.home per turn */
  agentHome: string
  /** locked model catalog (writeLockedCatalog). agent-own: <engine folder>/model_catalog.json, written by the
   * installer, read-only for the engine account. dev-owner-symlink: copied to <chat>/.codex/ every turn. */
  catalog: string
  model: string
}

/** The engine account's Codex login folder, relative to the agent root. One place for the installer, the launcher
 * (--codex-auth-dir), the server CLI (codex-login / -status / -logout) and the diagnostics. Never a chat folder: the
 * launcher refuses it as one (chat ids are uuids). */
export const CODEX_AUTH_DIR = 'codex-auth'
export const codexAuthDir = (agentRoot: string) => path.join(agentRoot, CODEX_AUTH_DIR)
/** The locked catalog of a production engine, next to the engine binary (installer: scripts/install-macos.sh). */
export const CODEX_CATALOG_FILE = 'model_catalog.json'
/** Real path of the catalog next to `bin` (the engine sandbox matches resolved paths; app/engines/codex/current is a
 * link to the version folder). */
export function codexCatalogFor(bin: string): string {
  let real = bin
  try { real = fs.realpathSync(bin) } catch {}
  return path.join(path.dirname(real), CODEX_CATALOG_FILE)
}
/** Model slugs of a locked catalog (first = default); throws when the file is missing or not a catalog. */
export function catalogModels(file: string): string[] {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(j.models)) throw new Error(`${file}: no models list`)
  for (const m of j.models) {
    // a catalog that would give the model a shell is never used (design tab 2: every entry shell disabled)
    if (m?.shell_type !== 'disabled' || m?.tool_mode !== 'direct' || (m?.apply_patch_tool_type ?? null) !== null) throw new Error(`${file}: model ${String(m?.slug)} is not locked`)
  }
  return j.models.map((m: any) => String(m.slug))
}

/** Build the local catalog from a fetched models_cache.json: no shell, no code mode, no node REPL, no extra tools. */
export function writeLockedCatalog(src: string, dst: string): string[] {
  const j = JSON.parse(fs.readFileSync(src, 'utf8'))
  j.models = j.models.map((m: any) => ({ ...m, shell_type: 'disabled', tool_mode: 'direct', node_repl_disabled: true, experimental_supported_tools: [],
    multi_agent_version: null, apply_patch_tool_type: null, supports_search_tool: false,
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false }))
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
  fs.writeFileSync(dst, JSON.stringify(j), { mode: 0o600 })
  return j.models.map((m: any) => m.slug)
}

/** Stage 1 local-login: engine CODEX_HOME holds only a symlink to the real auth.json. If codex replaced the
 * symlink with a refreshed file, move it back so the user's main login keeps the newest refresh token. */
export function prepareCodexHome(codexHome: string, auth: CodexConf['auth'], realAuth = path.join(os.homedir(), '.codex', 'auth.json')) {
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  for (const f of ['config.toml', 'AGENTS.md']) fs.rmSync(path.join(codexHome, f), { force: true })
  fs.rmSync(path.join(codexHome, 'skills'), { recursive: true, force: true })
  if (auth === 'agent-own' || auth === 'managed') return
  const link = path.join(codexHome, 'auth.json')
  let st: fs.Stats | null = null
  try { st = fs.lstatSync(link) } catch {}
  if (st && st.isFile()) fs.renameSync(link, realAuth)
  if (!st || !st.isSymbolicLink()) fs.symlinkSync(realAuth, link)
}

/** Where this turn's Codex keeps its state. dev-owner-symlink (dev, the engine runs as the owner under the engine
 * sandbox): in the chat folder, the only place the sandbox lets a turn read and write (security audit r1, os-layer
 * #2). The shared <data>/codex-home would need the server's data folder opened to every turn, and it mixed the
 * state (logs, sqlite) of every chat. */
export function codexTurnPaths(conf: CodexConf, chatDir: string): { codexHome: string; agentHome: string; catalog: string } {
  // managed / agent-own: the launcher (running as the engine account) makes <chat>/.codex (placeholder login or the
  // login copy) and <chat>/.home; the server cannot even read the chat folder. The catalog stays in the engine folder.
  if (conf.auth === 'agent-own' || conf.auth === 'managed') return { codexHome: '{CHAT_DIR}/.codex', agentHome: '{CHAT_DIR}/.home', catalog: conf.catalog }
  const codexHome = path.join(chatDir, '.codex')
  return { codexHome, agentHome: path.join(chatDir, '.home'), catalog: path.join(codexHome, 'catalog.json') }
}

/** A folder the server prepares inside a chat folder: the engine can write there, so a link (or file) it left in
 * place of the folder is removed (never followed) before the server writes into it. */
function realDir(p: string) {
  let st: fs.Stats | null = null
  try { st = fs.lstatSync(p) } catch {}
  if (st && !st.isDirectory()) fs.rmSync(p, { force: true }) // a link is unlinked, not followed
  fs.mkdirSync(p, { recursive: true, mode: 0o700 })
}

/** Before (and after) every Codex turn: prepare its CODEX_HOME (see prepareCodexHome); dev-owner-symlink also gets an
 * empty HOME and a fresh copy of the locked catalog in the chat folder. */
export function prepareCodexTurn(conf: CodexConf, chatDir: string, realAuth?: string) {
  if (conf.auth === 'agent-own' || conf.auth === 'managed') return // the launcher prepares and cleans the turn's Codex folders
  const p = codexTurnPaths(conf, chatDir)
  if (conf.auth === 'dev-owner-symlink') {
    realDir(chatDir)
    realDir(p.codexHome)
    fs.rmSync(p.agentHome, { recursive: true, force: true })
    fs.mkdirSync(p.agentHome, { mode: 0o700 })
  }
  prepareCodexHome(p.codexHome, conf.auth, realAuth)
  if (p.catalog !== conf.catalog) {
    fs.rmSync(p.catalog, { recursive: true, force: true })
    fs.copyFileSync(conf.catalog, p.catalog, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(p.catalog, 0o600)
  }
}

/** the pinned Codex CLI version (versions.json): sent as the `version` header the built-in provider sends (C8) */
export const CODEX_VERSION: string = (() => {
  try { const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'versions.json'), 'utf8'))['codex-cli']; if (typeof v === 'string') return v } catch {}
  return '0.163.0'
})()

/** Additional CLIs verified with the same locked profile. Installers still install CODEX_VERSION. */
export const CODEX_COMPATIBLE_VERSIONS = ['0.164.0', '0.165.0'] as const

/** seconds codex waits for one MCP tool call (ask_user waits for a person; codex's default is about 60 s) */
export const CODEX_TOOL_TIMEOUT_SEC = 1800

/** A managed Codex turn's provider setup (docs/DECISIONS.md "AI 연결" 3.5.3): everything the engine calls goes to the
 * model proxy on 127.0.0.1 (the launcher checks the addresses and refuses others). */
export interface CodexManaged { port: number; mode: 'chatgpt' | 'openai'; codexVersion: string }

export function codexManagedArgs(m: CodexManaged): string[] {
  return [
    '-c', 'model_provider="teamax"',
    // not "OpenAI": the name switches OpenAI-only behaviour on (C4)
    '-c', `model_providers.teamax.name=${JSON.stringify(PRODUCT.displayName)}`,
    '-c', `model_providers.teamax.base_url="http://127.0.0.1:${m.port}/codex/${m.mode}"`,
    '-c', 'model_providers.teamax.wire_api="responses"',
    // the provider takes the (placeholder) auth.json: Authorization / ChatGPT-Account-ID carry the turn token (C3)
    '-c', 'model_providers.teamax.requires_openai_auth=true',
    '-c', 'model_providers.teamax.supports_websockets=false',
    '-c', 'model_providers.teamax.request_max_retries=2',
    '-c', 'model_providers.teamax.stream_max_retries=2',
    '-c', 'model_providers.teamax.capabilities.remote_compaction="v2"',
    // the version header the built-in provider sends (C8)
    '-c', `model_providers.teamax.http_headers={ version = ${JSON.stringify(m.codexVersion)} }`,
    // background /wham/* calls go to the proxy too, which answers them without going upstream (C12)
    '-c', `chatgpt_base_url="http://127.0.0.1:${m.port}/codex/backend/"`,
    '-c', 'feedback.enabled=false',
    '-c', 'otel.metrics_exporter="none"',
  ]
}

export function codexArgs(conf: CodexConf, o: { extraTools?: string[]; model?: string; managed?: CodexManaged; webSearch?: boolean } = {}): string[] {
  return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--ignore-user-config',
    '-s', 'read-only',
    '-c', 'approval_policy="never"',
    '-c', 'project_doc_max_bytes=0',
    // no update check, no usage analytics (codex 0.163 sends them to chatgpt.com)
    '-c', 'check_for_update_on_startup=false',
    '-c', 'analytics.enabled=false',
    // the login is a file the launcher writes (never the keychain, which the engine account cannot reach; C11)
    ...(conf.auth === 'agent-own' || conf.auth === 'managed' ? ['-c', 'cli_auth_credentials_store="file"'] : []),
    ...(o.managed ? codexManagedArgs(o.managed) : []),
    // "cached" (Codex's own default): results from OpenAI's index, no live page loads. "live" let the search tool open
    // any address, outside the team server's address rules (docs/DECISIONS.md "Outbound web channels"); the model
    // proxy holds every web_search tool to external_web_access=false as well (proxy/codex-path.ts)
    '-c', `web_search="${o.webSearch === false ? 'disabled' : 'cached'}"`,
    '-c', `model_catalog_json=${JSON.stringify(conf.catalog)}`,
    '-c', `model=${JSON.stringify(o.model ?? conf.model)}`,
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['-c', `features.${f}=false`]),
    '-c', 'mcp_servers.team.command="{BRIDGE}"',
    '-c', 'mcp_servers.team.args=["--turn-dir","{CHAT_DIR}","--sock","{TOOLS_SOCK}"]',
    '-c', 'mcp_servers.team.startup_timeout_sec=20',
    '-c', `mcp_servers.team.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
    // our server decides every call (authorize); codex's own approval would just block them with approval_policy=never
    '-c', 'mcp_servers.team.default_tools_approval_mode="approve"',
    '-c', `mcp_servers.team.enabled_tools=${JSON.stringify([...Object.keys(FILE_TOOLS), ...(o.extraTools ?? [])])}`,
  ]
}

/** Production Codex network (design tab 2 "Codex 네트워크"): the engine account reaches only the model proxy (pf +
 * sandbox), which tunnels this turn's HTTPS (CONNECT) to the allowed hosts when the turn's proxy token comes with it. */
export const codexProxyUrl = (port: number, token: string) => `http://turn:${token}@127.0.0.1:${port}`

export function buildCodexLaunch(i: {
  turnId: string; chatDir: string; token: string; systemPrompt: string; message: string; timeoutMs: number; extraTools?: string[]; model?: string; webSearch?: boolean
  /** agent-own (F1): the CONNECT tunnel */
  proxy?: { port: number; token: string }
  /** managed: the provider setup and the placeholder auth.json (credentials/codex-home.ts dummyAuthJson) */
  managed?: CodexManaged & { authJson: string }
}, conf: CodexConf): LaunchRequest {
  const p = codexTurnPaths(conf, i.chatDir)
  if (conf.auth === 'agent-own' && !i.proxy) throw new Error('a Codex turn of the engine account needs the model proxy')
  if (conf.auth === 'managed' && !i.managed) throw new Error('a managed Codex turn needs its AI connection')
  const tmp = path.join(i.chatDir, '.tmp') // created by the launcher
  // codex has no system-prompt file option that keeps its tool instructions; the instructions travel on stdin
  // (never argv/env) ahead of the user's message.
  const stdin = `<instructions>\n${i.systemPrompt}\n</instructions>\n\n${i.message}`
  return {
    op: 'run', turnId: i.turnId, chatDir: i.chatDir, cmd: conf.bin,
    args: codexArgs({ ...conf, catalog: p.catalog }, { extraTools: i.extraTools, model: i.model, webSearch: i.webSearch, ...(i.managed ? { managed: { port: i.managed.port, mode: i.managed.mode, codexVersion: i.managed.codexVersion } } : {}) }),
    env: {
      PATH: '/usr/bin:/bin', HOME: p.agentHome, CODEX_HOME: p.codexHome, TMPDIR: tmp, LANG: 'en_US.UTF-8',
      // the team's time zone (system/time-zone.ts): a Linux server itself runs in UTC
      ...(engineTimeZone() ? { TZ: engineTimeZone()! } : {}),
      // agent-own (F1): HTTPS only through the model proxy's tunnel; certificates from the system bundle (the engine
      // sandbox has no keychain / trustd in this mode, and Codex then verifies with the file: tested under engine.sb).
      // managed: no HTTPS at all (plain HTTP to the proxy); the launcher sets CODEX_REFRESH_TOKEN_URL_OVERRIDE itself.
      ...(i.proxy && !i.managed ? { HTTPS_PROXY: codexProxyUrl(i.proxy.port, i.proxy.token), SSL_CERT_FILE: '/etc/ssl/cert.pem' } : {}),
    },
    token: i.token, systemPrompt: '', stdin, timeoutMs: i.timeoutMs,
    ...(conf.auth === 'agent-own' ? { codexAuth: true } : {}),
    ...(i.managed ? { codexHome: { authJson: i.managed.authJson } } : {}),
  }
}

/** The models of the locked catalog this server's Codex uses (the proxy's Codex path forwards only these). Read again
 * when the file changes. prod: next to the installed engine; dev: the one chat/engines.ts wrote into the data folder. */
const catalogCache = new Map<string, { key: string; models: string[] }>()
export function lockedCatalogModels(file: string | null): string[] {
  if (!file) return []
  try {
    const st = fs.statSync(file)
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`
    const c = catalogCache.get(file)
    if (c?.key === key) return c.models
    const models = catalogModels(file)
    catalogCache.set(file, { key, models })
    return models
  } catch { return [] }
}
