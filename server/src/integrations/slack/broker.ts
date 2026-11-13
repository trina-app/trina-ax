// Slack through the hosting service's official app (shared/src/cloud-protocol/slack-broker.ts, docs/SLACK.md "The official
// app"): this server has no Slack app of its own. The owner presses "Add to Slack" once; the hosting service holds the
// app's secrets and its ONE Socket Mode connection (the app-level token is app-wide and never comes here), and hands this
// server only the envelopes of the workspace it installed, through a long poll this server makes (no public address
// needed), and that workspace's bot token, sealed to a one-time key of the request. Answers go to Slack from here.
//
// When it is used (slackBrokerFor): ONLY when the operator set MYCEL_SLACK_BROKER_URL (or MYCEL_GOOGLE_DRIVE_BROKER_URL:
// both brokers are on the hosting service's console), and only once `status` answers that it serves this server. A
// server with its own Slack app saved keeps it; a server without the variable never calls the hosting service.
//
// Trust boundaries:
//  - Every call is signed with this server's relay team key (<data>/relay/team-key.pem), like the Drive broker's, with
//    another signing string (a signature of one never verifies at the other).
//  - The browser only ever goes to Slack's own pages (slackBrokerAuthorizeUrl), and comes back to this server's own
//    address from the hosting service's records.
//  - A sealed bot token opens only with the X25519 key made for that request; the key is forgotten after it.
//  - Nothing from these calls is logged: errors become SlackBrokerError codes without the answer's body.
import crypto, { type KeyObject } from 'node:crypto'
import {
  SLACK_BROKER_MAX_BODY_BYTES, SLACK_BROKER_PATHS, SLACK_BROKER_POLL_MAX_WAIT_MS, SLACK_BROKER_SEAL_INFO, SLACK_BROKER_EVENT_ID,
  parseSlackBrokerInstallInfo, parseSlackBrokerSealedToken, slackBrokerAuthorization, slackBrokerAuthorizeUrl, slackBrokerSealAad, slackBrokerSigningString, slackBrokerUserSealAad,
  type SlackBrokerEvent, type SlackBrokerInstallInfo, type SlackBrokerOp, type SlackBrokerSealedToken,
} from '@mycel/shared/cloud-protocol'
import type { AppContext } from '../../context'
import type { Logger } from '../../log'
import { loadOrCreateKey } from '../../relay-client/registration'

export type BrokerFetch = (input: string, init: RequestInit) => Promise<Response>
export interface SlackBrokerIdentity { key: KeyObject; publicKey: string }
export interface SlackBrokerOptions { origin: string; identity: () => SlackBrokerIdentity; fetch?: BrokerFetch; now?: () => number }

/** What went wrong, as a short code: the hosting service's error code, or `unreachable` (network, its 5xx, a bad answer) */
export class SlackBrokerError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(`slack_broker_${code}`) }
}

/** The hosting service's console origin: MYCEL_SLACK_BROKER_URL, else MYCEL_GOOGLE_DRIVE_BROKER_URL (the same console).
 * https, or http to this machine; an origin only. null: not set or not usable (also MYCEL_SLACK_BROKER_URL=off). */
export function slackBrokerOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const own = env.MYCEL_SLACK_BROKER_URL?.trim()
  if (own === 'off') return null
  const raw = own || env.MYCEL_GOOGLE_DRIVE_BROKER_URL?.trim()
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
  return u.origin
}

/** The broker of this server, or null without the variable. */
export function slackBrokerFor(ctx: AppContext, env: Record<string, string | undefined> = process.env): SlackBrokerOptions | null {
  const origin = slackBrokerOrigin(env)
  if (!origin) return null
  return { origin, identity: () => { const { key, publicKey } = loadOrCreateKey(ctx.config.dataDir); return { key, publicKey } } }
}

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const rawOf = (k: KeyObject) => (crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)
/** A one-time X25519 key for one redeem or token request: its raw public key goes in the signed body as `sealKey`. */
export function sealKeyPair(): { privateKey: KeyObject; sealKey: string } {
  const { privateKey } = crypto.generateKeyPairSync('x25519')
  return { privateKey, sealKey: rawOf(privateKey).toString('base64url') }
}
/** Open a sealed bot token (contract "Sealed bot token"); throws when it does not open. `aad`: a user token's
 * (slackBrokerUserSealAad) instead of the bot token's. */
