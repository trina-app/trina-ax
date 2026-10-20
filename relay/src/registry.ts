// Team registry (design tab 6 "팀 등록·인증 (중계 레지스트리)"): teams, team_keys, reservations in the relay's own
// SQLite. One team = one address. Exactly one valid key per team. Released / renamed-away names are held >= 1 year.
// Nothing personal is stored: no e-mail, no IPs; only names, public keys and timestamps.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  API_SIG_MAX_SKEW_MS, NAME_HOLD_MS, POW_MAX_AGE_MS, RESERVED_TEAM_NAMES, apiSigningString, checkTeamName,
  keyRotationString, parsePublicKey, powOk, registerSigningString, verifyB64,
  type RegisterRequest, type RegistryErrorCode, type TeamNameProblem,
} from '@mycel/shared/relay-protocol'
import { tx, type SqlDb } from './db.ts'

export interface TeamRow {
  id: string
  name: string
  region: string
  status: 'active' | 'suspended' | 'released'
  created_at: string
  last_heartbeat_at: string | null
  last_connected_at: string | null
}
export interface KeyRow { id: string; team_id: string; public_key: string; created_at: string; revoked_at: string | null }

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

const SCHEMA = `
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

const iso = (ms: number) => new Date(ms).toISOString()
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

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
    db.exec(SCHEMA)
    const ins = db.prepare('INSERT OR IGNORE INTO reservations (name, team_id, reason, hold_until) VALUES (?, NULL, ?, NULL)')
    for (const n of [...RESERVED_TEAM_NAMES, ...this.extraReserved]) if (!this.devNames.has(n)) ins.run(n, 'reserved')
    const free = db.prepare("DELETE FROM reservations WHERE name = ? AND team_id IS NULL AND reason = 'reserved'")
    for (const n of this.devNames) free.run(n)
  }

  // ------------------------------------------------------------ lookups

  teamByName(name: string): TeamRow | undefined {
    return this.db.prepare(`SELECT id, name, region, status, created_at, last_heartbeat_at, last_connected_at FROM teams WHERE name = ? AND status != 'released'`).get(name) as TeamRow | undefined
  }
  team(id: string): TeamRow | undefined {
    return this.db.prepare('SELECT id, name, region, status, created_at, last_heartbeat_at, last_connected_at FROM teams WHERE id = ?').get(id) as TeamRow | undefined
  }
  currentKey(teamId: string): KeyRow | undefined {
    return this.db.prepare('SELECT id, team_id, public_key, created_at, revoked_at FROM team_keys WHERE team_id = ? AND revoked_at IS NULL').get(teamId) as KeyRow | undefined
  }
  list(): TeamRow[] {
    return this.db.prepare('SELECT id, name, region, status, created_at, last_heartbeat_at, last_connected_at FROM teams ORDER BY created_at').all() as unknown as TeamRow[]
  }

  /** null when `name` can be given to `forTeam` (or to a new team), else the reason. */
  nameProblem(name: string, forTeam?: string): TeamNameProblem | 'taken' | null {
    const p = checkTeamName(name, this.extraReserved)
    if (p && !(p === 'reserved' && this.devNames.has(name))) return p
    const r = this.db.prepare('SELECT team_id, reason, hold_until FROM reservations WHERE name = ?').get(name) as { team_id: string | null; reason: string; hold_until: string | null } | undefined
    if (r) {
      const held = r.hold_until === null || Date.parse(r.hold_until) > this.now()
      const own = forTeam !== undefined && r.team_id === forTeam && r.reason !== 'blocked'
      if (held && !own) return r.reason === 'released' || r.reason === 'reclaimed' ? 'taken' : 'reserved'
    }
    const t = this.teamByName(name)
    if (t && t.id !== forTeam) return 'taken'
    return null
  }

  // ------------------------------------------------------------ registration

  register(req: RegisterRequest, powBits: number): { teamId: string; name: string; recoveryCode: string } {
    const name = typeof req.name === 'string' ? req.name : ''
    const problem = this.nameProblem(name)
    if (problem === 'taken') throw new RegistryError('name_taken', 'this team name is already in use', 409)
    if (problem === 'reserved') throw new RegistryError('name_reserved', 'this team name is reserved', 409)
    if (problem) throw new RegistryError('invalid_name', `team names are 3-40 lowercase letters, digits and hyphens (${problem})`)
    if (!Number.isInteger(req.ts) || Math.abs(this.now() - req.ts) > POW_MAX_AGE_MS) throw new RegistryError('bad_pow', 'timestamp too old or in the future')
    const key = parsePublicKey(req.publicKey)
    if (!key) throw new RegistryError('invalid_request', 'publicKey must be a base64 SPKI Ed25519 key')
    if (typeof req.nonce !== 'string' || !powOk(req, powBits)) throw new RegistryError('bad_pow', 'proof of work does not meet the difficulty')
    if (!verifyB64(key, registerSigningString(name, req.publicKey, req.ts), req.sig)) throw new RegistryError('bad_signature', 'signature does not match the key', 401)
    const region = typeof req.region === 'string' && /^[a-z0-9-]{1,32}$/.test(req.region) ? req.region : 'default'
    const teamId = randomUUID()
    const recoveryCode = newRecoveryCode()
    const at = iso(this.now())
    tx(this.db, () => {
      if (this.db.prepare('SELECT 1 AS x FROM team_keys WHERE public_key = ?').get(req.publicKey)) throw new RegistryError('key_in_use', 'this key is already registered', 409)
      if (this.teamByName(name)) throw new RegistryError('name_taken', 'this team name is already in use', 409)
      this.db.prepare('INSERT INTO teams (id, name, recovery_code_hash, region, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(teamId, name, hash(normCode(recoveryCode)), region, 'active', at)
      this.db.prepare('INSERT INTO team_keys (id, team_id, public_key, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), teamId, req.publicKey, at)
      this.db.prepare('DELETE FROM reservations WHERE name = ? AND team_id IS NOT NULL AND hold_until IS NOT NULL AND hold_until <= ?').run(name, at)
    })
    return { teamId, name, recoveryCode }
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
    this.db.prepare('UPDATE teams SET last_connected_at = ? WHERE id = ?').run(at, teamId)
    this.db.prepare('UPDATE team_keys SET last_seen_at = ? WHERE id = ?').run(at, keyId)
  }

  rename(teamId: string, name: string): void {
    const t = this.team(teamId)
    if (!t || t.status === 'released') throw new RegistryError('not_found', 'no such team', 404)
    if (t.name === name) return
    const problem = this.nameProblem(name, teamId)
    if (problem === 'taken') throw new RegistryError('name_taken', 'this team name is already in use', 409)
    if (problem === 'reserved') throw new RegistryError('name_reserved', 'this team name is reserved', 409)
    if (problem) throw new RegistryError('invalid_name', `invalid team name (${problem})`)
    tx(this.db, () => {
      this.hold(t.name, teamId, 'released')
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
      this.hold(t.name, teamId, reason)
      this.db.prepare(`UPDATE teams SET status = 'released' WHERE id = ?`).run(teamId)
      this.db.prepare('UPDATE team_keys SET revoked_at = ? WHERE team_id = ? AND revoked_at IS NULL').run(at, teamId)
    })
  }

  /** Operator kill switch (and back). */
  setStatus(teamId: string, status: 'active' | 'suspended'): void {
    const t = this.team(teamId)
    if (!t || t.status === 'released') throw new RegistryError('not_found', 'no such team', 404)
    this.db.prepare('UPDATE teams SET status = ? WHERE id = ?').run(status, teamId)
  }

  /** Operator: reserve or block a name (hold_until null = forever). */
  reserve(name: string, reason: 'reserved' | 'blocked', holdUntil: number | null = null): void {
    this.db.prepare('INSERT INTO reservations (name, team_id, reason, hold_until) VALUES (?, NULL, ?, ?) ON CONFLICT(name) DO UPDATE SET reason = excluded.reason, hold_until = excluded.hold_until, team_id = NULL')
      .run(name, reason, holdUntil === null ? null : iso(holdUntil))
  }

  reservation(name: string): { team_id: string | null; reason: string; hold_until: string | null } | undefined {
    return this.db.prepare('SELECT team_id, reason, hold_until FROM reservations WHERE name = ?').get(name) as never
  }

  private hold(name: string, teamId: string, reason: 'released' | 'reclaimed'): void {
    this.db.prepare('INSERT INTO reservations (name, team_id, reason, hold_until) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET team_id = excluded.team_id, reason = excluded.reason, hold_until = excluded.hold_until')
      .run(name, teamId, reason, iso(this.now() + NAME_HOLD_MS))
  }
}
