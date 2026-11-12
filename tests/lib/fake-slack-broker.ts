// A fake of the hosting service's Slack broker (shared/src/cloud-protocol/slack-broker.ts) for offline tests: every
// call's signature, time and nonce are checked against the one team key it serves; "Add to Slack" and "Sign in with
// Slack" make a state and, when a test plays Slack's return (slackReturn), a one-time handoff that only the start's
// PKCE verifier redeems; the bot token goes out sealed to the request's one-time X25519 key with the install as
// additional data; poll holds until an event is queued or the wait is over, and hands out events until acknowledged.
// Nothing here is a real credential: the bot token is the fake Slack's (tests/lib/fake-slack.ts).
import crypto from 'node:crypto'
import {
  SLACK_BROKER_PATHS, SLACK_BROKER_SEAL_ALG, SLACK_BROKER_SEAL_INFO, SLACK_INSTALL_AUTHORIZE_URL, SLACK_SIGNIN_AUTHORIZE_URL,
  parseSlackBrokerAuthorization, parseSlackBrokerInstall, parseSlackBrokerPoll, parseSlackBrokerRedeem, parseSlackBrokerSigninRedeem,
  parseSlackBrokerSigninStart, parseSlackBrokerStatus, parseSlackBrokerToken, slackBrokerSealAad, slackBrokerSigningString,
  type SlackBrokerEvent, type SlackBrokerInstallInfo, type SlackBrokerOp, type SlackBrokerSealedToken,
} from '@mycel/shared/cloud-protocol'

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const rawOf = (k: crypto.KeyObject) => (crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)

/** The contract's seal, written from its text (the team server's opener is tested against it and the shared vector).
 * `fixed`: the vector's key and iv instead of fresh ones. */
export function sealForTest(token: string, sealKey: string, aad: string, fixed?: { privateKey: crypto.KeyObject; iv: Buffer }): SlackBrokerSealedToken {
  const team = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(sealKey, 'base64url')]), format: 'der', type: 'spki' })
  const priv = fixed?.privateKey ?? crypto.generateKeyPairSync('x25519').privateKey
  const epk = rawOf(priv)
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: team })
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epk, Buffer.from(sealKey, 'base64url')]), Buffer.from(SLACK_BROKER_SEAL_INFO, 'utf8'), 32))
  const iv = fixed?.iv ?? crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final(), c.getAuthTag()])
  return { alg: SLACK_BROKER_SEAL_ALG, epk: epk.toString('base64url'), iv: iv.toString('base64url'), ct: ct.toString('base64url') }
}

export interface BrokerCall { op: SlackBrokerOp; body: Record<string, unknown>; at: number }
export interface FakeBroker {
  url: string
  /** the key it serves (base64 SPKI); a call signed with another key is not_hosted */
  servedKey: string
  /** false: every call answers not_hosted (403); 'unconfigured': not_configured (503); 'down': a 502 with no JSON */
  serving: true | false | 'unconfigured' | 'down'
  appId: string
  clientId: string
  botToken: string
  install: SlackBrokerInstallInfo | null
  /** the next install's workspace (Slack's answer at redeem) */
  nextInstall: Partial<SlackBrokerInstallInfo>
  /** refuse the next redeem with this code */
  redeemError: string | null
  /** who the next "Sign in with Slack" signed in as */
  signinAs: { slackUserId: string; slackTeamId: string }
  calls: BrokerCall[]
  acks: string[]
  /** the browser's way back from Slack through the broker: the team's callback with a one-time handoff (or an error) */
  slackReturn(kind: 'install' | 'signin', o?: { error?: 'consent_denied' | 'provider_error' }): string
  /** an envelope for the served owner (taken by its next poll); `id`: one handed out before, again */
  push(kind: SlackBrokerEvent['kind'], payload: unknown, id?: string): string
  /** the events not acknowledged yet */
  pending(): SlackBrokerEvent[]
  of(op: SlackBrokerOp): BrokerCall[]
  close(): void
}

