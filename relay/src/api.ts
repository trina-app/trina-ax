// Registry HTTP API on the relay's own address (relay.<domain>, or the bare host in dev). Design tab 6:
//   GET    /healthz                  liveness
//   GET    /teams/pow                proof-of-work difficulty
//   POST   /teams                    register: name + Ed25519 public key + signature + proof of work -> recovery code (once)
//   GET    /teams/:id                status (signed)
//   POST   /teams/:id/heartbeat      daily: version and member count only (signed)
//   PATCH  /teams/:id                rename (old name held 1 year) / key rotation (signed by the current key, or recovery code)
//   DELETE /teams/:id                release the address (name held 1 year), revoke the key (signed)
import type http from 'node:http'
import {
  ControlClose, POW_MAX_AGE_MS, normalizeTeamName, parseAuthorizationHeader,
  type HeartbeatRequest, type RegisterRequest, type RegisterResponse, type RegistryErrorCode, type TeamInfo, type UpdateTeamRequest,
} from '@mycel/shared/relay-protocol'
import { teamAddress } from './config.ts'
import { RegistryError, type TeamRow } from './registry.ts'
import { RELAY_VERSION, sendJson, type RelayServer } from './relay.ts'

const MAX_BODY = 16 * 1024

function fail(res: http.ServerResponse, status: number, code: RegistryErrorCode, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const ch of req as AsyncIterable<Buffer>) {
    n += ch.byteLength
    if (n > MAX_BODY) return null
    chunks.push(ch)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function info(relay: RelayServer, t: TeamRow): TeamInfo {
  return { teamId: t.id, name: t.name, status: t.status, address: teamAddress(relay.cfg, t.name), lastHeartbeatAt: t.last_heartbeat_at }
}

export async function handleRegistryApi(relay: RelayServer, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://relay.invalid')
  const path = url.pathname
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && path === '/healthz') return sendJson(res, 200, { ok: true, version: RELAY_VERSION })
    if (method === 'GET' && path === '/teams/pow') return sendJson(res, 200, { bits: relay.cfg.powBits, maxAgeMs: POW_MAX_AGE_MS })
    if (!path.startsWith('/teams')) return fail(res, 404, 'not_found', 'not found')
    const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(req)
    if (body === null) return fail(res, 413, 'invalid_request', 'body too large')
    let json: unknown = {}
    if (body) {
      try { json = JSON.parse(body) } catch { return fail(res, 400, 'invalid_request', 'body must be JSON') }
      if (typeof json !== 'object' || json === null || Array.isArray(json)) return fail(res, 400, 'invalid_request', 'body must be a JSON object')
    }

    if (method === 'POST' && path === '/teams') {
      if (!relay.allowRegistration(req)) return fail(res, 429, 'rate_limited', 'too many registrations, try again later')
      const r = json as RegisterRequest
      const out = relay.registry.register({ ...r, name: normalizeTeamName(String(r.name ?? '')) }, relay.cfg.powBits)
      relay.invalidateNames()
      relay.log.info('team_registered', { team: out.teamId })
      const reply: RegisterResponse = { ...out, address: teamAddress(relay.cfg, out.name) }
      return sendJson(res, 201, reply)
    }

    const m = /^\/teams\/([A-Za-z0-9-]{1,64})(\/heartbeat)?$/.exec(path)
    if (!m) return fail(res, 404, 'not_found', 'not found')
    const teamId = m[1]
    const auth = parseAuthorizationHeader(req.headers.authorization)
    const update = method === 'PATCH' && !m[2] ? (json as UpdateTeamRequest) : null
    let team: TeamRow
    if (update?.recoveryCode && !auth) {
      // lost key: the recovery code shown at registration replaces the signature (key rotation only)
      const t = relay.registry.team(teamId)
      if (!t || t.status === 'released' || !relay.registry.checkRecoveryCode(teamId, update.recoveryCode)) return fail(res, 401, 'unauthorized', 'bad recovery code')
      if (!update.publicKey || update.name) return fail(res, 400, 'invalid_request', 'a recovery code can only rotate the key')
      team = t
    } else {
      if (!auth || auth.team !== teamId) return fail(res, 401, 'unauthorized', 'signed request required')
      team = relay.registry.verifyApi(teamId, method, path, auth.ts, body, auth.sig)
    }

    if (method === 'GET' && !m[2]) return sendJson(res, 200, info(relay, team))
    if (method === 'POST' && m[2]) {
      const h = json as HeartbeatRequest
      relay.registry.heartbeat(teamId, String(h.version ?? ''), Number(h.members ?? 0))
      return sendJson(res, 200, info(relay, relay.registry.team(teamId)!))
    }
    if (update) {
      if (team.status === 'suspended') return fail(res, 403, 'suspended', 'team suspended')
      if (update.name !== undefined) relay.registry.rename(teamId, normalizeTeamName(String(update.name)))
      if (update.publicKey !== undefined) {
        relay.registry.rotateKey(teamId, String(update.publicKey), String(update.newKeySig ?? ''))
        relay.disconnectTeam(teamId, ControlClose.AUTH_FAILED, 'key rotated')
      }
      relay.invalidateNames()
      relay.log.info('team_updated', { team: teamId, renamed: update.name !== undefined, rotated: update.publicKey !== undefined })
      return sendJson(res, 200, info(relay, relay.registry.team(teamId)!))
    }
    if (method === 'DELETE' && !m[2]) {
      relay.registry.release(teamId)
      relay.invalidateNames()
      relay.disconnectTeam(teamId, ControlClose.AUTH_FAILED, 'team released')
      relay.log.info('team_released', { team: teamId })
      return sendJson(res, 200, info(relay, relay.registry.team(teamId)!))
    }
    return fail(res, 405, 'invalid_request', 'method not allowed')
  } catch (e) {
    if (e instanceof RegistryError) return fail(res, e.status, e.code, e.message)
    relay.log.error('api_error', { error: e instanceof Error ? e.message : 'unknown' })
    return fail(res, 500, 'internal', 'internal error')
  }
}
