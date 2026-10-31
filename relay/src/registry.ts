// Team registry (design tab 6 "팀 등록·인증 (중계 레지스트리)"): teams, team_keys, reservations in the relay's own
// SQLite. One team = one address. Exactly one valid key per team. Released / renamed-away names are held >= 1 year.
// Nothing personal is stored: no e-mail, no IPs; only names, public keys and timestamps.
//
// Schema changes are steps on PRAGMA user_version (control-plane 3.6.3), additive only, so a relay of the previous
// version (a/b deploy roll-back) still reads the file: version 1 adds who made a team (origin: self = public
// registration, cloud = control plane, addon = claim code), the control plane's reference, the suspension reason,
// maintenance windows, claim codes and the operator audit log.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  API_SIG_MAX_SKEW_MS, NAME_HOLD_MS, POW_MAX_AGE_MS, RESERVED_TEAM_NAMES, apiSigningString, checkTeamName,
  keyRotationString, parsePublicKey, powOk, registerSigningString, verifyB64,
  type RegisterRequest, type RegistryErrorCode, type TeamNameProblem,
} from '@mycel/shared/relay-protocol'
import { RENAME_REDIRECT_MS, normalizeClaimCode, type SuspendReason, type TeamOrigin } from '@mycel/shared/cloud-protocol/relay-ops'
import { tx, type SqlDb } from './db.ts'

export interface TeamRow {
  id: string
  name: string
  region: string
  status: 'active' | 'suspended' | 'released'
  created_at: string
  last_heartbeat_at: string | null
  last_connected_at: string | null
  last_version: string | null
  member_count: number | null
  origin: TeamOrigin
  external_ref: string | null
  suspend_reason: SuspendReason | null
  suspended_at: string | null
  maintenance_until: string | null
  /** F2: the control plane put the team's VM to sleep at this time; cleared when the team server connects */
  sleeping_since: string | null
}
export interface KeyRow { id: string; team_id: string; public_key: string; created_at: string; revoked_at: string | null }
export interface ClaimRow { code_hash: string; name: string; external_ref: string; created_at: string; expires_at: string; used_at: string | null; team_id: string | null }

