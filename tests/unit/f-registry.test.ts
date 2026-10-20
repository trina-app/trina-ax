// Relay registry: registration with signature + proof of work, name rules and holds, rename, key rotation,
// recovery code, release, operator suspension. Runs the relay's registry code on bun:sqlite (the relay itself uses
// node:sqlite through the same interface).
import { describe, expect, test } from 'bun:test'
import {
  NAME_HOLD_MS, apiSigningString, generateTeamKey, keyRotationString, loadPrivateKey, powSolve, registerSigningString, signB64,
  type RegisterRequest,
} from '@mycel/shared/relay-protocol'
import { openSqlite } from '../../relay/src/db.ts'
import { Registry, RegistryError } from '../../relay/src/registry.ts'

const BITS = 6
function regReq(name: string, kp = generateTeamKey(), ts = Date.now()): { req: RegisterRequest; kp: ReturnType<typeof generateTeamKey> } {
  const base = { name, publicKey: kp.publicKey, ts }
  const nonce = powSolve(base, BITS)
  return { req: { ...base, nonce, sig: signB64(loadPrivateKey(kp.privatePem), registerSigningString(name, kp.publicKey, ts)) }, kp }
}
async function registry(now?: () => number) {
  return new Registry(await openSqlite(':memory:'), { extraReserved: ['blockedname'], now })
}
function code(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof RegistryError ? e.code : `other: ${e}` }
}

