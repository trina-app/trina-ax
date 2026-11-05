// The push gateway's request handler, the same in the Worker (worker.ts) and the Bun entry (bun.ts). Contract:
// shared/src/cloud-protocol/push-gateway.ts. Provider calls go through deps.fetch; state through deps.state.
//
// Logs carry only coarse outcome codes: never tokens, bodies, keys, signatures or provider answers.
import {
  PUSH_GATEWAY_ERRORS, PUSH_GATEWAY_HEALTH_PATH, PUSH_GATEWAY_MAX_BODY_BYTES, PUSH_GATEWAY_MAX_SKEW_MS,
  PUSH_GATEWAY_SEND_PATH, parsePushGatewayAuthorization, parsePushGatewaySend, pushGatewaySigningString,
  type PushGatewayErrorCode, type PushPlatform,
} from '../../shared/src/cloud-protocol/push-gateway.ts'
import { createApns, type ApnsConfig } from './apns.ts'
import { importTeamKey, sha256Hex, verifyEd25519, type Bytes, type FetchLike } from './crypto.ts'
import { createFcm, parseServiceAccount, type SendOutcome } from './fcm.ts'
import type { GatewayState } from './state.ts'
import { DEFAULT_APP_TITLE, alertBody } from './text.ts'

/** Variables and secrets (wrangler.toml [vars], `wrangler secret put`, or the Bun entry's environment). */
export interface GatewayEnv {
  APP_TITLE?: string
  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_TOPIC?: string
  /** the .p8 key, PKCS#8 PEM */
  APNS_PRIVATE_KEY?: string
  /** 'on': also send to the APNs sandbox (development builds); default off */
  APNS_SANDBOX?: string
  /** the service-account JSON */
  FCM_SERVICE_ACCOUNT?: string
}

export interface LogLine {
  evt: 'push' | 'config'
  /** 'sent', 'duplicate', an error code, or for evt 'config' which provider is (not) set up */
  outcome: string
  platform?: PushPlatform
  status?: number
}

export interface GatewayDeps {
  fetch: FetchLike
  now(): number
  log(line: LogLine): void
  state: GatewayState
  /** provider origins, for tests and local runs (never from env vars) */
  endpoints?: { apnsProduction?: string; apnsSandbox?: string; fcm?: string }
}

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function answer(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } })
}

/** The request body, at most `max` bytes, read from the stream (Content-Length is not trusted); null when larger. */
export async function readBounded(req: Request, max: number): Promise<Bytes | null> {
  const cl = req.headers.get('content-length')
  if (cl && /^\d+$/.test(cl) && Number(cl) > max) return null
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

function apnsConfig(env: GatewayEnv): ApnsConfig | null {
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_TOPIC: topic, APNS_PRIVATE_KEY: privateKeyPem } = env
  if (!keyId || !teamId || !topic || !privateKeyPem) return null
  return { keyId, teamId, topic, privateKeyPem, sandbox: env.APNS_SANDBOX === 'on' }
}

export function createGateway(env: GatewayEnv, deps: GatewayDeps) {
  const title = env.APP_TITLE || DEFAULT_APP_TITLE
  const apnsCfg = apnsConfig(env)
  const apns = apnsCfg ? createApns(apnsCfg, { fetch: deps.fetch, now: deps.now, production: deps.endpoints?.apnsProduction, sandbox: deps.endpoints?.apnsSandbox }) : null
  const fcmCfg = parseServiceAccount(env.FCM_SERVICE_ACCOUNT)
  const fcm = fcmCfg ? createFcm(fcmCfg, { fetch: deps.fetch, now: deps.now, origin: deps.endpoints?.fcm }) : null
  if (env.FCM_SERVICE_ACCOUNT && !fcmCfg) deps.log({ evt: 'config', outcome: 'fcm_invalid' })

  async function send(req: Request): Promise<Response> {
    let platform: PushPlatform | undefined
    const fail = (error: PushGatewayErrorCode, extra: Record<string, string> = {}) => {
      const status = PUSH_GATEWAY_ERRORS[error]
      deps.log({ evt: 'push', outcome: error, platform, status })
      return answer(status, { ok: false, error }, extra)
    }

    const body = await readBounded(req, PUSH_GATEWAY_MAX_BODY_BYTES)
    if (!body) return fail('body_too_large')
    const auth = parsePushGatewayAuthorization(req.headers.get('authorization'))
    if (!auth) return fail('unauthorized')
    if (Math.abs(deps.now() - auth.ts) > PUSH_GATEWAY_MAX_SKEW_MS) return fail('clock_skew')
    const team = await importTeamKey(auth.key)
    if (!team) return fail('unauthorized')
    if (!(await verifyEd25519(team.key, auth.sig, pushGatewaySigningString(auth.ts, await sha256Hex(body))))) return fail('unauthorized')

    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    } catch {
      return fail('invalid_body')
    }
    const msg = parsePushGatewaySend(raw)
    if (!msg) return fail('invalid_body')
    platform = msg.platform

    if (await deps.state.isBlocked(team.keyId)) return fail('key_blocked')
    const provider = msg.platform === 'ios' ? apns : fcm
    if (!provider) return fail('not_configured')
    if (msg.platform === 'ios' && msg.environment === 'sandbox' && !apnsCfg?.sandbox) return fail('unsupported_environment')

    const tokenId = await sha256Hex(msg.token)
    const dedupeId = `${tokenId}:${msg.notificationId}`
    const now = deps.now()
    const k = await deps.state.admitKey(team.keyId, dedupeId, now)
    if (k.kind === 'duplicate') {
      deps.log({ evt: 'push', outcome: 'duplicate', platform, status: 200 })
      return answer(200, { ok: true })
    }
    if (k.kind === 'limited') return fail('rate_limited', { 'retry-after': String(k.retryAfterSec) })
    const t = await deps.state.admitToken(tokenId, now)
    if (t.kind === 'limited') {
      await deps.state.release(team.keyId, dedupeId)
      return fail('rate_limited', { 'retry-after': String(t.retryAfterSec) })
    }

    let outcome: SendOutcome
    try {
      outcome = await provider.send(msg, { title, body: alertBody(msg.code, msg.locale) })
    } catch {
      outcome = 'provider_error'
    }
    if (outcome === 'sent') {
      deps.log({ evt: 'push', outcome: 'sent', platform, status: 200 })
      return answer(200, { ok: true })
    }
    await deps.state.release(team.keyId, dedupeId)
    return fail(outcome)
  }

  return {
    async handle(req: Request): Promise<Response> {
      const { pathname } = new URL(req.url)
      if (req.method === 'GET' && pathname === PUSH_GATEWAY_HEALTH_PATH) return answer(200, { ok: true })
      if (req.method === 'POST' && pathname === PUSH_GATEWAY_SEND_PATH) {
        try {
          return await send(req)
        } catch {
          deps.log({ evt: 'push', outcome: 'internal', status: PUSH_GATEWAY_ERRORS.internal })
          return answer(PUSH_GATEWAY_ERRORS.internal, { ok: false, error: 'internal' })
        }
      }
      return answer(PUSH_GATEWAY_ERRORS.not_found, { ok: false, error: 'not_found' })
    },
  }
}
