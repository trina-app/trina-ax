// Sign in with Google through the hosting service (shared/src/cloud-protocol/google-signin.ts; part B of
// docs/AGENTS/plan/20261122-0454-google-login.md). A HOSTED team server without a Google client of its own borrows the
// hosting service's: one Google client with one return address on the console host, so a new team address needs no
// registration at Google.
//
// When it is used (google-login.ts googleLoginMode): the server has no Google client of its own
// (googleDriveOf(ctx).config is null and no MYCEL_GOOGLE_DRIVE_CLIENT_FILE), the console is the one the Drive broker
// uses (MYCEL_GOOGLE_DRIVE_BROKER_URL, or SERVICE_HOSTS.accountHost when the environment names none; google-drive/
// broker.ts brokerOrigin), and the console's `status` answered that it serves this server. A HOSTED server is served by
// the relay key the console recorded at enroll. A SELF-INSTALLED server (selfhost or office, not dev) with a public
// address and the variable left out uses the same console since 2026-11-27 (docs/decisions/
// 20261127-google-signin-selfhost.md), as Drive does (selfInstalledDefault): while the console answers `not_hosted` it
// registers its own address there with Drive's signed `register` (one registration serves both brokers; the console
// opens it while either CP_DRIVE_BROKER_SELF_REGISTER or CP_GOOGLE_SIGNIN_SELF is on), backing off 1, 2, 4, 8, 16, then
// 30 minutes. The console serves it only while its own CP_GOOGLE_SIGNIN_SELF says so, and sends the browser only to the
// address it proved.
//
// Trust boundaries:
//  - Every call is signed with this server's relay team key over the contract's own signing string: a Drive or Slack
//    broker signature never verifies there, nor one of theirs here.
//  - The console only relays: it hands back Google's raw id_token, and google-id-token.ts checks Google's signature
//    and the claims against the client id the start answered and this flow's nonce.
//  - Nothing from these calls is logged; an error is a short code without the answer's body.
import crypto, { type KeyObject } from 'node:crypto'
import {
  GOOGLE_SIGNIN_MAX_BODY_BYTES, GOOGLE_SIGNIN_PATHS, googleSigninAuthorization, googleSigninAuthorizeUrl, googleSigninSigningString,
  GOOGLE_SIGNIN_CLIENT_ID, parseGoogleSigninRedeemAnswer, parseGoogleSigninStatusAnswer, type GoogleSigninOp,
} from '@mycel/shared/cloud-protocol'
import type { AppContext } from '../context'
import { isHosted } from '../system/deployment'
import { loadOrCreateKey } from '../relay-client/registration'
import { brokerOrigin, DriveBroker, selfInstalledDefault } from '../integrations/google-drive/broker'
import { GoogleTransport, type DriveFetch } from '../integrations/google-drive/client'
import { GoogleKeys } from './google-id-token'

/** how often the console is asked whether it serves this team (a yes, then a no) */
const CHECK_OK_MS = 10 * 60_000, CHECK_RETRY_MS = 60_000
/** a self-installed server's longest wait after a "no" (1, 2, 4, 8, 16, then 30 minutes), as Drive's (oauth.ts) */
const REGISTER_MAX_MS = 30 * 60_000, REGISTER_TRIES_MAX = 6
/** the console's answers that say it does not serve this key now (anything else: it could not be asked) */
const NOT_SERVED = new Set(['not_hosted', 'not_configured'])
/** a call that found no console answering: no answer at all, or a server error (Google's included) */
export const brokerUnreachable = (e: unknown): boolean =>
  e instanceof SigninBrokerError && (e.code === 'unreachable' || e.code === 'provider_error' || /^http_5\d\d$/.test(e.code))
/** a refused or failed status: the console said it does not serve this server, or it could not be asked */
const failureOf = (e: unknown): 'not_served' | 'unreachable' => e instanceof SigninBrokerError && NOT_SERVED.has(e.code) ? 'not_served' : 'unreachable'
/** the flow's config_key in broker mode: the client id the console's start answered (a public value) */
const FLOW_KEY_PREFIX = 'gsi-broker:'
export const brokerFlowKey = (clientId: string) => FLOW_KEY_PREFIX + clientId
/** the broker's client id a flow was started with, or null for a direct flow (configKey: hex) */
export function brokerClientOf(configKey: string): string | null {
  if (!configKey.startsWith(FLOW_KEY_PREFIX)) return null
  const id = configKey.slice(FLOW_KEY_PREFIX.length)
  return GOOGLE_SIGNIN_CLIENT_ID.test(id) ? id : null
}

