// An in-process stand-in for the hosting service's Google sign-in broker (shared/src/cloud-protocol/drive-broker.ts),
// in front of FakeGoogleDrive. It checks every request the way the control plane does: the signature with the one
// team key it knows, the strict bodies, single-use handoffs bound to the PKCE challenge. It never opens a connection.
import crypto from 'node:crypto'
import {
  DRIVE_BROKER_PATHS, DRIVE_BROKER_SCOPE, driveBrokerSigningString, parseDriveBrokerAuthorization, parseDriveBrokerRedeem,
  parseDriveBrokerRefresh, parseDriveBrokerStart, parseDriveBrokerStatus,
} from '../../shared/src/cloud-protocol/drive-broker'
import type { DriveFetch } from '../../server/src/integrations/google-drive/client'
import type { BrokerOptions } from '../../server/src/integrations/google-drive/broker'
import type { FakeGoogleDrive } from './fake-google-drive'

export const BROKER_ORIGIN = 'https://account.broker.test'

export class FakeDriveBroker {
  readonly key = crypto.generateKeyPairSync('ed25519').privateKey
  readonly publicKey = crypto.createPublicKey(this.key).export({ format: 'der', type: 'spki' }).toString('base64')
  /** the key the "control plane" recorded for this team (another team's key is refused) */
  trusted = this.publicKey
  configured = true
  requests: { path: string; body: string }[] = []
  starts = new Map<string, { returnState: string; challenge: string; purpose: string }>()
  handoffs = new Map<string, { challenge: string; who: string }>()
  sealed = new Map<string, string>()
  revoked: string[] = []
  invalidGrant = false
  /** the start answer's Google address (a test makes it point elsewhere) */
  authorizeBase = 'https://accounts.google.com/o/oauth2/v2/auth'
  seen = new Set<string>()
  constructor(readonly google: FakeGoogleDrive) {}
  options(): BrokerOptions { return { origin: BROKER_ORIGIN, identity: () => ({ key: this.key, publicKey: this.publicKey }) } }

  /** The browser: Google's consent, then the control plane's callback, which sends it to the team's address. */
  browserReturn(authorizationUrl: string, who = 'alice'): { state: string; handoff: string } {
    const s = this.starts.get(new URL(authorizationUrl).searchParams.get('state') ?? '')
    if (!s) throw new Error('unknown broker state')
    this.starts.delete(new URL(authorizationUrl).searchParams.get('state')!)
    const handoff = crypto.randomBytes(32).toString('base64url')
    this.handoffs.set(handoff, { challenge: s.challenge, who })
    return { state: s.returnState, handoff }
  }

  private token(who: string, withRefresh: boolean) {
    const access = 'CANARY-broker-access:' + who + ':' + this.requests.length
    this.google.access.set(access, who)
    const out: Record<string, unknown> = { access_token: access, expires_in: this.google.expired ? 30 : 3600, scope: DRIVE_BROKER_SCOPE, token_type: 'Bearer' }
    if (withRefresh) {
      const sealed = `ev1.k1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(48).toString('base64url')}`
      this.sealed.set(sealed, who)
      out.refresh_token = sealed
    }
    return out
  }

  fetch: DriveFetch = async (raw, init = {}) => {
    if (!raw.startsWith(BROKER_ORIGIN + '/')) return this.google.fetch(raw, init)
    const path = new URL(raw).pathname, body = String(init.body ?? '')
    this.requests.push({ path, body })
    const err = (code: string, status: number) => Response.json({ error: { code, message: code } }, { status })
    const auth = parseDriveBrokerAuthorization(new Headers(init.headers).get('authorization'))
    if (!auth || init.method !== 'POST') return err('unauthorized', 401)
    const msg = driveBrokerSigningString(path, auth.ts, auth.nonce, crypto.createHash('sha256').update(body).digest('hex'))
    let ok = false
    try { ok = crypto.verify(null, Buffer.from(msg), crypto.createPublicKey({ key: Buffer.from(auth.key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(auth.sig, 'base64')) } catch {}
    if (!ok || this.seen.has(auth.nonce)) return err('unauthorized', 401)
    this.seen.add(auth.nonce)
    if (auth.key !== this.trusted) return err('not_hosted', 403)
    if (!this.configured) return err('not_configured', 503)
    let json: unknown
    try { json = JSON.parse(body) } catch { return err('invalid_request', 400) }
    if (path === DRIVE_BROKER_PATHS.status) return parseDriveBrokerStatus(json) ? Response.json({ ok: true }) : err('invalid_request', 400)
    if (path === DRIVE_BROKER_PATHS.start) {
      const b = parseDriveBrokerStart(json)
      if (!b) return err('invalid_request', 400)
      const state = crypto.randomBytes(32).toString('base64url')
      this.starts.set(state, { returnState: b.returnState, challenge: b.codeChallenge, purpose: b.purpose })
      const u = new URL(this.authorizeBase)
      u.searchParams.set('state', state); u.searchParams.set('scope', DRIVE_BROKER_SCOPE); u.searchParams.set('redirect_uri', BROKER_ORIGIN + '/drive-broker/google/callback')
      return Response.json({ authorizationUrl: u.href, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    }
    if (path === DRIVE_BROKER_PATHS.redeem) {
      const b = parseDriveBrokerRedeem(json)
      if (!b) return err('invalid_request', 400)
      const h = this.handoffs.get(b.handoff)
      this.handoffs.delete(b.handoff)
      if (!h || crypto.createHash('sha256').update(b.codeVerifier).digest('base64url') !== h.challenge) return err('invalid_handoff', 400)
      return Response.json(this.token(h.who, true))
    }
    if (path === DRIVE_BROKER_PATHS.refresh) {
      const b = parseDriveBrokerRefresh(json)
      if (!b) return err('invalid_request', 400)
      const who = this.sealed.get(b.refreshToken)
      if (!who || this.invalidGrant) return err('invalid_grant', 400)
      this.google.refreshCount++
      return Response.json(this.token(who, false))
    }
    if (path === DRIVE_BROKER_PATHS.revoke) {
      const b = parseDriveBrokerRefresh(json)
      if (!b) return err('invalid_request', 400)
      this.revoked.push(b.refreshToken); this.sealed.delete(b.refreshToken)
      return Response.json({ revocation: 'revoked' })
    }
    return err('invalid_request', 404)
  }
}
