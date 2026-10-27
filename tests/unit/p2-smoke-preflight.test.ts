import { afterEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { P2_SMOKE_BASE as B, P2_SMOKE_MARKER as M, P2_SMOKE_RECEIPT as R, preflightP2Smoke, assertP2ToolsSocket, collectP2RootAttestation, p2PreflightIO, type PreflightIO, type P2Stat, type P2SmokeMarker } from '../linux/p2-smoke-preflight'

const NOW = Date.parse('2026-10-26T01:00:00.000Z')
const digest = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const temps: string[] = []
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

// Real file bytes, injected Linux metadata/identity: tests never need Linux role accounts or root.
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-preflight-')); temps.push(tmp)
  const stats = new Map<string, P2Stat>(), files = new Map<string, string>(), links = new Map<string, string>(), reads: string[] = []
  const sr = { name: 'p2srv', uid: 901, gid: 901 }, ag = { name: 'p2agent', uid: 902, gid: 902 }
  const stat = (kind: P2Stat['kind'], uid = 0, gid = 0, mode = 0o755): P2Stat => ({ kind, uid, gid, mode, nlink: 1, size: 0 })
  function dir(p: string, uid = 0, gid = 0, mode = 0o755) { stats.set(p, stat('directory', uid, gid, mode)) }
  function file(p: string, data: string, uid = 0, gid = 0, mode = 0o644) {
    const f = files.get(p) ?? path.join(tmp, String(files.size)); files.set(p, f); fs.writeFileSync(f, data)
    stats.set(p, { ...stat('file', uid, gid, mode), size: Buffer.byteLength(data) })
  }
  for (const p of ['/', '/var', '/var/lib', B, `${B}/root`, `${B}/run`]) dir(p)
  for (const p of ['data', 'team', 'config', 'secrets']) dir(`${B}/${p}`, sr.uid, sr.gid, 0o700)
  dir(`${B}/status`, sr.uid, 0, 0o750)
  dir(`${B}/agent`, ag.uid, ag.gid, 0o700); dir(`${B}/agent/home`, 0, 0, 0o555)
  dir(`${B}/agent/codex-auth`, ag.uid, ag.gid, 0o700)
  dir(`${B}/run/tools`, sr.uid, ag.gid, 0o2750); dir(`${B}/run-launcher`, ag.uid, sr.gid, 0o2750)
  stats.set(`${B}/run-launcher/launcher.sock`, stat('socket', ag.uid, sr.gid, 0o660))
  const version = '0.2.2-p2', bundle = `${B}/app/versions/${version}`
  for (const p of ['app', 'app/versions', `app/versions/${version}`, `app/versions/${version}/bin`, `app/versions/${version}/native`, `app/versions/${version}/server`, `app/versions/${version}/server/src`, `app/versions/${version}/root`]) dir(`${B}/${p}`, sr.uid, sr.gid)
  stats.set(`${B}/app/current`, stat('symlink', sr.uid, sr.gid, 0o777)); links.set(`${B}/app/current`, bundle)
  for (const p of ['app/engines', 'app/engines/claude', 'app/engines/claude/123456789abc']) dir(`${B}/${p}`, sr.uid, ag.gid, 0o750)
  const claude = `${B}/app/engines/claude/123456789abc/claude`
  file(claude, 'synthetic ELF fixture', sr.uid, ag.gid, 0o750)
  stats.set(`${B}/app/engines/claude/current`, stat('symlink', sr.uid, ag.gid, 0o777)); links.set(`${B}/app/engines/claude/current`, path.dirname(claude))
  const lock = JSON.stringify({ format: 1, claude: { version: '2.1.305', 'linux-arm64': { sha256: digest('synthetic ELF fixture'), size: 21 } } })
  const entries: Record<string, { sha256: string; size: number; mode: number }> = {}
  for (const rel of ['bin/bun', 'native/mycel-gate', 'native/mycel-bridge', 'server/src/main.js', 'root/mycel-launcher', 'root/mycel-sandbox', 'root/mycel-bootstrap', 'engines.lock.json']) {
    const data = rel === 'engines.lock.json' ? lock : `fixture ${rel}`
    const mode = rel.endsWith('.json') || rel.endsWith('.js') ? 0o644 : 0o755
    file(`${bundle}/${rel}`, data, sr.uid, sr.gid, mode)
    entries[rel] = { sha256: digest(data), size: Buffer.byteLength(data), mode }
    if (rel.startsWith('root/')) file(`${B}/${rel}`, data, 0, 0, 0o755)
  }
  file(`${B}/root/VERSION`, version)
  file(`${bundle}/manifest.json`, JSON.stringify({ format: 1, version, files: entries }), sr.uid, sr.gid)
  const config = { mode: 'prod', listen: { host: '127.0.0.1', port: 47820 }, tls: null, teamRoot: `${B}/team`, dataDir: `${B}/data`, logDir: null,
    engine: { authMode: 'subscription', claudeBin: `${B}/app/engines/claude/current/claude`, codexBin: '', proxyPort: 47821, runDir: `${B}/run/tools`, agentRoot: `${B}/agent`, launcherSock: `${B}/run-launcher/launcher.sock`, agentUid: ag.uid },
    relay: { url: null, teamName: null, officialAvailable: false }, update: { auto: false, feedUrl: null } }
  file(`${B}/config/server.json`, JSON.stringify(config), sr.uid, sr.gid, 0o600)
  file(`${B}/data/app.db`, 'synthetic DB metadata is injected', sr.uid, sr.gid, 0o600)
  const credential = `${B}/secrets/p2-claude.json`; file(credential, 'DO NOT READ THIS BODY', sr.uid, sr.gid, 0o400)
  const marker: P2SmokeMarker = { schema: 1, purpose: 'p2-linux-claude-smoke', id: 'mycel-p2-smoke', base: B,
    runId: 'abf947ec-31e9-4cd6-b99f-7c8819da30e1', expiresAt: new Date(NOW + 3600000).toISOString(), configSha256: digest(JSON.stringify(config)), bundleManifestSha256: digest(fs.readFileSync(files.get(`${bundle}/manifest.json`)!)),
    server: sr, agent: ag, model: 'claude-sonnet-4-5', credentialFile: credential,
    limits: { providerRequests: 20, engineAttempts: 8, toolTurns: 6, turnTimeoutMs: 120000, totalTimeoutMs: 900000 },
    agentHome: { uid: 0, gid: 0, mode: 0o555, auditedAt: new Date(NOW - 1000).toISOString() }, legacyAgentAuthAbsent: true }
  const counts = { users: 0, chats: 0, turns: 0, schedules: 0, credentials: 0, engine_accounts: 0 }
  const resolve = (p: string) => { for (const [from, to] of links) if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length); return p }
  const io: PreflightIO = {
    platform: 'linux', arch: 'arm64', uid: sr.uid, gid: sr.gid,
    lstat(p) { return stats.get(resolve(p) === p || stats.has(p) ? p : resolve(p)) ?? null },
    realpath: resolve,
    readFile(p) { reads.push(p); const f = files.get(resolve(p)); if (!f) throw new Error('missing fixture'); return fs.readFileSync(f) },
    readDir(p) { return [...stats.keys()].filter(k => path.dirname(k) === p).map(k => path.basename(k)) },
    sha256(p) { return digest(io.readFile(p)) },
    account(name) { const a = name === sr.name ? sr : name === ag.name ? ag : null; return a && { ...a, home: `${B}/${a === sr ? 'data' : 'agent/home'}`, shell: '/usr/sbin/nologin', groupName: a.name, extraGroups: [] } },
    dbCounts() { return { ...counts } },
  }
  const syncMarker = () => file(M, JSON.stringify(marker), 0, sr.gid, 0o640)
  const syncConfig = () => { file(`${B}/config/server.json`, JSON.stringify(config), sr.uid, sr.gid, 0o600); marker.configSha256 = digest(JSON.stringify(config)); syncMarker() }
  syncMarker()
  return { io, marker, config, stats, links, reads, dir, file, syncMarker, syncConfig, counts, bundle, credential, sr, ag }
}

