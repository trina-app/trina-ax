// Engine login status for the diagnostics screen (design tab 6 step 4, tab 7 "진단 화면"). Component G.
// managed (production, cloud): the team's AI connections per engine family (Admin > AI connections), no logins.
// local-login (dev / this run): the owner's own CLI logins — `claude auth status` (JSON) and `codex login status`.
// Role-account mode (_axagent): Claude needs the owner's long-lived subscription token (`claude setup-token`) in
// secrets/claude-oauth-token; Codex needs a separate device-auth login of the engine account. Never returns account
// names or e-mail addresses.
import fs from 'node:fs'
import os from 'node:os'
import type { Database } from 'bun:sqlite'
import { subscriptionTokenStatus } from '../proxy/subscription'

export { CLAUDE_OAUTH_TOKEN_FILE } from '../proxy/subscription'

export interface EngineLogin {
  engine: 'claude-code' | 'codex'
  installed: boolean
  loggedIn: boolean | null
  /** e.g. claude.ai, ChatGPT, setup-token */
  method: string | null
  /** machine-readable reason when not logged in (setup_token_expiring / credential_expiring: logged in, but a token
   * ends within 14 days). credential_*: managed mode, the team's AI connections of the engine's family. */
  reason: 'not_installed' | 'not_logged_in' | 'setup_token_missing' | 'setup_token_expired' | 'setup_token_invalid' | 'setup_token_expiring' | 'engine_login_missing' | 'check_failed'
    | 'credential_none' | 'credential_unusable' | 'credential_limited' | 'credential_expiring' | null
  /** subscription token: when it stops working (one year after it was stored) */
  expiresAt?: string | null
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

/** the team's AI connections of one family (credentials/resolve.ts teamCredentialSummary) */
export interface CredentialSummary { total: number; usable: number; expiring: number; reasons: string[] }

export interface EngineCheckOptions {
  authMode: 'local-login' | 'managed'
  /** managed mode: the team's usable AI connections per engine (instead of logins) */
  managed?: { 'claude-code': CredentialSummary; codex: CredentialSummary }
  /** role-account install: the engine runs as another account, local logins do not apply */
  roleAccount: boolean
  claudeBin: string | null
  codexBin: string | null
  secretsDir: string
  /** the server's database: the model proxy notes there when the upstream refused the token */
  db?: Database | null
  /** role-account install: the engine account's Codex login as the launcher sees it (server/src/native.ts
   * codexLoginState; the server account cannot read <agent root>/codex-auth). null = launcher did not answer. */
  codexLogin?: () => Promise<{ loggedIn: boolean } | null>
}

function fromConnections(engine: EngineLogin['engine'], s: CredentialSummary): EngineLogin {
  if (s.usable > 0) return { engine, installed: true, loggedIn: true, method: `AI connections: ${s.usable}`, reason: s.expiring > 0 ? 'credential_expiring' : null }
  const reason = s.total === 0 ? 'credential_none' : s.reasons.length && s.reasons.every((r) => r === 'limited' || r === 'over_limit') ? 'credential_limited' : 'credential_unusable'
  return { engine, installed: true, loggedIn: false, method: null, reason }
}

export async function checkEngines(o: EngineCheckOptions): Promise<EngineLogin[]> {
  const exists = (p: string | null) => !!p && (() => { try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false } })()
  const out: EngineLogin[] = []
  // Claude Code
  if (!exists(o.claudeBin)) out.push({ engine: 'claude-code', installed: false, loggedIn: null, method: null, reason: 'not_installed' })
  else if (o.managed) out.push(fromConnections('claude-code', o.managed['claude-code']))
  else if (o.roleAccount) {
    // the owner's setup-token behind the model proxy: present, not older than a year, not refused by the upstream
    const st = subscriptionTokenStatus(o.secretsDir, o.db ?? null)
    const reason = ({ missing: 'setup_token_missing', malformed: 'setup_token_invalid', invalid: 'setup_token_invalid', expired: 'setup_token_expired', expiring: 'setup_token_expiring', ok: null } as const)[st.state]
    const ok = st.state === 'ok' || st.state === 'expiring'
    out.push({ engine: 'claude-code', installed: true, loggedIn: ok, method: ok ? 'setup-token' : null, reason, expiresAt: st.expiresAt })
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
  else if (o.managed) out.push(fromConnections('codex', o.managed.codex))
  else if (o.roleAccount) {
    // the engine account's own login lives in its folder, which the server account cannot read by design: ask the
    // launcher (it never returns the token)
    const s = o.codexLogin ? await o.codexLogin().catch(() => null) : null
    if (!o.codexLogin) out.push({ engine: 'codex', installed: true, loggedIn: null, method: null, reason: 'engine_login_missing' })
    else if (s?.loggedIn === false) out.push({ engine: 'codex', installed: true, loggedIn: false, method: null, reason: 'engine_login_missing' })
    else if (!s) out.push({ engine: 'codex', installed: true, loggedIn: null, method: null, reason: 'check_failed' })
    else out.push({ engine: 'codex', installed: true, loggedIn: true, method: 'ChatGPT (engine account)', reason: null })
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
