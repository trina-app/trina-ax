// Claude Code with the locked profile (design tab 2 "엔진 잠금"; owner 2026-10-21: built-in WebSearch allowed).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ENGINE_BUILTIN_ALLOWED, FILE_TOOLS, TEAM_TOOL_PREFIX, type AuthMode, type LaunchRequest } from '@mycel/shared'

/** environment switches that close file mentions, attachments, CLAUDE.md, bundled skills, background tasks, telemetry */
export const CLAUDE_LOCK_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1',
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  // without it Claude Code puts `git status`, the branch and recent commits of whatever repository the chat folder
  // sits in into the model's context (seen in the lockdown run: the server's own checkout and its commit messages)
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  DISABLE_AUTOUPDATER: '1',
}
// Claude Code 2.1.304 ships built-in plugins that load even with --setting-sources "" (seen in the lockdown run):
// cc-plugin-agents-md would feed AGENTS.md files into the context. They are switched off explicitly.
export const CLAUDE_BUILTIN_PLUGINS_OFF = ['cc-plugin-agents-md@builtin', 'cc-plugin-plugin-authoring@builtin']
export const CLAUDE_LOCK_SETTINGS = { autoMemoryEnabled: false, disableAllHooks: true, includeGitInstructions: false, enabledPlugins: Object.fromEntries(CLAUDE_BUILTIN_PLUGINS_OFF.map((p) => [p, false])) }
/** exactly what the engine may call */
export const CLAUDE_ALLOWED_TOOLS = [...Object.keys(FILE_TOOLS).map((t) => TEAM_TOOL_PREFIX + t), ...ENGINE_BUILTIN_ALLOWED]

export interface ClaudeConf {
  bin: string
  authMode: AuthMode
  /** unused by proxy modes (HOME is <chat>/.home, inside the sandbox); local-login uses the real home */
  agentHome: string
  /** subscription / company-key mode: the model proxy's address and the kind of credential behind it */
  modelProxy?: { baseUrl: string; kind: 'api-key' | 'oauth' }
}

/** Claude names its project folder after the cwd with every non-alphanumeric character replaced by '-' */
export const projectSlug = (dir: string) => {
  let parent = path.dirname(dir)
  try { parent = fs.realpathSync(parent) } catch {}
  return path.join(parent, path.basename(dir)).replace(/[^a-zA-Z0-9]/g, '-')
}

export function sessionLocation(conf: ClaudeConf, chatDir: string) {
  if (conf.authMode === 'local-login') {
    const dir = path.join(os.homedir(), '.claude', 'projects', projectSlug(chatDir))
    return { restoreDir: dir, collectDir: dir }
  }
  const projects = path.join(chatDir, '.claude', 'projects')
  return { restoreDir: path.join(projects, 'restored'), collectDir: projects }
}

/** Claude Code gives up on an MCP tool call after this (ask_user / browser site confirmations wait up to 15 minutes). */
export const MCP_TOOL_TIMEOUT_MS = 1_800_000

export function buildClaudeLaunch(i: {
  turnId: string; chatDir: string; token: string; systemPrompt: string; message: string
  sessionId: string; resume: boolean; stash: Buffer | null; model?: string; maxTurns: number; timeoutMs: number; proxyToken?: string
  /** our MCP tools besides the six file tools offered to this turn (remember, ask_user, browser tools, make_file ...) */
  extraTools?: string[]
}, conf: ClaudeConf): LaunchRequest {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--include-hook-events',
    '--tools', ENGINE_BUILTIN_ALLOWED.join(','),
    '--allowedTools', [...CLAUDE_ALLOWED_TOOLS, ...(i.extraTools ?? []).map((t) => TEAM_TOOL_PREFIX + t)].join(','),
    '--strict-mcp-config', '--mcp-config', '{MCP_CONFIG}',
    '--setting-sources', '',
    '--settings', JSON.stringify(CLAUDE_LOCK_SETTINGS),
    '--disable-slash-commands',
    '--permission-mode', 'dontAsk',
    '--append-system-prompt-file', '{SYSTEM_PROMPT_FILE}',
    '--max-turns', String(i.maxTurns),
    ...(i.model ? ['--model', i.model] : []),
    ...(i.resume ? ['--resume', i.sessionId] : ['--session-id', i.sessionId]),
  ]
  // temp files stay in the chat folder: with only TMPDIR, Claude Code still creates /tmp/claude-<uid> and
  // /tmp/cc-socks-<uid>, so CLAUDE_CODE_TMPDIR is set too (macOS spike 2026-10-21)
  const tmp = path.join(i.chatDir, '.tmp') // created by the launcher
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, ...CLAUDE_LOCK_ENV,
    MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) }
  if (conf.authMode === 'local-login') {
    // dev/test: the CLI's own login. Its macOS keychain entry is tied to the default config dir and the
    // user, so HOME stays the real home and CLAUDE_CONFIG_DIR is not set in this mode.
    env.HOME = os.homedir()
    for (const k of ['USER', 'LOGNAME']) if (process.env[k]) env[k] = process.env[k]!
  } else {
    // subscription / company key: everything of the CLI stays in the chat folder (the only place the sandbox lets the
    // engine write); the launcher creates .home. The per-turn proxy token goes to the launcher, which hands it to the
    // engine on an inherited pipe (fd 3), never in the environment (other processes of the engine account can read it).
    env.HOME = path.join(i.chatDir, '.home')
    env.CLAUDE_CONFIG_DIR = path.join(i.chatDir, '.claude')
    env.ANTHROPIC_BASE_URL = conf.modelProxy!.baseUrl
  }
  const loc = sessionLocation(conf, i.chatDir)
  const modelToken = conf.authMode !== 'local-login' && i.proxyToken ? { kind: conf.modelProxy!.kind, value: i.proxyToken } : undefined
  return {
    op: 'run', turnId: i.turnId, chatDir: i.chatDir, cmd: conf.bin, args, env, token: i.token, systemPrompt: i.systemPrompt,
    stdin: i.message, timeoutMs: i.timeoutMs, ...(modelToken ? { modelToken } : {}),
    ...(i.resume && i.stash ? { sessionRestore: { dir: loc.restoreDir, name: `${i.sessionId}.jsonl`, b64: i.stash.toString('base64') } } : {}),
    sessionCollect: { dir: loc.collectDir, name: `${i.sessionId}.jsonl`, removeDir: true },
  }
}
