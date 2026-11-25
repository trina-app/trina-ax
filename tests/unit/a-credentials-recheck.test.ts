// A refused AI account is confirmed before it is marked, and refused Claude subscriptions are checked again by
// themselves (server/src/credentials/confirm.ts, docs/decisions/20261125-ai-account-refusal-recheck.md): one free check
// per account at a time, a pass leaves it unmarked, a refusal after a pass marks it; the background round brings back
// an account whose check passes (only when the row did not change meanwhile), keeps the provider's newer answer, skips
// what it should (switched off, sharing off, checked < 5 h ago, a revoked token after 7 days, an ended plan after its
// one legacy check), and asks at most RECHECK_MAX accounts per round. No model tokens: only count_tokens / GET /models.
import { beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { checkOnce, confirmRefusal, PASSED_HOLD_MS, RECHECK_MAX, recheckDue, recheckRefused } from '../../server/src/credentials/confirm'
import { recheckDelay } from '../../server/src/credentials/maintenance'
import { createBroker } from '../../server/src/credentials/broker'
import { getRow, markInvalid, metaOf, toCredential } from '../../server/src/credentials/store'

const env = makeEnv('a-cred-recheck')
const up = 'http://127.0.0.1:9'
type Answer = 'ok' | '401' | '403org' | '403region' | '503'
let answers: Record<string, Answer> = {}
const calls: { path: string; token: string }[] = []
let gate: Promise<void> | null = null
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input))
  const hdr = new Headers(init?.headers)
  const token = (hdr.get('authorization') ?? '').replace(/^Bearer /, '') || (hdr.get('x-api-key') ?? '')
  calls.push({ path: u.pathname, token })
  if (gate) await gate
  const a = answers[token] ?? 'ok'
  const err = (status: number, type: string, message: string) => Response.json({ type: 'error', error: { type, message } }, { status })
  if (a === '401') return err(401, 'authentication_error', 'OAuth token has been revoked.')
  if (a === '403org') return err(403, 'permission_error', 'OAuth authentication is currently not allowed for this organization.')
  if (a === '403region') return err(403, 'permission_error', 'Request not allowed')
  if (a === '503') return err(503, 'api_error', 'Overloaded')
  return Response.json({ input_tokens: 3 })
}) as typeof fetch
let clock = Date.parse('2026-11-25T03:00:00Z')
const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets-recheck'), { upstreams: { anthropic: up, openai: up + '/v1' }, fetch: fakeFetch, now: () => clock })
setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true)
const TOK = (n: number) => `sk-ant-oat01-RECHECK${n}` + 'x'.repeat(40)
const OKEY = 'sk-proj-' + 'R'.repeat(40)
const HOUR = 3600_000
const auditCount = (action: string, id: string) => (env.db.query('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND target = ?').get(action, id) as { n: number }).n

let n = 0
/** a refused Claude subscription: marked with `code`, `ageMs` ago, with or without a saved answer (legacy) */
function refused(code: string, o: { ageMs?: number; legacy?: boolean; checkedAgoMs?: number; disabled?: boolean } = {}) {
  const tok = TOK(++n)
  const id = addCred(t.cc, 'anthropic-oauth', tok, { label: `R${n}`, disabled: o.disabled })
  const at = new Date(clock - (o.ageMs ?? HOUR)).toISOString()
  if (o.legacy) env.db.query("UPDATE engine_credentials SET status = 'invalid', status_code = ?, updated_at = ? WHERE id = ?").run(code, at, id)
  else {
    const refusal = { status: 403, type: 'permission_error', message: 'x', code, at, ...(o.checkedAgoMs !== undefined ? { checkedAt: new Date(clock - o.checkedAgoMs).toISOString() } : {}) }
    env.db.query("UPDATE engine_credentials SET status = 'invalid', status_code = ?, meta = json_set(meta, '$.refusal', json(?)), updated_at = ? WHERE id = ?").run(code, JSON.stringify(refusal), at, id)
  }
  return { id, tok }
}

