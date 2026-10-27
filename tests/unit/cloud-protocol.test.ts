// shared/src/cloud-protocol (control-plane SH-1): the MIT contracts between the public code and the control plane.
// Vectors up to date, signing strings equal to the relay's, the tenant-command gate, enroll mode rules, plan.json
// compatible with the linux runtime's, the relay-ops validators and their zod mirrors agreeing, self-containment.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  checkTeamName, keyRotationString as relayRotate, registerSigningString as relayRegister, verifyB64,
} from '@mycel/shared/relay-protocol'
import {
  EnrollFile, EnrollRequest, EnrollResponse, NoticesFile, OPS_SCOPES, OpsClaimRequestSchema, OpsCreateTeamRequestSchema,
  OpsHoldRequestSchema, OpsKeyRequestSchema, OpsMaintenanceRequestSchema, OpsNoticeRequestSchema, OpsRenameRequestSchema,
  OpsSuspendRequestSchema, PlanFile, PlanResources, CredentialKind, CLOUD_DEFAULT_CREDENTIAL_KINDS, ReleaseFeed, RelayRegistrationFile, TENANT_COMMANDS, TeamSlug, TenantStatus, EnrollStatus,
  canonicalJson, enrollResponseProblem, keyRotationString, onlySnapshotRollback, opsScopeFor, parseClaimRequest,
  parseCreateTeamRequest, parseHoldRequest, parseKeyRequest, parseMaintenanceRequest, parseNoticeRequest,
  parseOpsAuthorizationHeader, parseRenameRequest, parseSuspendRequest, registerSigningString, tenantCommandArgv,
  tenantCommandProblem, tenantCommandTimeoutSec, type EnrollResponseInput, type TenantCommandName,
} from '@mycel/shared/cloud-protocol'
import { CredentialKind as ApiCredentialKind, Username as ApiUsername } from '@mycel/shared/api'
import { buildVectors } from '../../shared/src/cloud-protocol/vectors.ts'
import { VECTORS_FILE, vectorsText } from '../../scripts/cloud-protocol-vectors.ts'

const DIR = path.resolve(import.meta.dir, '../../shared/src/cloud-protocol')
const V = buildVectors()

describe('cloud-protocol: package', () => {
  test('MIT license file, README states the dual license', () => {
    expect(fs.readFileSync(path.join(DIR, 'LICENSE'), 'utf8')).toContain('MIT License')
    expect(fs.readFileSync(path.join(DIR, 'README.md'), 'utf8')).toMatch(/dual-licensed/)
  })
  test('self-contained: imports only from this folder, zod and node:crypto', () => {
    for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(DIR, f), 'utf8')
      for (const m of src.matchAll(/^import .* from '([^']+)'/gm)) expect([m[1]!.startsWith('./'), m[1] === 'zod', m[1] === 'node:crypto'].some(Boolean)).toBe(true)
    }
  })
  test('relay-ops.ts has no zod (the relay loads it with Node type stripping)', () => {
    const src = fs.readFileSync(path.join(DIR, 'relay-ops.ts'), 'utf8')
    expect(src).not.toMatch(/from 'zod'/)
    expect(src).not.toMatch(/\benum\s+[A-Z]/)
  })
  test('vectors/vectors.json is up to date (bun scripts/cloud-protocol-vectors.ts)', () => {
    expect(fs.readFileSync(VECTORS_FILE, 'utf8')).toBe(vectorsText())
  })
})

describe('cloud-protocol: signing', () => {
  test('register / rotate strings are the relay registry strings', () => {
    expect(registerSigningString('acme', 'PK', 5)).toBe(relayRegister('acme', 'PK', 5))
    expect(keyRotationString('t1', 'PK')).toBe(relayRotate('t1', 'PK'))
  })
  test('vector signatures verify with the vector key', () => {
    for (const s of V.signing) expect(verifyB64(V.key.publicKeySpkiB64, s.string, s.sig)).toBe(true)
    const ops = V.signing.find((s) => s.kind === 'ops')!
    expect(parseOpsAuthorizationHeader(ops.authorization)).toEqual({ keyId: 'cp', ts: ops.ts!, sig: ops.sig })
  })
  test('canonical JSON: sorted keys, no spaces, refuses what JSON cannot hold', () => {
    for (const c of V.canonicalJson) expect(canonicalJson(c.in)).toBe(c.out)
    expect(canonicalJson({ a: undefined, b: [1, 'two'] })).toBe('{"b":[1,"two"]}')
    expect(() => canonicalJson({ a: NaN })).toThrow()
    expect(() => canonicalJson([undefined])).toThrow()
    expect(() => canonicalJson({ d: new Date() })).toThrow()
    expect(() => canonicalJson({ n: 1n })).toThrow()
  })
})

