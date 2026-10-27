// Test helpers for component F (relay): start a relay in-process (Bun) or as a Node 25 child process, register a
// team through the registry API, and connect a RelayClient with a fake app.
import fs from 'node:fs'
import path from 'node:path'
import type { Subprocess } from 'bun'
import {
  generateTeamKey, loadPrivateKey, powSolve, registerSigningString, signB64, type PowInfo, type RegisterResponse, type TeamKeyPair,
} from '@mycel/shared/relay-protocol'
import { loadRelayConfig, type RelayConfig } from '../../relay/src/config.ts'
import { openSqlite } from '../../relay/src/db.ts'
import { createRelayLog } from '../../relay/src/log.ts'
import { Registry } from '../../relay/src/registry.ts'
import { RelayServer } from '../../relay/src/relay.ts'
import { RelayClient, type RelayClientOptions } from '../../server/src/relay-client/client.ts'
import { WORK } from './env'

export const REPO = path.resolve(import.meta.dir, '..', '..')
export const F_WORK = path.join(WORK, 'f-relay')

export const quietLog = { debug() {}, info() {}, warn() {}, error() {} }
export function captureLog() {
  const lines: { level: string; msg: string; f?: Record<string, unknown> }[] = []
  const mk = (level: string) => (msg: string, f?: Record<string, unknown>) => { lines.push({ level, msg, f }) }
  return { lines, log: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') } }
}

export interface InProcessRelay { relay: RelayServer; port: number; base: string; ws: string; logLines: string[]; cfg: RelayConfig; stop(): Promise<void> }

/** Relay inside the test process (Bun). Timing knobs via env-style overrides. */
export async function startRelay(port: number, env: Record<string, string> = {}): Promise<InProcessRelay> {
  const cfg = loadRelayConfig(['--dev', '--port', String(port), '--data', path.join(F_WORK, `relay-${port}`), '--pow-bits', '4'], { RELAY_HOLD_MS: '300', ...env })
  const registry = new Registry(await openSqlite(':memory:'), { extraReserved: cfg.reserved })
  const logLines: string[] = []
  const relay = new RelayServer(cfg, registry, createRelayLog((l) => logLines.push(l)))
  await relay.listen()
  return { relay, port, cfg, logLines, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/connect`, stop: () => relay.stop(200) }
}

/** Register a team through the HTTP API (as the team server would). */
export async function registerTeam(apiBase: string, name: string, kp: TeamKeyPair = generateTeamKey()): Promise<RegisterResponse & { kp: TeamKeyPair }> {
  const pow = (await (await fetch(`${apiBase}/teams/pow`)).json()) as PowInfo
  const ts = Date.now()
  const base = { name, publicKey: kp.publicKey, ts }
  const nonce = powSolve(base, pow.bits)
  const res = await fetch(`${apiBase}/teams`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, nonce, sig: signB64(loadPrivateKey(kp.privatePem), registerSigningString(name, kp.publicKey, ts)) }),
  })
  if (res.status !== 201) throw new Error(`register ${name}: ${res.status} ${await res.text()}`)
  return { ...((await res.json()) as RegisterResponse), kp }
}

export function client(o: Partial<RelayClientOptions> & Pick<RelayClientOptions, 'url' | 'teamId' | 'fetch'> & { kp: TeamKeyPair }): RelayClient {
  const c = new RelayClient({ log: quietLog, ...o, key: loadPrivateKey(o.kp.privatePem) })
  c.start()
  return c
}

export async function until<T>(fn: () => T | Promise<T>, timeoutMs = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

/** URL of a team through a relay on localhost (Host routing: <team>.localhost) */
export function teamUrl(port: number, name: string, p = '/'): string {
  return `http://${name}.localhost:${port}${p}`
}

// ------------------------------------------------------------------ processes (conformance tests)

export interface Proc { p: Subprocess; log: string; kill(sig?: NodeJS.Signals | number): void }

export function spawnNodeRelay(port: number, dataDir: string, env: Record<string, string> = {}, logName = `relay-${port}`): Proc {
  fs.mkdirSync(F_WORK, { recursive: true })
  const log = path.join(F_WORK, `${logName}.log`)
  const fd = fs.openSync(log, 'a')
  const p = Bun.spawn(['node', '--disable-warning=ExperimentalWarning', path.join(REPO, 'relay/src/main.ts'), '--dev', '--port', String(port), '--data', dataDir, '--pow-bits', '4'], {
    cwd: REPO, env: { ...process.env, ...env }, stdout: fd, stderr: fd,
  })
  return { p, log, kill: (sig = 'SIGKILL') => { try { p.kill(sig) } catch {} } }
}

export function spawnFakeTeam(env: Record<string, string>, logName: string): Proc {
  const log = path.join(F_WORK, `${logName}.log`)
  const fd = fs.openSync(log, 'a')
  const p = Bun.spawn(['bun', path.join(REPO, 'tests/relay/fake-team.ts')], { cwd: REPO, env: { ...process.env, ...env }, stdout: fd, stderr: fd })
  return { p, log, kill: (sig = 'SIGKILL') => { try { p.kill(sig) } catch {} } }
}

export async function waitHttp(url: string, timeoutMs = 10_000, want = 200): Promise<number> {
  const t0 = Date.now()
  await until(async () => { try { return (await fetch(url)).status === want } catch { return false } }, timeoutMs, url)
  return Date.now() - t0
}

export function rssMb(pid: number): number {
  const out = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)]).stdout.toString().trim()
  return Number(out) / 1024
}

