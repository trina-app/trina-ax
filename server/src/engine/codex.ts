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
import { FILE_TOOLS, type LaunchRequest } from '@mycel/shared'

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
  /** agent-own: production, the engine account (_axagent) signed in itself (`codex login --device-auth`, run by the
   * server CLI through the launcher); its auth.json lives in ONE place, <agent root>/codex-auth (codexAuthDir), which
   * the launcher copies into the turn's <chat>/.codex and writes back after a refresh. The server never touches it.
   * dev-owner-symlink: dev / stage 1 — <chat>/.codex/auth.json is a symlink to the owner's login. */
  auth: 'agent-own' | 'dev-owner-symlink'
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
  if (auth === 'agent-own') return
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
  // agent-own: the launcher (running as the engine account) makes <chat>/.codex with the login copy and <chat>/.home;
  // the server cannot even read the chat folder. The catalog stays in the engine folder.
  if (conf.auth === 'agent-own') return { codexHome: '{CHAT_DIR}/.codex', agentHome: '{CHAT_DIR}/.home', catalog: conf.catalog }
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
  if (conf.auth === 'agent-own') return // the launcher prepares and cleans the turn's Codex folders
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

/** seconds codex waits for one MCP tool call (ask_user waits for a person; codex's default is about 60 s) */
export const CODEX_TOOL_TIMEOUT_SEC = 1800

export function codexArgs(conf: CodexConf, o: { extraTools?: string[]; model?: string } = {}): string[] {
  return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--ignore-user-config',
    '-s', 'read-only',
    '-c', 'approval_policy="never"',
    '-c', 'project_doc_max_bytes=0',
    // no update check, no usage analytics (codex 0.163 sends them to chatgpt.com through the same tunnel)
    '-c', 'check_for_update_on_startup=false',
    '-c', 'analytics.enabled=false',
    // the engine account's login is a file the launcher copies in (never the keychain, which it cannot reach)
    ...(conf.auth === 'agent-own' ? ['-c', 'cli_auth_credentials_store="file"'] : []),
    '-c', 'web_search="live"',
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

export function buildCodexLaunch(i: { turnId: string; chatDir: string; token: string; systemPrompt: string; message: string; timeoutMs: number; extraTools?: string[]; model?: string; proxy?: { port: number; token: string } }, conf: CodexConf): LaunchRequest {
  const p = codexTurnPaths(conf, i.chatDir)
  if (conf.auth === 'agent-own' && !i.proxy) throw new Error('a Codex turn of the engine account needs the model proxy')
  const tmp = path.join(i.chatDir, '.tmp') // created by the launcher
  // codex has no system-prompt file option that keeps its tool instructions; the instructions travel on stdin
  // (never argv/env) ahead of the user's message.
  const stdin = `<instructions>\n${i.systemPrompt}\n</instructions>\n\n${i.message}`
  return {
    op: 'run', turnId: i.turnId, chatDir: i.chatDir, cmd: conf.bin, args: codexArgs({ ...conf, catalog: p.catalog }, { extraTools: i.extraTools, model: i.model }),
    env: {
      PATH: '/usr/bin:/bin', HOME: p.agentHome, CODEX_HOME: p.codexHome, TMPDIR: tmp, LANG: 'en_US.UTF-8',
      // agent-own: HTTPS only through the model proxy; certificates from the system bundle (the engine sandbox has no
      // keychain / trustd in this mode, and Codex then verifies with the file: tested under engine.sb)
      ...(i.proxy ? { HTTPS_PROXY: codexProxyUrl(i.proxy.port, i.proxy.token), SSL_CERT_FILE: '/etc/ssl/cert.pem' } : {}),
    },
    token: i.token, systemPrompt: '', stdin, timeoutMs: i.timeoutMs,
    ...(conf.auth === 'agent-own' ? { codexAuth: true } : {}),
  }
}
