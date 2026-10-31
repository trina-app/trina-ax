// Relay operator API (control-plane 3.6.2) on the PRIVATE listener only (RELAY_PRIVATE_LISTEN, the relay's Tailscale
// address; the Tailscale ACL lets only tag:cp in). The public listener answers 404 for /ops.
//
// Every request is signed: Authorization: MycelRelayOps key=<keyId>, ts=<ms>, sig=<b64> over
// opsSigningString(method, path?query, ts, body) by a key in operator-keys.json. Checks, in order: a key we know
// (401 unauthorized), ts within ±60 s (401), the signature (401), the same signature not seen in the last 120 s
// (409 replayed), the key's scope for the endpoint (403 forbidden). Writes are idempotent where the control plane
// retries (create by externalRef, suspend, unsuspend, maintenance, same key again, delete of a released team) and every
// write goes to the registry's ops_audit (key id, action, team id; never IPs).
import fs from 'node:fs'
import type http from 'node:http'
import {
  ControlClose, keyRotationString, normalizeTeamName, parsePublicKey, verifyB64,
} from '@mycel/shared/relay-protocol'
import {
  MAX_HOLD_TTL_SEC, OPS_MAX_BODY, OPS_REPLAY_MAX, OPS_REPLAY_WINDOW_MS, OPS_SCOPES, OPS_SIG_MAX_SKEW_MS, TEAM_ORIGINS,
  opsScopeFor, opsSigningString, parseClaimRequest, parseCreateTeamRequest, parseHoldRequest, parseKeyRequest,
  parseMaintenanceRequest, parseNoticeRequest, parseOpsAuthorizationHeader, parseRenameRequest, parseSleepRequest, parseSuspendRequest,
  type OperatorKey, type OperatorTeamInfo, type OpsErrorCode, type OpsScope, type OpsStats, type Parsed, type TeamOrigin,
} from '@mycel/shared/cloud-protocol/relay-ops'
import { teamAddress } from './config.ts'
import { RegistryError, type TeamRow } from './registry.ts'
import type { RelayServer } from './relay.ts'

export class OpsKeysError extends Error { name = 'OpsKeysError' }

/** Parse operator-keys.json; throws on anything malformed (a typo must not silently drop or widen a key). */
export function parseOperatorKeys(text: string): OperatorKey[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new OpsKeysError('operator-keys.json is not JSON') }
  if (!Array.isArray(raw)) throw new OpsKeysError('operator-keys.json must be an array')
  const seen = new Set<string>()
  return raw.map((k, i) => {
    const o = k as Record<string, unknown>
    if (typeof o !== 'object' || o === null) throw new OpsKeysError(`key ${i}: not an object`)
    if (typeof o.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(o.keyId)) throw new OpsKeysError(`key ${i}: keyId`)
    if (seen.has(o.keyId)) throw new OpsKeysError(`key ${o.keyId}: listed twice`)
    seen.add(o.keyId)
    if (typeof o.publicKey !== 'string' || !parsePublicKey(o.publicKey)) throw new OpsKeysError(`key ${o.keyId}: publicKey must be a base64 SPKI Ed25519 key`)
    if (!Array.isArray(o.scopes) || !o.scopes.length || !o.scopes.every((s) => (OPS_SCOPES as readonly unknown[]).includes(s))) throw new OpsKeysError(`key ${o.keyId}: scopes must be some of ${OPS_SCOPES.join(', ')}`)
    return { keyId: o.keyId, publicKey: o.publicKey, label: typeof o.label === 'string' ? o.label : '', scopes: o.scopes as OpsScope[] }
  })
}

// (no parameter properties: Node strips types only, it does not transform TypeScript)
class OpsFail extends Error {
  readonly status: number
  readonly code: OpsErrorCode
  constructor(status: number, code: OpsErrorCode, message: string) { super(message); this.status = status; this.code = code }
}

const take = <T>(p: Parsed<T>): T => { if (!p.ok) throw new OpsFail(400, 'invalid_request', p.message); return p.value }

export class OpsApi {
  private keys: OperatorKey[] = []
  private keysMtime = -1
  private keysError: string | null = null
  /** signature -> time it may be used again (replay cache, memory only) */
  private seen = new Map<string, number>()
  readonly counters = { requests: 0, authFailures: 0, replays: 0, forbidden: 0 }