export class RegistryError extends Error {
  name = 'RegistryError'
  code: RegistryErrorCode
  status: number
  constructor(code: RegistryErrorCode, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** user_version 0: the tables as the first relay made them (CREATE IF NOT EXISTS: a new file and an old one alike). */
const SCHEMA_V0 = `
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  recovery_code_hash TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','released')),
  created_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  last_connected_at TEXT,
  last_version TEXT,
  member_count INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_live_name ON teams(name) WHERE status != 'released';
CREATE TABLE IF NOT EXISTS team_keys (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS team_keys_one_live ON team_keys(team_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_keys_public ON team_keys(public_key);
CREATE TABLE IF NOT EXISTS reservations (
  name TEXT PRIMARY KEY,
  team_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('released','reclaimed','blocked','reserved')),
  hold_until TEXT
);
`

/** step i takes user_version i to i + 1. Additive only (new columns with defaults, new tables, new indexes). */
export const MIGRATIONS: readonly string[] = [
  `ALTER TABLE teams ADD COLUMN origin TEXT NOT NULL DEFAULT 'self';
ALTER TABLE teams ADD COLUMN external_ref TEXT;
ALTER TABLE teams ADD COLUMN suspend_reason TEXT;
ALTER TABLE teams ADD COLUMN suspended_at TEXT;
ALTER TABLE teams ADD COLUMN maintenance_until TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS teams_external_ref ON teams(external_ref) WHERE external_ref IS NOT NULL AND status != 'released';
CREATE TABLE IF NOT EXISTS claims (
  code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, external_ref TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, team_id TEXT
);
CREATE INDEX IF NOT EXISTS claims_ref ON claims(external_ref);
CREATE TABLE IF NOT EXISTS ops_audit (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, key_id TEXT NOT NULL, action TEXT NOT NULL, team_id TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS ops_audit_at ON ops_audit(at);`,
  // F2 sleep: the control plane hibernated the team's VM (POST /ops/v1/teams/{id}/sleep); NULL = awake
  `ALTER TABLE teams ADD COLUMN sleeping_since TEXT;`,
]
export const REGISTRY_SCHEMA_VERSION = MIGRATIONS.length

/** operator audit records are kept this long (control-plane D33: operator access records 2 years) */
const AUDIT_KEEP_MS = 2 * 366 * 24 * 3600_000
const TEAM_COLS = 'id, name, region, status, created_at, last_heartbeat_at, last_connected_at, last_version, member_count, origin, external_ref, suspend_reason, suspended_at, maintenance_until, sleeping_since'

const iso = (ms: number) => new Date(ms).toISOString()
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 20 random base32 characters (100 bits) in groups of four: recovery codes and claim codes */
export function newRecoveryCode(): string {
  const b = randomBytes(20)
  let s = ''
  for (const x of b) s += B32[x & 31]
  return s.match(/.{4}/g)!.join('-')
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '')

export interface RegistryOptions {
  extraReserved?: string[]
  /** dev relay only (--dev): built-in reserved names that may be registered anyway, e.g. 'demo' for
   * http://demo.localhost:19161 in `bun run dev`. Never set in production. */
  devNames?: string[]
  now?: () => number
}

export interface OperatorCreate {
  name: string
  publicKey: string
  ts: number
  sig: string
  region: string
  origin: 'cloud' | 'addon'
  externalRef: string
}

export class Registry {
  readonly db: SqlDb
  private extraReserved: string[]
  private devNames: Set<string>
  private now: () => number

  constructor(db: SqlDb, o: RegistryOptions = {}) {
    this.db = db
    this.extraReserved = o.extraReserved ?? []
    this.devNames = new Set((o.devNames ?? []).filter((n) => !this.extraReserved.includes(n)))
    this.now = o.now ?? Date.now
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA_V0)
    this.migrate()
    const ins = db.prepare('INSERT OR IGNORE INTO reservations (name, team_id, reason, hold_until) VALUES (?, NULL, ?, NULL)')
    for (const n of [...RESERVED_TEAM_NAMES, ...this.extraReserved]) if (!this.devNames.has(n)) ins.run(n, 'reserved')
    const free = db.prepare("DELETE FROM reservations WHERE name = ? AND team_id IS NULL AND reason = 'reserved'")
    for (const n of this.devNames) free.run(n)
  }

  /** Bring the file to REGISTRY_SCHEMA_VERSION, one step per transaction. A newer file (rolled-back relay) is left as is. */
  private migrate(): void {
    let v = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    while (v < MIGRATIONS.length) {
      const step = v
      tx(this.db, () => {
        this.db.exec(MIGRATIONS[step]!)
        this.db.exec(`PRAGMA user_version = ${step + 1}`)
      })
      v = step + 1
    }
  }

  schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  }

  // ------------------------------------------------------------ lookups

  teamByName(name: string): TeamRow | undefined {
    return this.db.prepare(`SELECT ${TEAM_COLS} FROM teams WHERE name = ? AND status != 'released'`).get(name) as TeamRow | undefined
  }
  team(id: string): TeamRow | undefined {
    return this.db.prepare(`SELECT ${TEAM_COLS} FROM teams WHERE id = ?`).get(id) as TeamRow | undefined
  }
  teamByExternalRef(ref: string): TeamRow | undefined {
    return this.db.prepare(`SELECT ${TEAM_COLS} FROM teams WHERE external_ref = ? AND status != 'released'`).get(ref) as TeamRow | undefined
  }
  currentKey(teamId: string): KeyRow | undefined {
    return this.db.prepare('SELECT id, team_id, public_key, created_at, revoked_at FROM team_keys WHERE team_id = ? AND revoked_at IS NULL').get(teamId) as KeyRow | undefined
  }
  list(): TeamRow[] {
    return this.db.prepare(`SELECT ${TEAM_COLS} FROM teams ORDER BY created_at`).all() as unknown as TeamRow[]
  }
  /** Operator listing: newest-first pages by (created_at, id); `cursor` is the last row's "created_at|id". */
  page(o: { origin?: TeamOrigin; cursor?: string | null; limit?: number } = {}): { rows: TeamRow[]; next: string | null } {
    const limit = Math.max(1, Math.min(500, o.limit ?? 100))
    const where: string[] = ["status != 'released'"]
    const params: (string | number)[] = []
    if (o.origin) { where.push('origin = ?'); params.push(o.origin) }
    if (o.cursor) {
      const [at, id] = o.cursor.split('|')
      if (!at || !id) throw new RegistryError('invalid_request', 'bad cursor')
      where.push('(created_at < ? OR (created_at = ? AND id < ?))')
      params.push(at, at, id)
    }
    const rows = this.db.prepare(`SELECT ${TEAM_COLS} FROM teams WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit + 1) as unknown as TeamRow[]
    const more = rows.length > limit
    if (more) rows.pop()
    const last = rows.at(-1)
    return { rows, next: more && last ? `${last.created_at}|${last.id}` : null }
  }
  counts(): { active: number; suspended: number } {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM teams WHERE status != 'released' GROUP BY status`).all() as { status: string; n: number }[]
    const out = { active: 0, suspended: 0 }
    for (const r of rows) if (r.status === 'active' || r.status === 'suspended') out[r.status] = Number(r.n)
    return out
  }