// ------------------------------------------------------------------ a misbehaving team server (review tests)

/** A team server that speaks the handshake and then does whatever `onOpen` says with each stream (Bun WebSocket). */
export async function rawTeam(url: string, teamId: string, kp: TeamKeyPair, onOpen: (s: import('@mycel/shared/relay-protocol').Stream) => void): Promise<{ ws: WebSocket; mux: import('@mycel/shared/relay-protocol').Mux; closed: Promise<number> }> {
  const { Mux, authSigningString } = await import('@mycel/shared/relay-protocol')
  const key = loadPrivateKey(kp.privatePem)
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  let mux: InstanceType<typeof Mux> | null = null
  const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code) })
  await new Promise<void>((resolve, reject) => {
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data)
        if (m.t === 'challenge') {
          const ts = Date.now()
          ws.send(JSON.stringify({ t: 'auth', v: 2, team: teamId, instance: 'rawteam1', conn: 0, ts, sig: signB64(key, authSigningString(teamId, 'rawteam1', m.nonce, ts)) }))
        } else if (m.t === 'ok') {
          mux = new Mux({ send: (b) => ws.send(b), buffered: () => 0 }, { role: 'team', initialWindow: m.initialWindow, highWater: 1 << 20, maxStreams: 100, onOpen })
          resolve()
        } else reject(new Error(JSON.stringify(m)))
        return
      }
      mux?.onMessage(new Uint8Array(e.data as ArrayBuffer))
    }
  })
  return { ws, mux: mux!, closed }
}

// ------------------------------------------------------------------ operator API (control-plane RL-2)

export interface OpsKeySet { file: string; keys: Record<string, TeamKeyPair> }

/** operator-keys.json with the given keys (a fresh Ed25519 pair each) */
export function writeOpsKeys(file: string, defs: { keyId: string; scopes: string[] }[]): OpsKeySet {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const keys: Record<string, TeamKeyPair> = {}
  const json = defs.map((d) => { const kp = generateTeamKey(); keys[d.keyId] = kp; return { keyId: d.keyId, publicKey: kp.publicKey, label: d.keyId, scopes: d.scopes } })
  fs.writeFileSync(file, JSON.stringify(json, null, 1))
  return { file, keys }
}

let lastOpsTs = 0
/** A signed operator API call (as the control plane makes it). `o.raw` sends a prepared Authorization header. */
export async function opsCall(base: string, keyId: string, kp: TeamKeyPair, method: string, pathq: string, body?: unknown, o: { ts?: number; auth?: string | null; sign?: string } = {}): Promise<{ status: number; json: unknown; text: string; auth: string }> {
  const { opsAuthorizationHeader, opsSigningString } = await import('@mycel/shared/cloud-protocol/relay-ops')
  const text = body === undefined ? '' : JSON.stringify(body)
  // a strictly increasing timestamp, as a real client must keep: the same request signed in the same millisecond is
  // byte-for-byte the same signature (Ed25519 is deterministic), which the relay refuses as a replay
  const ts = o.ts ?? (lastOpsTs = Math.max(Date.now(), lastOpsTs + 1))
  const sig = signB64(loadPrivateKey(kp.privatePem), opsSigningString(method, pathq, ts, o.sign ?? text))
  const auth = o.auth === undefined ? opsAuthorizationHeader(keyId, ts, sig) : o.auth
  const res = await fetch(base + pathq, { method, headers: { ...(auth ? { authorization: auth } : {}), ...(text ? { 'content-type': 'application/json' } : {}) }, body: text || undefined })
  const t = await res.text()
  let json: unknown = null
  try { json = t ? JSON.parse(t) : null } catch {}
  return { status: res.status, json, text: t, auth: auth ?? '' }
}

