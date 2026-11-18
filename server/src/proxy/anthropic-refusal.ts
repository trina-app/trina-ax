// What an error answer of Anthropic says about the AI connection that sent the request (QA TC-4835, docs/decisions/
// 20261118-ai-account-failover.md). 401 (refused) and a long 429 (limit) are handled in model-proxy.ts as before;
// this names the other answers that are the account's fault, so the turn moves to the next connection and the
// connection gets a lasting state instead of staying "healthy" while every turn on it fails:
//   403 (any type)                 the account may not use the API now: a Claude subscription that ended or does not
//                                  include Claude Code, an organization switched off, a key without permission
//   400 billing / credit balance   no plan and no credit left: a Claude subscription that ended; an API key out of credit
// Everything else (other 400s, 404, 5xx, a network failure) says nothing certain about the account: passed on as it
// came, the connection keeps its state and the turn does not switch.
import type { CredentialKind } from '@mycel/shared/api'

export type AccountRefusal =
  /** marked refused with this status code (store.ts markInvalid): no wait brings it back */
  | { action: 'invalid'; code: 'plan_ended' | 'upstream_403' }
  /** out of credit (an API key): kept out like a credit limit (store.ts isCreditLimit), someone has to add credit */
  | { action: 'credit'; code: 'credit_balance_exhausted' }

const BILLING = /credit balance|billing|purchase credits|subscription|plan does not|not included in your plan/i

/** null = not the account's fault (pass it on, change nothing). `body`: the upstream's answer text (JSON or not). */
export function accountRefusal(status: number, body: string, kind: CredentialKind): AccountRefusal | null {
  if (status !== 400 && status !== 403) return null
  let type = '', message = ''
  try {
    const j = JSON.parse(body) as { error?: { type?: unknown; message?: unknown } }
    type = String(j?.error?.type ?? ''); message = String(j?.error?.message ?? '')
  } catch { message = body.slice(0, 2000) }
  const billing = type === 'billing_error' || BILLING.test(message)
  if (status === 403) return { action: 'invalid', code: kind === 'anthropic-oauth' ? 'plan_ended' : 'upstream_403' }
  if (!billing) return null
  return kind === 'anthropic-oauth' ? { action: 'invalid', code: 'plan_ended' } : { action: 'credit', code: 'credit_balance_exhausted' }
}
