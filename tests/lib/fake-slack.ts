// A stand-in for Slack (tests of the Slack connector, docs/SLACK.md): the Web API methods the connector calls
// (auth.test, apps.connections.open, bots.info, users.info, chat.postMessage, chat.postEphemeral, chat.update, chat.delete), a Socket Mode
// WebSocket that says hello and records every acknowledgement, and response URLs. Nothing reaches the real Slack.
import type { ServerWebSocket } from 'bun'

export interface Call { method: string; token: string | null; args: Record<string, string> }
export interface FakeUser { name: string; team_id: string; real_name?: string; is_bot?: boolean; deleted?: boolean }
export interface FakeSlack {
  url: string
  botToken: string
  appToken: string
  team: { id: string; name: string }
  botUserId: string
  appId: string
  /** the app the socket address names (another app's app-level token) */
  socketAppId?: string
  users: Record<string, FakeUser>
  calls: Call[]
  acks: { id: string; ms: number }[]
  responses: { path: string; body: Record<string, unknown> }[]
  scopes: string[]
  opens: number
  /** the next call of a method fails like this */
  failNext: Record<string, { error?: string; status?: number; retryAfter?: number }>
  sockets(): number
  connected(): Promise<void>
  send(obj: unknown): void
  /** an Events API envelope; returns its envelope id */
  event(event: Record<string, unknown>, o?: { eventId?: string; retry?: number; team?: string; appId?: string; enterprise?: string }): string
  /** an interactive (block_actions) envelope */
  action(payload: Record<string, unknown>): string
  disconnect(reason: string): void
  of(method: string): Call[]
  close(): void
}

let tsCounter = 0
export const nextTs = () => `${1_700_000_000 + Math.floor(Date.now() / 1000) % 1_000_000}.${String(++tsCounter).padStart(6, '0')}`

