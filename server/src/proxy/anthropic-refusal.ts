// What an error answer of Anthropic says about the AI connection that sent the request (QA TC-4835, docs/decisions/
// 20261118-ai-account-failover.md). 401 (refused) and a long 429 (limit) are handled in model-proxy.ts as before; this
// reads the other answers on POST /v1/messages only (never count_tokens: validate.ts treats its OAuth 403 as unclear).
// Only an answer that is really Anthropic's counts: its JSON error shape ({"type":"error","error":{"type":…}}) and a
// request-id header, from api.anthropic.com itself (or a loopback test upstream). An edge page, a company proxy, a
// gateway or a custom upstream never marks an account.
//   403 permission_error / authentication_error with a known account-level message (organization or account
//       disabled, no access to Claude Code on this plan, OAuth access revoked or not allowed)   -> marked refused
//   402 / 400 billing_error, or the exact "credit balance is too low"   -> a subscription: marked refused (plan_ended);
//                                                                          an API key: held out as out of credit
//   any other 403 from Anthropic   -> this account is skipped for the rest of the turn, nothing is marked
//   everything else (other 400s, 404, 5xx, a network failure)   -> passed on, nothing changes, no switch
import type { CredentialKind } from '@mycel/shared/api'
import { ANTHROPIC_API } from '../app-config'

export type AccountRefusal =
  /** marked refused with this status code (store.ts markInvalid): no wait brings it back, an admin reconnects */
  | { action: 'invalid'; code: 'plan_ended' | 'upstream_403' }
  /** an API key out of credit: held out (store.ts NO_CREDIT) until someone adds credit or the hold ends */
  | { action: 'no_credit' }
  /** refused for a reason that may not be the account's (a region, an IP): skip it in this turn only */
  | { action: 'skip' }

/** Anthropic's own wording for an account that may not use the API (permission_error / authentication_error) */
const ACCOUNT_LEVEL = [
  /\b(organization|account) (has been |is )?(disabled|suspended|deactivated)\b/i,
  // the account, not a model ("does not have access to Claude Opus 5" is a model-level 403)
  /\bdoes not have access to claude( code)?(\.|$)/i,
  /\bclaude( code)? is not (included|available) (in|on|with) your (plan|subscription)\b/i,
  /\boauth (authentication|access) is (currently )?not allowed\b/i,
  /\boauth token has been revoked\b/i,
]
const CREDIT_TOO_LOW = /credit balance is too low/i

/** Does an answer from this upstream speak for the account? Anthropic itself, or a loopback test upstream (the config
 * allows http:// only there), never a gateway or another https:// upstream (a company proxy may answer 403 itself). */
export function upstreamSpeaksForAccount(upstream: string, gateway: boolean): boolean {
  if (gateway) return false
  const u = upstream.replace(/\/+$/, '')
  if (u === ANTHROPIC_API) return true
  try { const h = new URL(u); return h.protocol === 'http:' && (h.hostname === '127.0.0.1' || h.hostname === 'localhost') } catch { return false }
}

/** null = not the account's fault (pass it on, change nothing). `requestId`: the answer's request-id header. */
export function accountRefusal(o: { path: string; status: number; body: string; requestId: string | null; kind: CredentialKind }): AccountRefusal | null {
  if (o.path !== '/v1/messages' || !o.requestId) return null
  if (o.status !== 400 && o.status !== 402 && o.status !== 403) return null
  let type = '', message = ''
  try {
    const j = JSON.parse(o.body) as { type?: unknown; error?: { type?: unknown; message?: unknown } }
    if (j?.type !== 'error' || !j.error || typeof j.error.type !== 'string') return null
    type = j.error.type; message = typeof j.error.message === 'string' ? j.error.message : ''
  } catch { return null }
  if (o.status === 403) {
    if ((type === 'permission_error' || type === 'authentication_error') && ACCOUNT_LEVEL.some((re) => re.test(message))) {
      return { action: 'invalid', code: o.kind === 'anthropic-oauth' ? 'plan_ended' : 'upstream_403' }
    }
    return { action: 'skip' }
  }
  if (type === 'billing_error' || CREDIT_TOO_LOW.test(message)) return o.kind === 'anthropic-oauth' ? { action: 'invalid', code: 'plan_ended' } : { action: 'no_credit' }
  return null
}