describe('registry', () => {
  test('register: signature and proof of work are checked; the recovery code is shown once and stored hashed', async () => {
    const r = await registry()
    const { req } = regReq('acme')
    expect(code(() => r.register({ ...req, sig: req.sig.replace(/^./, req.sig[0] === 'A' ? 'B' : 'A') }, BITS))).toBe('bad_signature')
    expect(code(() => r.register({ ...req, nonce: 'zzzz-not-it' }, 30))).toBe('bad_pow')
    expect(code(() => r.register({ ...req, ts: Date.now() - 3600_000 }, BITS))).toBe('bad_pow')
    expect(code(() => r.register({ ...req, publicKey: 'AAAA' }, BITS))).toBe('invalid_request')
    const out = r.register(req, BITS)
    expect(out.name).toBe('acme')
    expect(out.recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/)
    expect(r.teamByName('acme')?.id).toBe(out.teamId)
    expect(r.currentKey(out.teamId)?.public_key).toBe(req.publicKey)
    const raw = r.db.prepare('SELECT recovery_code_hash FROM teams WHERE id = ?').get(out.teamId) as { recovery_code_hash: string }
    expect(raw.recovery_code_hash).not.toContain(out.recoveryCode.replace(/-/g, ''))
    expect(r.checkRecoveryCode(out.teamId, out.recoveryCode.toLowerCase())).toBe(true)
    expect(r.checkRecoveryCode(out.teamId, 'AAAA-BBBB')).toBe(false)
  })

  test('names: rules, reserved words, taken, one key per registration', async () => {
    const r = await registry()
    expect(code(() => r.register(regReq('Bad_Name').req, BITS))).toBe('invalid_name')
    expect(code(() => r.register(regReq('www').req, BITS))).toBe('name_reserved')
    expect(code(() => r.register(regReq('relay').req, BITS))).toBe('name_reserved')
    expect(code(() => r.register(regReq('blockedname').req, BITS))).toBe('name_reserved')
    const first = regReq('acme')
    r.register(first.req, BITS)
    expect(code(() => r.register(regReq('acme').req, BITS))).toBe('name_taken')
    expect(code(() => r.register(regReq('acme2', first.kp).req, BITS))).toBe('key_in_use')
    r.reserve('nope', 'blocked')
    expect(r.nameProblem('nope')).toBe('reserved')
  })

  test('dev relay: devNames frees a built-in reserved name (demo) but never an operator reservation', async () => {
    const db = await openSqlite(':memory:')
    const prod = new Registry(db)
    expect(code(() => prod.register(regReq('demo').req, BITS))).toBe('name_reserved')
    // same database opened by a dev relay: the stored reservation goes away and demo can be registered
    const dev = new Registry(db, { devNames: ['demo', 'blockedname'], extraReserved: ['blockedname'] })
    expect(dev.register(regReq('demo').req, BITS).name).toBe('demo')
    expect(code(() => dev.register(regReq('blockedname').req, BITS))).toBe('name_reserved')
    expect(code(() => dev.register(regReq('www').req, BITS))).toBe('name_reserved')
  })

  test('rename holds the old name for a year; release holds it too; holds expire', async () => {
    let now = Date.now()
    const r = await registry(() => now)
    const a = r.register(regReq('acme', undefined, now).req, BITS)
    r.rename(a.teamId, 'acme-corp')
    expect(r.teamByName('acme')).toBeUndefined()
    expect(r.teamByName('acme-corp')?.id).toBe(a.teamId)
    // someone else can't take the old name ...
    expect(code(() => r.register(regReq('acme', undefined, now).req, BITS))).toBe('name_taken')
    // ... but the same team may take it back
    r.rename(a.teamId, 'acme')
    expect(r.teamByName('acme')?.id).toBe(a.teamId)
    r.release(a.teamId)
    expect(r.team(a.teamId)?.status).toBe('released')
    expect(r.currentKey(a.teamId)).toBeUndefined()
    expect(code(() => r.register(regReq('acme', undefined, now).req, BITS))).toBe('name_taken')
    const hold = r.reservation('acme')
    expect(Date.parse(hold!.hold_until!) - now).toBeGreaterThanOrEqual(NAME_HOLD_MS - 1000)
    now += NAME_HOLD_MS + 1000
    const b = r.register(regReq('acme', undefined, now).req, BITS)
    expect(r.teamByName('acme')?.id).toBe(b.teamId)
  })

  test('key rotation needs the new key to sign; the old key stops working', async () => {
    const r = await registry()
    const { req, kp } = regReq('acme')
    const a = r.register(req, BITS)
    const next = generateTeamKey()
    expect(code(() => r.rotateKey(a.teamId, next.publicKey, signB64(loadPrivateKey(kp.privatePem), keyRotationString(a.teamId, next.publicKey))))).toBe('bad_signature')
    r.rotateKey(a.teamId, next.publicKey, signB64(loadPrivateKey(next.privatePem), keyRotationString(a.teamId, next.publicKey)))
    expect(r.currentKey(a.teamId)?.public_key).toBe(next.publicKey)
    const ts = Date.now()
    const sigOld = signB64(loadPrivateKey(kp.privatePem), apiSigningString('GET', `/teams/${a.teamId}`, ts, ''))
    expect(code(() => r.verifyApi(a.teamId, 'GET', `/teams/${a.teamId}`, ts, '', sigOld))).toBe('unauthorized')
    const sigNew = signB64(loadPrivateKey(next.privatePem), apiSigningString('GET', `/teams/${a.teamId}`, ts, ''))
    expect(r.verifyApi(a.teamId, 'GET', `/teams/${a.teamId}`, ts, '', sigNew).id).toBe(a.teamId)
    // signatures are bound to method, path, time and body
    expect(code(() => r.verifyApi(a.teamId, 'DELETE', `/teams/${a.teamId}`, ts, '', sigNew))).toBe('unauthorized')
    expect(code(() => r.verifyApi(a.teamId, 'GET', `/teams/${a.teamId}`, ts - 120_000, '', sigNew))).toBe('unauthorized')
  })

  test('operator suspension and heartbeat', async () => {
    const r = await registry()
    const a = r.register(regReq('acme').req, BITS)
    r.setStatus(a.teamId, 'suspended')
    expect(r.teamByName('acme')?.status).toBe('suspended')
    r.setStatus(a.teamId, 'active')
    r.heartbeat(a.teamId, '0.1.0', 7)
    const row = r.db.prepare('SELECT last_version, member_count, last_heartbeat_at FROM teams WHERE id = ?').get(a.teamId) as Record<string, unknown>
    expect(row.last_version).toBe('0.1.0')
    expect(row.member_count).toBe(7)
    expect(row.last_heartbeat_at).toBeString()
  })

  test('the registry stores no IPs or personal data', async () => {
    const r = await registry()
    const cols = (t: string) => (r.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    for (const t of ['teams', 'team_keys', 'reservations']) for (const c of cols(t)) expect(c).not.toMatch(/ip|email|mail|phone|user/i)
  })
})