describe('cloud-protocol: tenant commands', () => {
  test('the gate allows the listed commands with valid args / stdin and refuses everything else', () => {
    for (const c of V.tenantCommands.allowed) expect(tenantCommandProblem(c.command, c.args, c.stdin)).toBeNull()
    for (const c of V.tenantCommands.refused) expect(tenantCommandProblem(c.command, c.args, c.stdin)).not.toBeNull()
    expect(tenantCommandProblem('status', [], null)).not.toBeNull()
    expect(tenantCommandProblem('idle-wait', { max: { $gt: 1 } }, null)).not.toBeNull()
    expect(tenantCommandProblem('reset-link', { owner: true, username: 'kim' }, null)).not.toBeNull()
  })
  test('the fifteen commands of control-plane 3.5.3', () => {
    expect(Object.keys(TENANT_COMMANDS).sort()).toEqual([
      'apply-plan', 'backup-prepare', 'backup-upload', 'credentials-escrow-out', 'export', 'idle-wait', 'notices-set',
      'prepare-stop', 'relay-key-proof', 'relay-registration-set', 'reset-link', 'set-server-config', 'setup-token-rotate',
      'status', 'update',
    ])
  })
  test('argv and timeouts', () => {
    for (const a of V.tenantCommandArgv) expect(tenantCommandArgv(a.command as TenantCommandName, a.args as never)).toEqual(a.argv)
    expect(tenantCommandArgv('idle-wait', { max: 600 })).toEqual(['idle-wait', '--json', '--max', '600'])
    expect(tenantCommandTimeoutSec('idle-wait', { max: 600 })).toBe(630)
    expect(tenantCommandTimeoutSec('prepare-stop', { grace: 120 })).toBe(180)
    expect(tenantCommandTimeoutSec('update', { version: '1.0.0' })).toBe(1800)
  })
  test('TenantStatus is strict: no field beyond the contract (no names, IPs, tokens)', () => {
    const ok = {
      at: '2026-10-22T00:00:00Z', kitVersion: '0.3.0', rootVersion: '0.3.0',
      app: { version: '0.3.0', health: 'ok', schemaApplied: 106, readerLevel: 1, uptimeSec: 100 },
      setupNeeded: false, activeMembers: 7, queue: { running: 1, queued: 0 }, relay: { state: 'connected', detail: null },
      lastLocalBackup: { id: '20261022T020000Z-daily', at: '2026-10-22T02:00:00Z' }, lastUploadedLocalId: null,
      overall: 'ok', checks: [{ id: 'disk', status: 'ok' }], ai: { claude: 'ok', codex: 'none' },
      credentialsKey: { present: true, version: 1 },
      resources: { memCurrent: 1, memMax: 2, oomKills: 0, cpuPressureSome10: 0, ioPressureSome10: 0, diskUsed: 1, diskTotal: 2 },
      update: { running: false, step: null },
    }
    expect(TenantStatus.safeParse(ok).success).toBe(true)
    expect(TenantStatus.safeParse({ ...ok, ip: '1.2.3.4' }).success).toBe(false)
    expect(TenantStatus.safeParse({ ...ok, app: { ...ok.app, owner: 'kim' } }).success).toBe(false)
    expect(TenantStatus.safeParse({ ...ok, relay: { state: 'offline', detail: 'the relay at 1.2.3.4 refused' } }).success).toBe(false)
  })
})