test('valid installed fixture normalizes subscription, reads no secret and permits missing pre-start tools socket', () => {
  const f = fixture(), p = preflightP2Smoke({ io: f.io, now: NOW })
  expect(p.config.engine.authMode).toBe('managed'); expect(p.bundleDir).toBe(f.bundle)
  expect(p.receiptFile).toBe(R); expect(p.marker.limits.providerRequests).toBe(20)
  expect(f.reads).not.toContain(f.credential)
})

for (const [name, mutate, reason] of [
  ['wrong platform', (f: ReturnType<typeof fixture>) => { f.io.platform = 'darwin' }, 'linux'],
  ['root worker', f => { f.io.uid = 0 }, 'worker identity'],
  ['wrong worker group', f => { f.io.gid = 0 }, 'worker identity'],
  ['untrusted marker', f => { f.stats.get(M)!.uid = f.sr.uid }, 'marker metadata'],
  ['world-readable marker', f => { f.stats.get(M)!.mode = 0o644 }, 'marker metadata'],
  ['expired run', f => { f.marker.expiresAt = new Date(NOW).toISOString(); f.syncMarker() }, 'expiry'],
  ['missing explicit budget', f => { delete (f.marker.limits as any).providerRequests; f.syncMarker() }, 'limits'],
  ['invalid run id', f => { f.marker.runId = 'another-install'; f.syncMarker() }, 'marker schema'],
  ['changed config', f => { f.file(`${B}/config/server.json`, '{}', f.sr.uid, f.sr.gid, 0o600) }, 'config hash'],
  ['local login', f => { f.config.engine.authMode = 'local-login'; f.syncConfig() }, 'managed'],
  ['relay enabled', f => { (f.config.relay as any).url = 'wss://example.invalid'; f.syncConfig() }, 'relay'],
  ['automatic updates', f => { f.config.update.auto = true; f.syncConfig() }, 'update'],
  ['escaped data path', f => { f.config.dataDir = '/tmp/outside'; f.syncConfig() }, 'layout'],
  ['escaped bundle symlink', f => { f.links.set(`${B}/app/current`, '/tmp/outside') }, 'bundle'],
  ['missing lock', f => { f.stats.delete(`${f.bundle}/engines.lock.json`) }, 'bundle file'],
  ['untrusted root executable', f => { f.stats.get(`${B}/root/mycel-launcher`)!.uid = f.sr.uid }, 'root program'],
  ['root executable symlink', f => { f.stats.get(`${B}/root/mycel-sandbox`)!.kind = 'symlink' }, 'root program'],
  ['wrong launcher type', f => { f.stats.get(`${B}/run-launcher/launcher.sock`)!.kind = 'file' }, 'launcher socket'],
  ['wrong launcher group', f => { f.stats.get(`${B}/run-launcher/launcher.sock`)!.gid = f.ag.gid }, 'launcher socket'],
  ['tools parent lacks setgid', f => { f.stats.get(`${B}/run/tools`)!.mode = 0o750 }, 'tools parent'],
  ['agent directory shared', f => { f.stats.get(`${B}/agent`)!.mode = 0o750 }, 'agent directory'],
  ['hardlinked credential', f => { f.stats.get(f.credential)!.nlink = 2 }, 'credential metadata'],
  ['credential symlink', f => { f.stats.get(f.credential)!.kind = 'symlink' }, 'credential metadata'],
  ['credential readable by group', f => { f.stats.get(f.credential)!.mode = 0o640 }, 'credential metadata'],
  ['prior receipt even empty', f => { f.file(R, '', f.sr.uid, f.sr.gid, 0o600) }, 'receipt'],
  ['nonempty users', f => { f.counts.users = 1 }, 'fresh database'],
  ['legacy DB account', f => { f.counts.engine_accounts = 1 }, 'fresh database'],
  ['legacy token file', f => { f.file(`${B}/secrets/claude-oauth-token`, 'not read') }, 'legacy credential'],
  ['legacy key folder', f => { f.file(`${B}/data/secrets`, 'not read') }, 'legacy credential'],
  ['missing root home attestation', f => { delete (f.marker as any).agentHome; f.syncMarker() }, 'marker schema'],
  ['untrusted app/current owner', f => { f.stats.get(`${B}/app/current`)!.uid = f.ag.uid }, 'bundle link'],
  ['untrusted engine/current owner', f => { f.stats.get(`${B}/app/engines/claude/current`)!.uid = f.ag.uid }, 'engine link'],
  ['existing team document', f => { f.file(`${B}/team/old.txt`, 'unread existing content', f.sr.uid, f.sr.gid, 0o600) }, 'fresh team'],
  ['existing session state', f => { f.file(`${B}/data/old-session.json`, 'unread existing content', f.sr.uid, f.sr.gid, 0o600) }, 'fresh data'],
  ['unexpected secret source', f => { f.file(`${B}/secrets/other-key`, 'not read', f.sr.uid, f.sr.gid, 0o600) }, 'legacy credential'],
  ['nonempty WAL', f => { f.file(`${B}/data/app.db-wal`, 'pending transaction', f.sr.uid, f.sr.gid, 0o600) }, 'fresh database'],
  ['existing vault key version', f => { f.file(`${B}/secrets/credentials.key.2`, 'not read', f.sr.uid, f.sr.gid, 0o600) }, 'legacy credential'],
  ['linked empty WAL', f => { f.file(`${B}/data/app.db-wal`, '', f.sr.uid, f.sr.gid, 0o600); f.stats.get(`${B}/data/app.db-wal`)!.nlink = 2 }, 'fresh database'],
] satisfies [string, (f: ReturnType<typeof fixture>) => void, string][]) {
  test(`rejects ${name} before credential body access`, () => {
    const f = fixture(); mutate(f)
    expect(() => preflightP2Smoke({ io: f.io, now: NOW })).toThrow(reason)
    expect(f.reads).not.toContain(f.credential)
  })
}

