// The placeholder auth.json of a managed Codex turn (docs/DECISIONS.md "AI 연결" D9, 3.5.3). It makes Codex 0.163 use
// its ChatGPT (or API key) code path against our provider while holding nothing real:
//   - access_token / OPENAI_API_KEY = this turn's proxy token (mpx_…): not a JWT, so Codex never refreshes for expiry
//   - refresh_token = the fixed "teamax-no-refresh"; account_id = "teamax-<sha256(connection id)[:12]>"
//   - id_token = an unsigned JWT (Codex reads its claims without a signature check, C10) with the connection's real
//     plan type and fedramp flag (so Codex behaves as with the real plan), no e-mail, no real user or account id
//   - last_refresh = now (the 8-day rule never fires within a turn, which lasts at most 3 hours)
// The launcher checks this shape and refuses a turn whose auth.json looks like a real login (security T1).
import crypto from 'node:crypto'
import { AUTH_CLAIM } from './openai-oauth'

export const PLACEHOLDER_REFRESH = 'teamax-no-refresh'
export const accountAlias = (credentialId: string) => 'teamax-' + crypto.createHash('sha256').update(credentialId).digest('hex').slice(0, 12)

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function dummyAuthJson(c: { credentialId: string; kind: 'chatgpt' | 'openai-api-key'; planType: string | null; fedramp: boolean }, token: string, now = Date.now()): string {
  if (c.kind === 'openai-api-key') return JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: token })
  const alias = accountAlias(c.credentialId)
  const iat = Math.floor(now / 1000)
  const payload = {
    email: 'codex@teamax.invalid', iat, exp: iat + 4 * 3600,
    [AUTH_CLAIM]: { chatgpt_plan_type: c.planType ?? 'plus', chatgpt_user_id: 'teamax', chatgpt_account_id: alias, chatgpt_account_is_fedramp: c.fedramp },
  }
  return JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u(payload)}.c2ln`, access_token: token, refresh_token: PLACEHOLDER_REFRESH, account_id: alias },
    last_refresh: new Date(now).toISOString(),
  })
}