export class SigninBrokerError extends Error {
  constructor(readonly code: string) { super(`google sign-in broker: ${code}`); this.name = 'SigninBrokerError' }
}

export interface SigninBrokerDeps {
  /** the console origin; left out: the Drive broker's (brokerOrigin), or a self-installed server's default
   * (selfInstalledDefault); null: none */
  origin?: string | null
  /** with `origin`: a self-installed server's own address, registered at the console while it answers `not_hosted`
   * (tests; never on a hosted server) */
  selfOrigin?: string | null
  /** the environment read for the defaults (tests) */
  env?: Record<string, string | undefined>
  identity?: () => { key: KeyObject; publicKey: string }
  /** the console and Google's key list (tests: a fake of both) */
  fetch?: DriveFetch
  now?: () => number
}

export class GoogleSigninBroker {
  private ok = false
  private checkedAt = 0
  private seq = 0
  /** why the last answer was no: the console does not serve this server ('not_served'), or it could not be asked
   * ('unreachable': no answer, a server error, an answer that is not the contract's); null after a yes */
  private failure: 'not_served' | 'unreachable' | null = null
  private registeredAt: number | null = null
  private registerTries = 0
  /** Google's signing keys, for the id_tokens this broker relays */
  readonly keys: GoogleKeys
  /** `selfOrigin`: a self-installed server's own address, which it registers at the console (null on a hosted server
   * and when an operator set the console's address by hand) */
  constructor(readonly origin: string, readonly identity: () => { key: KeyObject; publicKey: string }, private readonly fetcher: DriveFetch, readonly now: () => number, readonly selfOrigin: string | null = null) {
    this.keys = new GoogleKeys(new GoogleTransport(fetcher), now)
  }

  /** The console said it serves this team (its last answer). An old answer is asked again in the background. */
  serves(): boolean {
    if (this.now() - this.checkedAt >= (this.ok ? CHECK_OK_MS : this.retryMs())) void this.check()
    return this.ok
  }

  /** The last answer was no because the console could not be asked, not because it does not serve this server: the
   * sign-in page keeps the button for people without a password and says so on a click (google-login.ts). */
  unreachable(): boolean {
    return !this.ok && this.failure === 'unreachable'
  }

  /** Ask the console whether it serves this team now. A self-installed server it does not serve registers itself
   * (register), then asks again. */
  async check(): Promise<boolean> {
    this.checkedAt = this.now()
    const seq = ++this.seq
    let ok = false, failure: 'not_served' | 'unreachable' | null = null
    try { ok = await this.status() } catch (e) { failure = failureOf(e) }
    if (!ok && failure === 'not_served' && (await this.register())) {
      try { ok = await this.status(); failure = null } catch (e) { failure = failureOf(e) }
    }
    // a yes starts the back-off over; a console that cannot be asked backs it off too (as a refused register does)
    if (ok) this.registerTries = 0
    else if (this.selfOrigin && failure !== 'not_served') this.registerTries = Math.min(this.registerTries + 1, REGISTER_TRIES_MAX)
    if (seq === this.seq) { this.ok = ok; this.failure = ok ? null : failure ?? 'unreachable' }
    return ok
  }

  private async status(): Promise<boolean> {
    return !!parseGoogleSigninStatusAnswer(await this.call('status', { v: 1 }))
  }

  /** Register this self-installed server's address at the console with Drive's signed `register`
   * (shared/src/cloud-protocol/drive-broker.ts; the console fetches this server's public key at GOOGLE_BROKER_KEY_PATH
   * on that address, routes/drive.ts), at most once per back-off wait. true: the console said yes. */
  private async register(): Promise<boolean> {
    if (!this.selfOrigin) return false
    if (this.registeredAt !== null && this.now() - this.registeredAt < this.retryMs()) return false
    this.registeredAt = this.now()
    this.registerTries = Math.min(this.registerTries + 1, REGISTER_TRIES_MAX)
    return new DriveBroker({ origin: this.origin, identity: this.identity, selfOrigin: this.selfOrigin }, this.fetcher, this.now).register()
  }

  /** the wait after a "no": a minute on a hosted server; on a self-installed one 1, 2, 4, 8, 16, then 30 minutes, so
   * thousands of them never ask a console that says no once a minute */
  private retryMs(): number {
    return this.selfOrigin && this.registerTries ? Math.min(REGISTER_MAX_MS, 60_000 * 2 ** (this.registerTries - 1)) : CHECK_RETRY_MS
  }

