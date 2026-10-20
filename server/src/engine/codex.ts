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
import type { LaunchRequest } from '@mycel/shared'

export const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'unified_exec_tty', 'code_mode', 'code_mode_host', 'code_mode_interrupt', 'code_mode_only',
  'multi_agent', 'multi_agent_v2', 'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use',
  'image_generation', 'view_image', 'hooks', 'plugins', 'remote_plugin', 'plugin_sharing', 'skill_mcp_dependency_install', 'skill_search', 'sleep_tool',
  'tool_suggest', 'goals', 'shell_snapshot', 'workspace_dependencies', 'worktrees', 'mentions_v2', 'realtime_conversation', 'daemon_auto_start',
  'tool_call_mcp_elicitation', 'memories']

export interface CodexConf {
  bin: string
  /** engine's CODEX_HOME (no config.toml, no AGENTS.md, no skills) */
  codexHome: string
  /** agent-own: the engine account logged in itself (`codex login --device-auth`, stage 3) and auth.json lives in
   * codexHome. dev-owner-symlink: stage 1 tests only — auth.json is a symlink to the owner's login. */
  auth: 'agent-own' | 'dev-owner-symlink'
  /** engine's HOME (empty) so ~/.agents/skills etc. are not found */
  agentHome: string
  /** locked model catalog written by writeLockedCatalog() */
  catalog: string
  model: string
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

export function codexArgs(conf: CodexConf): string[] {
  return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--ignore-user-config',
    '-s', 'read-only',
    '-c', 'approval_policy="never"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'web_search="live"',
    '-c', `model_catalog_json=${JSON.stringify(conf.catalog)}`,
    '-c', `model=${JSON.stringify(conf.model)}`,
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['-c', `features.${f}=false`]),
    '-c', 'mcp_servers.team.command="{BRIDGE}"',
    '-c', 'mcp_servers.team.args=["--turn-dir","{CHAT_DIR}","--sock","{TOOLS_SOCK}"]',
    '-c', 'mcp_servers.team.startup_timeout_sec=20',
    '-c', 'mcp_servers.team.tool_timeout_sec=120',
  ]
}

export function buildCodexLaunch(i: { turnId: string; chatDir: string; token: string; systemPrompt: string; message: string; timeoutMs: number }, conf: CodexConf): LaunchRequest {
  fs.mkdirSync(i.chatDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(conf.agentHome, { recursive: true, mode: 0o700 })
  const tmp = path.join(i.chatDir, '.tmp')
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 })
  // codex has no system-prompt file option that keeps its tool instructions; the instructions travel on stdin
  // (never argv/env) ahead of the user's message.
  const stdin = `<instructions>\n${i.systemPrompt}\n</instructions>\n\n${i.message}`
  return {
    op: 'run', turnId: i.turnId, chatDir: i.chatDir, cmd: conf.bin, args: codexArgs(conf),
    env: { PATH: '/usr/bin:/bin', HOME: conf.agentHome, CODEX_HOME: conf.codexHome, TMPDIR: tmp, LANG: 'en_US.UTF-8' },
    token: i.token, systemPrompt: '', stdin, timeoutMs: i.timeoutMs,
  }
}
