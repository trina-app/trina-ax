// ChatGPT sign-in facts the server relies on (Codex CLI 0.163.0, `codex-rs/login`; docs/DECISIONS.md "AI 연결" C9/C10).
// Check these again with spike S1 (tests/engine/codex-managed-spike.ts) whenever the pinned Codex version changes.
import crypto from 'node:crypto'

/** the Codex CLI's OAuth client id (login/src/auth/manager.rs: refresh requests carry it) */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** where tokens are refreshed: <openaiAuth>/oauth/token */
export const REFRESH_PATH = '/oauth/token'
/** the claims namespace of the id_token */
export const AUTH_CLAIM = 'https://api.openai.com/auth'
/** Codex refreshes when the access token ends within 5 minutes, or the last refresh is older than 8 days */
export const REFRESH_BEFORE_EXP_MS = 5 * 60_000
export const REFRESH_EVERY_MS = 8 * 24 * 3600_000

export interface IdClaims { email: string | null; planType: string | null; accountId: string | null; userId: string | null; fedramp: boolean; exp: number | null }

/** The payload of a JWT (no signature check: only to read claims of a token we got from the provider). */
export function jwtPayload(t: string): Record<string, unknown> | null {
  const parts = t.split('.')
  if (parts.length !== 3) return null
  try { const j = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')); return j && typeof j === 'object' ? j : null } catch { return null }
}

export function idClaims(idToken: string): IdClaims | null {
  const p = jwtPayload(idToken)
  if (!p) return null
  const a = (p[AUTH_CLAIM] && typeof p[AUTH_CLAIM] === 'object' ? p[AUTH_CLAIM] : {}) as Record<string, unknown>
  return {
    email: typeof p.email === 'string' ? p.email : null,
    planType: typeof a.chatgpt_plan_type === 'string' ? a.chatgpt_plan_type : null,
    accountId: typeof a.chatgpt_account_id === 'string' ? a.chatgpt_account_id : null,
    userId: typeof a.chatgpt_user_id === 'string' ? a.chatgpt_user_id : null,
    fedramp: a.chatgpt_account_is_fedramp === true,
    exp: typeof p.exp === 'number' ? p.exp : null,
  }
}

/** expiry (ms) of an access token when it is a JWT */
export function accessExpiry(accessToken: string): number | null {
  const p = jwtPayload(accessToken)
  return p && typeof p.exp === 'number' ? p.exp * 1000 : null
}

/** "d***@g***.com": shown so the owner sees which account was connected; the full address is never stored */
export function maskEmail(e: string | null): string | null {
  if (!e) return null
  const m = /^([^@]+)@([^.]+)(\..+)?$/.exec(e)
  if (!m) return null
  return `${m[1]![0]}***@${m[2]![0]}***${m[3] ?? ''}`
}

/** a stable reference to the ChatGPT account that is not its id (audit, same-account checks) */
export const accountRef = (accountId: string) => crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 12)
