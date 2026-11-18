// The table of Anthropic error answers and what they mean for the AI connection (server/src/proxy/anthropic-refusal.ts,
// QA TC-4835): rejected / auth and limit stay in model-proxy.ts (401, long 429); subscription ended, out of credit,
// network or provider errors and unknown request errors are read here.
import { describe, expect, test } from 'bun:test'
import { accountRefusal } from '../../server/src/proxy/anthropic-refusal'

const body = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message } })

describe('accountRefusal', () => {
  test('subscription ended: a 403 of a Claude subscription account is plan_ended', () => {
    expect(accountRefusal(403, body('permission_error', 'OAuth authentication is currently not allowed for this organization.'), 'anthropic-oauth')).toEqual({ action: 'invalid', code: 'plan_ended' })
    expect(accountRefusal(403, 'Forbidden', 'anthropic-oauth')).toEqual({ action: 'invalid', code: 'plan_ended' })
  })
  test('subscription ended: a billing 400 of a Claude subscription account is plan_ended', () => {
    expect(accountRefusal(400, body('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), 'anthropic-oauth')).toEqual({ action: 'invalid', code: 'plan_ended' })
    expect(accountRefusal(400, body('billing_error', 'x'), 'anthropic-oauth')).toEqual({ action: 'invalid', code: 'plan_ended' })
  })
  test('an API key: 403 refused, out of credit kept out like a credit limit', () => {
    expect(accountRefusal(403, body('permission_error', 'Your API key does not have permission to use the specified resource.'), 'anthropic-api-key')).toEqual({ action: 'invalid', code: 'upstream_403' })
    expect(accountRefusal(400, body('invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), 'anthropic-api-key')).toEqual({ action: 'credit', code: 'credit_balance_exhausted' })
  })
  test('rejected / auth (401) and limit (429) are not read here (model-proxy.ts handles them)', () => {
    expect(accountRefusal(401, body('authentication_error', 'invalid x-api-key'), 'anthropic-oauth')).toBeNull()
    expect(accountRefusal(429, body('rate_limit_error', 'limit'), 'anthropic-oauth')).toBeNull()
  })
  test('network or provider errors say nothing about the account', () => {
    for (const s of [500, 502, 503, 529]) expect(accountRefusal(s, body('api_error', 'Internal server error'), 'anthropic-oauth')).toBeNull()
  })
  test('unknown request errors say nothing about the account', () => {
    expect(accountRefusal(400, body('invalid_request_error', 'messages: at least one message is required'), 'anthropic-oauth')).toBeNull()
    expect(accountRefusal(400, body('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'), 'anthropic-api-key')).toBeNull()
    expect(accountRefusal(404, body('not_found_error', 'model: x'), 'anthropic-oauth')).toBeNull()
    expect(accountRefusal(400, 'not json', 'anthropic-oauth')).toBeNull()
  })
})
