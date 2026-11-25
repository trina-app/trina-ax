// What an error answer of Anthropic says about the AI connection that sent the request (QA TC-4835, docs/decisions/
// 20261118-ai-account-failover.md). 401 (refused) and a long 429 (limit) are handled in model-proxy.ts as before; this
// reads the other answers on POST /v1/messages only (count_tokens is validate.ts's: the free check, which reads an
// account-level 403 with accountLevel403 / refusalCode below and any other OAuth 403 as unclear).
// Only an answer that is really Anthropic's counts: its JSON error shape ({"type":"error","error":{"type":…}}) and a
// request-id header, from api.anthropic.com itself (or a loopback test upstream). An edge page, a company proxy, a
// gateway or a custom upstream never marks an account, and neither does any answer on a free-roam demo instance, whose
// loopback upstream is demo-gate and whose one connection is a stand-in (proxy/model-proxy.ts `marks`).
//   403 permission_error / authentication_error with a known account-level message (organization or account
//       disabled, no access to Claude Code on this plan, OAuth access revoked or not allowed)   -> refused, confirmed by
//       one free check before it is marked (credentials/confirm.ts); "OAuth authentication is currently not allowed for
//       this organization" has its own code (org_oauth_blocked: it can pass, team.trina came back after 5 days)
//   402 / 400 billing_error, or the exact "credit balance is too low"   -> a subscription: marked refused (plan_ended);
//                                                                          an API key: held out as out of credit
//   any other 403 from Anthropic   -> this account is skipped for the rest of the turn, nothing is marked
//   everything else (other 400s, 404, 5xx, a network failure)   -> passed on, nothing changes, no switch
import type { CredentialKind } from '@mycel/shared/api'
import { ANTHROPIC_API } from '../app-config'

export type AccountRefusal =
  /** marked refused with this status code (store.ts markInvalid): no wait brings it back, an admin reconnects */
  | { action: 'invalid'; code: RefusalCode; error: ProviderError | null }
  /** an API key out of credit: held out (store.ts NO_CREDIT) until someone adds credit or the hold ends */
  | { action: 'no_credit' }
  /** refused for a reason that may not be the account's (a region, an IP): skip it in this turn only */
  | { action: 'skip' }

/** what an account is marked with when Anthropic refuses it (store.ts markInvalid) */
export type RefusalCode = 'plan_ended' | 'upstream_403' | 'org_oauth_blocked'

/** What the provider said, as saved on a refused account (store.ts meta.refusal) and shown in its expanded row: the
 * error type and message only, with anything that looks like a token, an e-mail address or an id taken out. */
export interface ProviderError { status: number; type: string; message: string }

const HIDE = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{6,}/g, // sk-ant-…, sk-proj-…
  /\bBearer\s+\S+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b(req|org|user|acct|msg)_[A-Za-z0-9]{6,}/g,
  /[A-Za-z0-9_\-.~+/=]{32,}/g, // any long token-like run
]
/** a provider's text made safe to keep and show: hidden parts, no control characters, at most `max` characters */
export function cleanProviderText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  for (const re of HIDE) out = out.replace(re, '[hidden]')
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > max ? out.slice(0, max - 1) + '…' : out
}

/** The error of a provider's JSON answer (Anthropic {"type":"error","error":{type,message}}, OpenAI {"error":{type|code,
 * message}}), cleaned; null when the body is not such an answer (an edge page, empty). */
export function providerError(status: number, body: string): ProviderError | null {
  try {
    const j = JSON.parse(body) as { error?: unknown }
    const e = (j && typeof j.error === 'object' && j.error ? j.error : null) as { type?: unknown; code?: unknown; message?: unknown } | null
    if (!e) return null
    const type = typeof e.type === 'string' ? e.type : typeof e.code === 'string' ? e.code : ''
    const message = typeof e.message === 'string' ? e.message : ''
    if (!type && !message) return null
    return { status, type: cleanProviderText(type, 60), message: cleanProviderText(message, 300) }
  } catch { return null }
}

const ORG_OAUTH_BLOCKED = /\boauth (authentication|access) is (currently )?not allowed\b/i
/** Anthropic's own wording for an account that may not use the API (permission_error / authentication_error) */
const ACCOUNT_LEVEL = [
  /\b(organization|account) (has been |is )?(disabled|suspended|deactivated)\b/i,
  // the account, not a model ("does not have access to Claude Opus 5" is a model-level 403)
  /\bdoes not have access to claude( code)?(\.|$)/i,
  /\bclaude( code)? is not (included|available) (in|on|with) your (plan|subscription)\b/i,
  ORG_OAUTH_BLOCKED,
  /\boauth token has been revoked\b/i,
]

/** a 403 with this error type and message is about the account (not a model, a region or a request) */
export function accountLevel403(type: string, message: string): boolean {
  return (type === 'permission_error' || type === 'authentication_error') && ACCOUNT_LEVEL.some((re) => re.test(message))
}
/** the code an account-level 403 marks it with: a subscription whose organization does not allow OAuth now has its own */
export function refusalCode(kind: CredentialKind, message: string): RefusalCode {
  if (kind !== 'anthropic-oauth') return 'upstream_403'
  return ORG_OAUTH_BLOCKED.test(message) ? 'org_oauth_blocked' : 'plan_ended'
}
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
    if (accountLevel403(type, message)) return { action: 'invalid', code: refusalCode(o.kind, message), error: providerError(o.status, o.body) }
    return { action: 'skip' }
  }
  if (type === 'billing_error' || CREDIT_TOO_LOW.test(message)) return o.kind === 'anthropic-oauth' ? { action: 'invalid', code: 'plan_ended', error: providerError(o.status, o.body) } : { action: 'no_credit' }
  return null
}