/** fields the operator API needs to create a team with this key (the tenant signs at enroll time) */
export function opsCreateBody(name: string, kp: TeamKeyPair, externalRef: string, ts = Date.now()) {
  return { name, publicKey: kp.publicKey, ts, sig: signB64(loadPrivateKey(kp.privatePem), registerSigningString(name, kp.publicKey, ts)), region: 'kr-seoul-1', origin: 'cloud', externalRef }
}

// ------------------------------------------------------------------ TLS test certificates (RL-5)

export interface TestPki { dir: string; caCrt: string; srvCrt: string; srvKey: string; aopCaCrt: string; cliCrt: string; cliKey: string; otherCrt: string; otherKey: string }

/**
 * A throwaway PKI with the openssl CLI: a server CA + server certificate for localhost / 127.0.0.1 (the Origin CA
 * certificate's part), a client CA + client certificate (Cloudflare's Authenticated Origin Pulls certificate, which
 * we make and upload), and a client certificate from another CA (someone else's Cloudflare account / anyone).
 */
export function makeTestPki(dir: string): TestPki {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const f = (n: string) => path.join(dir, n)
  const run = (args: string[]) => {
    const p = Bun.spawnSync(['openssl', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${p.stderr.toString()}`)
  }
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-sha256']
  // an explicit config: LibreSSL (macOS) otherwise makes a version-1 CA without basicConstraints, which OpenSSL 3 refuses
  fs.writeFileSync(f('ca.cnf'), '[req]\ndistinguished_name = dn\nx509_extensions = v3_ca\n[dn]\n[v3_ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n')
  const ca = (name: string) => run(['req', '-x509', '-config', f('ca.cnf'), ...ec, '-keyout', f(`${name}.key`), '-out', f(`${name}.crt`), '-days', '2', '-subj', `/CN=${name}`])
  const leaf = (name: string, caName: string, ext: string) => {
    fs.writeFileSync(f(`${name}.ext`), ext)
    run(['req', ...ec, '-keyout', f(`${name}.key`), '-out', f(`${name}.csr`), '-subj', `/CN=${name}`])
    run(['x509', '-req', '-sha256', '-in', f(`${name}.csr`), '-CA', f(`${caName}.crt`), '-CAkey', f(`${caName}.key`), '-CAcreateserial', '-CAserial', f(`${caName}.srl`), '-out', f(`${name}.crt`), '-days', '2', '-extfile', f(`${name}.ext`)])
  }
  ca('origin-ca')
  ca('aop-ca')
  ca('other-ca')
  leaf('srv', 'origin-ca', 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
  leaf('cli', 'aop-ca', 'extendedKeyUsage=clientAuth\n')
  leaf('other', 'other-ca', 'extendedKeyUsage=clientAuth\n')
  return { dir, caCrt: f('origin-ca.crt'), srvCrt: f('srv.crt'), srvKey: f('srv.key'), aopCaCrt: f('aop-ca.crt'), cliCrt: f('cli.crt'), cliKey: f('cli.key'), otherCrt: f('other.crt'), otherKey: f('other.key') }
}

// ------------------------------------------------------------------ old registry files (RL-1)

/** the registry file as the first relay version (before user_version steps) wrote it */
const OLD_SCHEMA = `
CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, recovery_code_hash TEXT NOT NULL, region TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','released')), created_at TEXT NOT NULL,
  last_heartbeat_at TEXT, last_connected_at TEXT, last_version TEXT, member_count INTEGER);
CREATE UNIQUE INDEX teams_live_name ON teams(name) WHERE status != 'released';
CREATE TABLE team_keys (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, public_key TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
CREATE UNIQUE INDEX team_keys_one_live ON team_keys(team_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX team_keys_public ON team_keys(public_key);
CREATE TABLE reservations (name TEXT PRIMARY KEY, team_id TEXT, reason TEXT NOT NULL CHECK (reason IN ('released','reclaimed','blocked','reserved')), hold_until TEXT);
`

export function writeOldRegistry(file: string, kp: TeamKeyPair): void {
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  fs.rmSync(file, { force: true })
  const d = new Database(file, { create: true })
  d.exec('PRAGMA journal_mode = WAL')
  d.exec(OLD_SCHEMA)
  d.query("INSERT INTO teams (id, name, recovery_code_hash, region, status, created_at, last_version, member_count) VALUES ('team-old-1', 'oldteam', 'x', 'default', 'suspended', '2026-01-01T00:00:00.000Z', '0.2.1', 4)").run()
  d.query("INSERT INTO team_keys (id, team_id, public_key, created_at) VALUES ('k1', 'team-old-1', ?, '2026-01-01T00:00:00.000Z')").run(kp.publicKey)
  d.query("INSERT INTO reservations (name, team_id, reason, hold_until) VALUES ('gone', 'team-old-1', 'released', '2027-01-01T00:00:00.000Z')").run()
  d.close()
}