describe('cloud-protocol: enroll', () => {
  test('files, requests: valid and invalid vectors', () => {
    for (const f of V.enroll.file.valid) expect(EnrollFile.safeParse(f).success).toBe(true)
    for (const f of V.enroll.file.invalid) expect(EnrollFile.safeParse(f).success).toBe(false)
    for (const r of V.enroll.request.valid) expect(EnrollRequest.safeParse(r).success).toBe(true)
    for (const r of V.enroll.request.invalid) expect(EnrollRequest.safeParse(r).success).toBe(false)
  })
  test('versions are informational: an empty kit / app version (an older mycel-enroll) reads as "unknown" (CP C-20)', () => {
    const r = EnrollRequest.parse({ ...V.enroll.request.valid[0], kitVersion: '', appVersion: '' })
    expect([r.kitVersion, r.appVersion]).toEqual(['unknown', 'unknown'])
    expect(EnrollRequest.safeParse({ ...V.enroll.request.valid[0], appVersion: 'x'.repeat(41) }).success).toBe(false)
  })
  test('ids and names: tenantId is a ULID, the time zone an IANA name; reattach may leave relayTeamId out', () => {
    const f = V.enroll.file.valid[0]!
    expect(EnrollFile.safeParse({ ...f, tenantId: '0192f1a2-7b3c-7d4e-8f50-123456789abc' }).success).toBe(false)
    expect(EnrollFile.safeParse({ ...f, timeZone: 'Asia/Seoul;reboot' }).success).toBe(false)
    expect(EnrollFile.safeParse({ ...f, timeZone: 'America/Argentina/Buenos_Aires' }).success).toBe(true)
    // ax-hostd's reimageTenant does not know the relay team; the data disk does
    expect(EnrollFile.safeParse({ ...V.enroll.file.valid[1], relayTeamId: null }).success).toBe(true)
  })
  test('enroll-status.json as mycel-enroll writes it (v, kitVersion; verify.schemaVersion null when the DB did not open)', () => {
    const st = EnrollStatus.parse({ v: 1, state: 'ok', mode: 'verify', step: 'verify', at: '2026-10-22T00:00:00.000Z', kitVersion: '0.3.0', error: null, verify: { ok: false, files: 0, bytes: 0, schemaVersion: null, seconds: 2 } })
    expect(st.verify?.schemaVersion).toBeNull()
    expect(EnrollStatus.parse({ state: 'running', at: '2026-10-22T00:00:00Z', mode: 'new' })).toMatchObject({ v: 1, kitVersion: null, verify: null })
  })
  test('an isolation-shaped file with a slug reads as mode new', () => {
    const f = EnrollFile.parse({ ...V.enroll.file.valid[0], mode: undefined, relayTeamId: undefined })
    expect(f.mode).toBe('new')
    expect(f.relayTeamId).toBeNull()
  })
  test('answers fit their mode', () => {
    const reg = { relayApi: 'https://relay.treesoop.com', teamId: 'abc-1', teamName: 'acme', publicKey: V.key.publicKeySpkiB64, address: 'https://acme.treesoop.com' }
    const server = { deployment: 'hosted' as const, relay: { url: 'wss://relay.treesoop.com/connect', teamName: 'acme' }, publicOrigins: ['https://acme.treesoop.com'], engine: { credentialKinds: ['anthropic-api-key', 'openai-api-key'] as ('anthropic-api-key' | 'openai-api-key')[] } }
    const base: EnrollResponseInput = { v: 1, server, relayRegistration: reg, setupToken: 'A'.repeat(32), plan: V.enroll.plan as never, notices: V.enroll.notices as never, restore: null }
    const nw = EnrollResponse.parse(base)
    expect(enrollResponseProblem('new', nw)).toBeNull()
    expect(enrollResponseProblem('reattach', nw)).not.toBeNull()
    expect(enrollResponseProblem('reattach', EnrollResponse.parse({ ...base, setupToken: null }))).toBeNull()
    expect(enrollResponseProblem('new', EnrollResponse.parse({ ...base, server: { ...server, relay: { ...server.relay, teamName: 'other' } } }))).toMatch(/teamName/)
    const armored = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCg==\n-----END AGE ENCRYPTED FILE-----\n'
    const restore = { chain: [{ backupId: 'b1', objects: [{ name: 'db.sqlite.zst', url: 'https://r2.example/x', sha256: 'a'.repeat(64), size: 10 }] }], identityAge: armored, credentialsKeyAge: null, expect: { files: 3, bytes: 100, schemaVersion: 106 } }
    const verify = EnrollResponse.parse({ ...base, server: null, relayRegistration: null, setupToken: null, restore })
    expect(enrollResponseProblem('verify', verify)).toBeNull()
    expect(enrollResponseProblem('restore', verify)).not.toBeNull()
  })
})