  private relay: RelayServer
  private keysFile: string | null
  private now: () => number

  constructor(relay: RelayServer, keysFile: string | null, now: () => number = Date.now) {
    this.relay = relay
    this.keysFile = keysFile
    this.now = now
    this.reloadKeys()
  }

  /** Re-read operator-keys.json when it changed (key rotation: the new key is added first, the old one removed later). */
  private reloadKeys(): void {
    if (!this.keysFile) return
    try {
      const st = fs.statSync(this.keysFile)
      if (st.mtimeMs === this.keysMtime) return
      this.keys = parseOperatorKeys(fs.readFileSync(this.keysFile, 'utf8'))
      this.keysMtime = st.mtimeMs
      this.keysError = null
      this.relay.log.info('ops_keys_loaded', { keys: this.keys.length })
    } catch (e) {
      // keep nothing usable from a broken file: fail closed, say why once
      const why = e instanceof Error ? e.message : 'unreadable'
      if (why !== this.keysError) this.relay.log.error('ops_keys_unusable', { error: why })
      this.keysError = why
      this.keys = []
      this.keysMtime = -1
    }
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.counters.requests++
    const method = (req.method ?? 'GET').toUpperCase()
    const target = req.url ?? '/'
    const url = new URL(target, 'http://relay.invalid')
    try {
      const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(req)
      if (body === null) throw new OpsFail(413, 'invalid_request', 'body too large')
      const key = this.authenticate(req, method, target, body)
      const scope = opsScopeFor(method, url.pathname)
      if (!scope) throw new OpsFail(404, 'not_found', 'no such operator endpoint')
      if (!key.scopes.includes(scope)) { this.counters.forbidden++; throw new OpsFail(403, 'forbidden', `key ${key.keyId} lacks scope ${scope}`) }
      let json: unknown = null
      if (body) {
        try { json = JSON.parse(body) } catch { throw new OpsFail(400, 'invalid_request', 'body must be JSON') }
      }
      this.route(method, url, json, key.keyId, res)
    } catch (e) {
      if (e instanceof OpsFail) return send(res, e.status, { error: { code: e.code, message: e.message } })
      if (e instanceof RegistryError) return send(res, e.status, { error: { code: e.code as OpsErrorCode, message: e.message } })
      this.relay.log.error('ops_error', { error: e instanceof Error ? e.name : 'unknown' })
      return send(res, 500, { error: { code: 'internal', message: 'internal error' } })
    }
  }

  private authenticate(req: http.IncomingMessage, method: string, target: string, body: string): OperatorKey {
    this.reloadKeys()
    const auth = parseOpsAuthorizationHeader(req.headers.authorization)
    const fail = (message: string) => { this.counters.authFailures++; return new OpsFail(401, 'unauthorized', message) }
    if (!auth) throw fail('signed request required (Authorization: MycelRelayOps key=..., ts=..., sig=...)')
    const key = this.keys.find((k) => k.keyId === auth.keyId)
    if (!key) throw fail('unknown operator key')
    const now = this.now()
    if (Math.abs(now - auth.ts) > OPS_SIG_MAX_SKEW_MS) throw fail('request timestamp out of range (check the clock)')
    if (!verifyB64(key.publicKey, opsSigningString(method, target, auth.ts, body), auth.sig)) throw fail('bad signature')
    // replay: the same signed request again within the window (after the signature check: only real signatures are kept)
    for (const [s, until] of this.seen) { if (until > now) break; this.seen.delete(s) }
    if (this.seen.has(auth.sig)) { this.counters.replays++; throw new OpsFail(409, 'replayed', 'this signed request was already used; sign it again') }
    if (this.seen.size >= OPS_REPLAY_MAX) { const first = this.seen.keys().next().value; if (first !== undefined) this.seen.delete(first) }
    this.seen.set(auth.sig, now + OPS_REPLAY_WINDOW_MS)
    return key
  }

  private info(t: TeamRow): OperatorTeamInfo {
    const live = this.relay.teamStatus(t.id)
    return {
      teamId: t.id, name: t.name, status: t.status, address: teamAddress(this.relay.cfg, t.name), lastHeartbeatAt: t.last_heartbeat_at,
      origin: t.origin, externalRef: t.external_ref, region: t.region, suspendReason: t.suspend_reason,
      maintenanceUntil: t.maintenance_until && Date.parse(t.maintenance_until) > this.now() ? t.maintenance_until : null,
      sleepingSince: t.sleeping_since ?? null,
      online: live.online, conns: live.conns, lastConnectedAt: t.last_connected_at, lastVersion: t.last_version,
      memberCount: t.member_count === null || t.member_count === undefined ? null : Number(t.member_count), createdAt: t.created_at,
    }
  }