export function openSealedToken(sealed: SlackBrokerSealedToken, privateKey: KeyObject, installId: string, slackTeamId: string, aad = slackBrokerSealAad(installId, slackTeamId)): string {
  const epk = Buffer.from(sealed.epk, 'base64url')
  const shared = crypto.diffieHellman({ privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, epk]), format: 'der', type: 'spki' }) })
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epk, rawOf(privateKey)]), Buffer.from(SLACK_BROKER_SEAL_INFO, 'utf8'), 32))
  const raw = Buffer.from(sealed.ct, 'base64url')
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'))
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8')
}

/** The PKCE S256 challenge of a verifier (RFC 7636), as the hosting service checks it at redeem */
export const challengeOf = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url')

const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,250}$/
const USER_TOKEN = /^xoxp-[A-Za-z0-9-]{10,250}$/
const ID = /^[A-Z0-9]{2,40}$/

export class SlackBrokerClient {
  constructor(readonly o: SlackBrokerOptions) {}
  get origin() { return this.o.origin }
  private now() { return (this.o.now ?? Date.now)() }

  /** A signed call. Answers only JSON objects; the hosting service's error code (never its message) otherwise. */
  private async call(op: SlackBrokerOp, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 20_000): Promise<Record<string, any>> {
    const path = SLACK_BROKER_PATHS[op], text = JSON.stringify(body)
    if (Buffer.byteLength(text) > SLACK_BROKER_MAX_BODY_BYTES) throw new SlackBrokerError('invalid_request')
    let id: SlackBrokerIdentity
    try { id = this.o.identity() } catch { throw new SlackBrokerError('unreachable') }
    const ts = this.now(), nonce = crypto.randomBytes(18).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(slackBrokerSigningString(path, ts, nonce, crypto.createHash('sha256').update(text).digest('hex')), 'utf8'), id.key).toString('base64')
    const s = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
    let r: Response
    try {
      r = await (this.o.fetch ?? fetch)(this.o.origin + path, { method: 'POST', redirect: 'manual', signal: s, headers: { 'content-type': 'application/json', authorization: slackBrokerAuthorization(id.publicKey, ts, nonce, sig) }, body: text })
    } catch { throw new SlackBrokerError(signal?.aborted ? 'cancelled' : 'unreachable') }
    let json: any = null
    try {
      const raw = await r.text()
      if (raw.length > 1_048_576) throw new Error('too large')
      json = JSON.parse(raw)
    } catch { json = null }
    if (r.ok && json && typeof json === 'object' && !Array.isArray(json)) return json
    const code = typeof json?.error?.code === 'string' && /^[a-z_]{1,40}$/.test(json.error.code) ? json.error.code : r.status === 429 ? 'rate_limited' : 'unreachable'
    throw new SlackBrokerError(code, r.status)
  }

  private install(raw: unknown): SlackBrokerInstallInfo | null { return raw === null ? null : parseSlackBrokerInstallInfo(raw) }

  /** The hosting service serves this server now: its app id and this server's install (or none). A short time limit:
   * Admin › Connected apps › Slack waits for it. */
  async status(): Promise<{ appId: string; install: SlackBrokerInstallInfo | null }> {
    const j = await this.call('status', { v: 1 }, undefined, 8000)
    if (j.ok !== true || typeof j.appId !== 'string' || !ID.test(j.appId)) throw new SlackBrokerError('unreachable')
    const install = this.install(j.install ?? null)
    if (j.install && !install) throw new SlackBrokerError('unreachable')
    return { appId: j.appId, install }
  }

  /** Slack's "Add to Slack" page for this flow (only ever Slack's own page). */
  async startInstall(returnState: string, codeChallenge: string): Promise<string> {
    const j = await this.call('install', { v: 1, returnState, codeChallenge })
    const url = slackBrokerAuthorizeUrl('install', j.authorizationUrl)
    if (!url) throw new SlackBrokerError('unreachable')
    return url
  }

  private opened(j: Record<string, any>, privateKey: KeyObject): { install: SlackBrokerInstallInfo; botToken: string } {
    const install = this.install(j.install), sealed = parseSlackBrokerSealedToken(j.token)
    if (!install || !sealed) throw new SlackBrokerError('unreachable')
    let botToken: string
    try { botToken = openSealedToken(sealed, privateKey, install.installId, install.teamId) } catch { throw new SlackBrokerError('unreachable') }
    if (!BOT_TOKEN.test(botToken)) throw new SlackBrokerError('unreachable')
    return { install, botToken }
  }

  /** The browser came back with a handoff: the install and its bot token (opened here, with this request's key). */
  async redeem(handoff: string, codeVerifier: string) {
    const k = sealKeyPair()
    return this.opened(await this.call('redeem', { v: 1, handoff, codeVerifier, sealKey: k.sealKey }), k.privateKey)
  }

  /** This server's bot token again (it lost its own copy). */
  async token() {
    const k = sealKeyPair()
    return this.opened(await this.call('token', { v: 1, sealKey: k.sealKey }), k.privateKey)
  }

  /** One long poll: acknowledges `ack`, answers this server's envelopes (or none after `waitMs`). */
  async poll(ack: string[], waitMs: number, signal?: AbortSignal): Promise<{ install: SlackBrokerInstallInfo | null; events: SlackBrokerEvent[] }> {
    const j = await this.call('poll', { v: 1, ack, waitMs: Math.min(waitMs, SLACK_BROKER_POLL_MAX_WAIT_MS) }, signal, waitMs + 20_000)
    const install = this.install(j.install ?? null)
    if (j.install && !install) throw new SlackBrokerError('unreachable')
    const events: SlackBrokerEvent[] = []
    for (const e of Array.isArray(j.events) ? j.events.slice(0, 100) : []) {
      if (!e || typeof e.id !== 'string' || !SLACK_BROKER_EVENT_ID.test(e.id) || !['events_api', 'interactive', 'lifecycle'].includes(e.kind)) continue
      events.push({ id: e.id, kind: e.kind, payload: e.payload, receivedAt: typeof e.receivedAt === 'string' ? e.receivedAt : '' })
    }
    return { install, events }
  }

  /** Remove the app from the workspace (the hosting service calls Slack) and forget the install there. */
  async uninstall(): Promise<'removed' | 'unavailable'> {
    try { return (await this.call('uninstall', { v: 1 })).slack === 'removed' ? 'removed' : 'unavailable' } catch { return 'unavailable' }
  }

  /** "Sign in with Slack" with the official app: Slack's page for this flow. */
  async startSignIn(returnState: string, codeChallenge: string): Promise<string> {
    const j = await this.call('signinStart', { v: 1, returnState, codeChallenge })
    const url = slackBrokerAuthorizeUrl('signin', j.authorizationUrl)
    if (!url) throw new SlackBrokerError('unreachable')
    return url
  }

  /** Who signed in to Slack (the hosting service checked Slack's answer and revoked the person's token). */
  async redeemSignIn(handoff: string, codeVerifier: string): Promise<{ slackUserId: string; slackTeamId: string }> {
    const j = await this.call('signinRedeem', { v: 1, handoff, codeVerifier })
    if (typeof j.slackUserId !== 'string' || !ID.test(j.slackUserId) || typeof j.slackTeamId !== 'string' || !ID.test(j.slackTeamId)) throw new SlackBrokerError('unreachable')
    return { slackUserId: j.slackUserId, slackTeamId: j.slackTeamId }
  }

  /** "Sign in with Slack" that also lets the AI read Slack (signin/read/start): Slack's OAuth v2 page with user scopes
   * only. An older hosting service answers 404 (the caller falls back to startSignIn). */
  async startRead(returnState: string, codeChallenge: string): Promise<string> {
    const j = await this.call('readStart', { v: 1, returnState, codeChallenge })
    const url = slackBrokerAuthorizeUrl('read', j.authorizationUrl)
    if (!url) throw new SlackBrokerError('unreachable')
    return url
  }

  /** Who signed in, and their user token (opened here with this request's key; `installId`: the install held here,
   * part of the seal's additional data). */
  async redeemRead(handoff: string, codeVerifier: string, installId: string): Promise<{ slackUserId: string; slackTeamId: string; scopes: string[]; userToken: string }> {
    const k = sealKeyPair()
    const j = await this.call('readRedeem', { v: 1, handoff, codeVerifier, sealKey: k.sealKey })
    if (typeof j.slackUserId !== 'string' || !ID.test(j.slackUserId) || typeof j.slackTeamId !== 'string' || !ID.test(j.slackTeamId)) throw new SlackBrokerError('unreachable')
    const sealed = parseSlackBrokerSealedToken(j.token)
    const scopes = Array.isArray(j.scopes) ? j.scopes.filter((x: unknown): x is string => typeof x === 'string' && x.length <= 100).slice(0, 100) : []
    if (!sealed) throw new SlackBrokerError('unreachable')
    let userToken: string
    try { userToken = openSealedToken(sealed, k.privateKey, installId, j.slackTeamId, slackBrokerUserSealAad(installId, j.slackTeamId, j.slackUserId)) } catch { throw new SlackBrokerError('unreachable') }
    if (!USER_TOKEN.test(userToken)) throw new SlackBrokerError('unreachable')
    return { slackUserId: j.slackUserId, slackTeamId: j.slackTeamId, scopes, userToken }
  }
}

