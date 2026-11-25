// A refusal is confirmed before an AI account is marked, and refused Claude subscriptions are checked again by
// themselves (docs/decisions/20261125-ai-account-refusal-recheck.md). Owner: A.
//   checkOnce       the free check of one account (validate.ts verifySecret: count_tokens for a Claude subscription,
//                   GET /models for an API key), one at a time per account: a refusal seen in use, "Check again" and
//                   the background re-check share it
//   confirmRefusal  a 401 (or an account-level 403) on a model request: one free check first. It passes -> nothing is
//                   marked (the proxy has the engine retry); a refusal of a request sent after that pass, within
//                   PASSED_HOLD_MS, is marked without another check (a subscription that ended may still pass
//                   count_tokens); the check refuses -> marked with the check's own code and answer; unclear -> the
//                   answer seen stands, marked as before
//   recheckRefused  every RECHECK_EVERY_MS: refused Claude subscriptions whose refusal can pass, back to ok on a 200
// ChatGPT is not handled here: its refresh and one retry are its confirming check (chatgpt-tokens.ts).
import type { CredentialKind } from '@mycel/shared/api'
import { anthropicGateway, isFreeRoam } from '../app-config'
import { audit } from '../admin/audit'
import { ctAll } from './i18n'
import {
  connectionsChanged, getRow, mainSecret, markInvalid, markRecovered, metaOf, noteRecheck, notifyAboutConnection, ORG_OAUTH_BLOCKED, secretOf, unusable,
  type CredCtx, type CredRow, type ProviderAnswer,
} from './store'
import { verifySecret, type CheckResult } from './validate'

type ApiKind = Exclude<CredentialKind, 'chatgpt'>
/** after a check passed, a refusal of a request sent later than that, within this time, is marked without a new check */
export const PASSED_HOLD_MS = 10 * 60_000
/** the background re-check: about every 6 hours, each round moved by up to RECHECK_JITTER_MS */
export const RECHECK_EVERY_MS = 6 * 3600_000
export const RECHECK_JITTER_MS = 30 * 60_000
/** at most this many accounts per round, one after another */
export const RECHECK_MAX = 10
/** an account checked less than this long ago is left for the next round (a restart does not check again) */
export const RECHECK_MIN_GAP_MS = 5 * 3600_000
const DAY_MS = 24 * 3600_000
/** how long after it was marked a refusal is still checked again: a blocked organization can pass after days
 * (team.trina came back after 5), a revoked token does not */
const RECHECK_FOR_MS: Record<string, number> = { [ORG_OAUTH_BLOCKED]: 30 * DAY_MS, upstream_401: 7 * DAY_MS }
/** marked before this version, with no saved answer: checked once (the org-not-allowed 403 was stored as plan_ended) */
const LEGACY_ONCE = new Set(['plan_ended', 'upstream_403'])

interface State { inflight: Map<string, Promise<CheckResult>>; passedAt: Map<string, number> }
function state(cc: CredCtx): State {
  return (cc.extra.confirm ??= { inflight: new Map(), passedAt: new Map() }) as State
}

/** The free check of one account (never ChatGPT: unverified). Requests of the same moment share one check. */
export function checkOnce(cc: CredCtx, row: CredRow): Promise<CheckResult> {
  if (row.kind === 'chatgpt') return Promise.resolve({ result: 'unverified', upstreamStatus: null })
  const st = state(cc)
  const running = st.inflight.get(row.id)
  if (running) return running
  const s = secretOf(cc, row as CredRow & { kind: ApiKind })
  if (!s) return Promise.resolve({ result: 'unverified', upstreamStatus: null })
  const p = verifySecret(cc, row.kind as ApiKind, mainSecret(row.kind, s)).finally(() => st.inflight.delete(row.id))
  st.inflight.set(row.id, p)
  return p
}

/** What a model request saw: its status, the code it would mark the account with, the provider's answer (cleaned). */
export interface SeenRefusal { status: number; code: string; error: ProviderAnswer | null }

/**
 * A 401 (or an account-level 403) on a model request of this account, sent at `sentAt` (ms): 'passed' (nothing marked;
 * the account answered the free check, or this request belongs to a burst whose check passed) or 'marked'.
 */
