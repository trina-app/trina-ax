// Is a pasted token / key plausible, and does the provider take it? Without spending tokens (docs/DECISIONS.md
// "AI 연결" 3.8.1/3.8.2): a Claude subscription token is tried on POST /v1/messages/count_tokens (free for API keys;
// whether it answers for an OAuth token is not documented: spike S2), an API key on GET /models. 200 = verified,
// 401 / 403 = refused (not saved), anything else = saved as "checked on the first question" (never a paid call
// instead). Redirects are never followed (security T13). Nothing here logs or returns the secret.
// With an Anthropic-compatible gateway (engine.anthropicGateway) an API key is the gateway's own: any format of the safe
// shape, checked where the gateway can tell (OpenRouter: GET /api/v1/key; others: a model list that needs the key).
import fs from 'node:fs'
import path from 'node:path'
import type { CredentialKind } from '@mycel/shared/api'
import { anthropicGateway, isOpenRouter, REPO_ROOT, type AnthropicGatewayConf } from '../app-config'
import type { CredCtx } from './store'

export const CLAUDE_TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/
export const ANTHROPIC_KEY_RE = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,300}$/
export const OPENAI_KEY_RE = /^sk-[A-Za-z0-9_-]{20,300}$/
/** a gateway's API key (OpenRouter sk-or-v1-…, DeepSeek sk-…, Kimi, GLM id.secret): characters safe in a header */
export const GATEWAY_KEY_RE = /^[A-Za-z0-9._-]{20,300}$/
const CHECK_TIMEOUT_MS = 10_000

/** the Claude Code version the proxy forwards as the client (user-agent / x-app) */
let claudeVersion = '2.1.305'
try { const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'versions.json'), 'utf8'))['claude-code']; if (typeof v === 'string') claudeVersion = v } catch {}
export const CLAUDE_CLIENT_HEADERS = { 'user-agent': `claude-cli/${claudeVersion} (external, cli)`, 'x-app': 'cli' }

/** null = plausible for this kind; else which message to show (never the value). `gateway`: engine.anthropicGateway is
 * on, so an anthropic-api-key is the gateway's key, and never an Anthropic key or token (sk-ant-…: it would go to a
 * third party). */
export function formatProblem(kind: CredentialKind, secret: string, gateway = false): 'badClaudeToken' | 'badAnthropicKey' | 'badGatewayKey' | 'badOpenaiKey' | null {
  if (kind === 'anthropic-oauth') return CLAUDE_TOKEN_RE.test(secret) ? null : 'badClaudeToken'
  if (kind === 'anthropic-api-key' && gateway) return GATEWAY_KEY_RE.test(secret) && !/^sk-ant-/i.test(secret) ? null : 'badGatewayKey'
  if (kind === 'anthropic-api-key') return ANTHROPIC_KEY_RE.test(secret) ? null : 'badAnthropicKey'
  if (kind === 'openai-api-key') return OPENAI_KEY_RE.test(secret) && !secret.startsWith('sk-ant-') ? null : 'badOpenaiKey'
  return null
}

export type CheckResult = { result: 'ok' | 'refused' | 'unverified'; upstreamStatus: number | null }

/** OpenRouter answers its model list without a key, so a key is checked on GET <api>/v1/key (older servers:
 * /auth/key; `get` adds the path to .../api/v1): ok, refused (401 / 403), or unchecked when neither answers. The API
 * engine's status (admin/engines.ts) and a gateway connection use it. */
export async function openRouterKey(get: (path: string) => Promise<Response>): Promise<'ok' | 'refused' | 'unchecked'> {
  let k = await get('/key')
  if (k.status === 404) { await k.body?.cancel().catch(() => {}); k = await get('/auth/key') }
  await k.body?.cancel().catch(() => {})
  if (k.status === 401 || k.status === 403) return 'refused'
  return k.ok ? 'ok' : 'unchecked'
}

/** A gateway's key, without spending tokens: OpenRouter on GET /api/v1/key; another gateway on GET <base>/v1/models,
 * which proves the key only when the same list is refused without one (a public list says nothing about it). */
async function verifyGatewayKey(cc: CredCtx, g: AnthropicGatewayConf, secret: string): Promise<CheckResult> {
  if (/^sk-ant-/i.test(secret)) return { result: 'unverified', upstreamStatus: null } // an Anthropic key or token: never to a third party
  const base = cc.upstreams.anthropic
  const get = (p: string, headers: Record<string, string>) => cc.fetch(base + p, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  try {
    if (isOpenRouter(g)) {
      const r = await openRouterKey((p) => get('/v1' + p, { authorization: `Bearer ${secret}` }))
      return r === 'ok' ? { result: 'ok', upstreamStatus: 200 } : r === 'refused' ? { result: 'refused', upstreamStatus: 401 } : { result: 'unverified', upstreamStatus: null }
    }
    const r = await get('/v1/models', { 'x-api-key': secret, 'anthropic-version': '2023-06-01' })
    await r.body?.cancel().catch(() => {})
    if (r.status === 401 || r.status === 403) return { result: 'refused', upstreamStatus: r.status }
    if (!r.ok) return { result: 'unverified', upstreamStatus: r.status }
    const open = await get('/v1/models', { 'anthropic-version': '2023-06-01' })
    await open.body?.cancel().catch(() => {})
    return open.ok ? { result: 'unverified', upstreamStatus: r.status } : { result: 'ok', upstreamStatus: r.status }
  } catch {
    return { result: 'unverified', upstreamStatus: null }
  }
}

/** Ask the provider about a token / key without spending tokens. */
export async function verifySecret(cc: CredCtx, kind: Exclude<CredentialKind, 'chatgpt'>, secret: string): Promise<CheckResult> {
  const g = anthropicGateway(cc.config)
  if (g && kind === 'anthropic-api-key') return verifyGatewayKey(cc, g, secret)
  // the anthropic upstream is the gateway: a Claude subscription token is never sent there (not even to check it)
  if (g && kind === 'anthropic-oauth') return { result: 'unverified', upstreamStatus: null }
  let url: string
  let init: RequestInit
  if (kind === 'anthropic-oauth') {
    url = `${cc.upstreams.anthropic}/v1/messages/count_tokens`
    init = {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json', ...CLAUDE_CLIENT_HEADERS },
      body: JSON.stringify({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'ping' }] }),
    }
  } else if (kind === 'anthropic-api-key') {
    url = `${cc.upstreams.anthropic}/v1/models`
    init = { method: 'GET', headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } }
  } else {
    url = `${cc.upstreams.openai}/models`
    init = { method: 'GET', headers: { authorization: `Bearer ${secret}` } }
  }
  try {
    const r = await cc.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
    await r.body?.cancel().catch(() => {})
    if (r.status >= 200 && r.status < 300) return { result: 'ok', upstreamStatus: r.status }
    if (r.status === 401 || (r.status === 403 && kind !== 'anthropic-oauth')) return { result: 'refused', upstreamStatus: r.status }
    return { result: 'unverified', upstreamStatus: r.status }
  } catch {
    return { result: 'unverified', upstreamStatus: null }
  }
}
