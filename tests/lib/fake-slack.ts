// A stand-in for Slack (tests of the Slack connector, docs/SLACK.md): the Web API methods the connector calls
// (auth.test, apps.connections.open, bots.info, users.info, users.list, conversations.open, .replies, .info, chat.postMessage,
// chat.postEphemeral, chat.update, chat.delete), a Socket Mode
// WebSocket that says hello and records every acknowledgement, and response URLs. Nothing reaches the real Slack.
import type { ServerWebSocket } from 'bun'

export interface Call { method: string; token: string | null; args: Record<string, string>; at: number }
export interface FakeUser { name: string; team_id: string; real_name?: string; email?: string; is_bot?: boolean; deleted?: boolean; enterprise_id?: string }
export interface FakeSlack {
  url: string
  botToken: string
  appToken: string
  team: { id: string; name: string }
  botUserId: string
  appId: string
  /** the app's credentials for "Sign in with Slack" */
  clientId: string
  clientSecret: string
  /** codes Slack's "Sign in with Slack" gave a browser, and what their id_token says */
  codes: Record<string, { user: string; team?: string; nonce: string; aud?: string; iss?: string; exp?: number; enterprise?: string }>
  /** the app the socket address names (another app's app-level token) */
  socketAppId?: string
  users: Record<string, FakeUser>
  calls: Call[]
  acks: { id: string; ms: number }[]
  responses: { path: string; body: Record<string, unknown> }[]
  scopes: string[]
  opens: number
  /** the next call of a method fails like this; hang: answer nothing for that long (the client times out), recorded
   * as a call (it reached Slack) unless `lost` */
  failNext: Record<string, { error?: string; status?: number; retryAfter?: number; hang?: number; lost?: boolean }>
  /** channels conversations.info calls shared with another organization; `unknown`: no is_ext_shared in the answer */
  sharedChannels: Set<string>
  unknownChannels: Set<string>
  sockets(): number
  connected(): Promise<void>
  send(obj: unknown): void
  /** an Events API envelope; returns its envelope id */
  event(event: Record<string, unknown>, o?: { eventId?: string; retry?: number; team?: string; appId?: string; enterprise?: string; extShared?: boolean }): string
  /** an interactive (block_actions) envelope */
  action(payload: Record<string, unknown>): string
  disconnect(reason: string): void
  of(method: string): Call[]
  close(): void
}

let tsCounter = 0
export const nextTs = () => `${1_700_000_000 + Math.floor(Date.now() / 1000) % 1_000_000}.${String(++tsCounter).padStart(6, '0')}`

/** a Slack user object the way users.info and users.list give it (the e-mail only with users:read.email) */
function userObject(id: string, x: FakeUser) {
  return { id, team_id: x.team_id, name: x.name, real_name: x.real_name ?? x.name, deleted: !!x.deleted, is_bot: !!x.is_bot, ...(x.enterprise_id ? { enterprise_user: { enterprise_id: x.enterprise_id, teams: [x.team_id] } } : {}),
    profile: { display_name: x.name, real_name: x.real_name ?? x.name, ...(x.email !== undefined ? { email: x.email } : {}) } }
}

export function startFakeSlack(): FakeSlack {
  const open = new Set<ServerWebSocket<{ at: number }>>()
  const sent = new Map<string, number>()
  let envelopes = 0
  const fake: FakeSlack = {
    url: '', botToken: 'xoxb-111-222-' + 'b'.repeat(24), appToken: 'xapp-1-A0APP-333-' + 'a'.repeat(32),
    team: { id: 'T0ACME', name: 'Acme' }, botUserId: 'U0BOT', appId: 'A0APP', clientId: '1111111111.2222222222', clientSecret: 'f'.repeat(32), codes: {},
    users: {}, calls: [], acks: [], responses: [], opens: 0, failNext: {}, sharedChannels: new Set(), unknownChannels: new Set(),
    scopes: ['app_mentions:read', 'channels:read', 'chat:write', 'groups:read', 'im:history', 'im:write', 'users:read', 'users:read.email'],
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
        payload: { type: 'event_callback', token: 'unused', team_id: o.team ?? fake.team.id, api_app_id: o.appId ?? fake.appId, event_id: o.eventId ?? `Ev${String(envelopes).padStart(8, '0')}`, event_time: Math.floor(Date.now() / 1000), ...(o.enterprise ? { enterprise_id: o.enterprise } : {}), is_ext_shared_channel: !!o.extShared, event } })
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
      const f = fake.failNext[method]
      if (!f?.lost) fake.calls.push({ method, token, args, at: Date.now() })
      if (f) {
        delete fake.failNext[method]
        if (f.hang) { await Bun.sleep(f.hang); return json({ ok: true, channel: args.channel, ts: nextTs() }) }
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
          return json({ ok: true, user: userObject(args.user!, x) })
        }
        case 'users.list': {
          if (!bot) return json({ ok: false, error: 'invalid_auth' })
          // two pages, so the connector has to follow the cursor
          const all = Object.entries(fake.users).map(([id, x]) => userObject(id, x))
          const half = Math.ceil(all.length / 2)
          return args.cursor === 'page2' ? json({ ok: true, members: all.slice(half), response_metadata: { next_cursor: '' } }) : json({ ok: true, members: all.slice(0, half), response_metadata: { next_cursor: 'page2' } })
        }
        case 'conversations.replies': {
          if (!bot) return json({ ok: false, error: 'invalid_auth' })
          const ours = fake.calls.filter((c) => c.method === 'chat.postMessage' && c.args.channel === args.channel && c.args.thread_ts === args.ts)
          return json({ ok: true, messages: ours.map((c) => ({ user: fake.botUserId, bot_id: 'B0BOT', text: c.args.text, ts: (c.at / 1000).toFixed(6) })) })
        }
        case 'conversations.info': {
          if (!bot) return json({ ok: false, error: 'invalid_auth' })
          const ch = args.channel ?? ''
          return json({ ok: true, channel: { id: ch, ...(fake.unknownChannels.has(ch) ? {} : { is_ext_shared: fake.sharedChannels.has(ch), is_pending_ext_shared: false }) } })
        }
        case 'openid.connect.token': {
          // the app's credentials in the body (no bearer token), a code used once
          if (token || args.client_id !== fake.clientId) return json({ ok: false, error: 'invalid_client_id' })
          if (args.client_secret !== fake.clientSecret) return json({ ok: false, error: 'bad_client_secret' })
          const c = fake.codes[args.code ?? '']
          if (!c || args.grant_type !== 'authorization_code') return json({ ok: false, error: 'invalid_code' })
          delete fake.codes[args.code!]
          const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
          const claims = { iss: c.iss ?? 'https://slack.com', sub: c.user, aud: c.aud ?? fake.clientId, exp: c.exp ?? Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), nonce: c.nonce,
            'https://slack.com/user_id': c.user, 'https://slack.com/team_id': c.team ?? fake.team.id, ...(c.enterprise ? { 'https://slack.com/enterprise_id': c.enterprise } : {}), name: c.user }
          return json({ ok: true, access_token: `xoxp-user-${c.user}`, token_type: 'Bearer', id_token: `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln` })
        }
        case 'auth.revoke': return json({ ok: true, revoked: true })
        case 'conversations.open': return bot && /^U[A-Z0-9]+$/.test(args.users ?? '') ? json({ ok: true, channel: { id: 'D' + args.users!.slice(1) } }) : json({ ok: false, error: 'invalid_arguments' })
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