test('worker uses explicit root attestation without traversing engine-private home', () => {
  const f = fixture(), original = f.io.lstat
  f.io.lstat = p => { if (p.startsWith(`${B}/agent/`)) throw new Error('EACCES'); return original(p) }
  expect(preflightP2Smoke({ io: f.io, now: NOW }).marker.agentHome.auditedAt).toBe(new Date(NOW - 1000).toISOString())
})

test('post-start socket check requires actual server:agent 0660 socket', () => {
  const f = fixture(), p = preflightP2Smoke({ io: f.io, now: NOW })
  expect(() => assertP2ToolsSocket(p, f.io)).toThrow('tools socket')
  f.stats.set(p.toolsSock, { kind: 'socket', uid: f.sr.uid, gid: f.ag.gid, mode: 0o660, nlink: 1, size: 0 })
  expect(() => assertP2ToolsSocket(p, f.io)).not.toThrow()
  f.stats.get(p.toolsSock)!.gid = f.sr.gid
  expect(() => assertP2ToolsSocket(p, f.io)).toThrow('tools socket')
})

test('root collector inspects home and legacy auth presence, never their contents', () => {
  const f = fixture()
  expect(() => collectP2RootAttestation(f.io, NOW)).toThrow('root identity')
  f.io.uid = 0; f.io.gid = 0
  expect(collectP2RootAttestation(f.io, NOW)).toEqual({ agentHome: { uid: 0, gid: 0, mode: 0o555, auditedAt: new Date(NOW).toISOString() }, legacyAgentAuthAbsent: true })
  f.file(`${B}/agent/codex-auth/auth.json`, 'not read', f.ag.uid, f.ag.gid, 0o600)
  expect(() => collectP2RootAttestation(f.io, NOW)).toThrow('legacy credential')
  expect(f.reads).toEqual([])
})

