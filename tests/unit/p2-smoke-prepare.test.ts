import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadAppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { getSetting } from '../../server/src/admin/settings'
import { resolveCredential } from '../../server/src/credentials/resolve'
import { makeCredCtx, secretOf, getRow } from '../../server/src/credentials/store'
import { silentLogger } from '../../server/src/log'
import { claimP2Receipt, prepareP2Fixture, readP2Credential } from '../linux/p2-smoke-prepare'
import type { P2Limits, P2SmokePlan } from '../linux/p2-smoke-preflight'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
function temp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-prepare-')); fs.chmodSync(d, 0o700); dirs.push(d); return d }
const limits: P2Limits = { providerRequests: 20, engineAttempts: 6, toolTurns: 6, turnTimeoutMs: 120_000, totalTimeoutMs: 900_000 }
// Synthetic, never sent to a provider. Constructed to keep secret scanners from treating fixtures as live keys.
const key = ['sk', 'ant', 'api03', 'P2_TEST_ONLY_'.repeat(3)].join('-')
const uid = process.getuid!()
function credFile(d: string, value: unknown = { kind: 'anthropic-api-key', key }) {
  const f = path.join(d, 'credential.json'); fs.writeFileSync(f, JSON.stringify(value), { mode: 0o600 }); return f
}
test('credential input uses only the explicit protected file', () => {
  expect(readP2Credential(credFile(temp()), uid)).toEqual({ kind: 'anthropic-api-key', key })
})
test('credential errors never echo malformed body or key', () => {
  const f = credFile(temp()); fs.writeFileSync(f, `not-json-${key}`)
  try { readP2Credential(f, uid); throw new Error('accepted') } catch (e) { expect((e as Error).message).toBe('P2_CREDENTIAL_INVALID') }
})
for (const attack of ['mode', 'symlink', 'hardlink', 'owner', 'size', 'extra', 'expiry'] as const) {
  test(`credential refuses ${attack}`, () => {
    const d = temp(); let f = credFile(d)
    if (attack === 'mode') fs.chmodSync(f, 0o644)
    if (attack === 'symlink') { const link = path.join(d, 'link'); fs.symlinkSync(f, link); f = link }
    if (attack === 'hardlink') fs.linkSync(f, path.join(d, 'hard'))
    if (attack === 'size') fs.writeFileSync(f, 'x'.repeat(20_000))
    if (attack === 'extra') fs.writeFileSync(f, JSON.stringify({ kind: 'anthropic-api-key', key, token: 'extra' }))
    if (attack === 'expiry') fs.writeFileSync(f, JSON.stringify({ kind: 'anthropic-oauth', token: ['sk','ant','oat01','x'.repeat(30)].join('-'), expiresAt: '2000-01-01T00:00:00.000Z' }))
    expect(() => readP2Credential(f, attack === 'owner' ? uid + 1 : uid)).toThrow('P2_CREDENTIAL_INVALID')
  })
}
test('receipt is durable before admission, cannot reopen, and contains only bounded counters', () => {
  const f = path.join(temp(), 'receipt.jsonl'); const runId = randomUUID(); let syncs = 0
  const r = claimP2Receipt(f, runId, limits, fd => { fs.fsyncSync(fd); syncs++ })
  r.persist({ providerRequests: 1, engineAttempts: 1 })
  expect(syncs).toBeGreaterThanOrEqual(2)
  expect(() => claimP2Receipt(f, runId, limits)).toThrow('P2_RECEIPT_EXISTS_OR_UNSAFE')
  expect(() => r.persist({ providerRequests: 0, engineAttempts: 1 })).toThrow('P2_RECEIPT_COUNTERS')
  r.finish('failed'); r.close()
  expect(fs.statSync(f).mode & 0o777).toBe(0o600)
  const records = fs.readFileSync(f, 'utf8').trim().split('\n').map(s => JSON.parse(s))
  expect(records.at(-1).status).toBe('failed')
  expect(records.at(-1).providerRequests).toBe(1)
  expect(records[0].runId).toBe(runId)
  expect(fs.readFileSync(f, 'utf8')).not.toContain(key)
})
test('receipt rejects overspend and counter jumps before writing', () => {
  const f = path.join(temp(), 'r'); const r = claimP2Receipt(f, randomUUID(), limits)
  const before = fs.readFileSync(f, 'utf8')
  expect(() => r.persist({ providerRequests: 21, engineAttempts: 0 })).toThrow('P2_RECEIPT_COUNTERS')
  expect(() => r.persist({ providerRequests: 2, engineAttempts: 0 })).toThrow('P2_RECEIPT_COUNTERS')
  expect(fs.readFileSync(f, 'utf8')).toBe(before); r.close()
})
test('failed fsync poisons the receipt and never allows a later admission', () => {
  const f = path.join(temp(), 'r'); let calls = 0
  const r = claimP2Receipt(f, randomUUID(), limits, fd => { if (++calls === 3) throw new Error('disk unavailable'); fs.fsyncSync(fd) })
  expect(() => r.persist({ providerRequests: 1, engineAttempts: 0 })).toThrow('P2_RECEIPT_IO')
  expect(() => r.persist({ providerRequests: 1, engineAttempts: 0 })).toThrow('P2_RECEIPT_CLOSED')
  r.close(); expect(() => claimP2Receipt(f, randomUUID(), limits)).toThrow()
})
test('receipt rejects symlink without touching target', () => {
  const d = temp(); const target = path.join(d, 'target'); fs.writeFileSync(target, 'untouched')
  const f = path.join(d, 'r'); fs.symlinkSync(target, f)
  expect(() => claimP2Receipt(f, randomUUID(), limits)).toThrow('P2_RECEIPT_EXISTS_OR_UNSAFE')
  expect(fs.readFileSync(target, 'utf8')).toBe('untouched')
})
function plan(): P2SmokePlan {
  const base = temp(); for (const d of ['data', 'team', 'secrets']) fs.mkdirSync(path.join(base, d), { mode: 0o700 })
  const config = loadAppConfig({ env: {}, argv: [], cwd: base }); config.teamRoot = path.join(base, 'team'); config.dataDir = path.join(base, 'data')
  return { base, config, dbFile: path.join(base, 'data', 'mycel.sqlite'), marker: { runId: randomUUID(), model: 'claude-haiku-5-5', limits } } as P2SmokePlan
}
test('fresh synthetic fixture uses encrypted personal Alice credential without network verification', async () => {
  const p = plan(); const f = await prepareP2Fixture(p, { kind: 'anthropic-api-key', key })
  try {
    expect((f.db.query('SELECT count(*) AS n FROM users').get() as {n:number}).n).toBe(3)
    expect(getSetting<Record<string, boolean>>(f.db, 'engines.enabled')).toEqual({ 'claude-code': true, codex: false, api: false })
    expect(getSetting<boolean>(f.db, 'engines.limitFallback')).toBe(false)
    expect(getSetting<{codexAuth:string}>(f.db, 'credentials.migratedV1')?.codexAuth).toBe('none')
    const allowedKinds = new Set<'anthropic-api-key'>(['anthropic-api-key'])
    expect(resolveCredential(f.db, { userId: 'alice', engine: 'claude-code', allowedKinds }).ok).toBe(true)
    expect(resolveCredential(f.db, { userId: 'bob', engine: 'claude-code', allowedKinds }).ok).toBe(false)
    const cc = makeCredCtx({ db: f.db, secretsDir: path.join(p.base, 'secrets'), config: p.config, log: silentLogger })
    expect(secretOf(cc, getRow(f.db, f.credentialId)!)).toEqual({ key })
    const row = f.db.query('SELECT secret_enc, checked_at FROM engine_credentials').get() as {secret_enc:string;checked_at:null}
    expect(row.secret_enc).not.toContain(key); expect(row.checked_at).toBeNull()
    expect(fs.readFileSync(path.join(p.config.teamRoot, f.files.bobPrivate), 'utf8')).toBe(f.files.bobCanary)
    expect(fs.readFileSync(path.join(p.config.teamRoot, f.files.aliceWrite), 'utf8')).toBe('P2_BEFORE_WRITE')
    expect(fs.readFileSync(path.join(p.config.teamRoot, f.files.scheduleWrite), 'utf8')).toBe('P2_BEFORE_SCHEDULE')
    expect(await Bun.password.verify(f.users.alice.password, (f.db.query("SELECT password_hash FROM users WHERE id='alice'").get() as {password_hash:string}).password_hash)).toBe(true)
  } finally { f.db.close() }
})
test('seed refuses an existing user before creating files or credential keys', async () => {
  const p = plan(); const db = openDb(p.dbFile); db.query("INSERT INTO users(id,username,name,role) VALUES('existing','existing','existing','owner')").run(); db.close()
  await expect(prepareP2Fixture(p, { kind: 'anthropic-api-key', key })).rejects.toThrow('P2_FIXTURE_NOT_FRESH')
  expect(fs.readdirSync(p.config.teamRoot)).toEqual([]); expect(fs.readdirSync(path.join(p.base, 'secrets'))).toEqual([])
})
test('seed refuses existing synthetic path without overwriting or removing it', async () => {
  const p = plan(); fs.mkdirSync(path.join(p.config.teamRoot, 'shared')); fs.writeFileSync(path.join(p.config.teamRoot, 'shared', 'p2-input.txt'), 'keep')
  await expect(prepareP2Fixture(p, { kind: 'anthropic-api-key', key })).rejects.toThrow('P2_FIXTURE_NOT_FRESH')
  expect(fs.readFileSync(path.join(p.config.teamRoot, 'shared', 'p2-input.txt'), 'utf8')).toBe('keep')
})
