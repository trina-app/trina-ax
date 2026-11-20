// The table of Anthropic error answers and what they mean for the AI connection (server/src/proxy/anthropic-refusal.ts,
// QA TC-4835): rejected / auth (401) and limit (429) stay in model-proxy.ts; subscription ended, out of credit, a 403
// that may not be the account's, network or provider errors and unknown request errors are read here.
import { describe, expect, test } from 'bun:test'
import type { CredentialKind } from '@mycel/shared/api'
import { accountRefusal, upstreamSpeaksForAccount } from '../../server/src/proxy/anthropic-refusal'

const body = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message } })
const read = (status: number, b: string, kind: CredentialKind = 'anthropic-oauth', o: { path?: string; requestId?: string | null } = {}) =>
  accountRefusal({ path: o.path ?? '/v1/messages', status, body: b, requestId: o.requestId === undefined ? 'req_011CTest401x' : o.requestId, kind })

describe('accountRefusal: marks', () => {
  test('subscription ended: a known account-level 403 of a Claude subscription account is plan_ended', () => {
    expect(read(403, body('permission_error', 'OAuth authentication is currently not allowed for this organization.'))).toEqual({ action: 'invalid', code: 'plan_ended' })
    expect(read(403, body('permission_error', 'This organization has been disabled.'))).toEqual({ action: 'invalid', code: 'plan_ended' })
    expect(read(403, body('authentication_error', 'OAuth token has been revoked. Please obtain a new token.'))).toEqual({ action: 'invalid', code: 'plan_ended' })
    expect(read(403, body('permission_error', 'Your account does not have access to Claude Code.'))).toEqual({ action: 'invalid', code: 'plan_ended' })
  })
  test('subscription ended: a 402 or 400 billing_error, or the exact credit phrase, of a subscription account is plan_ended', () => {
    expect(read(402, body('billing_error', 'Payment required'))).toEqual({ action: 'invalid', code: 'plan_ended' })
    expect(read(400, body('billing_error', 'x'))).toEqual({ action: 'invalid', code: 'plan_ended' })
    expect(read(400, body('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))).toEqual({ action: 'invalid', code: 'plan_ended' })
  })
  test('an API key: account-level 403 refused (upstream_403), out of credit held as no_credit', () => {
    expect(read(403, body('permission_error', 'This organization has been disabled.'), 'anthropic-api-key')).toEqual({ action: 'invalid', code: 'upstream_403' })
    expect(read(402, body('billing_error', 'Payment required'), 'anthropic-api-key')).toEqual({ action: 'no_credit' })
    expect(read(400, body('invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), 'anthropic-api-key')).toEqual({ action: 'no_credit' })
  })
})

describe('accountRefusal: never marks', () => {
  test('any other 403 from Anthropic (a region, a permission it did not explain): skipped in the turn only', () => {
    expect(read(403, body('permission_error', 'Request not allowed'))).toEqual({ action: 'skip' })
    expect(read(403, body('permission_error', 'This service is not available in your region.'))).toEqual({ action: 'skip' })
    expect(read(403, body('permission_error', 'Your API key does not have permission to use the specified resource.'), 'anthropic-api-key')).toEqual({ action: 'skip' })
    // a model the account may not use is not the account refused
    expect(read(403, body('permission_error', 'Your account does not have access to Claude Opus 5.'))).toEqual({ action: 'skip' })
    expect(read(403, body('permission_error', 'This organization does not have access to claude-opus-5-5'))).toEqual({ action: 'skip' })
  })
  test('an edge or proxy page (HTML, not Anthropic\'s error shape) changes nothing', () => {
    expect(read(403, '<html><head><title>Attention Required! | Cloudflare</title></head></html>')).toBeNull()
    expect(read(403, JSON.stringify({ message: 'Forbidden' }))).toBeNull()
    expect(read(402, 'Payment Required')).toBeNull()
  })
  test('no request-id header: not Anthropic\'s answer, nothing', () => {
    expect(read(403, body('permission_error', 'This organization has been disabled.'), 'anthropic-oauth', { requestId: null })).toBeNull()
    expect(read(402, body('billing_error', 'x'), 'anthropic-oauth', { requestId: null })).toBeNull()
  })
  test('count_tokens: never read (validate.ts treats its OAuth 403 as unclear)', () => {
    expect(read(403, body('permission_error', 'This organization has been disabled.'), 'anthropic-oauth', { path: '/v1/messages/count_tokens' })).toBeNull()
    expect(read(402, body('billing_error', 'x'), 'anthropic-oauth', { path: '/v1/messages/count_tokens' })).toBeNull()
  })
  test('a 400 that mentions a subscription or a plan but is no billing error: nothing', () => {
    expect(read(400, body('invalid_request_error', 'Extended thinking is not included in your subscription for this model.'))).toBeNull()
    expect(read(400, body('invalid_request_error', 'Your plan does not support this model.'))).toBeNull()
  })
  test('rejected / auth (401) and limit (429) are not read here (model-proxy.ts handles them)', () => {
    expect(read(401, body('authentication_error', 'invalid x-api-key'))).toBeNull()
    expect(read(429, body('rate_limit_error', 'limit'))).toBeNull()
  })
  test('network or provider errors say nothing about the account', () => {
    for (const s of [500, 502, 503, 529]) expect(read(s, body('api_error', 'Internal server error'))).toBeNull()
  })
  test('unknown request errors say nothing about the account', () => {
    expect(read(400, body('invalid_request_error', 'messages: at least one message is required'))).toBeNull()
    expect(read(400, body('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'), 'anthropic-api-key')).toBeNull()
    expect(read(404, body('not_found_error', 'model: x'))).toBeNull()
  })
})

describe('upstreamSpeaksForAccount', () => {
  test('Anthropic itself and a loopback test upstream', () => {
    expect(upstreamSpeaksForAccount('https://api.anthropic.com', false)).toBe(true)
    expect(upstreamSpeaksForAccount('https://api.anthropic.com/', false)).toBe(true)
    expect(upstreamSpeaksForAccount('http://127.0.0.1:4100', false)).toBe(true)
  })
  test('never a gateway or another upstream (a company proxy may answer 403 itself)', () => {
    expect(upstreamSpeaksForAccount('https://api.anthropic.com', true)).toBe(false)
    expect(upstreamSpeaksForAccount('https://openrouter.ai/api', true)).toBe(false)
    expect(upstreamSpeaksForAccount('https://llm-proxy.example.com', false)).toBe(false)
    expect(upstreamSpeaksForAccount('https://api.anthropic.com.example.com', false)).toBe(false)
  })
})

describe('classifyError: sign-in errors need the error class or the leading text', () => {
  test('sign-in errors', async () => {
    const { classifyError } = await import('../../server/src/engine/claude-parse')
    for (const m of ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'authentication_failed', 'Failed to authenticate. API Error: 401', 'Not logged in · Please run /login', 'OAuth token has expired.', '401 Unauthorized']) expect(classifyError(m)).toBe('auth')
  })
  test('a 401 inside a request id or a body is not a sign-in error', async () => {
    const { classifyError } = await import('../../server/src/engine/claude-parse')
    expect(classifyError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"},"request_id":"req_011C401abc"}')).toBe('crash')
    expect(classifyError('API Error: 500 {"error":{"type":"api_error"}} request-id: req_401401')).toBe('crash')
  })
  test('no credit left is its own reason, not a crash to try again (AI parity leftover)', async () => {
    const { classifyError } = await import('../../server/src/engine/claude-parse')
    for (const m of ['Credit balance is too low', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}', '{"type":"error","error":{"type":"billing_error","message":"x"}}']) expect(classifyError(m)).toBe('no_credit')
    expect(classifyError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}')).toBe('crash')
  })
  test('an overloaded provider is busy, not a usage limit (QA AP-071)', async () => {
    const { classifyError } = await import('../../server/src/engine/claude-parse')
    for (const m of ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CTest2"}', 'Repeated 529 Overloaded errors', '529 overloaded', 'API Error: 529']) expect(classifyError(m)).toBe('provider_busy')
    // a 529 inside an id or a count is nothing; real limits stay limits
    expect(classifyError('API Error: 500 {"error":{"type":"api_error"}} request-id: req_529529')).toBe('crash')
    expect(classifyError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')).toBe('rate_limit')
    expect(classifyError('Claude AI usage limit reached|1763600000')).toBe('rate_limit')
  })
})