beforeEach(() => {
  answers = {}; calls.length = 0; gate = null; t.notices.length = 0
  ;(t.cc.extra.confirm as { passedAt?: Map<string, number> } | undefined)?.passedAt?.clear()
  // each test starts with no refused account left over from another
  env.db.query("UPDATE engine_credentials SET disabled = 1 WHERE status = 'invalid'").run()
})

describe('confirm before marking (a refusal seen in use)', () => {
  test('a 401 whose free check passes: nothing marked; the check went to count_tokens only', async () => {
    const tok = TOK(++n); const id = addCred(t.cc, 'anthropic-oauth', tok)
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('passed')
    expect(calls).toEqual([{ path: '/v1/messages/count_tokens', token: tok }])
    expect(getRow(env.db, id)!.status).toBe('ok')
  })
  test('the check refuses: marked with the check\'s own code and answer (org not allowed: org_oauth_blocked)', async () => {
    const tok = TOK(++n); const id = addCred(t.cc, 'anthropic-oauth', tok)
    answers[tok] = '403org'
    expect(await confirmRefusal(t.cc, id, clock, { status: 403, code: 'plan_ended', error: null })).toBe('marked')
    const r = getRow(env.db, id)!
    expect([r.status, r.status_code]).toEqual(['invalid', 'org_oauth_blocked'])
    expect(metaOf(r).refusal).toMatchObject({ status: 403, type: 'permission_error', message: 'OAuth authentication is currently not allowed for this organization.', code: 'org_oauth_blocked' })
    expect(toCredential(t.cc, r, 'en')).toMatchObject({ state: 'invalid', providerError: { status: 403, type: 'permission_error' } })
    expect(toCredential(t.cc, r, 'en').detail).toMatch(/not allowing access right now/)
    expect(t.notices.map((x) => x.n.code)).toContain('credential_rejected')
  })
  test('the check gives no clear answer (503): the answer seen stands and is marked as before', async () => {
    const tok = TOK(++n); const id = addCred(t.cc, 'anthropic-oauth', tok)
    answers[tok] = '503'
    const seen = { status: 401, code: 'upstream_401', error: { status: 401, type: 'authentication_error', message: 'invalid token' } }
    expect(await confirmRefusal(t.cc, id, clock, seen)).toBe('marked')
    const r = getRow(env.db, id)!
    expect(r.status_code).toBe('upstream_401')
    expect(metaOf(r).refusal).toMatchObject({ status: 401, message: 'invalid token' })
  })
  test('many refusals at once: one check (single-flight); a request sent before the pass is the same burst; one sent after it marks', async () => {
    const tok = TOK(++n); const id = addCred(t.cc, 'anthropic-oauth', tok)
    let open!: () => void
    gate = new Promise((r) => { open = r })
    const sentAt = clock
    const all = Promise.all([1, 2, 3].map(() => confirmRefusal(t.cc, id, sentAt, { status: 401, code: 'upstream_401', error: null })))
    await Bun.sleep(5)
    open(); gate = null
    expect(await all).toEqual(['passed', 'passed', 'passed'])
    expect(calls.length).toBe(1)
    // sent before the check passed: still the same burst, no new check
    expect(await confirmRefusal(t.cc, id, sentAt, { status: 401, code: 'upstream_401', error: null })).toBe('passed')
    expect(calls.length).toBe(1)
    // sent after it, within the hold: marked without another check
    clock += 60_000
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('marked')
    expect(calls.length).toBe(1)
    expect(getRow(env.db, id)!.status_code).toBe('upstream_401')
  })
  test('marked although its check passed: the background re-check leaves it (it would only pass again)', async () => {
    const tok = TOK(++n); const id = addCred(t.cc, 'anthropic-oauth', tok)
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('passed')
    clock += 1000
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('marked')
    expect(metaOf(getRow(env.db, id)!).refusal?.checkPasses).toBe(true)
    clock += 6 * HOUR
    expect(recheckDue(t.cc, getRow(env.db, id)!, clock)).toBe(false)
  })
  test('an answer that works again ends the hold: a later 401 is checked afresh, not marked', async () => {
    const tok = TOK(++n); const id = addCred(t.cc, 'anthropic-oauth', tok)
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('passed')
    createBroker(t.cc).succeeded(id)
    clock += 1000
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('passed')
    expect(calls.length).toBe(2)
    expect(getRow(env.db, id)!.status).toBe('ok')
  })
  test('after the hold a refusal is checked again', async () => {
    const tok = TOK(++n); const id = addCred(t.cc, 'anthropic-oauth', tok)
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('passed')
    clock += PASSED_HOLD_MS + 1000
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('passed')
    expect(calls.length).toBe(2)
  })
  test('an OpenAI API key: confirmed on GET /models, the same rules', async () => {
    const id = addCred(t.cc, 'openai-api-key', OKEY)
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('passed')
    expect(calls).toEqual([{ path: '/v1/models', token: OKEY }])
    answers[OKEY] = '401'; clock += PASSED_HOLD_MS + 1000
    expect(await confirmRefusal(t.cc, id, clock, { status: 401, code: 'upstream_401', error: null })).toBe('marked')
    expect(getRow(env.db, id)!.status_code).toBe('upstream_401')
  })
  test('ChatGPT is never checked here (its refresh is its check)', async () => {
    const r = { ...getRow(env.db, addCred(t.cc, 'openai-api-key', 'sk-proj-' + 'C'.repeat(40)))!, kind: 'chatgpt' as const }
    expect(await checkOnce(t.cc, r)).toEqual({ result: 'unverified', upstreamStatus: null })
  })
})

