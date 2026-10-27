// Registering this team server's address at a relay, and the daily heartbeat (tab 6 "팀 등록·인증").
// The Ed25519 private key lives in <data>/relay/team-key.pem (0600); the relay only ever sees the public key.
// The recovery code is shown once: it goes to <data>/relay/recovery-code.txt (0600) and the log, for the owner to
// print and keep.
//
// Three ways to get the address (control-plane SV-4, SV-9):
//   1. <data>/relay/registration.json (the hosted service: the control plane registered the address with this server's
//      own key through the relay's operator API; mycel-enroll / `mycel-ctl relay-registration-set` writes the file).
//      Adopted as is, no proof of work; it wins over what the DB had (address change, key rotation).
//   2. a claim code (the official relay add-on for self-hosted servers: Admin > System > connection), used once.
//   3. public registration with proof of work (self-hosted relays; the production relay has it closed).
// A hosted server (deployment "hosted") never registers by itself: without the file it waits (awaiting_operator).
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { KeyObject } from 'node:crypto'
import { uuidv7 } from '@mycel/shared'
import {
  apiSigningString, authorizationHeader, generateTeamKey, keyRotationString, loadPrivateKey, powInput, publicKeyOf,
  registerSigningString, signB64,
  type PowInfo, type RegisterRequest, type RegisterResponse, type RegistryError, type TeamInfo, type UpdateTeamRequest,
} from '@mycel/shared/relay-protocol'
import { createHash } from 'node:crypto'
import { RelayRegistrationFile } from '@mycel/shared/cloud-protocol'

export interface Registration {
  relayApi: string
  teamId: string
  teamName: string
  publicKey: string
  address: string
  registeredAt: string
  lastHeartbeatAt: string | null
}

