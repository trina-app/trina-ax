// Engine login status for the diagnostics screen (design tab 6 step 4, tab 7 "진단 화면"). Component G.
// local-login (dev / this run): the owner's own CLI logins — `claude auth status` (JSON) and `codex login status`.
// Role-account mode (_axagent): Claude needs the owner's long-lived subscription token (`claude setup-token`) in
// secrets/claude-oauth-token; Codex needs a separate device-auth login of the engine account. Never returns account
// names or e-mail addresses.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** File in <data>/secrets that holds the owner's long-lived Claude subscription token (`claude setup-token`) for the
 * role-account mode. The admin engine screen and the diagnostics both look for this one name. */
export const CLAUDE_OAUTH_TOKEN_FILE = 'claude-oauth-token'

export interface EngineLogin {
  engine: 'claude-code' | 'codex'
  installed: boolean
  loggedIn: boolean | null
  /** e.g. claude.ai, ChatGPT, setup-token */
  method: string | null
  /** machine-readable reason when not logged in */
  reason: 'not_installed' | 'not_logged_in' | 'setup_token_missing' | 'engine_login_missing' | 'check_failed' | null
}

/**
 * A minimal environment for the status commands. USER / LOGNAME are needed: Claude Code finds its macOS keychain
 * entry by the account name, and without them `claude auth status` answers "loggedIn: false" for a working login.
 */
export function checkEnv(): Record<string, string> {
  const user = os.userInfo().username
  return { HOME: process.env.HOME ?? os.homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin', USER: user, LOGNAME: user, DISABLE_AUTOUPDATER: '1' }
}

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', cwd: '/', env: checkEnv() })
  const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, out: out + err }
  } finally {
    clearTimeout(t)
  }
}

export interface EngineCheckOptions {
  authMode: 'local-login' | 'proxy'
  /** role-account install: the engine runs as another account, local logins do not apply */
  roleAccount: boolean
  claudeBin: string | null
  codexBin: string | null
  secretsDir: string
}

export async function checkEngines(o: EngineCheckOptions): Promise<EngineLogin[]> {
  const exists = (p: string | null) => !!p && (() => { try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false } })()
  const out: EngineLogin[] = []
  // Claude Code
  if (!exists(o.claudeBin)) out.push({ engine: 'claude-code', installed: false, loggedIn: null, method: null, reason: 'not_installed' })
  else if (o.roleAccount) {
    const has = fs.existsSync(path.join(o.secretsDir, CLAUDE_OAUTH_TOKEN_FILE))
    out.push({ engine: 'claude-code', installed: true, loggedIn: has, method: has ? 'setup-token' : null, reason: has ? null : 'setup_token_missing' })
  } else {
    try {
      const r = await run([o.claudeBin!, 'auth', 'status'], 15_000)
      const j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)) as { loggedIn?: boolean; authMethod?: string }
      out.push({ engine: 'claude-code', installed: true, loggedIn: !!j.loggedIn, method: j.authMethod ?? null, reason: j.loggedIn ? null : 'not_logged_in' })
    } catch {
      out.push({ engine: 'claude-code', installed: true, loggedIn: null, method: null, reason: 'check_failed' })
    }
  }
  // Codex CLI
  if (!exists(o.codexBin)) out.push({ engine: 'codex', installed: false, loggedIn: null, method: null, reason: 'not_installed' })
  else if (o.roleAccount) {
    // the engine account's own login lives in its folder, which the server account cannot read by design
    out.push({ engine: 'codex', installed: true, loggedIn: null, method: null, reason: 'engine_login_missing' })
  } else {
    try {
      const r = await run([o.codexBin!, 'login', 'status'], 15_000)
      const ok = r.code === 0 && /logged in/i.test(r.out)
      out.push({ engine: 'codex', installed: true, loggedIn: ok, method: ok ? (/chatgpt/i.test(r.out) ? 'ChatGPT' : 'API key') : null, reason: ok ? null : 'not_logged_in' })
    } catch {
      out.push({ engine: 'codex', installed: true, loggedIn: null, method: null, reason: 'check_failed' })
    }
  }
  return out
}
