// Local preparation only. The live entrypoint must pass preflight and claim a receipt before calling this.
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { openDb } from '../../server/src/db'
import { hashPassword } from '../../server/src/auth/passwords'
import { setSetting } from '../../server/src/admin/settings'
import { makeCredCtx } from '../../server/src/credentials/store'
import { insertRow } from '../../server/src/credentials/service'
import { formatProblem } from '../../server/src/credentials/validate'
import { silentLogger } from '../../server/src/log'
import type { P2Limits, P2SmokePlan } from './p2-smoke-preflight'

export type P2CredentialInput = { kind: 'anthropic-api-key'; key: string } | { kind: 'anthropic-oauth'; token: string; expiresAt: string }
export interface P2Counts { providerRequests: number; engineAttempts: number }
export interface P2Receipt { persist(counts: P2Counts): void; finish(status: 'passed' | 'failed' | 'interrupted'): void; close(): void }
export interface P2Fixture {
  db: Database
  users: Record<'owner' | 'alice' | 'bob', { id: string; username: string; password: string }>
  credentialId: string
  files: { sharedRead: string; sharedText: string; aliceWrite: string; aliceText: string; bobPrivate: string; bobCanary: string; scheduleWrite: string; scheduleText: string }
}
function credentialInput(value: unknown, now: number): P2CredentialInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('P2_CREDENTIAL_INVALID')
  const o = value as Record<string, unknown>
  if (o.kind === 'anthropic-api-key' && Object.keys(o).sort().join(',') === 'key,kind' && typeof o.key === 'string' && !formatProblem(o.kind, o.key)) return { kind: o.kind, key: o.key }
  if (o.kind === 'anthropic-oauth' && Object.keys(o).sort().join(',') === 'expiresAt,kind,token' && typeof o.token === 'string' && !formatProblem(o.kind, o.token)
    && typeof o.expiresAt === 'string' && Number.isFinite(Date.parse(o.expiresAt)) && Date.parse(o.expiresAt) > now + 900_000) return { kind: o.kind, token: o.token, expiresAt: o.expiresAt }
  throw new Error('P2_CREDENTIAL_INVALID')
}

function privateParent(file: string) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('unsafe path')
  const parent = path.dirname(file), st = fs.lstatSync(parent)
  if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o022) !== 0 || fs.realpathSync(parent) !== parent) throw new Error('unsafe parent')
}

export function readP2Credential(file: string, uid: number, now = Date.now()): P2CredentialInput {
  let fd: number | undefined
  try {
    privateParent(file)
    const before = fs.lstatSync(file)
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.uid !== uid || ![0o400, 0o600].includes(st.mode & 0o7777)
      || st.size < 1 || st.size > 16_384 || st.dev !== before.dev || st.ino !== before.ino) throw new Error('unsafe credential')
    // Bound the read even if another same-UID process grows the file after fstat.
    const buffer = Buffer.alloc(16_385); const n = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (n > 16_384 || n !== st.size) throw new Error('credential changed')
    return credentialInput(JSON.parse(buffer.subarray(0, n).toString('utf8')), now)
  } catch { throw new Error('P2_CREDENTIAL_INVALID') }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

/** Append-only durable admission record. Never resumes or removes a receipt, including after a crash. */
export function claimP2Receipt(file: string, runId: string, limits: P2Limits, sync = fs.fsyncSync): P2Receipt {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)
    || Object.values(limits).some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('P2_RECEIPT_INPUT')
  let fd: number
  try {
    privateParent(file)
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_APPEND, 0o600)
  } catch { throw new Error('P2_RECEIPT_EXISTS_OR_UNSAFE') }
  let closed = false, poisoned = false, finished = false
  let counts: P2Counts = { providerRequests: 0, engineAttempts: 0 }
  function append(record: Record<string, unknown>) {
    if (closed || poisoned || finished) throw new Error('P2_RECEIPT_CLOSED')
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o7777) !== 0o600) throw new Error('unsafe receipt')
      const bytes = Buffer.from(JSON.stringify(record) + '\n')
      let offset = 0
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
        if (written <= 0) throw new Error('short write')
        offset += written
      }
      sync(fd)
    } catch { poisoned = true; throw new Error('P2_RECEIPT_IO') }
  }
  try {
    append({ schema: 1, runId, status: 'claimed', ...counts, limits: {
      providerRequests: limits.providerRequests, engineAttempts: limits.engineAttempts, toolTurns: limits.toolTurns,
      turnTimeoutMs: limits.turnTimeoutMs, totalTimeoutMs: limits.totalTimeoutMs,
    } })
    const parentFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY)
    try { sync(parentFd) } finally { fs.closeSync(parentFd) }
  } catch { fs.closeSync(fd); throw new Error('P2_RECEIPT_IO') }
  return {
    persist(next) {
      if (closed || poisoned || finished) throw new Error('P2_RECEIPT_CLOSED')
      if (!Number.isSafeInteger(next.providerRequests) || !Number.isSafeInteger(next.engineAttempts)
        || next.providerRequests < counts.providerRequests || next.engineAttempts < counts.engineAttempts
        || next.providerRequests > limits.providerRequests || next.engineAttempts > limits.engineAttempts
        || next.providerRequests - counts.providerRequests > 1 || next.engineAttempts - counts.engineAttempts > 1
        || next.providerRequests + next.engineAttempts === counts.providerRequests + counts.engineAttempts) throw new Error('P2_RECEIPT_COUNTERS')
      const clean = { providerRequests: next.providerRequests, engineAttempts: next.engineAttempts }
      append({ status: 'admitted', ...clean }); counts = clean
    },
    finish(status) {
      if (!['passed', 'failed', 'interrupted'].includes(status)) throw new Error('P2_RECEIPT_INPUT')
      append({ status, ...counts }); finished = true
    },
    close() { if (!closed) { closed = true; fs.closeSync(fd) } },
  }
}

