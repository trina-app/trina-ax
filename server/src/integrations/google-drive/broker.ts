// Google sign-in through the hosting service (shared/src/cloud-protocol/drive-broker.ts): a hosted team server has no
// Google client of its own. The control plane holds ONE Google client whose ONE return address is on the console host,
// so a new team address needs no new registration at Google.
//
// When it is used (driveBrokerFor): ONLY when the operator set MYCEL_GOOGLE_DRIVE_BROKER_URL (the control plane's
// console origin, e.g. https://account.trina.app; https, or http to this machine), on a hosted server (server.json
// `deployment: "hosted"`) WITHOUT a Google client of its own (no client.json, no MYCEL_GOOGLE_DRIVE_CLIENT_FILE).
// Without the variable nothing changes: no call to the hosting service, Drive as today. A self-installed server, and
// any server with its own client.json, keeps the direct flow (oauth.ts) unchanged. Even when it is set, Drive turns
// on only after the hosting service answers that it serves this team (oauth.ts checkBroker).
//
// Trust boundaries:
//  - Every call is signed with this server's relay team key (<data>/relay/team-key.pem). The control plane serves only
//    the key it recorded for a hosted team, and sends the browser only to that team's own address.
//  - The refresh token this server keeps is SEALED by the control plane with this team's id as associated data: it is
//    useless to Google without the control plane, and useless to the control plane for any other team. It is sealed a
//    second time here, in the Drive store's own key context, like a direct token.
//  - Nothing from these calls is logged; errors become DriveError codes without the answer's body.
import crypto, { type KeyObject } from 'node:crypto'
import {
  DRIVE_BROKER_MAX_BODY_BYTES, DRIVE_BROKER_PATHS, driveBrokerAuthorization, driveBrokerSigningString,
  type DriveBrokerOp, type DriveBrokerPurpose,
} from '@mycel/shared/cloud-protocol'
import type { AppContext } from '../../context'
import { isHosted } from '../../system/deployment'
import { loadOrCreateKey } from '../../relay-client/registration'
import { DriveError } from './store'
import type { DriveFetch } from './client'

export interface BrokerIdentity { key: KeyObject; publicKey: string }
export interface BrokerOptions { origin: string; identity: () => BrokerIdentity }

/** The control plane origin from MYCEL_GOOGLE_DRIVE_BROKER_URL. null: not set, or not usable. */
export function brokerOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.MYCEL_GOOGLE_DRIVE_BROKER_URL?.trim()
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
  return u.origin
}

/** Whether this server signs in through the hosting service: the broker URL set, hosted, no Google client of its own. */
export function driveBrokerFor(ctx: AppContext, ownClient: boolean, clientFromEnv: boolean, env: Record<string, string | undefined> = process.env): BrokerOptions | null {
  if (ownClient || clientFromEnv || !isHosted(ctx.config)) return null
  const origin = brokerOrigin(env)
  if (!origin) return null
  return { origin, identity: () => { const { key, publicKey } = loadOrCreateKey(ctx.config.dataDir); return { key, publicKey } } }
}

/** The configuration fingerprint of broker mode: connections made through one control plane origin belong together. */
export const brokerKey = (origin: string) => 'broker:' + crypto.createHash('sha256').update(origin).digest('hex')

export class DriveBroker {
  constructor(readonly o: BrokerOptions, private readonly fetcher: DriveFetch = fetch, private readonly now: () => number = Date.now) {}

  /** A signed call. Answers only JSON objects; maps the broker's error codes to Drive errors without its message. */
  private async call(op: DriveBrokerOp, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
    const path = DRIVE_BROKER_PATHS[op], text = JSON.stringify(body)
    if (Buffer.byteLength(text) > DRIVE_BROKER_MAX_BODY_BYTES) throw new DriveError('invalid_flow')
    let id: BrokerIdentity
    try { id = this.o.identity() } catch { throw new DriveError('broker_unavailable', 503) }
    const ts = this.now(), nonce = crypto.randomBytes(18).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(driveBrokerSigningString(path, ts, nonce, crypto.createHash('sha256').update(text).digest('hex')), 'utf8'), id.key).toString('base64')
    const s = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])])
    let r: Response
    try {
      r = await this.fetcher(this.o.origin + path, { method: 'POST', redirect: 'manual', signal: s, headers: { 'content-type': 'application/json', authorization: driveBrokerAuthorization(id.publicKey, ts, nonce, sig) }, body: text })
    } catch {
      throw new DriveError(s.aborted && signal?.aborted ? 'cancelled' : 'broker_unavailable', s.aborted && signal?.aborted ? 409 : 503)
    }
    let json: any = null
    try {
      const len = Number(r.headers.get('content-length'))
      if (len > 65_536) throw new Error()
      const raw = await r.text()
      if (raw.length > 65_536) throw new Error()
      json = JSON.parse(raw)
    } catch { json = null }
    if (r.ok && json && typeof json === 'object' && !Array.isArray(json)) return json
    const code = typeof json?.error?.code === 'string' ? json.error.code : ''
    if (code === 'invalid_grant') throw new DriveError('needs_reconnect', 409)
    if (code === 'invalid_handoff') throw new DriveError('invalid_flow')
    if (code === 'rate_limited' || r.status === 429) throw new DriveError('rate_limited', 503)
    if (code === 'provider_error') throw new DriveError('provider_unavailable', 503)
    throw new DriveError('broker_unavailable', 503)
  }

  /** The broker serves this team now (signed; the hosting service knows this team key and has a Google client). */
  async ready(signal?: AbortSignal): Promise<boolean> {
    try { return (await this.call('status', { v: 1 }, signal)).ok === true } catch { return false }
  }
  async start(purpose: DriveBrokerPurpose, returnState: string, codeChallenge: string): Promise<string> {
    const j = await this.call('start', { v: 1, purpose, returnState, codeChallenge })
    const url = typeof j.authorizationUrl === 'string' ? j.authorizationUrl : ''
    // only ever send a person to Google's own sign-in page
    let u: URL
    try { u = new URL(url) } catch { throw new DriveError('broker_unavailable', 503) }
    if (u.protocol !== 'https:' || u.hostname !== 'accounts.google.com') throw new DriveError('broker_unavailable', 503)
    return u.href
  }
  /** Google's token answer (access_token, expires_in, scope; refresh_token = the SEALED token). */
  redeem(handoff: string, codeVerifier: string, signal?: AbortSignal) { return this.call('redeem', { v: 1, handoff, codeVerifier }, signal) }
  refresh(sealedRefreshToken: string, signal?: AbortSignal) { return this.call('refresh', { v: 1, refreshToken: sealedRefreshToken }, signal) }
  async revoke(sealedRefreshToken: string): Promise<'revoked' | 'unavailable'> {
    try { return (await this.call('revoke', { v: 1, refreshToken: sealedRefreshToken })).revocation === 'revoked' ? 'revoked' : 'unavailable' } catch { return 'unavailable' }
  }
}