test('root collector rejects a linked legacy auth directory, even without an auth file', () => {
  const f = fixture(); f.io.uid = 0; f.io.gid = 0
  f.stats.get(`${B}/agent/codex-auth`)!.kind = 'symlink'
  expect(() => collectP2RootAttestation(f.io, NOW)).toThrow('legacy credential')
})

test('missing DB remains missing and is accepted only without orphan journals', () => {
  const f = fixture(); f.stats.delete(`${B}/data/app.db`)
  expect(preflightP2Smoke({ io: f.io, now: NOW }).dbFile).toBe(`${B}/data/app.db`)
  expect(f.reads).not.toContain(`${B}/data/app.db`)
  f.file(`${B}/data/app.db-wal`, '', f.sr.uid, f.sr.gid, 0o600)
  expect(() => preflightP2Smoke({ io: f.io, now: NOW })).toThrow('orphan journal')
})

test('real SQLite adapter counts a detached snapshot without creating WAL/SHM or changing bytes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-db-read-')); temps.push(tmp)
  const db = new Database(':memory:')
  for (const name of ['users', 'chats', 'turns', 'schedules', 'engine_credentials', 'engine_accounts']) db.exec(`CREATE TABLE ${name} (id TEXT)`)
  db.exec("INSERT INTO engine_credentials VALUES ('synthetic')")
  const file = path.join(tmp, 'app.db'), bytes = db.serialize(); db.close(); fs.writeFileSync(file, bytes)
  expect(p2PreflightIO().dbCounts(file)).toEqual({ users: 0, chats: 0, turns: 0, schedules: 0, credentials: 1, engine_accounts: 0 })
  expect(fs.readdirSync(tmp)).toEqual(['app.db']); expect(digest(fs.readFileSync(file))).toBe(digest(bytes))
})

test('fresh server startup may leave empty textcache and uploads directories', () => {
  const f = fixture()
  for (const name of ['textcache', 'uploads']) f.dir(`${B}/data/${name}`, f.sr.uid, f.sr.gid, 0o700)
  expect(() => preflightP2Smoke({ io: f.io, now: NOW })).not.toThrow()
  f.file(`${B}/data/uploads/old.part`, 'unread', f.sr.uid, f.sr.gid, 0o600)
  expect(() => preflightP2Smoke({ io: f.io, now: NOW })).toThrow('fresh data')
})

test('real adapter accepts a stopped checkpointed WAL database without changing its header or writing sidecars', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-db-wal-')); temps.push(tmp)
  const file = path.join(tmp, 'app.db'), db = new Database(file)
  db.exec('PRAGMA journal_mode=WAL')
  for (const name of ['users', 'chats', 'turns', 'schedules', 'engine_credentials', 'engine_accounts']) db.exec(`CREATE TABLE ${name} (id TEXT)`)
  db.close()
  const before = fs.readFileSync(file), names = fs.readdirSync(tmp)
  expect(p2PreflightIO().dbCounts(file).users).toBe(0)
  expect(digest(fs.readFileSync(file))).toBe(digest(before)); expect(fs.readdirSync(tmp)).toEqual(names)
})