describe('the background re-check of refused Claude subscriptions', () => {
  test('org not allowed, then allowed again: back to ok, audited, the owner and admins told once a day, the saved answer gone', async () => {
    const a = refused('org_oauth_blocked')
    expect(await recheckRefused(t.cc)).toEqual({ checked: 1, recovered: 1 })
    const r = getRow(env.db, a.id)!
    expect([r.status, r.status_code]).toEqual(['ok', null])
    expect(metaOf(r).refusal).toBeUndefined()
    expect(r.checked_at).toBe(new Date(clock).toISOString())
    expect(auditCount('credential.recovered', a.id)).toBe(1)
    expect(t.notices.map((x) => x.n.code)).toEqual(['credential_recovered'])
    expect(calls.every((c) => c.path === '/v1/messages/count_tokens')).toBe(true)
  })
  test('still refused: the newer answer and when it was checked are kept, no new notice; unclear: only when', async () => {
    const a = refused('org_oauth_blocked'); answers[a.tok] = '403org'
    const b = refused('upstream_401'); answers[b.tok] = '503'
    expect(await recheckRefused(t.cc)).toEqual({ checked: 2, recovered: 0 })
    const ra = getRow(env.db, a.id)!
    expect(ra.status_code).toBe('org_oauth_blocked')
    expect(metaOf(ra).refusal).toMatchObject({ message: 'OAuth authentication is currently not allowed for this organization.', checkedAt: new Date(clock).toISOString() })
    const rb = getRow(env.db, b.id)!
    expect([rb.status, rb.status_code]).toEqual(['invalid', 'upstream_401'])
    expect(metaOf(rb).refusal).toMatchObject({ message: 'x', checkedAt: new Date(clock).toISOString() })
    expect(t.notices).toEqual([])
    // checked less than 5 hours ago: the next round (a restart) leaves them
    calls.length = 0
    clock += 4 * HOUR
    expect(await recheckRefused(t.cc)).toEqual({ checked: 0, recovered: 0 })
    clock += 2 * HOUR
    expect((await recheckRefused(t.cc)).checked).toBe(2)
  })
  test('a legacy plan_ended (marked before, no saved answer) is checked once and gets its real code; then never again', async () => {
    const a = refused('plan_ended', { legacy: true, ageMs: 5 * 24 * HOUR }); answers[a.tok] = '403org'
    expect((await recheckRefused(t.cc)).checked).toBe(1)
    expect(getRow(env.db, a.id)!.status_code).toBe('org_oauth_blocked')
    // a legacy row whose one check was unclear is not asked again either
    const c = refused('upstream_403', { legacy: true }); answers[c.tok] = '503'
    clock += 6 * HOUR; calls.length = 0
    await recheckRefused(t.cc)
    expect(calls.map((x) => x.token)).toContain(c.tok)
    clock += 6 * HOUR; calls.length = 0
    await recheckRefused(t.cc)
    expect(calls.map((x) => x.token)).not.toContain(c.tok)
    // an ended plan with its answer saved is not checked in the background (count_tokens may pass for it)
    const b = refused('plan_ended')
    clock += 6 * HOUR
    calls.length = 0
    await recheckRefused(t.cc)
    expect(calls.map((c) => c.token)).not.toContain(b.tok)
  })
  test('what is never asked: switched off, sharing off, a revoked token after 7 days, a blocked one after 30 days, a gateway', async () => {
    const off = refused('org_oauth_blocked', { disabled: true })
    const old401 = refused('upstream_401', { ageMs: 8 * 24 * HOUR })
    const old403 = refused('org_oauth_blocked', { ageMs: 31 * 24 * HOUR })
    const fresh401 = refused('upstream_401', { ageMs: 6 * 24 * HOUR })
    setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, false)
    try {
      expect(await recheckRefused(t.cc)).toEqual({ checked: 0, recovered: 0 })
    } finally { setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true) }
    expect(await recheckRefused(t.cc)).toEqual({ checked: 1, recovered: 1 })
    expect(calls.map((c) => c.token)).toEqual([fresh401.tok])
    for (const x of [off, old401, old403]) expect(getRow(env.db, x.id)!.status).toBe('invalid')
    const gw = testCredCtx(env.db, path.join(env.fx.data, 'secrets-recheck'), { upstreams: { anthropic: up }, fetch: fakeFetch, gateway: { label: 'GW', baseUrl: 'https://gw.example', models: ['m'] } as never })
    refused('org_oauth_blocked')
    expect(await recheckRefused(gw.cc)).toEqual({ checked: 0, recovered: 0 })
  })
  test('at most RECHECK_MAX accounts per round', async () => {
    for (let i = 0; i < RECHECK_MAX + 3; i++) refused('org_oauth_blocked')
    expect(await recheckRefused(t.cc)).toEqual({ checked: RECHECK_MAX, recovered: RECHECK_MAX })
    expect((await recheckRefused(t.cc)).checked).toBe(3)
  })
  test('a row that changed while its check ran (a new mark, a new token) is never set back', async () => {
    const a = refused('org_oauth_blocked')
    let open!: () => void
    gate = new Promise((r) => { open = r })
    const round = recheckRefused(t.cc)
    await Bun.sleep(5)
    clock += 1000
    markInvalid(t.cc, a.id, 'upstream_401', 401, { quiet: true })
    open(); gate = null
    expect(await round).toEqual({ checked: 1, recovered: 0 })
    expect(getRow(env.db, a.id)!.status_code).toBe('upstream_401')
    expect(auditCount('credential.recovered', a.id)).toBe(0)
  })
  test('recheckDue and the round\'s wait: about 6 hours, at most 30 minutes either way', () => {
    expect(recheckDelay(0)).toBe(5.5 * HOUR)
    expect(recheckDelay(1)).toBe(6.5 * HOUR)
    expect(recheckDelay(0.5)).toBe(6 * HOUR)
    const a = refused('usage_not_included')
    expect(recheckDue(t.cc, getRow(env.db, a.id)!, clock)).toBe(false)
  })
})