describe('cloud-protocol: files and release', () => {
  test("plan.json as the linux runtime writes it (§3.8.5) parses; the control plane's fields are optional", () => {
    const w1 = { format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, reserveMiB: 768, turnMemoryMaxMiB: null, turnPidsMax: 256, turnDiskMaxMiB: 1024, readMaxMiB: 128, convMemoryMaxMiB: null, localBackupRetentionDays: 3, updatedAt: '2026-10-22T00:00:00Z' }
    const p = PlanFile.parse(w1)
    expect(p.maxActiveMembers).toBeNull()
    expect(p.display).toBeNull()
    expect(PlanFile.parse(V.enroll.plan).maxActiveMembers).toBe(12)
    expect(PlanFile.safeParse({ ...w1, maxConcurrency: 17 }).success).toBe(false)
  })
  test('notices: at most 10, unique ids', () => {
    const n = { id: 'n1', level: 'info', audience: 'owner', text: { ko: '가', en: 'a', id: 'a' }, link: null, until: null }
    expect(NoticesFile.safeParse({ format: 1, issuedAt: '2026-10-22T00:00:00Z', notices: [n] }).success).toBe(true)
    expect(NoticesFile.safeParse({ format: 1, issuedAt: '2026-10-22T00:00:00Z', notices: [n, n] }).success).toBe(false)
    expect(NoticesFile.safeParse({ format: 1, issuedAt: '2026-10-22T00:00:00Z', notices: Array.from({ length: 11 }, (_, i) => ({ ...n, id: `n${i}` })) }).success).toBe(false)
  })
  test('registration.json: dev relay addresses are allowed over http, real ones only https', () => {
    const reg = { relayApi: 'http://127.0.0.1:19161', teamId: 't', teamName: 'myteam', publicKey: V.key.publicKeySpkiB64, address: 'http://myteam.localhost:19161' }
    expect(RelayRegistrationFile.safeParse(reg).success).toBe(true)
    expect(RelayRegistrationFile.safeParse({ ...reg, relayApi: 'http://relay.treesoop.com' }).success).toBe(false)
  })
  test('release manifest: the server feed plus optional fields', () => {
    const feed = { version: '0.3.1', publishedAt: '2026-10-22T00:00:00Z', bundles: [] }
    expect(ReleaseFeed.parse(feed).needsRoot).toBe(false)
    const full = ReleaseFeed.parse({ ...feed, readerLevel: 2, minReaderRequired: 2, rollout: { percent: 10, salt: 'x' } })
    expect(onlySnapshotRollback(1, full)).toBe(true)
    expect(onlySnapshotRollback(2, full)).toBe(false)
  })
  test('reset-link usernames = the team server\'s username rule (shared/src/api/auth.ts)', () => {
    for (const u of ['kim', 'kim.lee', 'kim@acme.co', 'k_1-2', 'a', 'x'.repeat(64), 'x'.repeat(65), '../root', 'kim lee', 'kim/lee', '한글']) {
      expect(tenantCommandProblem('reset-link', { username: u }, null) === null).toBe(ApiUsername.safeParse(u).success)
    }
  })
  test('credential kinds = the team server\'s (shared/src/api/credentials.ts); the hosted default is API keys only', () => {
    expect([...CredentialKind.options]).toEqual([...ApiCredentialKind.options])
    expect([...CLOUD_DEFAULT_CREDENTIAL_KINDS]).toEqual(['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'])
  })
  test('plan resources are ax-hostd\'s (one schema): strict, the Proxmox ranges', () => {
    const r = { memoryMB: 4096, vcpus: 3, cpuUnits: 150, dataDiskGB: 50, io: { mbps: 150, iops: 4000 }, netRateMBps: 25 }
    expect(PlanResources.safeParse(r).success).toBe(true)
    expect(PlanResources.safeParse({ ...r, extra: 1 }).success).toBe(false)
    expect(PlanResources.safeParse({ ...r, cpuUnits: 300_000 }).success).toBe(false)
  })
  test('team slug rule = the relay name rule (reserved words aside)', () => {
    for (const n of ['acme', 'a-b', 'ab', 'Acme', '-ab', 'ab-', 'xn--abc', 'a'.repeat(40), 'a'.repeat(41), 'ab_c', 'www', '0ab']) {
      const relay = checkTeamName(n)
      expect(TeamSlug.safeParse(n).success).toBe(relay === null || relay === 'reserved')
    }
  })
})