  /** null when `name` can be given to `forTeam` (or to a new team), else the reason. */
  nameProblem(name: string, forTeam?: string): TeamNameProblem | 'taken' | null {
    const p = checkTeamName(name, this.extraReserved)
    if (p && !(p === 'reserved' && this.devNames.has(name))) return p
    const r = this.reservation(name)
    if (r) {
      const held = r.hold_until === null || Date.parse(r.hold_until) > this.now()
      const own = forTeam !== undefined && r.team_id === forTeam && r.reason !== 'blocked'
      if (held && !own) return r.reason === 'released' || r.reason === 'reclaimed' ? 'taken' : 'reserved'
    }
    const t = this.teamByName(name)
    if (t && t.id !== forTeam) return 'taken'
    return null
  }

  /**
   * Like nameProblem, but a temporary hold (reason 'reserved' with an end: a signup or a claim code in progress) does
   * not count: the operator API and claim codes create the team the hold was for. Permanent reservations, blocks and
   * the one-year holds of renamed / released names still do (`allowReserved`: the relay host's own CLI may use a
   * built-in reserved name, e.g. the operators' probe team ax-probe; a block never).
   */
  private operatorNameProblem(name: string, o: { allowReserved?: boolean } = {}): TeamNameProblem | 'taken' | null {
    const p = checkTeamName(name, this.extraReserved)
    if (p && !(p === 'reserved' && (o.allowReserved || this.devNames.has(name)))) return p
    const r = this.reservation(name)
    if (r) {
      const temporary = r.reason === 'reserved' && r.hold_until !== null
      const held = r.hold_until === null || Date.parse(r.hold_until) > this.now()
      if (held && !temporary) {
        if (r.reason === 'released' || r.reason === 'reclaimed') return 'taken'
        if (r.reason === 'blocked' || !o.allowReserved) return 'reserved'
      }
    }
    if (this.teamByName(name)) return 'taken'
    return null
  }

  private nameError(problem: TeamNameProblem | 'taken'): RegistryError {
    if (problem === 'taken') return new RegistryError('name_taken', 'this team name is already in use', 409)
    if (problem === 'reserved') return new RegistryError('name_reserved', 'this team name is reserved', 409)
    return new RegistryError('invalid_name', `team names are 3-40 lowercase letters, digits and hyphens (${problem})`)
  }

  // ------------------------------------------------------------ registration

  register(req: RegisterRequest, powBits: number): { teamId: string; name: string; recoveryCode: string } {
    const name = typeof req.name === 'string' ? req.name : ''
    const problem = this.nameProblem(name)
    if (problem) throw this.nameError(problem)
    if (!Number.isInteger(req.ts) || Math.abs(this.now() - req.ts) > POW_MAX_AGE_MS) throw new RegistryError('bad_pow', 'timestamp too old or in the future')
    const key = parsePublicKey(req.publicKey)
    if (!key) throw new RegistryError('invalid_request', 'publicKey must be a base64 SPKI Ed25519 key')
    if (typeof req.nonce !== 'string' || !powOk({ ...req, nonce: req.nonce }, powBits)) throw new RegistryError('bad_pow', 'proof of work does not meet the difficulty')
    if (!verifyB64(key, registerSigningString(name, req.publicKey, req.ts), req.sig)) throw new RegistryError('bad_signature', 'signature does not match the key', 401)
    const region = typeof req.region === 'string' && /^[a-z0-9-]{1,32}$/.test(req.region) ? req.region : 'default'
    return this.insertTeam({ name, publicKey: req.publicKey, region, origin: 'self', externalRef: null })
  }

