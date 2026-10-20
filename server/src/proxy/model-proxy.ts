// Model proxy for "company key" mode (design tab 1 "모델 프록시 예산", tab 3 "모델 호출"). The engine gets
// ANTHROPIC_BASE_URL=<this proxy> and a per-turn proxy token instead of the real key. The proxy checks the token
// (turn + user, expiry, revocation), budgets, optionally the TCP peer's process group, injects the real key,
// forwards to the upstream API and counts usage itself (authoritative numbers in `turns`).
// Not the default in stage 1 (owner 2026-10-21: subscriptions only); covered by tests against a fake upstream.
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { audit } from '../admin/audit'

const h = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

export function issueProxyToken(db: Database, turnId: string, userId: string, o: { ttlMs?: number; budgetUsd?: number } = {}) {
  const token = 'mpx_' + crypto.randomBytes(32).toString('base64url')
  db.query('INSERT INTO proxy_tokens (token_hash, turn_id, user_id, expires_at, budget_usd) VALUES (?,?,?,?,?)')
    .run(h(token), turnId, userId, new Date(Date.now() + (o.ttlMs ?? 30 * 60_000)).toISOString(), o.budgetUsd ?? null)
  return token
}
export function revokeProxyTokens(db: Database, turnId: string) {
  db.query('UPDATE proxy_tokens SET revoked_at = ? WHERE turn_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), turnId)
}

/** USD per million tokens (approximate list prices; input, output). Cache reads 0.1x input, cache writes 1.25x input. */
const PRICES: [RegExp, number, number][] = [[/opus/i, 15, 75], [/sonnet/i, 3, 15], [/haiku/i, 1, 5]]
export function costUsd(model: string, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) {
  const [, pi, po] = PRICES.find(([re]) => re.test(model)) ?? [null, 15, 75]
  return ((u.input_tokens ?? 0) * pi + (u.output_tokens ?? 0) * po + (u.cache_read_input_tokens ?? 0) * pi * 0.1 + (u.cache_creation_input_tokens ?? 0) * pi * 1.25) / 1e6
}

export interface ProxyOpts {
  db: Database
  /** the real credential: a company API key (x-api-key) or a long-lived subscription OAuth token (Authorization: Bearer) */
  upstream: { baseUrl: string; kind: "api-key" | "oauth"; secret: string }
  /** return false to refuse (e.g. TCP peer not in the turn's process group) */
  peerCheck?: (clientPort: number, serverPort: number, turnId: string) => Promise<boolean>
  port?: number
}

// ---------------- forwarding rules (design tab 7 "모델 프록시를 통한 외부 전송", tab 3 "모델 호출") ----------------
// The proxy holds the real credential. A broken or new-version engine could ask the model company to send data out for
// it: an MCP connector (mcp_servers), code execution (container), server tools such as web_fetch, or image / document
// blocks the API downloads from a URL. Only what Claude Code needs passes: POST /v1/messages (and count_tokens),
// custom tools plus the web_search server tool, and content blocks whose data is inline. Anything else is a 403.

/** content block types that carry nothing the API would fetch or run */
const BLOCK_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'server_tool_use', 'web_search_tool_result', 'tool_reference', 'search_result'])
/** image / document sources that are inline data */
const INLINE_SOURCES = new Set(['base64', 'text', 'content'])
export const PROXY_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]{0,79}$/

function checkBlocks(v: unknown, depth: number): string | null {
  if (typeof v === 'string') return null
  if (!Array.isArray(v)) return 'content must be a string or a list of blocks'
  if (depth > 8) return 'content nested too deep'
  for (const b of v as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') return 'bad content block'
    const type = String(b.type)
    if (!BLOCK_TYPES.has(type)) return `content block type ${type.slice(0, 40)} is not allowed`
    if (type === 'image' || type === 'document') {
      const src = b.source as Record<string, unknown> | undefined
      if (!src || !INLINE_SOURCES.has(String(src.type))) return `${type} blocks must carry their data inline (no url / file sources)`
      if (src.type === 'content') { const r = checkBlocks(src.content, depth + 1); if (r) return r }
    }
    if (type === 'server_tool_use' && b.name !== 'web_search') return `server tool ${String(b.name).slice(0, 40)} is not allowed`
    if (type === 'tool_result' && b.content !== undefined) { const r = checkBlocks(b.content, depth + 1); if (r) return r }
  }
  return null
}

/** null = forward; else why the request is refused. `body` is the parsed JSON (null when there is none / not JSON). */
export function checkProxyRequest(method: string, url: URL, body: unknown): string | null {
  if (method !== 'POST' || !PROXY_PATHS.has(url.pathname)) return `${method} ${url.pathname.slice(0, 80)} is not forwarded`
  for (const [k, v] of url.searchParams) if (k !== 'beta' || v !== 'true') return 'unexpected query parameter'
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object'
  const b = body as Record<string, unknown>
  for (const k of ['mcp_servers', 'container']) if (k in b) return `${k} is not allowed`
  if (typeof b.model !== 'string' || !MODEL_RE.test(b.model)) return 'model is not a Claude model name'
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return 'tools must be a list'
    for (const t of b.tools as Record<string, unknown>[]) {
      const type = t && typeof t === 'object' ? t.type : undefined
      if (type === undefined || type === null || type === 'custom') continue
      if (typeof type === 'string' && /^web_search_\d+$/.test(type)) continue
      return `tool type ${String(type).slice(0, 40)} is not allowed`
    }
  }
  if (b.system !== undefined) { const r = checkBlocks(b.system, 0); if (r) return r }
  if (!Array.isArray(b.messages)) return 'messages must be a list'
  for (const m of b.messages as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object') return 'bad message'
    const r = checkBlocks(m.content, 0)
    if (r) return r
  }
  return null
}

