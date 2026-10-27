// The price table for API-key connections (docs/DECISIONS.md "AI 연결" D16, "가격표"): the models the engines can pick
// are in it, the long-context boundaries, unknown models at the family's most expensive row, subscriptions at 0, and a
// warning (not a failure) when the table is older than 90 days.
import { describe, expect, test } from 'bun:test'
import { claudeCost, claudePrice, CLAUDE_MAX, costOf, openaiCost, openaiPrice, OPENAI_MAX, PRICES_AS_OF } from '../../server/src/credentials/prices'

describe('price table', () => {
  test('the current Claude models and the Codex models the docs name are priced', () => {
    for (const m of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-opus-4-8'])
      expect(claudePrice(m), m).not.toBeNull()
    for (const m of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5-2025-08-07'])
      expect(openaiPrice(m), m).not.toBeNull()
  })
  test('Claude: input, 5-minute and 1-hour cache writes, cache reads, output, web searches', () => {
    // Opus 5.5: 4 / 5 / 8 / 0.20 / 20 per million; $10 per 1,000 searches
    expect(claudeCost('claude-opus-5-5', { input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 }, cache_read_input_tokens: 1e6, output_tokens: 1e6, server_tool_use: { web_search_requests: 3 } }))
      .toBeCloseTo(4 + 5 + 8 + 0.2 + 20 + 0.03, 6)
    // no split given: all cache writes at the 5-minute price
    expect(claudeCost('claude-opus-5-5', { cache_creation_input_tokens: 1e6 })).toBeCloseTo(5, 6)
  })
  test('Haiku 5.5 changes price above 100,000 input tokens per request (input + cache writes + reads)', () => {
    expect(claudeCost('claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 50_000, output_tokens: 1e6 })).toBeCloseTo(0.05 * 0.1 + 0.05 * 0.01 + 0.5, 6)
    expect(claudeCost('claude-haiku-5-5', { input_tokens: 50_001, cache_read_input_tokens: 50_000, output_tokens: 1e6 })).toBeCloseTo(0.050001 * 0.5 + 0.05 * 0.05 + 2.5, 6)
  })
  test('OpenAI: cached input, the 272k long-context rule, web search calls', () => {
    expect(openaiCost('gpt-5.4', { input_tokens: 200_000, input_tokens_details: { cached_tokens: 50_000 }, output_tokens: 1e6, web_search_calls: 2 })).toBeCloseTo(0.15 * 2.5 + 0.05 * 0.25 + 15 + 0.02, 6)
    // above 272k input the whole request is long: input and cache x2, output x1.5
    expect(openaiCost('gpt-5.4', { input_tokens: 1e6, input_tokens_details: { cached_tokens: 2e5 }, output_tokens: 1e6 })).toBeCloseTo(0.8 * 2.5 * 2 + 0.2 * 0.25 * 2 + 15 * 1.5, 6)
    expect(openaiCost('gpt-6.1-sol', { input_tokens: 272_000, output_tokens: 0 })).toBeCloseTo(0.272 * 2, 6)
    expect(openaiCost('gpt-6.1-sol', { input_tokens: 272_001, output_tokens: 1e6 })).toBeCloseTo(0.272001 * 2 * 2 + 10 * 1.5, 6)
    expect(openaiCost('gpt-5.4-mini', { input_tokens: 300_000 })).toBeCloseTo(0.3 * 0.75, 6) // no long rule for this one
  })
  test('unknown models at the family\'s most expensive row; subscriptions cost nothing', () => {
    expect(claudeCost('claude-future-9', { input_tokens: 1e6 })).toBe(CLAUDE_MAX.in)
    expect(openaiCost('gpt-9-ultra', { input_tokens: 100_000 })).toBeCloseTo(OPENAI_MAX.in / 10, 9)
    expect(openaiCost('gpt-9-ultra', { input_tokens: 1e6 })).toBe(OPENAI_MAX.in * 2) // long-context rule of the most expensive row
    expect(costOf('anthropic-oauth', 'claude-opus-5-5', { input_tokens: 1e6 })).toBe(0)
    expect(costOf('chatgpt', 'gpt-5.4', { input_tokens: 1e6 })).toBe(0)
    expect(costOf('anthropic-api-key', 'claude-opus-5-5', { input_tokens: 1e6 })).toBeCloseTo(4, 6)
  })
  test('the table date (a warning when it is older than 90 days, so the table gets updated with each release)', () => {
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const age = (Date.now() - Date.parse(PRICES_AS_OF)) / 86400_000
    if (age > 90) console.warn(`credentials/prices.ts: PRICES_AS_OF ${PRICES_AS_OF} is ${Math.floor(age)} days old; check the price pages and update it`)
    expect(age).toBeGreaterThan(-2)
  })
})
