// Sign in with Google through the hosting service (shared/src/cloud-protocol/google-signin.ts; part B of
// docs/AGENTS/plan/20261122-0454-google-login.md). A HOSTED team server without a Google client of its own borrows the
// hosting service's: one Google client with one return address on the console host, so a new team address needs no
// registration at Google.
//
// When it is used (google-login.ts googleLoginMode): the server is hosted, has no Google client of its own
// (googleDriveOf(ctx).config is null and no MYCEL_GOOGLE_DRIVE_CLIENT_FILE), the console is the one the Drive broker
// uses (MYCEL_GOOGLE_DRIVE_BROKER_URL, or SERVICE_HOSTS.accountHost when the environment names none; google-drive/
// broker.ts brokerOrigin), and the console's `status` answered that it serves this team. A self-installed server never
// uses it in this version.
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
import { brokerOrigin } from '../integrations/google-drive/broker'
import { GoogleTransport, type DriveFetch } from '../integrations/google-drive/client'
import { GoogleKeys } from './google-id-token'

/** how often the console is asked whether it serves this team (a yes, then a no) */
const CHECK_OK_MS = 10 * 60_000, CHECK_RETRY_MS = 60_000
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
  /** the console origin; left out: the Drive broker's (brokerOrigin); null: none */
  origin?: string | null
  identity?: () => { key: KeyObject; publicKey: string }
  /** the console and Google's key list (tests: a fake of both) */
  fetch?: DriveFetch
  now?: () => number
}

export class GoogleSigninBroker {
  private ok = false
  private checkedAt = 0
  private seq = 0
  /** Google's signing keys, for the id_tokens this broker relays */
  readonly keys: GoogleKeys
  constructor(readonly origin: string, private readonly identity: () => { key: KeyObject; publicKey: string }, private readonly fetcher: DriveFetch, readonly now: () => number) {
    this.keys = new GoogleKeys(new GoogleTransport(fetcher), now)
  }

  /** The console said it serves this team (its last answer). An old answer is asked again in the background. */
  serves(): boolean {
    if (this.now() - this.checkedAt >= (this.ok ? CHECK_OK_MS : CHECK_RETRY_MS)) void this.check()
    return this.ok
  }

  /** Ask the console whether it serves this team now. */
  async check(): Promise<boolean> {
    this.checkedAt = this.now()
    const seq = ++this.seq
    let ok = false
    try { ok = !!parseGoogleSigninStatusAnswer(await this.call('status', { v: 1 })) } catch { ok = false }
    if (seq === this.seq) this.ok = ok
    return ok
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
    if (code === 'not_hosted' || code === 'not_configured') { this.ok = false; this.checkedAt = this.now() }
    throw new SigninBrokerError(code)
  }
}

const instances = new WeakMap<AppContext, GoogleSigninBroker | null>()

/** This server's way to the hosting service's Google sign-in: hosted servers with a console only, else null. `deps`
 * (tests) makes a new one. The first one asks the console at once, so the sign-in page knows soon after a start. */
export function googleSigninBrokerOf(ctx: AppContext, deps?: SigninBrokerDeps): GoogleSigninBroker | null {
  if (!deps && instances.has(ctx)) return instances.get(ctx)!
  const b = build(ctx, deps ?? {})
  instances.set(ctx, b)
  if (b) void b.check()
  return b
}

function build(ctx: AppContext, deps: SigninBrokerDeps): GoogleSigninBroker | null {
  if (!isHosted(ctx.config)) return null
  const origin = deps.origin !== undefined ? deps.origin : brokerOrigin(process.env, true)
  if (!origin) return null
  const identity = deps.identity ?? (() => { const { key, publicKey } = loadOrCreateKey(ctx.config.dataDir); return { key, publicKey } })
  return new GoogleSigninBroker(origin, identity, deps.fetch ?? fetch, deps.now ?? Date.now)
}
