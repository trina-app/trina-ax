// The Cloudflare entry (reference, NOT deployed from this repository; ops steps: docs/runbooks/room-email-mailbox.md).
//   - `email`: Email Routing's catch-all on the mail domain calls it once per recipient. It checks the size, reads the
//     mail and hands it to the one Durable Object, which runs the gateway (gateway.ts) and answers what to reject.
//   - `fetch`: the team servers' API (api.ts) under /api/mail-in/v1/*, run in the same Durable Object, so a held poll
//     wakes when mail comes.
//   - `Mailbox`: the Durable Object. Its storage holds everything (store.ts); one instance for the whole service in v1
//     (a team is small; shard by team later if the load asks).
// Minimal local interfaces instead of @cloudflare/workers-types (no new dependency).
import { DEFAULT_AUTHSERV_ID, handleEmail, receiveMail, upkeep, type EmailMessageLike, type IncomingMail, type ReceiveResult } from './gateway.ts'
import { handleApi } from './api.ts'
import { webMailCrypto } from './crypto.ts'
import { Waiters, type MailboxDeps } from './deps.ts'
import { MailStore, type KvLike } from './store.ts'

interface DurableObjectStub { fetch(input: string, init?: RequestInit): Promise<Response> }
interface DurableObjectNamespace { idFromName(name: string): unknown; get(id: unknown): DurableObjectStub }
interface DurableObjectState { storage: KvLike & { setAlarm(at: number): Promise<void>; getAlarm(): Promise<number | null> } }
interface Fetcher { fetch(input: string, init?: RequestInit): Promise<Response> }

export interface Env {
  MAILBOX: DurableObjectNamespace
  /** the mail domain, e.g. the separate mail-in apex domain (lowercase) */
  MAIL_DOMAIN: string
  /** the hosting service's registry (a service binding): POST /internal/mail-in/team {key} → {teamId} | 404 */
  TEAMS: Fetcher
  /** the authserv-id of the receiving service's own Authentication-Results (default mx.cloudflare.net) */
  AUTHSERV_ID?: string
}

const INTERNAL = 'https://mailbox.internal'
const stub = (env: Env) => env.MAILBOX.get(env.MAILBOX.idFromName('mailbox'))

export default {
  async email(message: EmailMessageLike, env: Env): Promise<void> {
    await handleEmail(message, async (m: IncomingMail): Promise<ReceiveResult> => {
      const r = await stub(env).fetch(`${INTERNAL}/internal/receive`, {
        method: 'POST',
        headers: { 'x-mail-to': m.to, 'x-mail-from': m.from, 'x-mail-size': String(m.rawSize ?? m.raw.length) },
        body: m.raw as Uint8Array<ArrayBuffer>,
      })
      // a fault in the store: thrown, so Email Routing does not take the mail (what the sender sees is a phase 0 check)
      if (!r.ok) throw new Error(`mailbox ${r.status}`)
      return await r.json() as ReceiveResult
    })
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url)
    if (!u.pathname.startsWith('/api/mail-in/v1/')) return new Response('Not found', { status: 404 })
    return stub(env).fetch(`${INTERNAL}${u.pathname}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? req.body : undefined })
  },
}

export class Mailbox {
  private deps: MailboxDeps
  constructor(private state: DurableObjectState, env: Env) {
    this.deps = {
      store: new MailStore(state.storage),
      crypto: webMailCrypto(),
      domain: env.MAIL_DOMAIN?.trim().toLowerCase() || null,
      teams: async (key) => {
        const r = await env.TEAMS.fetch(`${INTERNAL}/internal/mail-in/team`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })
        if (!r.ok) return null
        const j = await r.json() as { teamId?: unknown }
        return typeof j.teamId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(j.teamId) ? j.teamId : null
      },
      now: () => Date.now(),
      waiters: new Waiters(),
      authServId: env.AUTHSERV_ID || DEFAULT_AUTHSERV_ID,
      // a hash prefix and a reason only
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    }
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url)
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 3_600_000)
    if (u.pathname === '/internal/receive' && req.method === 'POST') {
      const raw = new Uint8Array(await req.arrayBuffer())
      const r = await receiveMail(this.deps, { to: req.headers.get('x-mail-to') ?? '', from: req.headers.get('x-mail-from') ?? '', raw, rawSize: Number(req.headers.get('x-mail-size') ?? raw.length) })
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } })
    }
    return handleApi(this.deps, new Request(`${INTERNAL}${u.pathname}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? req.body : undefined }))
  }
  async alarm(): Promise<void> {
    await upkeep(this.deps)
    await this.state.storage.setAlarm(Date.now() + 3_600_000)
  }
}