/** Never uses the destructive makeFixture helper; creates only previously absent synthetic paths. */
export async function prepareP2Fixture(plan: P2SmokePlan, credential: P2CredentialInput): Promise<P2Fixture> {
  const input = credentialInput(credential, Date.now())
  const db = openDb(plan.dbFile)
  try {
    for (const table of ['users', 'chats', 'turns', 'schedules', 'engine_credentials', 'engine_accounts', 'groups', 'folders', 'folder_rules']) {
      if ((db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n !== 0) throw new Error('P2_FIXTURE_NOT_FRESH')
    }
    const team = plan.config.teamRoot
    const files = {
      sharedRead: 'shared/p2-input.txt', sharedText: `P2_READ_${randomBytes(16).toString('hex')}`,
      aliceWrite: 'users/alice/p2-output.txt', aliceText: `P2_WRITE_${randomBytes(16).toString('hex')}`,
      bobPrivate: 'users/bob/p2-private.txt', bobCanary: `P2_PRIVATE_${randomBytes(24).toString('hex')}`,
      scheduleWrite: 'users/alice/p2-scheduled.txt', scheduleText: `P2_SCHEDULE_${randomBytes(16).toString('hex')}`,
    }
    // Check all parents and targets before creating anything; an EEXIST later also fails closed.
    for (const rel of [files.sharedRead, files.aliceWrite, files.bobPrivate, files.scheduleWrite]) {
      const parts = rel.split('/'); let current = team
      const root = fs.lstatSync(team)
      if (!root.isDirectory() || root.uid !== process.getuid!() || fs.realpathSync(team) !== team) throw new Error('P2_FIXTURE_NOT_FRESH')
      for (const part of parts.slice(0, -1)) {
        current = path.join(current, part)
        try { const st = fs.lstatSync(current); if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o022)) throw new Error('P2_FIXTURE_NOT_FRESH') }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
      try { fs.lstatSync(path.join(team, rel)); throw new Error('P2_FIXTURE_NOT_FRESH') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    for (const dir of ['shared', 'users', 'users/alice', 'users/bob']) {
      const absolute = path.join(team, dir)
      try { fs.mkdirSync(absolute, { mode: 0o700 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      if (!fs.lstatSync(absolute).isDirectory() || fs.realpathSync(absolute) !== absolute) throw new Error('P2_FIXTURE_NOT_FRESH')
    }
    // Pre-write versions are recorded by the product; seed outputs so version history is actually exercised.
    for (const [rel, body] of [[files.sharedRead, files.sharedText], [files.bobPrivate, files.bobCanary],
      [files.aliceWrite, 'P2_BEFORE_WRITE'], [files.scheduleWrite, 'P2_BEFORE_SCHEDULE']]) {
      fs.writeFileSync(path.join(team, rel!), body!, { flag: 'wx', mode: 0o600 })
    }
    const users = {} as P2Fixture['users']
    for (const id of ['owner', 'alice', 'bob'] as const) {
      const password = `P2!${randomBytes(32).toString('base64url')}`
      users[id] = { id, username: id, password }
      db.query('INSERT INTO users (id,username,name,role,password_hash,status,must_change_password,locale) VALUES (?,?,?,?,?,?,0,?)')
        .run(id, id, `P2 ${id}`, id === 'owner' ? 'owner' : 'member', await hashPassword(password), 'active', 'en')
    }
    db.query("INSERT INTO folders (id,path) VALUES ('p2-shared','shared')").run()
    db.query("INSERT INTO folder_rules (id,folder_id,subject_type,subject_id,access) VALUES (?,'p2-shared','everyone',NULL,'write')").run(randomUUID())
    for (const [k, v] of Object.entries({ defaultEngine: 'claude-code', defaultModel: plan.marker.model, defaultLocale: 'en', concurrency: 1, timeZone: 'UTC',
      'engines.enabled': { 'claude-code': true, codex: false, api: false }, 'engines.limitFallback': false,
      'engines.memberChoice': { mode: 'everyone', groupIds: [], userIds: [] }, 'credentials.memberOwn': true,
      // Root attestation already proved no legacy agent login. Do not ask the launcher to export or clear it.
      'credentials.migratedV1': { at: new Date().toISOString(), accounts: [], codexAuth: 'none' } })) setSetting(db, k, v)
    const cc = makeCredCtx({ db, secretsDir: path.join(plan.base, 'secrets'), config: plan.config, log: silentLogger,
      fetch: (() => { throw new Error('P2_PREPARE_NETWORK_FORBIDDEN') }) as unknown as typeof fetch })
    if (!cc.allowedKinds.has(input.kind)) throw new Error('P2_CREDENTIAL_KIND_DISABLED')
    // Deliberately no verifySecret/createCredential: their provider verification would evade the live admission cap.
    const credentialId = insertRow(cc, { kind: input.kind, label: 'P2 synthetic Alice', ownerUserId: 'alice', priority: 0, assignments: [], createdBy: 'alice',
      secret: input.kind === 'anthropic-api-key' ? { key: input.key } : { token: input.token },
      expiresAt: input.kind === 'anthropic-oauth' ? input.expiresAt : null, checkedAt: null })
    cc.cache.clear()
    return { db, users, credentialId, files }
  } catch (e) {
    db.close()
    if (e instanceof Error && /^P2_[A-Z_]+$/.test(e.message)) throw e
    throw new Error('P2_FIXTURE_PREPARATION_FAILED')
  }
}
