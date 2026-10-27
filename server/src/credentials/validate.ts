// Is a pasted token / key plausible, and does the provider take it? Without spending tokens (docs/DECISIONS.md
// "AI 연결" 3.8.1/3.8.2): a Claude subscription token is tried on POST /v1/messages/count_tokens (free for API keys;
// whether it answers for an OAuth token is not documented: spike S2), an API key on GET /models. 200 = verified,
// 401 / 403 = refused (not saved), anything else = saved as "checked on the first question" (never a paid call
// instead). Redirects are never followed (security T13). Nothing here logs or returns the secret.
import fs from 'node:fs'
import path from 'node:path'
import type { CredentialKind } from '@mycel/shared/api'
import { REPO_ROOT } from '../app-config'
import type { CredCtx } from './store'

export const CLAUDE_TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/
export const ANTHROPIC_KEY_RE = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,300}$/
export const OPENAI_KEY_RE = /^sk-[A-Za-z0-9_-]{20,300}$/
const CHECK_TIMEOUT_MS = 10_000

/** the Claude Code version the proxy forwards as the client (user-agent / x-app) */
let claudeVersion = '2.1.305'
try { const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'versions.json'), 'utf8'))['claude-code']; if (typeof v === 'string') claudeVersion = v } catch {}
export const CLAUDE_CLIENT_HEADERS = { 'user-agent': `claude-cli/${claudeVersion} (external, cli)`, 'x-app': 'cli' }

/** null = plausible for this kind; else which message to show (never the value) */
export function formatProblem(kind: CredentialKind, secret: string): 'badClaudeToken' | 'badAnthropicKey' | 'badOpenaiKey' | null {
  if (kind === 'anthropic-oauth') return CLAUDE_TOKEN_RE.test(secret) ? null : 'badClaudeToken'
  if (kind === 'anthropic-api-key') return ANTHROPIC_KEY_RE.test(secret) ? null : 'badAnthropicKey'
  if (kind === 'openai-api-key') return OPENAI_KEY_RE.test(secret) && !secret.startsWith('sk-ant-') ? null : 'badOpenaiKey'
  return null
}

export type CheckResult = { result: 'ok' | 'refused' | 'unverified'; upstreamStatus: number | null }

/** Ask the provider about a token / key without spending tokens. */
export async function verifySecret(cc: CredCtx, kind: Exclude<CredentialKind, 'chatgpt'>, secret: string): Promise<CheckResult> {
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
