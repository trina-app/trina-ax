// Read-only admission for the dedicated P2 install. No launcher, context, migration or credential body reads.
// Preparation must stop the dedicated server first (install-linux.sh starts it; there is no --no-start).
// Fresh startup creates empty data/textcache and data/uploads. Vault keys are created on first use, not merely
// by constructing createContext. A periodic backup can create user-state artifacts: do not leave the fresh server
// running until that tick, and never delete unexpected state just to make preflight pass.
// This is an admission snapshot, not a process/firewall attestation. The bundle hash covers installed artifacts;
// a source-imported runner needs its own delivered-source manifest tied to this run (the caller's responsibility).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import { AppConfigFile, normalizeAuthMode, type AppConfig } from '../../server/src/app-config'

export const P2_SMOKE_ID = 'mycel-p2-smoke'
export const P2_SMOKE_BASE = '/var/lib/mycel-p2-smoke'
export const P2_SMOKE_MARKER = `${P2_SMOKE_BASE}/root/p2-smoke.json`
export const P2_SMOKE_RECEIPT = `${P2_SMOKE_BASE}/status/p2-smoke.receipt.json`
export interface P2Identity { name: string; uid: number; gid: number }
export interface P2Limits { providerRequests: number; engineAttempts: number; toolTurns: number; turnTimeoutMs: number; totalTimeoutMs: number }
export interface P2RootAttestation {
  agentHome: { uid: 0; gid: 0; mode: number; auditedAt: string }
  legacyAgentAuthAbsent: true
}
export interface P2SmokeMarker extends P2RootAttestation {
  schema: 1; purpose: 'p2-linux-claude-smoke'; id: typeof P2_SMOKE_ID; base: typeof P2_SMOKE_BASE
  runId: string; expiresAt: string; configSha256: string; bundleManifestSha256: string
  server: P2Identity; agent: P2Identity; model: string; credentialFile: string; limits: P2Limits
}
export interface P2Stat { kind: 'file' | 'directory' | 'socket' | 'symlink' | 'other'; uid: number; gid: number; mode: number; nlink: number; size: number }
export interface P2Account extends P2Identity { home: string; shell: string; groupName: string; extraGroups: string[] }
export interface PreflightIO {
  platform: string; arch: string; uid: number; gid: number
  lstat(file: string): P2Stat | null
  realpath(file: string): string
  readFile(file: string): Uint8Array
  readDir(file: string): string[]
  sha256(file: string): string
  account(name: string): P2Account | null
  dbCounts(file: string): Record<string, number>
}
export interface P2SmokePlan {
  marker: P2SmokeMarker; config: AppConfig; base: string; configFile: string; bundleDir: string
  launcherSock: string; toolsSock: string; credentialFile: string; receiptFile: string; dbFile: string
}
const B = P2_SMOKE_BASE
const SHA = /^[a-f0-9]{64}$/
const posInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const identity = z.object({ name: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/), uid: z.number().int().min(100).max(999), gid: z.number().int().positive() }).strict()
const markerSchema = z.object({
  schema: z.literal(1), purpose: z.literal('p2-linux-claude-smoke'), id: z.literal(P2_SMOKE_ID), base: z.literal(B),
  runId: z.string().uuid(), expiresAt: z.string().datetime(), configSha256: z.string().regex(SHA), bundleManifestSha256: z.string().regex(SHA),
  server: identity, agent: identity, model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/), credentialFile: z.literal(`${B}/secrets/p2-claude.json`),
  limits: z.object({ providerRequests: posInt, engineAttempts: posInt, toolTurns: posInt, turnTimeoutMs: posInt, totalTimeoutMs: posInt }).strict(),
  agentHome: z.object({ uid: z.literal(0), gid: z.literal(0), mode: z.literal(0o555), auditedAt: z.string().datetime() }).strict(),
  legacyAgentAuthAbsent: z.literal(true),
}).strict()
const TABLES = { users: 'users', chats: 'chats', turns: 'turns', schedules: 'schedules', credentials: 'engine_credentials', engine_accounts: 'engine_accounts' } as const
const fail = (reason: string): never => { throw new Error(`P2 preflight: ${reason}`) }
const need = (ok: unknown, reason: string): void => { if (!ok) fail(reason) }
const hash = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex')
const kindOf = (s: fs.Stats): P2Stat['kind'] => s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSocket() ? 'socket' : 'other'

