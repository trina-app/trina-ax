// Relay registry, cloud additions (control-plane RL-1): user_version steps from an old registry file, operator-made
// teams (idempotent by externalRef, temporary holds ignored, permanent reservations kept), holds, claim codes (one use,
// expiry, other names), suspension reasons, maintenance, renamed-address lookups (90 days) and the operator audit.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  NAME_HOLD_MS, generateTeamKey, loadPrivateKey, powSolve, registerSigningString, signB64, type TeamKeyPair,
} from '@mycel/shared/relay-protocol'
import { openSqlite } from '../../relay/src/db.ts'
import { MIGRATIONS, REGISTRY_SCHEMA_VERSION, Registry, RegistryError } from '../../relay/src/registry.ts'
import { F_WORK, writeOldRegistry } from '../lib/f-relay'

function code(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof RegistryError ? e.code : `other: ${e}` }
}
function signed(name: string, kp: TeamKeyPair = generateTeamKey(), ts = Date.now()) {
  return { name, publicKey: kp.publicKey, ts, sig: signB64(loadPrivateKey(kp.privatePem), registerSigningString(name, kp.publicKey, ts)), kp }
}
function op(name: string, ref: string, kp: TeamKeyPair = generateTeamKey(), ts = Date.now()) {
  const s = signed(name, kp, ts)
  return { req: { name, publicKey: s.publicKey, ts: s.ts, sig: s.sig, region: 'kr-seoul-1', origin: 'cloud' as const, externalRef: ref }, kp }
}

describe('registry: schema steps', () => {
  test('an old registry file opens: steps applied once, rows and keys intact, new columns defaulted', async () => {
    fs.mkdirSync(F_WORK, { recursive: true })
    const file = path.join(F_WORK, `old-registry-${process.pid}.db`)
    const kp = generateTeamKey()
    writeOldRegistry(file, kp)
    const r = new Registry(await openSqlite(file))
    expect(r.schemaVersion()).toBe(REGISTRY_SCHEMA_VERSION)
    expect(REGISTRY_SCHEMA_VERSION).toBe(MIGRATIONS.length)
    const t = r.teamByName('oldteam')!
    expect(t).toMatchObject({ id: 'team-old-1', status: 'suspended', origin: 'self', external_ref: null, suspend_reason: null, maintenance_until: null, last_version: '0.2.1' })
    expect(r.currentKey('team-old-1')?.public_key).toBe(kp.publicKey)
    expect(r.reservation('gone')?.reason).toBe('released')
    r.db.close()
    // opening again does not step again (ALTER TABLE ADD COLUMN twice would throw)
    const again = new Registry(await openSqlite(file))
    expect(again.schemaVersion()).toBe(REGISTRY_SCHEMA_VERSION)
    expect(again.list().length).toBe(1)
    again.db.close()
  })
  test('a file from a newer relay (higher user_version) is left alone (a/b roll-back reads it)', async () => {
    const db = await openSqlite(':memory:')
    new Registry(db)
    db.exec(`PRAGMA user_version = ${REGISTRY_SCHEMA_VERSION + 3}`)
    const r = new Registry(db)
    expect(r.schemaVersion()).toBe(REGISTRY_SCHEMA_VERSION + 3)
  })
})

