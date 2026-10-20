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

export async function until<T>(fn: () => T | Promise<T>, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
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