describe('cloud-protocol: relay operator API', () => {
  const pairs: [(x: unknown) => { ok: boolean }, { safeParse(x: unknown): { success: boolean } }, unknown[], unknown[]][] = [
    [parseHoldRequest, OpsHoldRequestSchema, [{ name: 'acme', ttlSec: 1800 }], [{ name: 'acme', ttlSec: 3601 }, { name: 'acme' }, { name: 'acme', ttlSec: 5, x: 1 }]],
    [parseCreateTeamRequest, OpsCreateTeamRequestSchema,
      [{ name: 'acme', publicKey: V.key.publicKeySpkiB64, ts: 1, sig: 'AAAA', region: 'kr-seoul-1', origin: 'cloud', externalRef: '0192-abc' }],
      [{ name: 'acme', publicKey: V.key.publicKeySpkiB64, ts: 1, sig: 'AAAA', region: 'kr-seoul-1', origin: 'self', externalRef: 'x' },
        { name: 'acme', publicKey: V.key.publicKeySpkiB64, ts: 1, sig: 'AAAA', region: 'KR', origin: 'cloud', externalRef: 'x' },
        { name: 'acme', publicKey: 'not base64!', ts: 1, sig: 'AAAA', region: 'kr', origin: 'cloud', externalRef: 'x' }]],
    [parseSuspendRequest, OpsSuspendRequestSchema, [{ reason: 'billing' }, { reason: 'operator' }], [{ reason: 'because' }, {}]],
    [(x) => parseMaintenanceRequest(x, 0), OpsMaintenanceRequestSchema, [{ untilMs: null }, { untilMs: 1000 }], [{ untilMs: 'soon' }, {}]],
    [parseKeyRequest, OpsKeyRequestSchema, [{ publicKey: 'AAAA', newKeySig: 'BBBB' }], [{ publicKey: 'AAAA' }]],
    [parseRenameRequest, OpsRenameRequestSchema, [{ name: 'acme' }], [{ name: '' }, { name: 'a', other: 1 }]],
    [parseNoticeRequest, OpsNoticeRequestSchema, [{ level: 'warn', code: 'fair_use', message: 'hi' }], [{ level: 'critical', code: 'x', message: 'm' }, { level: 'info', code: 'Bad Code', message: 'm' }]],
    [parseClaimRequest, OpsClaimRequestSchema, [{ name: 'acme', ttlSec: 604800, externalRef: 'team-1' }], [{ name: 'acme', ttlSec: 604801, externalRef: 'team-1' }, { name: 'acme', ttlSec: 3600 }]],
  ]
  test('the plain validators (relay) and the zod schemas (control plane) agree', () => {
    for (const [plain, zod, good, badOnes] of pairs) {
      for (const g of good) { expect(plain(g).ok).toBe(true); expect(zod.safeParse(g).success).toBe(true) }
      for (const b of badOnes) { expect(plain(b).ok).toBe(false); expect(zod.safeParse(b).success).toBe(false) }
    }
  })
  test('every endpoint has a scope; unknown paths have none', () => {
    const table: [string, string, string | null][] = [
      ['GET', '/ops/v1/names/acme', 'teams:read'], ['POST', '/ops/v1/holds', 'teams:write'], ['DELETE', '/ops/v1/holds/acme', 'teams:write'],
      ['POST', '/ops/v1/teams', 'teams:write'], ['GET', '/ops/v1/teams/t1', 'teams:read'], ['GET', '/ops/v1/teams', 'teams:read'],
      ['POST', '/ops/v1/teams/t1/suspend', 'teams:write'], ['POST', '/ops/v1/teams/t1/unsuspend', 'teams:write'],
      ['POST', '/ops/v1/teams/t1/maintenance', 'teams:write'], ['PUT', '/ops/v1/teams/t1/key', 'teams:write'],
      ['PATCH', '/ops/v1/teams/t1', 'teams:write'], ['DELETE', '/ops/v1/teams/t1', 'teams:write'],
      ['POST', '/ops/v1/teams/t1/notice', 'notice:write'], ['POST', '/ops/v1/claims', 'claims:write'],
      ['DELETE', '/ops/v1/claims/ref', 'claims:write'], ['GET', '/ops/v1/stats', 'teams:read'],
      ['GET', '/ops/v1/teams/t1/extra', null], ['POST', '/ops/v1/stats', null], ['GET', '/teams/t1', null],
    ]
    for (const [m, p, s] of table) expect(opsScopeFor(m, p)).toBe(s as never)
    expect(OPS_SCOPES.length).toBe(4)
  })
  test('Node loads relay-ops.ts directly (type stripping, no build step)', () => {
    if (!Bun.which('node')) return
    const p = Bun.spawnSync(['node', '--disable-warning=ExperimentalWarning', '-e', `import(${JSON.stringify(path.join(DIR, 'relay-ops.ts'))}).then((m) => console.log(m.opsSigningString('get', '/ops/v1/stats', 1, '')))`])
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toContain('mycel-relay-ops-v1\nGET\n/ops/v1/stats\n1\ne3b0c442')
  })
})