  private team(id: string, o: { live?: boolean } = { live: true }): TeamRow {
    const t = /^[A-Za-z0-9-]{1,64}$/.test(id) ? this.relay.registry.team(id) : undefined
    if (!t || (o.live && t.status === 'released')) throw new OpsFail(404, 'not_found', 'no such team')
    return t
  }

  private audit(keyId: string, action: string, teamId: string | null, detail: string | null = null): void {
    this.relay.registry.audit(keyId, action, teamId, detail)
    this.relay.log.info('ops', { key: keyId, action, team: teamId })
  }

  private route(method: string, url: URL, json: unknown, keyId: string, res: http.ServerResponse): void {
    const reg = this.relay.registry
    const p = url.pathname.slice('/ops/v1'.length)
    let seg: string[]
    try { seg = p.split('/').filter(Boolean).map((s) => decodeURIComponent(s)) } catch { throw new OpsFail(400, 'invalid_request', 'bad escape in the path') }
    const changed = () => this.relay.invalidateNames()

    if (method === 'GET' && seg[0] === 'stats') {
      const s: OpsStats = { teams: reg.counts(), ...this.relay.liveCounts() }
      return send(res, 200, s)
    }
    if (method === 'GET' && seg[0] === 'names' && seg.length === 2) {
      const name = normalizeTeamName(seg[1]!)
      const problem = reg.nameProblem(name)
      return send(res, 200, { name, available: problem === null, problem })
    }
    if (seg[0] === 'holds') {
      if (method === 'POST') {
        const b = take(parseHoldRequest(json))
        const name = normalizeTeamName(b.name)
        const holdUntil = reg.hold(name, Math.min(b.ttlSec, MAX_HOLD_TTL_SEC) * 1000)
        this.audit(keyId, 'holds.create', null, `name=${name} ttl=${b.ttlSec}`)
        changed()
        return send(res, 200, { name, holdUntil })
      }
      const name = normalizeTeamName(seg[1] ?? '')
      if (reg.unhold(name)) { this.audit(keyId, 'holds.delete', null, `name=${name}`); changed() }
      return send(res, 204, null)
    }
    if (seg[0] === 'claims') {
      if (method === 'POST') {
        const b = take(parseClaimRequest(json))
        const name = normalizeTeamName(b.name)
        const out = reg.createClaim({ name, ttlMs: b.ttlSec * 1000, externalRef: b.externalRef })
        this.audit(keyId, 'claims.create', null, `name=${name} ref=${b.externalRef}`)
        changed()
        return send(res, 201, { name, code: out.code, expiresAt: out.expiresAt })
      }
      const ref = seg[1] ?? ''
      const n = reg.deleteClaims(ref)
      if (n) { this.audit(keyId, 'claims.delete', null, `ref=${ref.slice(0, 128)}`); changed() }
      return send(res, 204, null)
    }
    if (seg[0] !== 'teams') throw new OpsFail(404, 'not_found', 'no such operator endpoint')

    if (seg.length === 1) {
      if (method === 'GET') {
        const origin = url.searchParams.get('origin')
        if (origin && !(TEAM_ORIGINS as readonly string[]).includes(origin)) throw new OpsFail(400, 'invalid_request', 'origin: self, cloud or addon')
        const limit = Number(url.searchParams.get('limit') ?? 100)
        const { rows, next } = reg.page({ origin: (origin as TeamOrigin | null) ?? undefined, cursor: url.searchParams.get('cursor'), limit: Number.isFinite(limit) ? limit : 100 })
        return send(res, 200, { teams: rows.map((t) => this.info(t)), next })
      }
      // POST /teams: the control plane creates a team with the tenant's own key
      const b = take(parseCreateTeamRequest(json))
      const { team, created } = reg.createByOperator({ ...b, name: normalizeTeamName(b.name) })
      if (created) {
        this.relay.counters.regOperator++
        this.audit(keyId, 'teams.create', team.id, `origin=${team.origin}`)
        changed()
      }
      return send(res, created ? 201 : 200, this.info(team))
    }

    const id = seg[1]!
    const action = seg[2]
    if (method === 'GET' && !action) return send(res, 200, this.info(this.team(id, { live: false })))
    if (method === 'DELETE' && !action) {
      const t = this.team(id, { live: false })
      if (t.status !== 'released') {
        reg.release(id)
        changed()
        this.relay.disconnectTeam(id, ControlClose.AUTH_FAILED, 'team released')
        this.audit(keyId, 'teams.delete', id)
      }
      return send(res, 200, this.info(reg.team(id)!))
    }
    if (method === 'PATCH' && !action) {
      const b = take(parseRenameRequest(json))
      this.team(id)
      reg.rename(id, normalizeTeamName(b.name))
      changed()
      this.audit(keyId, 'teams.rename', id)
      return send(res, 200, this.info(reg.team(id)!))
    }
    if (method === 'PUT' && action === 'key') {
      const b = take(parseKeyRequest(json))
      this.team(id)
      const cur = reg.currentKey(id)
      if (cur?.public_key === b.publicKey) {
        // the same rotation again (a retried job): already done, as long as the new key really signed it
        if (!verifyB64(b.publicKey, keyRotationString(id, b.publicKey), b.newKeySig)) throw new OpsFail(401, 'bad_signature', 'the new key did not sign the rotation')
        return send(res, 200, this.info(reg.team(id)!))
      }
      reg.rotateKey(id, b.publicKey, b.newKeySig)
      this.relay.disconnectTeam(id, ControlClose.AUTH_FAILED, 'key rotated')
      this.audit(keyId, 'teams.key', id)
      return send(res, 200, this.info(reg.team(id)!))
    }
    if (method === 'POST' && action === 'suspend') {
      const b = take(parseSuspendRequest(json))
      const t = this.team(id)
      if (t.status !== 'suspended' || t.suspend_reason !== b.reason) {
        reg.setStatus(id, 'suspended', b.reason)
        changed()
        this.audit(keyId, 'teams.suspend', id, `reason=${b.reason}`)
      }
      this.relay.suspendNow(id)
      return send(res, 200, this.info(reg.team(id)!))
    }
    if (method === 'POST' && action === 'unsuspend') {
      const t = this.team(id)
      if (t.status === 'suspended') {
        reg.setStatus(id, 'active')
        changed()
        this.audit(keyId, 'teams.unsuspend', id)
      }
      return send(res, 200, this.info(reg.team(id)!))
    }
    if (method === 'POST' && action === 'maintenance') {
      const b = take(parseMaintenanceRequest(json, this.now()))
      this.team(id)
      reg.setMaintenance(id, b.untilMs)
      changed()
      this.audit(keyId, 'teams.maintenance', id, b.untilMs === null ? 'off' : `until=${new Date(b.untilMs).toISOString()}`)
      return send(res, 204, null)
    }
    if (method === 'POST' && action === 'sleep') {
      // F2: the control plane marks the team asleep just before it hibernates the VM (and awake again when a wake
      // fails or is cancelled). Live connections stay: they drop when the VM sleeps; a connect clears the flag.
      const b = take(parseSleepRequest(json))
      const t = this.team(id)
      if (!!t.sleeping_since !== b.sleeping) {
        reg.setSleeping(id, b.sleeping)
        changed()
        this.audit(keyId, 'teams.sleep', id, b.sleeping ? 'on' : 'off')
      }
      return send(res, 200, this.info(reg.team(id)!))
    }
    if (method === 'POST' && action === 'notice') {
      const b = take(parseNoticeRequest(json))
      this.team(id)
      if (!this.relay.sendNotice(id, { type: 'notice', level: b.level, code: b.code, message: b.message, at: this.now() })) throw new OpsFail(409, 'conflict', 'the team server is not connected')
      this.audit(keyId, 'teams.notice', id, `code=${b.code}`)
      return send(res, 204, null)
    }
    throw new OpsFail(404, 'not_found', 'no such operator endpoint')
  }
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const ch of req as AsyncIterable<Buffer>) {
    n += ch.byteLength
    if (n > OPS_MAX_BODY) return null
    chunks.push(ch)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: http.ServerResponse, status: number, o: unknown): void {
  if (res.headersSent) { res.destroy(); return }
  if (status === 204) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return }
  const body = JSON.stringify(o)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' })
  res.end(body)
}
