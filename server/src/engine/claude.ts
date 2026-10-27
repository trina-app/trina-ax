// Claude Code with the locked profile (design tab 2 "엔진 잠금"; owner 2026-10-21: built-in WebSearch allowed).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ENGINE_BUILTIN_ALLOWED, FILE_TOOLS, TEAM_TOOL_PREFIX, type AuthMode, type LaunchRequest } from '@mycel/shared'
import { engineTimeZone } from '../system/time-zone'

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
  /** managed mode: the model proxy's address (the kind of credential is the turn's AI connection's, per attempt) */
  modelProxy?: { baseUrl: string }
  /** local-login in office mode: the engine's HTTPS goes through the proxy's CONNECT tunnel (HTTPS_PROXY with a
   * per-turn token; the sandbox allows no other network, security round 4b) */
  connectProxy?: boolean
}

/** HTTPS_PROXY of a turn that tunnels through the local proxy: the per-turn token is the proxy password */
export const turnProxyUrl = (port: number, token: string) => `http://turn:${token}@127.0.0.1:${port}`

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

/** The model of a subscription-mode turn nobody chose a model for. With an injected token (our per-turn token on fd 3)
 * Claude Code cannot tell the plan and starts on Sonnet, where the Mac's stored Max login starts on Opus (Claude Code
 * 2.1.305/2.1.306, seen on the staging install 2026-10-22: every turn was claude-sonnet-*). A team default, chat or
 * personal model still wins; company-key mode keeps Claude Code's own default (API pricing). */
export const SUBSCRIPTION_DEFAULT_MODEL = 'opus'

/** Claude Code gives up on an MCP tool call after this (ask_user / browser site confirmations wait up to 15 minutes). */
export const MCP_TOOL_TIMEOUT_MS = 1_800_000

export function buildClaudeLaunch(i: {
  turnId: string; chatDir: string; token: string; systemPrompt: string; message: string
  sessionId: string; resume: boolean; stash: Buffer | null; model?: string; maxTurns: number; timeoutMs: number; proxyToken?: string
  /** the kind of the turn's AI connection: the engine then behaves as with that kind of credential (subscription
   * defaults for a Claude subscription token, x-api-key for an API key); default oauth */
  tokenKind?: 'oauth' | 'api-key'
  /** local-login through the CONNECT tunnel (office mode): the proxy port and this attempt's proxy token */
  tunnel?: { port: number; token: string }
  /** our MCP tools besides the six file tools offered to this turn (remember, ask_user, browser tools, make_file ...) */
  extraTools?: string[]
  /** False for approved local-folder templates; normal chat keeps the existing built-in search. */
  webSearch?: boolean
}, conf: ClaudeConf): LaunchRequest {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--include-hook-events',
    '--tools', (i.webSearch === false ? [] : ENGINE_BUILTIN_ALLOWED).join(','),
    '--allowedTools', [...CLAUDE_ALLOWED_TOOLS.filter(t => i.webSearch !== false || t !== 'WebSearch'), ...(i.extraTools ?? []).map((t) => TEAM_TOOL_PREFIX + t)].join(','),
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
  const tz = engineTimeZone() // the team's time zone (system/time-zone.ts): a Linux server itself runs in UTC
  if (tz) env.TZ = tz
  if (conf.authMode === 'local-login') {
    // dev/test: the CLI's own login. Its macOS keychain entry is tied to the default config dir and the
    // user, so HOME stays the real home and CLAUDE_CONFIG_DIR is not set in this mode.
    env.HOME = os.homedir()
    for (const k of ['USER', 'LOGNAME']) if (process.env[k]) env[k] = process.env[k]!
    // office mode: the only way out of the sandbox is the proxy port (the token is useless to any process outside this
    // turn's engine session: the proxy checks the TCP peer through the launcher)
    if (i.tunnel) env.HTTPS_PROXY = turnProxyUrl(i.tunnel.port, i.tunnel.token)
  } else {
    // managed: everything of the CLI stays in the chat folder (the only place the sandbox lets the
    // engine write); the launcher creates .home. The per-turn proxy token goes to the launcher, which hands it to the
    // engine on an inherited pipe (fd 3), never in the environment (other processes of the engine account can read it).
    env.HOME = path.join(i.chatDir, '.home')
    env.CLAUDE_CONFIG_DIR = path.join(i.chatDir, '.claude')
    env.ANTHROPIC_BASE_URL = conf.modelProxy!.baseUrl
  }
  const loc = sessionLocation(conf, i.chatDir)
  const modelToken = conf.authMode !== 'local-login' && i.proxyToken ? { kind: i.tokenKind ?? 'oauth', value: i.proxyToken } : undefined
  return {
    op: 'run', turnId: i.turnId, chatDir: i.chatDir, cmd: conf.bin, args, env, token: i.token, systemPrompt: i.systemPrompt,
    stdin: i.message, timeoutMs: i.timeoutMs, ...(modelToken ? { modelToken } : {}),
    ...(i.resume && i.stash ? { sessionRestore: { dir: loc.restoreDir, name: `${i.sessionId}.jsonl`, b64: i.stash.toString('base64') } } : {}),
    sessionCollect: { dir: loc.collectDir, name: `${i.sessionId}.jsonl`, removeDir: true },
  }
}