/** These adapters only read local files; SQLite is deserialized in memory, never opened on disk. */
export function p2PreflightIO(): PreflightIO {
  const io: PreflightIO = {
    platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1,
    lstat(file) {
      try { const s = fs.lstatSync(file); return { kind: kindOf(s), uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, nlink: s.nlink, size: s.size } }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; return fail('metadata unavailable') }
    },
    realpath(file) { try { return fs.realpathSync(file) } catch { return fail('path unavailable') } },
    readFile(file) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try { need(fs.fstatSync(fd).isFile(), 'regular file required'); return fs.readFileSync(fd) } finally { fs.closeSync(fd) }
    },
    readDir(file) { return fs.readdirSync(file) },
    sha256(file) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), h = crypto.createHash('sha256')
      try {
        need(fs.fstatSync(fd).isFile(), 'regular file required')
        const buf = Buffer.alloc(1024 * 1024); let n: number
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
        return h.digest('hex')
      } finally { fs.closeSync(fd) }
    },
    account(name) {
      const rows = Buffer.from(io.readFile('/etc/passwd')).toString('utf8').split('\n').map(l => l.split(':'))
      const p = rows.find(r => r[0] === name); if (!p || p.length < 7) return null
      const groups = Buffer.from(io.readFile('/etc/group')).toString('utf8').split('\n').map(l => l.split(':'))
      const group = groups.find(g => Number(g[2]) === Number(p[3]))
      return { name, uid: Number(p[2]), gid: Number(p[3]), home: p[5], shell: p[6], groupName: group?.[0] ?? '', extraGroups: groups.filter(g => g[0] !== group?.[0] && (g[3] ?? '').split(',').includes(name)).map(g => g[0]) }
    },
    dbCounts(file) {
      for (const suffix of ['-wal', '-journal']) need(!io.lstat(file + suffix)?.size, 'fresh database pending journal')
      const bytes = Buffer.from(io.readFile(file))
      need(bytes.length >= 100 && bytes.subarray(0, 16).toString() === 'SQLite format 3\0', 'fresh database format')
      // A stopped/checkpointed WAL database still has header bytes 18/19=2. In-memory deserialize cannot
      // open its WAL: mark ONLY this detached snapshot as rollback format. No on-disk header is changed.
      bytes[18] = 1; bytes[19] = 1
      const db = Database.deserialize(bytes, true)
      try { return Object.fromEntries(Object.entries(TABLES).map(([key, table]) => [key, (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n])) }
      finally { db.close() }
    },
  }
  return io
}

function meta(io: PreflightIO, p: string, kind: P2Stat['kind'], uid: number, gid: number, modes: number[], reason: string): P2Stat {
  const s = io.lstat(p)
  need(s && s.kind === kind && s.uid === uid && s.gid === gid && modes.includes(s.mode) && (kind !== 'file' || s.nlink === 1), reason)
  need(io.realpath(p) === p, reason)
  return s!
}
function rootParents(io: PreflightIO) {
  for (const p of ['/', '/var', '/var/lib', B, `${B}/root`]) {
    const s = io.lstat(p)
    need(s?.kind === 'directory' && s.uid === 0 && (s.mode & 0o022) === 0 && io.realpath(p) === p, 'untrusted root path')
  }
}
function json(io: PreflightIO, file: string, reason: string): unknown {
  need((io.lstat(file)?.size ?? Infinity) <= 16 * 1024 * 1024, reason)
  try { return JSON.parse(Buffer.from(io.readFile(file)).toString('utf8')) } catch { return fail(reason) }
}
function noLegacyFiles(io: PreflightIO) {
  for (const p of [`${B}/secrets/claude-oauth-token`, `${B}/data/secrets`]) need(!io.lstat(p), 'legacy credential source')
  need(!io.readDir(`${B}/secrets`).some(n => /^credentials\.key(?:\.|$)/.test(n) || n === 'credential-sealing.jwk'), 'legacy credential vault')
  need(io.readDir(`${B}/secrets`).every(n => ['p2-claude.json', 'lan-tls.crt', 'lan-tls.key'].includes(n)), 'legacy credential source')
}
function directory(io: PreflightIO, p: string, uid: number, gid: number, mode: number, reason: string) { meta(io, p, 'directory', uid, gid, [mode], reason) }