export type FeedState = 'connecting' | 'connected' | 'error'
export interface FeedOptions {
  client: SlackBrokerClient
  log: Logger
  /** one envelope for this server (awaited before it is acknowledged; the connector handles an event id once) */
  onEvent: (e: SlackBrokerEvent) => Promise<void>
  /** the install in each poll answer (null: removed at the hosting service) */
  onInstall: (install: SlackBrokerInstallInfo | null) => void
  onState: (s: FeedState, err: 'broker_unreachable' | 'not_served' | null) => void
  waitMs?: number
  retryMs?: number
}

/** The long-poll loop: poll, hand each envelope on, acknowledge it with the next poll. A failure waits 1, 2, 4 … s (at
 * most a minute); "not served" waits a minute. Stopped: the held poll is cancelled. */
export class SlackBrokerFeed {
  state: FeedState = 'connecting'
  lastError: 'broker_unreachable' | 'not_served' | null = null
  private stopped = false
  private abort = new AbortController()
  private failures = 0
  private ack: string[] = []
  private running: Promise<void> | null = null
  constructor(private readonly o: FeedOptions) {}

  start() { if (!this.running) this.running = this.loop() }
  stop() { this.stopped = true; this.abort.abort(); this.flush() }

  /** Stopped with events taken but not acknowledged yet (Turn off, removed from Slack): acknowledged now, so they are
   * not handed out again later (a stale "removed" would undo an install added again meanwhile). Best effort. */
  private flush() {
    if (!this.ack.length) return
    const ack = this.ack.splice(0)
    void this.o.client.poll(ack, 0).catch(() => {})
  }