function apiError(status: number, type: string, message: string) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } })
}

function spent(db: Database, where: string, args: any[], period: 'day' | 'month') {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0); if (period === 'month') since.setUTCDate(1)
  return (db.query(`SELECT COALESCE(SUM(t.cost_usd),0) AS c FROM turns t WHERE t.started_at >= ? AND ${where}`).get(since.toISOString(), ...args) as any).c as number
}

export function overBudget(db: Database, userId: string, turnId: string, tokenBudget: number | null): string | null {
  if (tokenBudget !== null) {
    const c = (db.query('SELECT cost_usd FROM turns WHERE id = ?').get(turnId) as any)?.cost_usd ?? 0
    if (c >= tokenBudget) return 'turn budget reached'
  }
  const groups = (db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as any[]).map((r) => r.group_id)
  for (const b of db.query("SELECT * FROM budgets WHERE action = 'block'").all() as any[]) {
    let s: number
    if (b.subject_type === 'user' && b.subject_id === userId) s = spent(db, 't.user_id = ?', [userId], b.period)
    else if (b.subject_type === 'group' && groups.includes(b.subject_id)) s = spent(db, 't.user_id IN (SELECT user_id FROM group_members WHERE group_id = ?)', [b.subject_id], b.period)
    else if (b.subject_type === 'team') s = spent(db, '1=1', [], b.period)
    else continue
    if (s >= b.limit_usd) return `${b.subject_type} ${b.period} budget reached`
  }
  return null
}

export function startModelProxy(o: ProxyOpts) {
  const { db } = o
  const add = db.query('UPDATE turns SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?')
  const record = (turnId: string, model: string, u: any) => {
    add.run((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), u.output_tokens ?? 0, costUsd(model, u), turnId)
  }
  const server = Bun.serve({
    hostname: '127.0.0.1', port: o.port ?? 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (!url.pathname.startsWith('/v1/')) return apiError(404, 'not_found_error', 'not found')
      // the engine sends its per-turn token as x-api-key (ANTHROPIC_API_KEY) or as a Bearer (CLAUDE_CODE_OAUTH_TOKEN)
      const tok = (req.headers.get('x-api-key') || req.headers.get('authorization')?.replace(/^Bearer\s*/i, '') || '').trim()
      if (!tok) return apiError(401, 'authentication_error', 'missing proxy token')
      const row = db.query('SELECT * FROM proxy_tokens WHERE token_hash = ?').get(h(tok)) as any
      if (!row || row.revoked_at || row.expires_at < new Date().toISOString()) return apiError(401, 'authentication_error', 'invalid proxy token')
      if (o.peerCheck) {
        const ip = srv.requestIP(req)
        if (!ip || !(await o.peerCheck(ip.port, server.port!, row.turn_id))) return apiError(403, 'permission_error', 'caller is not part of this turn')
      }
      const why = overBudget(db, row.user_id, row.turn_id, row.budget_usd)
      if (why) return apiError(429, 'rate_limit_error', why)
      const headers = new Headers()
      for (const [k, v] of req.headers) if (/^(anthropic-|content-type$|accept$)/i.test(k)) headers.set(k, v)
      if (o.upstream.kind === 'api-key') headers.set('x-api-key', o.upstream.secret)
      else {
        headers.set('authorization', 'Bearer ' + o.upstream.secret)
        const beta = new Set((headers.get('anthropic-beta') ?? '').split(',').map((s) => s.trim()).filter(Boolean))
        beta.add('oauth-2025-04-20')
        headers.set('anthropic-beta', [...beta].join(','))
      }
      const body = req.method === 'GET' ? undefined : await req.arrayBuffer()
      let parsed: unknown = null
      try { if (body) parsed = JSON.parse(new TextDecoder().decode(body)) } catch {}
      const refused = checkProxyRequest(req.method, url, parsed)
      if (refused) {
        audit(db, { actor: row.user_id, action: 'proxy.refused', target: row.turn_id, detail: { reason: refused } })
        return apiError(403, 'permission_error', `refused by the team server: ${refused}`)
      }
      let model = String((parsed as { model?: unknown }).model ?? 'unknown')
      const up = await fetch(o.upstream.baseUrl.replace(/\/$/, '') + url.pathname + url.search, { method: req.method, headers, body })
      const outHeaders = new Headers(up.headers); outHeaders.delete('content-encoding'); outHeaders.delete('content-length')
      if (!url.pathname.startsWith('/v1/messages') || url.pathname.includes('count_tokens')) return new Response(up.body, { status: up.status, headers: outHeaders })
      if ((up.headers.get('content-type') ?? '').includes('text/event-stream') && up.body) {
        // pass the stream through untouched while reading usage from message_start / message_delta
        const usage: any = {}
        let buf = ''
        const dec = new TextDecoder()
        const ts = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, ctl) {
            ctl.enqueue(chunk)
            buf += dec.decode(chunk, { stream: true })
            let i
            while ((i = buf.indexOf('\n')) >= 0) {
              const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
              if (!l.startsWith('data:')) continue
              try {
                const ev = JSON.parse(l.slice(5))
                if (ev.type === 'message_start') { Object.assign(usage, ev.message?.usage ?? {}); model = ev.message?.model ?? model }
                if (ev.type === 'message_delta' && ev.usage) Object.assign(usage, ev.usage)
              } catch {}
            }
          },
          flush() { record(row.turn_id, model, usage) },
        })
        return new Response(up.body.pipeThrough(ts), { status: up.status, headers: outHeaders })
      }
      const text = await up.text()
      try { const j = JSON.parse(text); if (j.usage) record(row.turn_id, j.model ?? model, j.usage) } catch {}
      return new Response(text, { status: up.status, headers: outHeaders })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, stop: () => server.stop(true) }
}