  /** Google's sign-in page for this flow (checked: Google's own page, this nonce, the client id answered, Google
   * returning to this console) and the client id the id_token must be for. */
  async start(returnState: string, codeChallenge: string, nonce: string): Promise<{ url: string; clientId: string }> {
    const j = await this.call('start', { v: 1, returnState, codeChallenge, nonce })
    const clientId = typeof j.clientId === 'string' && GOOGLE_SIGNIN_CLIENT_ID.test(j.clientId) ? j.clientId : null
    const url = clientId ? googleSigninAuthorizeUrl(j.authorizationUrl, { origin: this.origin, clientId, nonce }) : null
    if (!clientId || !url) throw new SigninBrokerError('bad_answer')
    return { url, clientId }
  }

  /** Google's raw id_token for this handoff (the verifier of the start's challenge). Not checked here. */
  async redeem(handoff: string, codeVerifier: string): Promise<string> {
    const a = parseGoogleSigninRedeemAnswer(await this.call('redeem', { v: 1, handoff, codeVerifier }))
    if (!a) throw new SigninBrokerError('bad_answer')
    return a.idToken
  }

  /** A signed call; answers only JSON objects. A refusal that says the console does not serve this team (any more)
   * makes serves() false at once. */
  private async call(op: GoogleSigninOp, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = GOOGLE_SIGNIN_PATHS[op], text = JSON.stringify(body)
    if (Buffer.byteLength(text) > GOOGLE_SIGNIN_MAX_BODY_BYTES) throw new SigninBrokerError('too_large')
    let id: { key: KeyObject; publicKey: string }
    try { id = this.identity() } catch { throw new SigninBrokerError('no_key') }
    const ts = this.now(), nonce = crypto.randomBytes(18).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(googleSigninSigningString(path, ts, nonce, crypto.createHash('sha256').update(text).digest('hex')), 'utf8'), id.key).toString('base64')
    let r: Response
    try {
      r = await this.fetcher(this.origin + path, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', authorization: googleSigninAuthorization(id.publicKey, ts, nonce, sig) }, body: text,
      })
    } catch { throw new SigninBrokerError('unreachable') }
    let json: unknown = null
    try {
      if (Number(r.headers.get('content-length')) > 65_536) throw new Error()
      const raw = await r.text()
      if (raw.length > 65_536) throw new Error()
      json = JSON.parse(raw)
    } catch { json = null }
    const obj = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null
    if (r.ok && obj) return obj
    const err = obj?.error as { code?: unknown } | undefined
    const code = typeof err?.code === 'string' && /^[a-z_]{1,40}$/.test(err.code) ? err.code : `http_${r.status}`
    if (NOT_SERVED.has(code)) { this.ok = false; this.failure = 'not_served'; this.checkedAt = this.now() }
    throw new SigninBrokerError(code)
  }
}

const instances = new WeakMap<AppContext, GoogleSigninBroker | null>()

/** This server's way to the hosting service's Google sign-in: a hosted server with a console, or a self-installed one
 * with the console's address set or its default (selfInstalledDefault), else null. `deps`
 * (tests) makes a new one. The first one asks the console at once, so the sign-in page knows soon after a start. */
export function googleSigninBrokerOf(ctx: AppContext, deps?: SigninBrokerDeps): GoogleSigninBroker | null {
  if (!deps && instances.has(ctx)) return instances.get(ctx)!
  const b = build(ctx, deps ?? {})
  instances.set(ctx, b)
  if (b) void b.check()
  return b
}

/** Where this server asks, as google-drive/broker.ts driveBrokerFor decides for Drive. A hosted server: the variable's
 * console or the edition's, never registering (the console knows its key from enroll). A self-installed one: the
 * variable's console when an operator set it (registered by hand, `admin.js google-broker-key`), else the edition's
 * console and its own public address to register there (selfInstalledDefault: selfhost or office, not dev). */
function build(ctx: AppContext, deps: SigninBrokerDeps): GoogleSigninBroker | null {
  const env = deps.env ?? process.env
  const hosted = isHosted(ctx.config)
  let origin: string | null, selfOrigin: string | null = null
  if (deps.origin !== undefined) { origin = deps.origin; selfOrigin = hosted ? null : deps.selfOrigin ?? null }
  else {
    origin = brokerOrigin(env, hosted)
    const self = !origin && !hosted ? selfInstalledDefault(ctx, env) : null
    if (self) { origin = self.origin; selfOrigin = self.selfOrigin }
  }
  if (!origin) return null
  const identity = deps.identity ?? (() => { const { key, publicKey } = loadOrCreateKey(ctx.config.dataDir); return { key, publicKey } })
  return new GoogleSigninBroker(origin, identity, deps.fetch ?? fetch, deps.now ?? Date.now, selfOrigin)
}