  private set(s: FeedState, err: 'broker_unreachable' | 'not_served' | null) {
    if (this.state === s && this.lastError === err) return
    this.state = s; this.lastError = err
    try { this.o.onState(s, err) } catch { /* the connector's note only */ }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      ;(t as { unref?: () => void }).unref?.()
      this.abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
  }

  private async loop() {
    while (!this.stopped) {
      let answer
      try { answer = await this.o.client.poll(this.ack, this.o.waitMs ?? SLACK_BROKER_POLL_MAX_WAIT_MS, this.abort.signal) } catch (e) {
        if (this.stopped) return
        const code = e instanceof SlackBrokerError ? e.code : 'unreachable'
        const notServed = code === 'not_hosted' || code === 'not_configured'
        this.set('error', notServed ? 'not_served' : 'broker_unreachable')
        const base = this.o.retryMs ?? 1000
        // not served: a minute (60 × the base wait); else 1, 2, 4 … × the base, at most a minute
        await this.sleep(notServed ? 60 * base : Math.min(60_000, base * 2 ** Math.min(this.failures++, 6)))
        continue
      }
      // stopped while the answer came: it is not this feed's any more (nothing acknowledged: it comes again)
      if (this.stopped) return
      this.ack = []
      this.failures = 0
      this.set('connected', null)
      // one answer's envelopes side by side (each is a person's question; the connector handles an event id and a
      // message once, also when two run at once), then all of them taken
      await Promise.all(answer.events.map(async (e) => {
        try { await this.o.onEvent(e) } catch (err) { this.o.log.error('slack broker event failed', { err: err instanceof Error ? err.name : 'unknown' }) }
      }))
      // taken (handled or not): acknowledged with the next poll; a repeat after a restart is handled once anyway
      for (const e of answer.events) this.ack.push(e.id)
      if (this.stopped) { this.flush(); return }
      // after the events: a `lifecycle` event among them says why the install is gone better than `install: null`
      try { this.o.onInstall(answer.install) } catch { /* the connector's note only */ }
    }
  }
}