  /**
   * Registration with a claim code (self-hosted official relay add-on, control-plane 3.13): no proof of work, the code
   * names the address and the control plane's reference. The team key still signs (it holds the key). The code is
   * spent by the registration; a wrong, used, expired or other-name code is `bad_claim`.
   */
  registerWithClaim(req: RegisterRequest & { claimCode: string }): { teamId: string; name: string; recoveryCode: string } {
    const name = typeof req.name === 'string' ? req.name : ''
    if (!Number.isInteger(req.ts) || Math.abs(this.now() - req.ts) > POW_MAX_AGE_MS) throw new RegistryError('invalid_request', 'timestamp too old or in the future')
    const key = parsePublicKey(req.publicKey)
    if (!key) throw new RegistryError('invalid_request', 'publicKey must be a base64 SPKI Ed25519 key')
    if (!verifyB64(key, registerSigningString(name, req.publicKey, req.ts), req.sig)) throw new RegistryError('bad_signature', 'signature does not match the key', 401)
    const code = normalizeClaimCode(String(req.claimCode ?? ''))
    return tx(this.db, () => {
      const c = code.length >= 16 ? (this.db.prepare('SELECT code_hash, name, external_ref, created_at, expires_at, used_at, team_id FROM claims WHERE code_hash = ?').get(hash(code)) as ClaimRow | undefined) : undefined
      if (!c || c.used_at || Date.parse(c.expires_at) <= this.now() || c.name !== name) throw new RegistryError('bad_claim', 'this claim code is not valid for this address (wrong, used, expired or for another name)', 403)
      const problem = this.operatorNameProblem(name)
      if (problem) throw this.nameError(problem)
      if (this.teamByExternalRef(c.external_ref)) throw new RegistryError('conflict', 'this subscription already has a team address', 409)
      const out = this.insertTeam({ name, publicKey: req.publicKey, region: 'default', origin: 'addon', externalRef: c.external_ref }, false)
      this.db.prepare('UPDATE claims SET used_at = ?, team_id = ? WHERE code_hash = ?').run(iso(this.now()), out.teamId, c.code_hash)
      return out
    })
  }

  /**
   * The control plane (operator API POST /ops/v1/teams) creates a team with the tenant's own key: no proof of work,
   * no rate limit; the key's signature over registerSigningString proves the tenant holds it. Temporary holds are
   * ignored, permanent reservations are not (unless `allowReserved`: the relay host's CLI). Idempotent: the same
   * externalRef with the same key returns the existing team (created: false); with another key it is a conflict.
   */
  createByOperator(req: OperatorCreate, o: { allowReserved?: boolean } = {}): { team: TeamRow; created: boolean } {
    const key = parsePublicKey(req.publicKey)
    if (!key) throw new RegistryError('invalid_request', 'publicKey must be a base64 SPKI Ed25519 key')
    return tx(this.db, () => {
      const existing = this.teamByExternalRef(req.externalRef)
      if (existing) {
        if (this.currentKey(existing.id)?.public_key === req.publicKey && existing.name === req.name) return { team: existing, created: false }
        throw new RegistryError('conflict', 'this externalRef already has a team with another key or name', 409)
      }
      const problem = this.operatorNameProblem(req.name, o)
      if (problem) throw this.nameError(problem)
      if (!Number.isInteger(req.ts) || Math.abs(this.now() - req.ts) > POW_MAX_AGE_MS) throw new RegistryError('invalid_request', 'ts too old or in the future (the key signs registerSigningString at enroll time)')
      if (!verifyB64(key, registerSigningString(req.name, req.publicKey, req.ts), req.sig)) throw new RegistryError('bad_signature', 'signature does not match the key', 401)
      const out = this.insertTeam({ name: req.name, publicKey: req.publicKey, region: req.region, origin: req.origin, externalRef: req.externalRef }, false)
      return { team: this.team(out.teamId)!, created: true }
    })
  }

