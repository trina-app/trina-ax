// A local mailbox for development and e2e tests: the team API (api.ts) over HTTP in memory, plus POST /dev/send that
// runs the gateway path (gateway.ts) as if a mail had come in, so a developer can "send" a mail without a mail domain.
// Loopback only. Every valid Ed25519 key is served (its team id is a hash of the key). Never for production.
//
//   bun mailbox/src/dev.ts --port 19171 [--domain mail.localhost]
//   MYCEL_MAIL_IN_URL=http://127.0.0.1:19171 bun run dev:server
//   curl -s http://127.0.0.1:19171/dev/send -H 'content-type: application/json' \
//     -d '{"to":"<address from the room>","from":"shop@example.com","raw":"From: Shop <shop@example.com>\r\nSubject: New order\r\n\r\nOrder 1"}'
import crypto from 'node:crypto'
import { handleApi } from './api.ts'
import { Waiters, type MailboxDeps } from './deps.ts'
import { receiveMail, upkeep } from './gateway.ts'
import { nodeMailCrypto } from './node-crypto.ts'
import { MailStore, MemoryKv } from './store.ts'

export interface DevMailbox { url: string; deps: MailboxDeps; stop(): void }

export function startDevMailbox(o: { port?: number; domain?: string; now?: () => number } = {}): DevMailbox {
  const deps: MailboxDeps = {
    store: new MailStore(new MemoryKv()),
    crypto: nodeMailCrypto,
    domain: (o.domain ?? 'mail.localhost').toLowerCase(),
    teams: async (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
    now: o.now ?? (() => Date.now()),
    waiters: new Waiters(),
    log: (event, fields) => console.log(`[mailbox] ${event} ${JSON.stringify(fields)}`),
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: o.port ?? 19171,
    idleTimeout: 60,
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/dev/send' && req.method === 'POST') {
        let b: { to?: unknown; from?: unknown; raw?: unknown }
        try { b = await req.json() as typeof b } catch { return Response.json({ error: 'send JSON {to, from, raw}' }, { status: 400 }) }
        if (typeof b.to !== 'string' || typeof b.raw !== 'string') return Response.json({ error: 'send JSON {to, from, raw}' }, { status: 400 })
        const raw = new TextEncoder().encode(b.raw)
        const r = await receiveMail(deps, { to: b.to, from: typeof b.from === 'string' ? b.from : 'sender@example.com', raw, rawSize: raw.length })
        return Response.json(r.accepted ? { accepted: true, id: r.id } : { accepted: false, smtp: r.smtp })
      }
      return handleApi(deps, req)
    },
  })
  const t = setInterval(() => { void upkeep(deps) }, 3_600_000)
  ;(t as { unref?: () => void }).unref?.()
  return { url: `http://127.0.0.1:${server.port}`, deps, stop: () => { clearInterval(t); server.stop(true) } }
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
  const m = startDevMailbox({ port: Number(arg('--port') ?? 19171), domain: arg('--domain') })
  console.log(`dev mailbox at ${m.url} (mail domain ${m.deps.domain}); POST /dev/send {to, from, raw}`)
}