export function startFakeSlack(): FakeSlack {
  const open = new Set<ServerWebSocket<{ at: number }>>()
  const sent = new Map<string, number>()
  let envelopes = 0
  const fake: FakeSlack = {
    url: '', botToken: 'xoxb-111-222-' + 'b'.repeat(24), appToken: 'xapp-1-A0APP-333-' + 'a'.repeat(32),
    team: { id: 'T0ACME', name: 'Acme' }, botUserId: 'U0BOT', appId: 'A0APP',
    users: {}, calls: [], acks: [], responses: [], opens: 0, failNext: {},
    scopes: ['app_mentions:read', 'chat:write', 'im:history', 'users:read'],
    sockets: () => open.size,
    async connected() {
      const end = Date.now() + 10_000
      while (!open.size && Date.now() < end) await Bun.sleep(10)
      if (!open.size) throw new Error('the connector never connected to the fake Slack')
      await Bun.sleep(30)
    },
    send(obj) { const s = JSON.stringify(obj); for (const ws of open) ws.send(s) },
    event(event, o = {}) {
      const id = `env-${++envelopes}`
      sent.set(id, Date.now())
      fake.send({ envelope_id: id, type: 'events_api', accepts_response_payload: false, ...(o.retry ? { retry_attempt: o.retry, retry_reason: 'timeout' } : {}),
        payload: { type: 'event_callback', token: 'unused', team_id: o.team ?? fake.team.id, api_app_id: o.appId ?? fake.appId, event_id: o.eventId ?? `Ev${String(envelopes).padStart(8, '0')}`, event_time: Math.floor(Date.now() / 1000), ...(o.enterprise ? { enterprise_id: o.enterprise } : {}), event } })
      return id
    },
    action(payload) {
      const id = `env-${++envelopes}`
      sent.set(id, Date.now())
      fake.send({ envelope_id: id, type: 'interactive', accepts_response_payload: false, payload })
      return id
    },
    disconnect(reason) { fake.send({ type: 'disconnect', reason, debug_info: { host: 'fake' } }) },
    of: (method) => fake.calls.filter((c) => c.method === method),
    close() { for (const ws of open) ws.close(); server.stop(true) },
  }
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } })
  const server = Bun.serve<{ at: number }, never>({
    port: 0, hostname: '127.0.0.1',
    async fetch(req, srv) {
      const u = new URL(req.url)
      if (u.pathname === '/link') return srv.upgrade(req, { data: { at: Date.now() } }) ? undefined : new Response('no', { status: 400 })
      if (u.pathname.startsWith('/actions/')) {
        fake.responses.push({ path: u.pathname, body: await req.json() as Record<string, unknown> })
        return new Response('ok')
      }
      const m = /^\/api\/([a-zA-Z.]+)$/.exec(u.pathname)
      if (!m || req.method !== 'POST') return new Response('not found', { status: 404 })
      const method = m[1]!
      const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
      const args = Object.fromEntries(new URLSearchParams(await req.text()))
      fake.calls.push({ method, token, args })
      const f = fake.failNext[method]
      if (f) {
        delete fake.failNext[method]
        if (f.status === 429) return new Response('', { status: 429, headers: { 'retry-after': String(f.retryAfter ?? 1) } })
        return json({ ok: false, error: f.error ?? 'internal_error' })
      }
      const bot = token === fake.botToken, app = token === fake.appToken
      switch (method) {
        case 'auth.test':
          if (!bot && !app) return json({ ok: false, error: 'invalid_auth' })
          return json({ ok: true, url: 'https://acme.slack.com/', team: fake.team.name, user: 'trina-ax', team_id: fake.team.id, user_id: fake.botUserId, bot_id: 'B0BOT', is_enterprise_install: false }, { 'x-oauth-scopes': fake.scopes.join(',') })
        case 'apps.connections.open':
          if (bot) return json({ ok: false, error: 'not_allowed_token_type' })
          if (!app) return json({ ok: false, error: 'invalid_auth' })
          fake.opens++
          return json({ ok: true, url: `ws://${u.host}/link?ticket=${fake.opens}&app_id=${fake.socketAppId ?? fake.appId}` })
        case 'bots.info':
          if (!bot) return json({ ok: false, error: 'invalid_auth' })
          return json({ ok: true, bot: { id: args.bot, app_id: fake.appId, user_id: fake.botUserId, name: 'trina-ax' } })
        case 'users.info': {
          if (!bot) return json({ ok: false, error: 'invalid_auth' })
          const x = fake.users[args.user ?? '']
          if (!x) return json({ ok: false, error: 'user_not_found' })
          return json({ ok: true, user: { id: args.user, team_id: x.team_id, name: x.name, real_name: x.real_name ?? x.name, deleted: !!x.deleted, is_bot: !!x.is_bot, profile: { display_name: x.name, real_name: x.real_name ?? x.name } } })
        }
        case 'chat.postMessage': return bot ? json({ ok: true, channel: args.channel, ts: nextTs() }) : json({ ok: false, error: 'invalid_auth' })
        case 'chat.postEphemeral': return bot ? json({ ok: true, message_ts: nextTs() }) : json({ ok: false, error: 'invalid_auth' })
        case 'chat.update': return bot ? json({ ok: true, channel: args.channel, ts: args.ts }) : json({ ok: false, error: 'invalid_auth' })
        case 'chat.delete': return bot ? json({ ok: true, channel: args.channel, ts: args.ts }) : json({ ok: false, error: 'invalid_auth' })
      }
      return json({ ok: false, error: 'unknown_method' })
    },
    websocket: {
      open(ws) { open.add(ws); ws.send(JSON.stringify({ type: 'hello', num_connections: open.size, connection_info: { app_id: fake.appId }, debug_info: { host: 'fake', approximate_connection_time: 3600 } })) },
      message(_ws, msg) {
        try { const j = JSON.parse(String(msg)) as { envelope_id?: string }; if (j.envelope_id) fake.acks.push({ id: j.envelope_id, ms: Date.now() - (sent.get(j.envelope_id) ?? Date.now()) }) } catch {}
      },
      close(ws) { open.delete(ws) },
    },
  })
  fake.url = `http://127.0.0.1:${server.port}`
  return fake
}