  private insertTeam(t: { name: string; publicKey: string; region: string; origin: TeamOrigin; externalRef: string | null }, ownTx = true): { teamId: string; name: string; recoveryCode: string } {
    const teamId = randomUUID()
    const recoveryCode = newRecoveryCode()
    const at = iso(this.now())
    const body = () => {
      if (this.db.prepare('SELECT 1 AS x FROM team_keys WHERE public_key = ?').get(t.publicKey)) throw new RegistryError('key_in_use', 'this key is already registered', 409)
      if (this.teamByName(t.name)) throw new RegistryError('name_taken', 'this team name is already in use', 409)
      this.db.prepare('INSERT INTO teams (id, name, recovery_code_hash, region, status, created_at, origin, external_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(teamId, t.name, hash(normCode(recoveryCode)), t.region, 'active', at, t.origin, t.externalRef)
      this.db.prepare('INSERT INTO team_keys (id, team_id, public_key, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), teamId, t.publicKey, at)
      // an expired hold of this name goes; so does the temporary hold this registration was for
      this.db.prepare('DELETE FROM reservations WHERE name = ? AND hold_until IS NOT NULL AND hold_until <= ?').run(t.name, at)
      if (t.origin !== 'self') this.db.prepare("DELETE FROM reservations WHERE name = ? AND team_id IS NULL AND reason = 'reserved' AND hold_until IS NOT NULL").run(t.name)
    }
    if (ownTx) tx(this.db, body)
    else body()
    return { teamId, name: t.name, recoveryCode }
  }

  /** Verify a signed API request (Authorization: MycelRelay ...) against the team's current key. */
  verifyApi(teamId: string, method: string, path: string, ts: number, body: string, sig: string): TeamRow {
    const t = this.team(teamId)
    if (!t || t.status === 'released') throw new RegistryError('not_found', 'no such team', 404)
    if (Math.abs(this.now() - ts) > API_SIG_MAX_SKEW_MS) throw new RegistryError('unauthorized', 'request timestamp out of range (check the clock)', 401)
    const k = this.currentKey(teamId)
    if (!k || !verifyB64(k.public_key, apiSigningString(method, path, ts, body), sig)) throw new RegistryError('unauthorized', 'bad signature', 401)
    return t
  }

  checkRecoveryCode(teamId: string, code: string): boolean {
    const r = this.db.prepare('SELECT recovery_code_hash FROM teams WHERE id = ?').get(teamId) as { recovery_code_hash: string } | undefined
    if (!r || typeof code !== 'string') return false
    const a = Buffer.from(hash(normCode(code)), 'hex')
    const b = Buffer.from(r.recovery_code_hash, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  heartbeat(teamId: string, version: string, members: number): void {
    this.db.prepare('UPDATE teams SET last_heartbeat_at = ?, last_version = ?, member_count = ? WHERE id = ?')
      .run(iso(this.now()), String(version).slice(0, 40), Math.max(0, Math.min(100_000, Math.floor(members) || 0)), teamId)
  }

  touchConnected(teamId: string, keyId: string): void {
    const at = iso(this.now())
    // a connected team server is awake (F2): the sleep flag ends here
    this.db.prepare('UPDATE teams SET last_connected_at = ?, sleeping_since = NULL WHERE id = ?').run(at, teamId)
    this.db.prepare('UPDATE team_keys SET last_seen_at = ? WHERE id = ?').run(at, keyId)
  }

  rename(teamId: string, name: string): void {
    const t = this.team(teamId)
    if (!t || t.status === 'released') throw new RegistryError('not_found', 'no such team', 404)
    if (t.name === name) return
    const problem = this.nameProblem(name, teamId)
    if (problem) throw this.nameError(problem)
    tx(this.db, () => {
      this.holdFor(t.name, teamId, 'released')
      this.db.prepare('DELETE FROM reservations WHERE name = ? AND team_id = ?').run(name, teamId)
      this.db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, teamId)
    })
  }

  /** Replace the team's key. Proof: the new key signed keyRotationString (checked here); the caller checked the old key or the recovery code. */
  rotateKey(teamId: string, publicKey: string, newKeySig: string): void {
    const key = parsePublicKey(publicKey)
    if (!key) throw new RegistryError('invalid_request', 'publicKey must be a base64 SPKI Ed25519 key')
    if (!verifyB64(key, keyRotationString(teamId, publicKey), newKeySig)) throw new RegistryError('bad_signature', 'the new key did not sign the rotation', 401)
    tx(this.db, () => {
      const other = this.db.prepare('SELECT team_id FROM team_keys WHERE public_key = ?').get(publicKey) as { team_id: string } | undefined
      if (other) throw new RegistryError('key_in_use', 'this key is already registered', 409)
      const at = iso(this.now())
      this.db.prepare('UPDATE team_keys SET revoked_at = ? WHERE team_id = ? AND revoked_at IS NULL').run(at, teamId)
      this.db.prepare('INSERT INTO team_keys (id, team_id, public_key, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), teamId, publicKey, at)
    })
  }

  /** Give the address back: the name is held for a year, keys are revoked. */
  release(teamId: string, reason: 'released' | 'reclaimed' = 'released'): void {
    const t = this.team(teamId)
    if (!t || t.status === 'released') throw new RegistryError('not_found', 'no such team', 404)
    tx(this.db, () => {
      const at = iso(this.now())
      this.holdFor(t.name, teamId, reason)
      this.db.prepare(`UPDATE teams SET status = 'released', maintenance_until = NULL WHERE id = ?`).run(teamId)
      this.db.prepare('UPDATE team_keys SET revoked_at = ? WHERE team_id = ? AND revoked_at IS NULL').run(at, teamId)
    })
  }

  /** Operator kill switch (and back). Suspending records why (the visitor page differs for billing). */
  setStatus(teamId: string, status: 'active' | 'suspended', reason: SuspendReason = 'operator'): void {
    const t = this.team(teamId)
    if (!t || t.status === 'released') throw new RegistryError('not_found', 'no such team', 404)
    if (status === 'suspended') this.db.prepare('UPDATE teams SET status = ?, suspend_reason = ?, suspended_at = COALESCE(CASE WHEN status = ? THEN suspended_at END, ?) WHERE id = ?').run(status, reason, 'suspended', iso(this.now()), teamId)
    else this.db.prepare('UPDATE teams SET status = ?, suspend_reason = NULL, suspended_at = NULL WHERE id = ?').run(status, teamId)
  }

  /** "The team server is being updated" until then (null = over). Only shown while the team server is offline. */
  setMaintenance(teamId: string, untilMs: number | null): void {
    const t = this.team(teamId)
    if (!t || t.status === 'released') throw new RegistryError('not_found', 'no such team', 404)
    this.db.prepare('UPDATE teams SET maintenance_until = ? WHERE id = ?').run(untilMs === null ? null : iso(untilMs), teamId)
  }

  /** F2 sleep flag: true = the VM sleeps from now (an existing time stays), false = awake. */
  setSleeping(teamId: string, sleeping: boolean): void {
    const t = this.team(teamId)
    if (!t || t.status === 'released') throw new RegistryError('not_found', 'no such team', 404)
    if (sleeping) this.db.prepare('UPDATE teams SET sleeping_since = COALESCE(sleeping_since, ?) WHERE id = ?').run(iso(this.now()), teamId)
    else this.db.prepare('UPDATE teams SET sleeping_since = NULL WHERE id = ?').run(teamId)
  }

  /** Operator: reserve or block a name (hold_until null = forever). */
  reserve(name: string, reason: 'reserved' | 'blocked', holdUntil: number | null = null): void {
    this.db.prepare('INSERT INTO reservations (name, team_id, reason, hold_until) VALUES (?, NULL, ?, ?) ON CONFLICT(name) DO UPDATE SET reason = excluded.reason, hold_until = excluded.hold_until, team_id = NULL')
      .run(name, reason, holdUntil === null ? null : iso(holdUntil))
  }

  reservation(name: string): { team_id: string | null; reason: string; hold_until: string | null } | undefined {
    return this.db.prepare('SELECT team_id, reason, hold_until FROM reservations WHERE name = ?').get(name) as never
  }

  /**
   * A temporary hold while someone signs up for `name` (operator API POST /ops/v1/holds): public registration sees it
   * as reserved; the operator API and claim codes do not. Holding a name already held temporarily extends the hold.
   */
  hold(name: string, ttlMs: number): string {
    const problem = this.operatorNameProblem(name)
    if (problem) throw this.nameError(problem)
    const until = iso(this.now() + ttlMs)
    this.reserve(name, 'reserved', this.now() + ttlMs)
    return until
  }

  /** Drop a temporary hold; true when there was one. Permanent reservations and name holds are never touched. */
  unhold(name: string): boolean {
    const r = this.reservation(name)
    if (!r || r.reason !== 'reserved' || r.hold_until === null || r.team_id !== null) return false
    this.db.prepare("DELETE FROM reservations WHERE name = ? AND reason = 'reserved' AND hold_until IS NOT NULL AND team_id IS NULL").run(name)
    return true
  }

  /**
   * A one-time claim code for `name` (official relay add-on): shown once to the control plane, only its hash is kept.
   * The name is held until the code expires. A new code for the same externalRef replaces the unused old one.
   */
  createClaim(o: { name: string; ttlMs: number; externalRef: string }): { code: string; expiresAt: string } {
    return tx(this.db, () => {
      const problem = this.operatorNameProblem(o.name)
      if (problem) throw this.nameError(problem)
      if (this.teamByExternalRef(o.externalRef)) throw new RegistryError('conflict', 'this externalRef already has a team', 409)
      const nowIso = iso(this.now())
      const other = this.db.prepare('SELECT external_ref FROM claims WHERE name = ? AND used_at IS NULL AND expires_at > ? AND external_ref != ?').get(o.name, nowIso, o.externalRef)
      if (other) throw new RegistryError('name_taken', 'another claim code holds this name', 409)
      for (const old of this.db.prepare('SELECT name FROM claims WHERE external_ref = ? AND used_at IS NULL').all(o.externalRef) as { name: string }[]) this.unhold(old.name)
      this.db.prepare('DELETE FROM claims WHERE external_ref = ? AND used_at IS NULL').run(o.externalRef)
      const code = newRecoveryCode()
      const expiresAt = iso(this.now() + o.ttlMs)
      this.db.prepare('INSERT INTO claims (code_hash, name, external_ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(hash(normalizeClaimCode(code)), o.name, o.externalRef, nowIso, expiresAt)
      this.reserve(o.name, 'reserved', this.now() + o.ttlMs)
      return { code, expiresAt }
    })
  }

  /** Withdraw the unused claim codes of externalRef (and their name holds). Returns how many there were. */
  deleteClaims(externalRef: string): number {
    return tx(this.db, () => {
      const rows = this.db.prepare('SELECT name FROM claims WHERE external_ref = ? AND used_at IS NULL').all(externalRef) as { name: string }[]
      for (const r of rows) this.unhold(r.name)
      this.db.prepare('DELETE FROM claims WHERE external_ref = ? AND used_at IS NULL').run(externalRef)
      return rows.length
    })
  }

  /**
   * Where a renamed-away address lives now (control-plane D40): the name is held for its team (reason 'released' after
   * a rename), that team is still live, and the rename was less than 90 days ago. A released team is not followed.
   */
  renamedTo(name: string): TeamRow | undefined {
    const r = this.reservation(name)
    if (!r || r.reason !== 'released' || !r.team_id || !r.hold_until) return undefined
    const since = Date.parse(r.hold_until) - NAME_HOLD_MS
    if (!(this.now() - since < RENAME_REDIRECT_MS)) return undefined
    const t = this.team(r.team_id)
    return t && t.status !== 'released' && t.name !== name ? t : undefined
  }

  /** Operator API write record: key id, action, team id. Never IPs or names of people. */
  audit(keyId: string, action: string, teamId: string | null, detail: string | null = null): void {
    const at = this.now()
    this.db.prepare('INSERT INTO ops_audit (id, at, key_id, action, team_id, detail) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), iso(at), keyId, action, teamId, detail === null ? null : detail.slice(0, 500))
    this.db.prepare('DELETE FROM ops_audit WHERE at < ?').run(iso(at - AUDIT_KEEP_MS))
  }

  auditLog(limit = 100): { at: string; key_id: string; action: string; team_id: string | null; detail: string | null }[] {
    return this.db.prepare('SELECT at, key_id, action, team_id, detail FROM ops_audit ORDER BY at DESC LIMIT ?').all(limit) as never
  }

  private holdFor(name: string, teamId: string, reason: 'released' | 'reclaimed'): void {
    this.db.prepare('INSERT INTO reservations (name, team_id, reason, hold_until) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET team_id = excluded.team_id, reason = excluded.reason, hold_until = excluded.hold_until')
      .run(name, teamId, reason, iso(this.now() + NAME_HOLD_MS))
  }
}
