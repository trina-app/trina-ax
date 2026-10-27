// List prices for the cost estimate of API-key connections (docs/DECISIONS.md "AI 연결" D16, "가격표"). USD per
// million tokens. Subscriptions (anthropic-oauth, chatgpt) have no price per request: their cost is 0, tokens still
// count. A model missing here is priced at the most expensive row of its family, so a budget never fills late.
// Update every release: open the two official price pages, match the tables, change PRICES_AS_OF
// (tests/unit/a-prices.test.ts warns when it is older than 90 days).
//   https://platform.claude.com/docs/en/about-claude/pricing      https://developers.openai.com/api/docs/pricing
import type { CredentialKind } from '@mycel/shared/api'

export const PRICES_AS_OF = '2026-10-22'
/** web search: USD per 1,000 searches (both providers) */
export const WEB_SEARCH_PER_1K = 10

/** in, cache write 5 min, cache write 1 h, cache read, out */
interface ClaudePrice { in: number; cw5: number; cw1h: number; cr: number; out: number }
const cp = (i: number, cw5: number, cw1h: number, cr: number, out: number): ClaudePrice => ({ in: i, cw5, cw1h, cr, out })
export const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  'claude-fable-5-1': cp(10, 12.5, 20, 0.25, 50), 'claude-mythos-5-1': cp(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': cp(10, 12.5, 20, 1, 50), 'claude-mythos-5': cp(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': cp(4, 5, 8, 0.2, 20),
  'claude-opus-5': cp(5, 6.25, 10, 0.5, 25), 'claude-opus-4-8': cp(5, 6.25, 10, 0.5, 25), 'claude-opus-4-7': cp(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': cp(5, 6.25, 10, 0.5, 25), 'claude-opus-4-5': cp(5, 6.25, 10, 0.5, 25),
  'claude-sonnet-5-5': cp(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': cp(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': cp(3, 3.75, 6, 0.3, 15), 'claude-sonnet-4-5': cp(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': cp(0.1, 0.125, 0.2, 0.01, 0.5),
  'claude-haiku-4-5': cp(1, 1.25, 2, 0.1, 5),
}
/** Haiku 5.5 above 100,000 input tokens per request (input + cache writes + cache reads) */
const HAIKU_55_LONG = cp(0.5, 0.625, 1, 0.05, 2.5)
const HAIKU_55_LIMIT = 100_000
export const CLAUDE_MAX = cp(10, 12.5, 20, 1, 50)

/** in, cached in, out, long (> 272k input: in x2, out x1.5) */
interface OpenAiPrice { in: number; cached: number; out: number; long: boolean }
const op = (i: number, cached: number, out: number, long = false): OpenAiPrice => ({ in: i, cached, out, long })
export const OPENAI_PRICES: Record<string, OpenAiPrice> = {
  'gpt-6-astra': op(10, 1, 50, true), 'gpt-6.1-sol': op(2, 0.1, 10, true), 'gpt-6-sol': op(2, 0.2, 10, true), 'gpt-6-luna': op(0.1, 0.01, 0.5, true),
  'gpt-5.6-sol': op(4, 0.4, 20, true), 'gpt-5.6-terra': op(2, 0.2, 12, true), 'gpt-5.6-luna': op(0.2, 0.02, 1.2, true),
  'gpt-5.5': op(5, 0.5, 30, true), 'gpt-5.4': op(2.5, 0.25, 15, true),
  'gpt-5.4-mini': op(0.75, 0.075, 4.5), 'gpt-5.4-nano': op(0.2, 0.02, 1.25),
  'gpt-5.3-codex': op(1.75, 0.175, 14), 'gpt-5.2': op(1.75, 0.175, 14),
  'gpt-5.1': op(1.25, 0.125, 10), 'gpt-5': op(1.25, 0.125, 10),
  'gpt-5-mini': op(0.25, 0.025, 2), 'gpt-5-nano': op(0.05, 0.005, 0.4),
}
export const OPENAI_MAX = op(10, 1, 50, true)
const OPENAI_LONG_LIMIT = 272_000

const unknownSeen = new Set<string>()
/** the model of a usage was not in the table (audited once per model and server start: credential.unknown_price) */
export let onUnknownPrice: ((model: string) => void) | null = null
export function setUnknownPriceHook(fn: ((model: string) => void) | null) { onUnknownPrice = fn }
function unknown(model: string) {
  if (unknownSeen.has(model)) return
  unknownSeen.add(model)
  try { onUnknownPrice?.(model) } catch {}
}

/** `claude-x-y` or `claude-x-y-YYYYMMDD` -> the table row */
export function claudePrice(model: string): ClaudePrice | null {
  const base = model.replace(/-\d{8}$/, '')
  return CLAUDE_PRICES[base] ?? null
}
/** `gpt-x` or `gpt-x-YYYY-MM-DD` -> the table row */
export function openaiPrice(model: string): OpenAiPrice | null {
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  return OPENAI_PRICES[base] ?? null
}

export interface ClaudeUsage {
  input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  server_tool_use?: { web_search_requests?: number }
}
export interface OpenAiUsage {
  input_tokens?: number; output_tokens?: number
  input_tokens_details?: Record<string, number | undefined> & { cached_tokens?: number }
  /** counted by the proxy from the response's output items */
  web_search_calls?: number
}

export function claudeCost(model: string, u: ClaudeUsage): number {
  const n = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)
  const cw1h = n(u.cache_creation?.ephemeral_1h_input_tokens)
  const split = u.cache_creation && (u.cache_creation.ephemeral_5m_input_tokens !== undefined || u.cache_creation.ephemeral_1h_input_tokens !== undefined)
  const cw5 = split ? n(u.cache_creation?.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens)
  const cr = n(u.cache_read_input_tokens), i = n(u.input_tokens), o = n(u.output_tokens)
  let p = claudePrice(model)
  if (p === CLAUDE_PRICES['claude-haiku-5-5'] && i + cw5 + cw1h + cr > HAIKU_55_LIMIT) p = HAIKU_55_LONG
  if (!p) { unknown(model); p = CLAUDE_MAX }
  return (i * p.in + cw5 * p.cw5 + cw1h * p.cw1h + cr * p.cr + o * p.out) / 1e6 + n(u.server_tool_use?.web_search_requests) * WEB_SEARCH_PER_1K / 1000
}

export function openaiCost(model: string, u: OpenAiUsage): number {
  const n = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)
  let p = openaiPrice(model)
  if (!p) { unknown(model); p = OPENAI_MAX }
  const input = n(u.input_tokens)
  const cached = Math.min(input, n(u.input_tokens_details?.cached_tokens))
  // a cache write count, when the usage names one, is priced as written input (no separate column in the usage yet)
  const writes = Object.entries(u.input_tokens_details ?? {}).filter(([k]) => /cache_(write|creation)/.test(k)).reduce((s, [, v]) => s + n(v), 0)
  const long = p.long && input > OPENAI_LONG_LIMIT
  const uncached = Math.max(0, input - cached)
  return (uncached * p.in * (long ? 2 : 1) + cached * p.cached * (long ? 2 : 1) + writes * p.in * 0.25 + n(u.output_tokens) * p.out * (long ? 1.5 : 1)) / 1e6
    + n(u.web_search_calls) * WEB_SEARCH_PER_1K / 1000
}

/** Cost of one request of a connection: list price for API keys, 0 for subscriptions. */
export function costOf(kind: CredentialKind, model: string, usage: ClaudeUsage | OpenAiUsage): number {
  if (kind === 'anthropic-api-key') return claudeCost(model, usage as ClaudeUsage)
  if (kind === 'openai-api-key') return openaiCost(model, usage as OpenAiUsage)
  return 0
}