export class RelayRegistrationError extends Error {
  name = 'RelayRegistrationError'
  code: string
  status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

export const REGISTRATION_FILE = 'registration.json'
export const CLAIM_FILE = 'claim.json'

const sameApi = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/** <data>/relay/registration.json, or null when there is none. Throws registration_file_invalid when it is unusable. */
export function readRegistrationFile(dataDir: string): RelayRegistrationFile | null {
  const file = path.join(dataDir, 'relay', REGISTRATION_FILE)
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new RelayRegistrationError('registration_file_invalid', `${file} is not readable: ${(e as Error).message}`)
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new RelayRegistrationError('registration_file_invalid', `${file} is not JSON`) }
  const p = RelayRegistrationFile.safeParse(raw)
  if (!p.success) throw new RelayRegistrationError('registration_file_invalid', `${file}: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  return p.data
}

/**
 * The hosted service's registration (control-plane SV-4): take <data>/relay/registration.json when it names this relay
 * and this server's key. Null when there is no file. The file wins over the DB row (the control plane rewrote it after
 * a rename or a key rotation).
 */
export function adoptRegistrationFile(db: Database, dataDir: string, relayApi: string, publicKey: string): Registration | null {
  const f = readRegistrationFile(dataDir)
  if (!f) return null
  if (!sameApi(f.relayApi, relayApi)) throw new RelayRegistrationError('registration_other_relay', `registration.json is for ${f.relayApi}, this server connects to ${relayApi}`)
  if (f.publicKey !== publicKey) throw new RelayRegistrationError('registration_key_mismatch', 'registration.json names another team key than <data>/relay/team-key.pem')
  const existing = getRegistration(db, relayApi)
  if (existing && existing.teamId === f.teamId && existing.teamName === f.teamName && existing.publicKey === publicKey && existing.address === f.address) return existing
  const reg: Registration = {
    relayApi, teamId: f.teamId, teamName: f.teamName, publicKey, address: f.address,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(), lastHeartbeatAt: existing?.teamId === f.teamId ? existing.lastHeartbeatAt : null,
  }
  saveRegistration(db, reg)
  recordRelayEvent(db, 'adopted', f.address)
  return reg
}

/** The relay answered "unknown team" for the adopted registration: keep the file aside, wait for a new one. */
export function rejectRegistrationFile(dataDir: string): void {
  const file = path.join(dataDir, 'relay', REGISTRATION_FILE)
  try { fs.renameSync(file, `${file}.rejected`) } catch { /* gone already */ }
}

export interface ClaimCode { relayApi: string; name: string; code: string }

/** A claim code from the connection screen (official relay add-on), kept until the registration used it (0600). */
export function saveClaimCode(dataDir: string, c: ClaimCode): void {
  const file = path.join(relayDir(dataDir), CLAIM_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(c) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readClaimCode(dataDir: string): ClaimCode | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', CLAIM_FILE), 'utf8')) as ClaimCode
    return typeof c.relayApi === 'string' && typeof c.name === 'string' && typeof c.code === 'string' ? c : null
  } catch { return null }
}

export function clearClaimCode(dataDir: string): void {
  fs.rmSync(path.join(dataDir, 'relay', CLAIM_FILE), { force: true })
}

export function relayDir(dataDir: string): string {
  const d = path.join(dataDir, 'relay')
  fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  return d
}

/** Load the team key, creating it (0600) on first use. */
export function loadOrCreateKey(dataDir: string): { key: KeyObject; publicKey: string; created: boolean } {
  const file = path.join(relayDir(dataDir), 'team-key.pem')
  let created = false
  if (!fs.existsSync(file)) {
    const kp = generateTeamKey()
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, kp.privatePem, { mode: 0o600 })
    fs.renameSync(tmp, file)
    created = true
  }
  const st = fs.statSync(file)
  if ((st.mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
  const key = loadPrivateKey(fs.readFileSync(file, 'utf8'))
  return { key, publicKey: publicKeyOf(key), created }
}

export function getRegistration(db: Database, relayApi: string): Registration | null {
  const r = db.query('SELECT relay_api, team_id, team_name, public_key, address, registered_at, last_heartbeat_at FROM relay_registrations WHERE relay_api = ?').get(relayApi) as
    | { relay_api: string; team_id: string; team_name: string; public_key: string; address: string; registered_at: string; last_heartbeat_at: string | null }
    | null
  return r ? { relayApi: r.relay_api, teamId: r.team_id, teamName: r.team_name, publicKey: r.public_key, address: r.address, registeredAt: r.registered_at, lastHeartbeatAt: r.last_heartbeat_at } : null
}

export function forgetRegistration(db: Database, relayApi: string): void {
  db.query('DELETE FROM relay_registrations WHERE relay_api = ?').run(relayApi)
}

function saveRegistration(db: Database, r: Registration): void {
  db.query(`INSERT INTO relay_registrations (relay_api, team_id, team_name, public_key, address, registered_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(relay_api) DO UPDATE SET team_id = excluded.team_id, team_name = excluded.team_name, public_key = excluded.public_key, address = excluded.address, registered_at = excluded.registered_at, last_heartbeat_at = excluded.last_heartbeat_at`)
    .run(r.relayApi, r.teamId, r.teamName, r.publicKey, r.address, r.registeredAt, r.lastHeartbeatAt)
}

export function recordRelayEvent(db: Database, kind: string, detail: string | null = null): void {
  try {
    db.query('INSERT INTO relay_events (id, at, kind, detail) VALUES (?, ?, ?, ?)').run(uuidv7(), new Date().toISOString(), kind, detail)
    db.query(`DELETE FROM relay_events WHERE at < ?`).run(new Date(Date.now() - 30 * 24 * 3600_000).toISOString())
  } catch { /* diagnostics only */ }
}

export function recentRelayEvents(db: Database, limit = 20): { at: string; kind: string; detail: string | null }[] {
  return db.query('SELECT at, kind, detail FROM relay_events ORDER BY at DESC LIMIT ?').all(limit) as never
}

async function call<T>(url: string, init: RequestInit, timeoutMs = 15_000): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new RelayRegistrationError('unreachable', `relay not reachable: ${(e as Error).message}`)
  }
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!res.ok) {
    const err = (body as RegistryError | null)?.error
    throw new RelayRegistrationError(err?.code ?? 'http_' + res.status, err?.message ?? `relay answered ${res.status}`, res.status)
  }
  return body as T
}

/** Proof of work without blocking the event loop for long (yields every 20k hashes). */
export async function solvePow(r: Pick<RegisterRequest, 'name' | 'publicKey' | 'ts'>, bits: number): Promise<string> {
  for (let i = 0; ; i++) {
    const nonce = i.toString(36)
    const d = createHash('sha256').update(powInput(r, nonce)).digest()
    let z = 0
    for (const byte of d) { if (byte === 0) { z += 8; continue } z += Math.clz32(byte) - 24; break }
    if (z >= bits) return nonce
    if (i % 20_000 === 19_999) await new Promise((res) => setTimeout(res, 0))
  }
}

/**
 * Register `name` at the relay unless this key is already registered there. Returns the registration.
 * hosted: the control plane registers the address (registration.json); never register here, wait for the file.
 */
export async function ensureRegistered(o: { db: Database; dataDir: string; relayApi: string; name: string; key: KeyObject; publicKey: string; hosted?: boolean; log: { info(m: string, f?: object): void; warn(m: string, f?: object): void } }): Promise<Registration> {
  const adopted = adoptRegistrationFile(o.db, o.dataDir, o.relayApi, o.publicKey)
  if (adopted) return adopted
  const existing = getRegistration(o.db, o.relayApi)
  if (existing && existing.publicKey === o.publicKey) return existing
  // this team already has the address there, under another key (restored on another Mac, or the key file was lost):
  // registering again would only find the name taken. The owner moves it with the recovery code (recoverWithCode).
  if (existing) throw new RelayRegistrationError('recovery_needed', `the team address ${existing.address} is registered with another key; enter the recovery code to move it to this server`)
  if (o.hosted) throw new RelayRegistrationError('awaiting_operator', 'the hosted service registers this team address; waiting for <data>/relay/registration.json')
  if (!o.name) throw new RelayRegistrationError('team_name_missing', 'no team name to register')
  const ts = Date.now()
  const base = { name: o.name, publicKey: o.publicKey, ts }
  const sig = signB64(o.key, registerSigningString(o.name, o.publicKey, ts))
  const claim = readClaimCode(o.dataDir)
  const useClaim = claim && sameApi(claim.relayApi, o.relayApi) && claim.name === o.name ? claim : null
  let req: RegisterRequest
  if (useClaim) {
    // the official relay add-on: the code from the account console replaces the proof of work
    req = { ...base, sig, claimCode: useClaim.code }
  } else {
    const pow = await call<PowInfo>(`${o.relayApi}/teams/pow`, { method: 'GET' })
    if (pow.open === false) throw new RelayRegistrationError('registration_closed', 'this relay registers team addresses with a claim code only: enter the code from the account console')
    req = { ...base, nonce: await solvePow(base, pow.bits), sig }
  }
  const r = await call<RegisterResponse>(`${o.relayApi}/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
  if (useClaim) clearClaimCode(o.dataDir)
  const reg: Registration = { relayApi: o.relayApi, teamId: r.teamId, teamName: r.name, publicKey: o.publicKey, address: r.address, registeredAt: new Date().toISOString(), lastHeartbeatAt: null }
  saveRegistration(o.db, reg)
  const file = path.join(relayDir(o.dataDir), 'recovery-code.txt')
  fs.writeFileSync(file, [
    `Team address: ${r.address}`,
    `Relay: ${o.relayApi}`,
    `Team id: ${r.teamId}`,
    `Recovery code: ${r.recoveryCode}`,
    '',
    'Print this and keep it somewhere safe, then delete this file. The recovery code lets you move the team address',
    'to a new server key if this server is lost. It is shown only once.',
    '',
  ].join('\n'), { mode: 0o600 })
  recordRelayEvent(o.db, 'registered', r.address)
  o.log.warn('relay: team address registered; the recovery code was saved once, print it and delete the file', { address: r.address, file })
  return reg
}

/**
 * Lost key / restore: move the registered address (team id from this server's registration) to the current key with
 * the recovery code. The new key signs the rotation; the relay disconnects whatever still uses the old key.
 */
export async function recoverWithCode(o: { db: Database; relayApi: string; key: KeyObject; publicKey: string; recoveryCode: string; teamId?: string }): Promise<Registration> {
  const existing = getRegistration(o.db, o.relayApi)
  const teamId = o.teamId ?? existing?.teamId
  if (!teamId) throw new RelayRegistrationError('not_registered', 'this server has no team address at this relay to recover')
  const code = o.recoveryCode.trim()
  if (!code) throw new RelayRegistrationError('invalid_request', 'recovery code required')
  const body: UpdateTeamRequest = { publicKey: o.publicKey, newKeySig: signB64(o.key, keyRotationString(teamId, o.publicKey)), recoveryCode: code }
  const info = await call<TeamInfo>(`${o.relayApi}/teams/${teamId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const reg: Registration = {
    relayApi: o.relayApi, teamId: info.teamId, teamName: info.name, publicKey: o.publicKey, address: info.address,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(), lastHeartbeatAt: info.lastHeartbeatAt,
  }
  saveRegistration(o.db, reg)
  recordRelayEvent(o.db, 'recovered', info.address)
  return reg
}

async function signed<T>(o: { relayApi: string; teamId: string; key: KeyObject }, method: string, p: string, body: unknown): Promise<T> {
  const text = body === undefined ? '' : JSON.stringify(body)
  const ts = Date.now()
  const sig = signB64(o.key, apiSigningString(method, p, ts, text))
  return call<T>(`${o.relayApi}${p}`, { method, headers: { authorization: authorizationHeader(o.teamId, ts, sig), ...(text ? { 'content-type': 'application/json' } : {}) }, body: text || undefined })
}

/** Daily liveness signal: version and member count only (no chats, no files). */
export async function heartbeat(o: { db: Database; relayApi: string; teamId: string; key: KeyObject; version: string }): Promise<TeamInfo> {
  const members = (o.db.query(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`).get() as { n: number }).n
  const info = await signed<TeamInfo>(o, 'POST', `/teams/${o.teamId}/heartbeat`, { version: o.version, members })
  o.db.query('UPDATE relay_registrations SET last_heartbeat_at = ? WHERE relay_api = ?').run(new Date().toISOString(), o.relayApi)
  return info
}

export async function teamInfo(o: { relayApi: string; teamId: string; key: KeyObject }): Promise<TeamInfo> {
  return signed<TeamInfo>(o, 'GET', `/teams/${o.teamId}`, undefined)
}