describe('registry: operator-made teams', () => {
  test('createByOperator: signature checked, no proof of work, idempotent by externalRef + key', async () => {
    const r = new Registry(await openSqlite(':memory:'))
    const a = op('acme', 'cp-team-1')
    expect(code(() => r.createByOperator({ ...a.req, sig: signed('other', a.kp).sig }))).toBe('bad_signature')
    expect(code(() => r.createByOperator({ ...a.req, ts: Date.now() - 3600_000, sig: signed('acme', a.kp, Date.now() - 3600_000).sig }))).toBe('invalid_request')
    const first = r.createByOperator(a.req)
    expect(first.created).toBe(true)
    expect(first.team).toMatchObject({ name: 'acme', origin: 'cloud', external_ref: 'cp-team-1', region: 'kr-seoul-1' })
    // the same request again (a retried provisioning job): the same team, nothing new
    const again = r.createByOperator(op('acme', 'cp-team-1', a.kp).req)
    expect(again).toMatchObject({ created: false, team: { id: first.team.id } })
    // same reference, another key: refused
    expect(code(() => r.createByOperator(op('acme', 'cp-team-1').req))).toBe('conflict')
    // another reference for a taken name / a used key
    expect(code(() => r.createByOperator(op('acme', 'cp-team-2').req))).toBe('name_taken')
    expect(code(() => r.createByOperator(op('acme2', 'cp-team-2', a.kp).req))).toBe('key_in_use')
  })
  test('temporary holds are ignored by the operator API, permanent reservations and name holds are not', async () => {
    const r = new Registry(await openSqlite(':memory:'), { extraReserved: ['extra'] })
    r.hold('held', 60_000)
    // public registration sees the hold as reserved
    expect(r.nameProblem('held')).toBe('reserved')
    expect(r.createByOperator(op('held', 'ref-1').req).created).toBe(true)
    expect(r.reservation('held')).toBeUndefined() // the hold it was for is gone
    expect(code(() => r.createByOperator(op('www', 'ref-2').req))).toBe('name_reserved')
    expect(code(() => r.createByOperator(op('extra', 'ref-3').req))).toBe('name_reserved')
    r.reserve('nope', 'blocked')
    expect(code(() => r.createByOperator(op('nope', 'ref-4').req))).toBe('name_reserved')
    // the relay host's CLI may use a built-in reserved name (ax-probe), never a blocked one
    expect(r.createByOperator(op('ax-probe', 'ref-5').req, { allowReserved: true }).created).toBe(true)
    expect(code(() => r.createByOperator(op('nope', 'ref-6').req, { allowReserved: true }))).toBe('name_reserved')
    // a renamed-away name stays held for its team
    const t = r.createByOperator(op('first', 'ref-7').req).team
    r.rename(t.id, 'second')
    expect(code(() => r.createByOperator(op('first', 'ref-8').req))).toBe('name_taken')
  })
  test('holds: refused for reserved names, extend, unhold only removes temporary holds', async () => {
    let now = Date.now()
    const r = new Registry(await openSqlite(':memory:'), { now: () => now })
    expect(code(() => r.hold('www', 1000))).toBe('name_reserved')
    expect(code(() => r.hold('A b', 1000))).toBe('invalid_name')
    const until = r.hold('acme', 60_000)
    expect(Date.parse(until)).toBe(now + 60_000)
    expect(r.hold('acme', 120_000)).toBe(new Date(now + 120_000).toISOString())
    expect(r.unhold('www')).toBe(false)
    expect(r.unhold('acme')).toBe(true)
    expect(r.unhold('acme')).toBe(false)
    r.hold('later', 1000)
    now += 2000
    expect(r.nameProblem('later')).toBeNull() // expired hold
  })
})

describe('registry: claim codes', () => {
  test('one use, the right name, before expiry; a new code for the same reference replaces the old one', async () => {
    let now = Date.now()
    const r = new Registry(await openSqlite(':memory:'), { now: () => now })
    const c1 = r.createClaim({ name: 'clinic', ttlMs: 7 * 86_400_000, externalRef: 'addon-1' })
    expect(c1.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/)
    // the code itself is not stored, only its hash
    expect(JSON.stringify(r.db.prepare('SELECT * FROM claims').all())).not.toContain(c1.code.replace(/-/g, ''))
    // the name is held against public registration meanwhile
    expect(r.nameProblem('clinic')).toBe('reserved')
    // another reference can't claim the same name while the code lives
    expect(code(() => r.createClaim({ name: 'clinic', ttlMs: 1000, externalRef: 'addon-2' }))).toBe('name_taken')
    const c2 = r.createClaim({ name: 'clinic', ttlMs: 7 * 86_400_000, externalRef: 'addon-1' })
    const s = signed('clinic')
    expect(code(() => r.registerWithClaim({ ...s, claimCode: c1.code }))).toBe('bad_claim') // replaced
    expect(code(() => r.registerWithClaim({ ...signed('other'), claimCode: c2.code }))).toBe('bad_claim') // other name
    const out = r.registerWithClaim({ ...s, claimCode: c2.code.toLowerCase().replace(/-/g, ' ') })
    expect(r.team(out.teamId)).toMatchObject({ name: 'clinic', origin: 'addon', external_ref: 'addon-1' })
    expect(code(() => r.registerWithClaim({ ...signed('clinic'), claimCode: c2.code }))).toBe('bad_claim') // used
    const c3 = r.createClaim({ name: 'late', ttlMs: 1000, externalRef: 'addon-3' })
    now += 2000
    expect(code(() => r.registerWithClaim({ ...signed('late', undefined, now), claimCode: c3.code }))).toBe('bad_claim') // expired
    expect(code(() => r.registerWithClaim({ ...signed('x1y'), claimCode: 'short' }))).toBe('bad_claim')
  })
  test('deleteClaims withdraws unused codes and their holds', async () => {
    const r = new Registry(await openSqlite(':memory:'))
    const c = r.createClaim({ name: 'clinic', ttlMs: 86_400_000, externalRef: 'addon-1' })
    expect(r.deleteClaims('addon-1')).toBe(1)
    expect(r.nameProblem('clinic')).toBeNull()
    expect(code(() => r.registerWithClaim({ ...signed('clinic'), claimCode: c.code }))).toBe('bad_claim')
  })
  test('a claim for a reference that already has a team is refused', async () => {
    const r = new Registry(await openSqlite(':memory:'))
    r.createByOperator(op('acme', 'ref-1').req)
    expect(code(() => r.createClaim({ name: 'acme-2', ttlMs: 1000, externalRef: 'ref-1' }))).toBe('conflict')
  })
})