export async function confirmRefusal(cc: CredCtx, id: string, sentAt: number, seen: SeenRefusal): Promise<'passed' | 'marked'> {
  const row = getRow(cc.db, id)
  if (!row) return 'marked'
  const st = state(cc)
  const now = cc.now()
  for (const [k, at] of st.passedAt) if (now - at > PASSED_HOLD_MS) st.passedAt.delete(k)
  const passed = st.passedAt.get(id)
  // sent before the passed check finished: the same burst
  if (passed !== undefined && sentAt <= passed) return 'passed'
  const mark = (code: string, status: number | null, error: ProviderAnswer | null | undefined) => {
    st.passedAt.delete(id)
    markInvalid(cc, id, code, status, { error })
    return 'marked' as const
  }
  // refused again after a check that passed: the check does not tell (an ended plan may pass count_tokens)
  if (passed !== undefined) return mark(seen.code, seen.status, seen.error)
  // already marked (another request of the same burst got here first): nothing to check
  if (row.status === 'invalid') return 'marked'
  const v = await checkOnce(cc, row)
  if (v.result === 'ok') {
    st.passedAt.set(id, Math.max(st.passedAt.get(id) ?? 0, cc.now()))
    cc.log.warn('model proxy: the provider refused an AI connection, but a free check of it passed; not marked', { credential: id, status: seen.status })
    return 'passed'
  }
  const now2 = getRow(cc.db, id)
  if (now2?.status === 'invalid') return 'marked'
  if ((v.result === 'refused' || v.result === 'blocked') && v.code) return mark(v.code, v.upstreamStatus, v.error)
  return mark(seen.code, seen.status, seen.error)
}

/** Is this refused row one the background re-check asks about now? */
export function recheckDue(cc: CredCtx, r: CredRow, now: number): boolean {
  if (r.kind !== 'anthropic-oauth' || r.status !== 'invalid' || r.disabled) return false
  // only a row whose one reason not to be used is the refusal (not switched off, kind allowed, sharing on)
  if (unusable(cc.db, r, new Date(now), cc.allowedKinds)?.why !== 'invalid') return false
  const ref = metaOf(r).refusal
  if (ref?.checkedAt && now - Date.parse(ref.checkedAt) < RECHECK_MIN_GAP_MS) return false
  const code = r.status_code ?? ''
  const hasAnswer = !!(ref && (ref.type || ref.message))
  if (LEGACY_ONCE.has(code)) return !hasAnswer
  const forMs = RECHECK_FOR_MS[code]
  if (forMs === undefined) return false
  const since = Date.parse(ref?.at ?? r.updated_at)
  return Number.isFinite(since) && now - since <= forMs
}

/** One round of the background re-check. Returns how many came back. `gapMs`: a pause between two checks. */
export async function recheckRefused(cc: CredCtx, o: { gapMs?: number } = {}): Promise<{ checked: number; recovered: number }> {
  // a free-roam demo's stand-in is never checked; a Claude token is never sent to a gateway
  if (isFreeRoam(cc.config) || anthropicGateway(cc.config)) return { checked: 0, recovered: 0 }
  const ids = (cc.db.query("SELECT id FROM engine_credentials WHERE kind = 'anthropic-oauth' AND status = 'invalid' AND disabled = 0 ORDER BY updated_at").all() as { id: string }[]).map((x) => x.id)
  let checked = 0, recovered = 0
  for (const id of ids) {
    if (checked >= RECHECK_MAX) break
    const r = getRow(cc.db, id)
    if (!r || !recheckDue(cc, r, cc.now())) continue
    if (checked > 0 && o.gapMs) await new Promise((res) => setTimeout(res, o.gapMs))
    checked++
    const v = await checkOnce(cc, r)
    if (v.result === 'ok') {
      if (!markRecovered(cc, id, r.updated_at)) continue
      recovered++
      audit(cc.db, { actor: null, action: 'credential.recovered', target: id, detail: { kind: r.kind, code: r.status_code, by: 'recheck' } })
      cc.log.info('AI connections: a refused account was accepted again', { credential: id, code: r.status_code })
      notifyAboutConnection(cc, r, { level: 'info', code: 'credential_recovered', message: ctAll('nRecovered', { label: r.label }), link: '/admin/credentials' }, ctAll('nRecovered', { label: r.label }), DAY_MS)
    } else if ((v.result === 'refused' || v.result === 'blocked') && v.code) {
      noteRecheck(cc, r, { code: v.code, upstreamStatus: v.upstreamStatus, error: v.error })
    } else {
      noteRecheck(cc, r, {})
    }
  }
  if (recovered) connectionsChanged(cc)
  return { checked, recovered }
}