export function startFakeBroker(o: { servedKey: string; botToken: string; teamOrigin: () => string }): FakeBroker {
  const nonces = new Set<string>()
  const states = new Map<string, { kind: 'install' | 'signin'; returnState: string; challenge: string }>()
  const handoffs = new Map<string, { kind: 'install' | 'signin'; challenge: string }>()
  let queue: { e: SlackBrokerEvent; leasedUntil: number }[] = []
  let waiters: (() => void)[] = []
  let seq = 0
  const fake: FakeBroker = {
    url: '', servedKey: o.servedKey, serving: true, appId: 'A0APP', clientId: '1111111111.2222222222', botToken: o.botToken,
    install: null, nextInstall: {}, redeemError: null, signinAs: { slackUserId: 'U0ALICE', slackTeamId: 'T0ACME' }, calls: [], acks: [],
    slackReturn(kind, x = {}) {
      const last = [...states.entries()].reverse().find(([, s]) => s.kind === kind)
      if (!last) throw new Error(`no ${kind} was started at the fake broker`)
      const [state, s] = last
      states.delete(state)
      const u = new URL(o.teamOrigin() + (kind === 'install' ? '/api/integrations/slack/official/callback' : '/api/integrations/slack/oauth/callback'))
      u.searchParams.set('state', s.returnState)
      if (x.error) u.searchParams.set('error', x.error)
      else {
        const h = crypto.randomBytes(32).toString('base64url')
        handoffs.set(h, { kind, challenge: s.challenge })
        u.searchParams.set('handoff', h)
      }
      return u.pathname + u.search
    },
    push(kind, payload, again) {
      const id = again ?? `ev-${String(++seq).padStart(8, '0')}`
      queue.push({ e: { id, kind, payload, receivedAt: new Date().toISOString() }, leasedUntil: 0 })
      for (const w of waiters.splice(0)) w()
      return id
    },
    pending: () => queue.map((q) => q.e),
    of: (op) => fake.calls.filter((c) => c.op === op),
    close() { for (const w of waiters.splice(0)) w(); server.stop(true) },
  }
  const fail = (code: string, status: number) => Response.json({ error: { code, message: `fake: ${code}` } }, { status })
  const opOf = Object.fromEntries(Object.entries(SLACK_BROKER_PATHS).map(([k, v]) => [v, k as SlackBrokerOp]))
  const challengeOf = (v: string) => crypto.createHash('sha256').update(v).digest('base64url')
  const takeHandoff = (kind: 'install' | 'signin', h: string, verifier: string) => {
    const x = handoffs.get(h)
    handoffs.delete(h)
    return !!x && x.kind === kind && x.challenge === challengeOf(verifier)
  }
  const handOver = (sealKey: string) => ({ install: fake.install!, token: sealForTest(fake.botToken, sealKey, slackBrokerSealAad(fake.install!.installId, fake.install!.teamId)) })
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      const op = opOf[path]
      if (!op || req.method !== 'POST') return new Response('not found', { status: 404 })
      const text = await req.text()
      const auth = parseSlackBrokerAuthorization(req.headers.get('authorization'))
      if (!auth || Math.abs(Date.now() - auth.ts) > 60_000 || nonces.has(`${auth.key}:${auth.nonce}`)) return fail('unauthorized', 401)
      let pub: crypto.KeyObject
      try { pub = crypto.createPublicKey({ key: Buffer.from(auth.key, 'base64'), format: 'der', type: 'spki' }) } catch { return fail('unauthorized', 401) }
      const signed = slackBrokerSigningString(path, auth.ts, auth.nonce, crypto.createHash('sha256').update(text).digest('hex'))
      if (!crypto.verify(null, Buffer.from(signed, 'utf8'), pub, Buffer.from(auth.sig, 'base64'))) return fail('unauthorized', 401)
      nonces.add(`${auth.key}:${auth.nonce}`)
      let body: Record<string, unknown>
      try { body = JSON.parse(text) } catch { return fail('invalid_request', 400) }
      fake.calls.push({ op, body, at: Date.now() })
      if (fake.serving === 'down') return new Response('<html>bad gateway</html>', { status: 502 })
      if (fake.serving === 'unconfigured') return fail('not_configured', 503)
      if (!fake.serving || auth.key !== fake.servedKey) return fail('not_hosted', 403)
      switch (op) {
        case 'status':
          if (!parseSlackBrokerStatus(body)) return fail('invalid_request', 400)
          return Response.json({ ok: true, appId: fake.appId, install: fake.install })
        case 'install':
        case 'signinStart': {
          const b = op === 'install' ? parseSlackBrokerInstall(body) : parseSlackBrokerSigninStart(body)
          if (!b) return fail('invalid_request', 400)
          if (op === 'signinStart' && !fake.install) return fail('not_installed', 404)
          const state = crypto.randomBytes(32).toString('base64url')
          states.set(state, { kind: op === 'install' ? 'install' : 'signin', returnState: b.returnState, challenge: b.codeChallenge })
          const u = new URL(op === 'install' ? SLACK_INSTALL_AUTHORIZE_URL : SLACK_SIGNIN_AUTHORIZE_URL)
          u.search = new URLSearchParams({ client_id: fake.clientId, state, redirect_uri: 'https://broker.example/slack-broker/', ...(op === 'signinStart' ? { team: fake.install!.teamId, scope: 'openid profile', response_type: 'code' } : { scope: 'chat:write' }) }).toString()
          return Response.json({ authorizationUrl: u.href, expiresAt: new Date(Date.now() + 600_000).toISOString() })
        }
        case 'redeem': {
          const b = parseSlackBrokerRedeem(body)
          if (!b) return fail('invalid_request', 400)
          if (!takeHandoff('install', b.handoff, b.codeVerifier)) return fail('invalid_handoff', 400)
          if (fake.redeemError) { const code = fake.redeemError; fake.redeemError = null; return fail(code, code === 'provider_error' ? 502 : 409) }
          fake.install = { installId: fake.install?.installId ?? crypto.randomUUID(), teamId: 'T0ACME', teamName: 'Acme', enterpriseId: null, botUserId: 'U0BOT', appId: fake.appId, scopes: ['app_mentions:read', 'channels:read', 'chat:write', 'groups:read', 'im:history', 'im:write', 'users:read', 'users:read.email'], installedAt: new Date().toISOString(), ...fake.nextInstall }
          return Response.json(handOver(b.sealKey))
        }
        case 'token': {
          const b = parseSlackBrokerToken(body)
          if (!b) return fail('invalid_request', 400)
          if (!fake.install) return fail('not_installed', 404)
          return Response.json(handOver(b.sealKey))
        }
        case 'poll': {
          const b = parseSlackBrokerPoll(body)
          if (!b) return fail('invalid_request', 400)
          fake.acks.push(...b.ack)
          queue = queue.filter((q) => !b.ack.includes(q.e.id))
          const due = () => queue.filter((q) => q.leasedUntil <= Date.now())
          if (!due().length && b.waitMs > 0) await new Promise<void>((done) => { const t = setTimeout(done, b.waitMs); waiters.push(() => { clearTimeout(t); done() }); req.signal.addEventListener('abort', () => { clearTimeout(t); done() }) })
          const out = due().slice(0, 50)
          for (const q of out) q.leasedUntil = Date.now() + 60_000
          return Response.json({ install: fake.install, events: out.map((q) => q.e) })
        }
        case 'uninstall':
          fake.install = null
          return Response.json({ slack: 'removed' })
        case 'signinRedeem': {
          const b = parseSlackBrokerSigninRedeem(body)
          if (!b) return fail('invalid_request', 400)
          if (!takeHandoff('signin', b.handoff, b.codeVerifier)) return fail('invalid_handoff', 400)
          if (!fake.install) return fail('not_installed', 404)
          if (fake.signinAs.slackTeamId !== fake.install.teamId) return fail('outsider', 409)
          return Response.json({ ...fake.signinAs, enterpriseId: null })
        }
      }
      return fail('invalid_request', 400)
    },
  })
  fake.url = `http://127.0.0.1:${server.port}`
  return fake
}