describe('registry: status, maintenance, renamed addresses, audit', () => {
  test('suspension keeps its reason and first time; unsuspend clears both', async () => {
    let now = Date.now()
    const r = new Registry(await openSqlite(':memory:'), { now: () => now })
    const t = r.createByOperator(op('acme', 'ref-1').req).team
    r.setStatus(t.id, 'suspended', 'billing')
    const at = r.team(t.id)!.suspended_at
    now += 5000
    r.setStatus(t.id, 'suspended', 'canceled')
    expect(r.team(t.id)).toMatchObject({ status: 'suspended', suspend_reason: 'canceled', suspended_at: at })
    r.setStatus(t.id, 'active')
    expect(r.team(t.id)).toMatchObject({ status: 'active', suspend_reason: null, suspended_at: null })
    r.setMaintenance(t.id, now + 60_000)
    expect(r.team(t.id)!.maintenance_until).toBe(new Date(now + 60_000).toISOString())
    r.setMaintenance(t.id, null)
    expect(r.team(t.id)!.maintenance_until).toBeNull()
    expect(r.counts()).toEqual({ active: 1, suspended: 0 })
  })
  test('renamedTo: the old name points at the team for 90 days; not after, not for a released team', async () => {
    let now = Date.now()
    const r = new Registry(await openSqlite(':memory:'), { now: () => now })
    const t = r.createByOperator(op('acme', 'ref-1').req).team
    r.rename(t.id, 'acme-corp')
    expect(r.renamedTo('acme')?.name).toBe('acme-corp')
    r.rename(t.id, 'acme-co')
    expect(r.renamedTo('acme')?.name).toBe('acme-co')
    expect(r.renamedTo('acme-corp')?.name).toBe('acme-co')
    now += 91 * 86_400_000
    expect(r.renamedTo('acme')).toBeUndefined()
    expect(r.nameProblem('acme')).toBe('taken') // still held for a year
    now += NAME_HOLD_MS
    expect(r.nameProblem('acme')).toBeNull()
    const u = r.createByOperator(op('bravo', 'ref-2', undefined, now).req).team
    r.rename(u.id, 'bravo2')
    r.release(u.id)
    expect(r.renamedTo('bravo')).toBeUndefined()
  })
  test('operator audit: key id, action, team id; pages of teams by origin', async () => {
    const r = new Registry(await openSqlite(':memory:'))
    r.audit('cp', 'teams.suspend', 't1', 'reason=billing')
    expect(r.auditLog()[0]).toMatchObject({ key_id: 'cp', action: 'teams.suspend', team_id: 't1', detail: 'reason=billing' })
    for (let i = 0; i < 5; i++) r.createByOperator(op(`team-${i}`, `ref-${i}`).req)
    const kp = generateTeamKey()
    const ts = Date.now()
    r.register({ name: 'selfmade', publicKey: kp.publicKey, ts, nonce: powSolve({ name: 'selfmade', publicKey: kp.publicKey, ts }, 4), sig: signB64(loadPrivateKey(kp.privatePem), registerSigningString('selfmade', kp.publicKey, ts)) }, 4)
    const p1 = r.page({ origin: 'cloud', limit: 3 })
    expect(p1.rows.length).toBe(3)
    expect(p1.next).not.toBeNull()
    const p2 = r.page({ origin: 'cloud', limit: 3, cursor: p1.next })
    expect(p2.rows.length).toBe(2)
    expect(p2.next).toBeNull()
    expect(new Set([...p1.rows, ...p2.rows].map((t) => t.name)).size).toBe(5)
    expect(r.page({ origin: 'self' }).rows.map((t) => t.name)).toEqual(['selfmade'])
  })
})

describe('reserved names (RL-7)', () => {
  test('the control plane, mail, billing and operator names are reserved for public registration', async () => {
    const { checkTeamName } = await import('@mycel/shared/relay-protocol')
    for (const n of ['cloud', 'ops', 'operator', 'agent', 'agents', 'metrics', 'monitor', 'monitoring', 'grafana', 'prometheus', 'backup', 'backups', 'notify', 'bounce', 'mailer', 'invoice', 'invoices', 'receipt', 'receipts', 'checkout', 'legal', 'terms', 'privacy', 'trust', 'changelog', 'teamax-cloud', 'ax-probe', 'account', 'status', 'relay'])
      expect({ n, p: checkTeamName(n) }).toEqual({ n, p: 'reserved' })
    expect(checkTeamName('cp')).toBe('too_short')
    const r = new Registry(await openSqlite(':memory:'))
    expect(r.nameProblem('ax-probe')).toBe('reserved')
  })
})