/** Root preparation only: this is a dated attestation, not a worker's live inspection of agent/home. */
export function collectP2RootAttestation(io = p2PreflightIO(), now = Date.now()): P2RootAttestation {
  need(io.platform === 'linux', 'linux required'); need(io.uid === 0 && io.gid === 0, 'root identity required')
  rootParents(io)
  const agent = io.lstat(`${B}/agent`)
  need(agent?.kind === 'directory' && agent.uid >= 100 && agent.uid <= 999 && agent.mode === 0o700 && io.realpath(`${B}/agent`) === `${B}/agent`, 'agent directory')
  directory(io, `${B}/agent/home`, 0, 0, 0o555, 'agent home')
  if (io.lstat(`${B}/agent/codex-auth`)) directory(io, `${B}/agent/codex-auth`, agent!.uid, agent!.gid, 0o700, 'legacy credential directory')
  for (const p of [`${B}/agent/codex-auth/auth.json`, `${B}/agent/home/.claude`, `${B}/agent/home/.claude.json`, `${B}/agent/home/.codex`]) need(!io.lstat(p), 'legacy credential source')
  return { agentHome: { uid: 0, gid: 0, mode: 0o555, auditedAt: new Date(now).toISOString() }, legacyAgentAuthAbsent: true }
}

export function preflightP2Smoke(options: { io?: PreflightIO; now?: number } = {}): P2SmokePlan {
  const io = options.io ?? p2PreflightIO(), now = options.now ?? Date.now()
  need(io.platform === 'linux', 'linux required'); need(['arm64', 'x64'].includes(io.arch), 'linux architecture')
  rootParents(io)
  // Parse only after root ownership, non-link and exact private mode have been established.
  const ms = io.lstat(P2_SMOKE_MARKER)
  need(ms?.kind === 'file' && ms.uid === 0 && ms.mode === 0o640 && ms.nlink === 1 && io.realpath(P2_SMOKE_MARKER) === P2_SMOKE_MARKER, 'marker metadata')
  const parsed = markerSchema.safeParse(json(io, P2_SMOKE_MARKER, 'marker schema'))
  if (!parsed.success) fail(parsed.error.issues.some(i => i.path[0] === 'limits') ? 'limits required' : 'marker schema')
  const marker = parsed.data as P2SmokeMarker, { server: sr, agent: ag, limits } = marker
  need(ms!.gid === sr.gid, 'marker metadata')
  need(io.uid === sr.uid && io.gid === sr.gid && sr.uid !== ag.uid && sr.gid !== ag.gid && sr.name !== ag.name, 'worker identity')
  const expires = Date.parse(marker.expiresAt), audited = Date.parse(marker.agentHome.auditedAt)
  need(expires > now && expires - now >= limits.totalTimeoutMs && audited <= now && now - audited <= 7200000, 'expiry or stale root attestation')
  need(limits.turnTimeoutMs <= limits.totalTimeoutMs && limits.totalTimeoutMs <= 7200000, 'limits invalid')
  for (const [a, home] of [[sr, `${B}/data`], [ag, `${B}/agent/home`]] as const) {
    const actual = io.account(a.name)
    need(actual && actual.uid === a.uid && actual.gid === a.gid && actual.groupName === a.name && actual.home === home && ['/usr/sbin/nologin', '/sbin/nologin', '/usr/bin/false', '/bin/false'].includes(actual.shell) && actual.extraGroups.length === 0, 'account identity')
  }
  for (const p of ['config', 'data', 'team', 'secrets']) directory(io, `${B}/${p}`, sr.uid, sr.gid, 0o700, 'private layout')
  directory(io, `${B}/status`, sr.uid, 0, 0o750, 'receipt parent')
  need(!io.lstat(P2_SMOKE_RECEIPT), 'single-run receipt already exists')
  directory(io, `${B}/agent`, ag.uid, ag.gid, 0o700, 'agent directory')
  directory(io, `${B}/run`, 0, 0, 0o755, 'run parent')
  directory(io, `${B}/run-launcher`, ag.uid, sr.gid, 0o2750, 'launcher parent')
  directory(io, `${B}/run/tools`, sr.uid, ag.gid, 0o2750, 'tools parent')
  const launcherSock = `${B}/run-launcher/launcher.sock`, toolsSock = `${B}/run/tools/tools.sock`, configFile = `${B}/config/server.json`
  meta(io, launcherSock, 'socket', ag.uid, sr.gid, [0o660], 'launcher socket')
  meta(io, configFile, 'file', sr.uid, sr.gid, [0o600], 'config metadata')
  need(io.sha256(configFile) === marker.configSha256, 'config hash')
  const cf = AppConfigFile.safeParse(json(io, configFile, 'config schema')); need(cf.success, 'config schema')
  const f = cf.data!
  need(f.mode === 'prod' && !f.office && normalizeAuthMode(f.engine.authMode) === 'managed', 'managed prod required')
  need(f.relay.url === null && f.relay.teamName === null && !f.relay.officialAvailable && f.tunnel === null, 'relay disabled required')
  need(f.update.auto === false, 'update disabled required')
  need(f.tls === null && f.listen.host === '127.0.0.1' && f.logDir === null, 'loopback layout required')
  need(f.teamRoot === `${B}/team` && f.dataDir === `${B}/data` && f.engine.runDir === `${B}/run/tools` && f.engine.agentRoot === `${B}/agent` && f.engine.launcherSock === launcherSock && f.engine.agentUid === ag.uid, 'fixed layout required')
  need(f.engine.claudeBin === `${B}/app/engines/claude/current/claude` && (!f.engine.codexBin || f.engine.codexBin === '') && f.engine.proxyPort !== undefined, 'Claude-only layout required')
  need(!f.engine.modelUpstream && !f.engine.modelUpstreams, 'unexpected upstream override')
  const current = io.lstat(`${B}/app/current`)
  need(current?.kind === 'symlink' && current.uid === sr.uid && current.gid === sr.gid && current.nlink === 1, 'bundle link')
  const bundleDir = io.realpath(`${B}/app/current`)
  need(new RegExp(`^${B}/app/versions/[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$`).test(bundleDir), 'bundle path')
  for (const p of [`${B}/app`, `${B}/app/versions`, bundleDir]) directory(io, p, sr.uid, sr.gid, 0o755, 'bundle directory')
  const manifestFile = `${bundleDir}/manifest.json`
  meta(io, manifestFile, 'file', sr.uid, sr.gid, [0o644], 'bundle manifest')
  need(io.sha256(manifestFile) === marker.bundleManifestSha256, 'bundle manifest hash')
  const manifest = json(io, manifestFile, 'bundle manifest') as { format?: number; version?: string; files?: Record<string, { sha256: string; size: number; mode: number }> }
  need(manifest?.format === 1 && manifest.version === path.basename(bundleDir) && manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'bundle manifest')
  const required = ['bin/bun', 'native/mycel-gate', 'native/mycel-bridge', 'server/src/main.js', 'root/mycel-launcher', 'root/mycel-sandbox', 'root/mycel-bootstrap', 'engines.lock.json']
  for (const rel of required) need(manifest.files![rel], 'bundle file missing')
  for (const [rel, entry] of Object.entries(manifest.files!)) {
    need(rel.length > 0 && !path.isAbsolute(rel) && !rel.split('/').some(p => !p || p === '.' || p === '..') && !rel.includes('\\'), 'bundle file path')
    need(entry && SHA.test(entry.sha256) && Number.isSafeInteger(entry.size) && entry.size >= 0 && Number.isInteger(entry.mode) && (entry.mode & ~0o755) === 0, 'bundle file manifest')
    const p = `${bundleDir}/${rel}`, s = io.lstat(p)
    need(s?.kind === 'file' && s.nlink === 1 && s.uid === sr.uid && s.gid === sr.gid && s.size === entry.size && s.mode === entry.mode && io.realpath(p) === p, 'bundle file metadata')
    for (let d = path.dirname(p); d !== bundleDir; d = path.dirname(d)) directory(io, d, sr.uid, sr.gid, 0o755, 'bundle directory')
    need(io.sha256(p) === entry.sha256, 'bundle file hash')
  }
  for (const name of ['mycel-launcher', 'mycel-sandbox', 'mycel-bootstrap']) {
    const p = `${B}/root/${name}`
    meta(io, p, 'file', 0, 0, [0o755], 'root program metadata')
    need(io.sha256(p) === manifest.files![`root/${name}`].sha256, 'root program hash')
  }
  meta(io, `${B}/root/VERSION`, 'file', 0, 0, [0o644], 'root version')
  need(Buffer.from(io.readFile(`${B}/root/VERSION`)).toString('utf8').trim() === manifest.version, 'root version mismatch')
  const lock = json(io, `${bundleDir}/engines.lock.json`, 'engine lock') as any
  const pin = lock?.claude?.[io.arch === 'arm64' ? 'linux-arm64' : 'linux-amd64']
  need(lock?.format === 1 && /^\d+\.\d+\.\d+$/.test(lock?.claude?.version) && pin && SHA.test(pin.sha256) && Number.isSafeInteger(pin.size) && pin.size > 0, 'engine lock hash')
  const engineLink = io.lstat(`${B}/app/engines/claude/current`)
  need(engineLink?.kind === 'symlink' && engineLink.uid === sr.uid && engineLink.gid === ag.gid && engineLink.nlink === 1, 'engine link')
  const binary = io.realpath(f.engine.claudeBin!)
  need(new RegExp(`^${B}/app/engines/claude/[a-f0-9]{12}/claude$`).test(binary), 'engine binary path')
  for (const p of [`${B}/app/engines`, `${B}/app/engines/claude`, path.dirname(binary)]) directory(io, p, sr.uid, ag.gid, 0o750, 'engine directory')
  const bs = meta(io, binary, 'file', sr.uid, ag.gid, [0o750], 'engine binary')
  need(bs.size === pin.size && io.sha256(binary) === pin.sha256, 'engine binary hash')
  meta(io, marker.credentialFile, 'file', sr.uid, sr.gid, [0o400, 0o600], 'credential metadata')
  noLegacyFiles(io)
  need(io.readDir(`${B}/team`).length === 0, 'fresh team required')
  need(io.readDir(`${B}/data`).every(n => ['app.db', 'app.db-wal', 'app.db-shm', 'app.db-journal', 'setup-token', 'textcache', 'sessions', 'uploads'].includes(n)), 'fresh data required')
  for (const name of ['textcache', 'sessions', 'uploads']) if (io.lstat(`${B}/data/${name}`)) {
    directory(io, `${B}/data/${name}`, sr.uid, sr.gid, 0o700, 'fresh data directory')
    need(io.readDir(`${B}/data/${name}`).length === 0, 'fresh data required')
  }
  const dbFile = `${B}/data/app.db`, dbStat = io.lstat(dbFile)
  if (dbStat) {
    meta(io, dbFile, 'file', sr.uid, sr.gid, [0o600, 0o640], 'fresh database metadata')
    need(dbStat.size <= 256 * 1024 * 1024, 'fresh database size')
    for (const suffix of ['-wal', '-journal', '-shm']) if (io.lstat(dbFile + suffix)) {
      const s = meta(io, dbFile + suffix, 'file', sr.uid, sr.gid, [0o600, 0o640], 'fresh database journal metadata')
      if (suffix !== '-shm') need(s.size === 0, 'fresh database pending journal')
    }
    let counts: Record<string, number>
    try { counts = io.dbCounts(dbFile) } catch { return fail('fresh database schema') }
    need(Object.keys(TABLES).every(k => counts[k] === 0), 'fresh database required')
  } else {
    for (const suffix of ['-wal', '-journal', '-shm']) need(!io.lstat(dbFile + suffix), 'fresh database orphan journal')
  }
  const config: AppConfig = {
    ...f, mode: 'prod', configFile, teamRoot: `${B}/team`, dataDir: `${B}/data`, logDir: null,
    logLevel: f.logLevel ?? 'info', validateResponses: f.validateResponses ?? false, setupToken: null,
    engine: { ...f.engine, authMode: 'managed', ...(f.engine.authMode !== 'managed' ? { authModeAlias: f.engine.authMode } : {}), codexBin: '' },
  }
  const plan: P2SmokePlan = { marker, config, base: B, configFile, bundleDir, launcherSock, toolsSock, credentialFile: marker.credentialFile, receiptFile: P2_SMOKE_RECEIPT, dbFile }
  if (io.lstat(toolsSock)) assertP2ToolsSocket(plan, io)
  return plan
}

export function assertP2ToolsSocket(plan: P2SmokePlan, io = p2PreflightIO()): void {
  const { server: sr, agent: ag } = plan.marker
  need(io.platform === 'linux' && io.uid === sr.uid && io.gid === sr.gid && plan.toolsSock === `${B}/run/tools/tools.sock`, 'worker identity')
  directory(io, `${B}/run/tools`, sr.uid, ag.gid, 0o2750, 'tools parent')
  meta(io, plan.toolsSock, 'socket', sr.uid, ag.gid, [0o660], 'tools socket')
}
