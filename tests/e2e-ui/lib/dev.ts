// The product under test: `bun run dev` (team server on 19100 in DEV mode with the real engines and your own
// Claude Code / Codex logins, the Node 25 relay on 19161 with the team "demo"), started with a fresh data folder
// under tests/.work/e2e-ui/devhome. State the steps share (setup token, accounts, ids) lives in state.json next to
// it, so a single step can be rerun against a running product (E2E_REUSE=1, see playwright.config.ts).
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
export const WORK = path.join(REPO, 'tests', '.work', 'e2e-ui')
export const DEV_HOME = path.join(WORK, 'devhome')
export const DEV_LOG = path.join(WORK, 'dev.log')
export const STATE_FILE = path.join(WORK, 'state.json')
export const CALLS_FILE = path.join(WORK, 'engine-calls.json')

export const DIRECT = 'http://localhost:19100'
export const RELAYED = 'http://demo.localhost:19161'
export const SERVER_PORT = 19100
export const RELAY_PORT = 19161

export interface Account { username: string; password: string; name: string; id?: string }
export interface State {
  devPid?: number
  setupToken?: string
  owner: Account
  alice: Account
  bob: Account
  [k: string]: unknown
}

const DEFAULT_STATE: State = {
  owner: { username: 'olga', password: 'owner password 1', name: 'Olga' },
  alice: { username: 'alice', password: 'spring garden 2026', name: 'Alice' },
  bob: { username: 'bob', password: 'harbor lights 77', name: 'Bob' },
}

export function readState(): State {
  try { return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } } catch { return structuredClone(DEFAULT_STATE) }
}
export function writeState(patch: Partial<State>): State {
  const s = { ...readState(), ...patch }
  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
  return s
}

export async function healthy(base = DIRECT): Promise<boolean> {
  try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
}

/** pids listening on a TCP port (lsof). */
export function listeners(port: number): number[] {
  try {
    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch { return [] }
}

/** Resident memory of a process in MB (ps). */
export function rssMb(pid: number): number {
  try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024 } catch { return NaN }
}

export async function until<T>(fn: () => T | Promise<T>, ms: number, what: string, every = 250): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as NonNullable<T> } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, every))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ''}`)
}

/** Start `bun run dev` with a fresh data folder; resolves once the server and the relay route answer. */
export async function startDev(): Promise<State> {
  for (const port of [SERVER_PORT, RELAY_PORT]) {
    if (listeners(port).length) throw new Error(`port ${port} is in use: stop the other dev run first (or E2E_REUSE=1)`)
  }
  fs.rmSync(DEV_HOME, { recursive: true, force: true })
  fs.mkdirSync(DEV_HOME, { recursive: true })
  fs.rmSync(STATE_FILE, { force: true })
  const log = fs.openSync(DEV_LOG, 'w')
  const child = spawn('bun', ['run', 'scripts/dev.ts'], {
    cwd: REPO,
    detached: true, // own process group: teardown stops server + relay together
    stdio: ['ignore', log, log],
    env: { ...process.env, TEAM_AX_DEV_DIR: DEV_HOME, NO_COLOR: '1' },
  })
  child.unref()
  const token = await until(() => /setupToken ([A-Za-z0-9_-]+)/.exec(fs.readFileSync(DEV_LOG, 'utf8'))?.[1], 180_000, 'the setup token in dev.log')
  await until(() => healthy(DIRECT), 30_000, 'the team server')
  await until(() => healthy(RELAYED), 30_000, 'the relay route to the team')
  return writeState({ devPid: child.pid, setupToken: token })
}

export function stopDev(pid: number | undefined) {
  if (!pid) return
  try { process.kill(-pid, 'SIGTERM') } catch {}
}

/** Kill the relay process (dev.ts restarts it after 1.5 s). Returns the old pid. */
export function killRelay(): number {
  const pids = listeners(RELAY_PORT)
  if (!pids.length) throw new Error('no relay listening')
  for (const p of pids) process.kill(p, 'SIGKILL')
  return pids[0]!
}

export const serverPid = () => listeners(SERVER_PORT)[0]
export const relayPid = () => listeners(RELAY_PORT)[0]

/**
 * Real engine calls are metered: every prompt the scenario sends counts against E2E_MAX_CLAUDE / E2E_MAX_CODEX
 * (defaults 20 / 3), kept across runs in engine-calls.json (delete it to reset).
 */
export function countEngineCall(engine: 'claude' | 'codex') {
  let c = { claude: 0, codex: 0 }
  try { c = JSON.parse(fs.readFileSync(CALLS_FILE, 'utf8')) } catch {}
  const max = engine === 'claude' ? Number(process.env.E2E_MAX_CLAUDE ?? 20) : Number(process.env.E2E_MAX_CODEX ?? 3)
  if (c[engine] >= max) throw new Error(`engine budget used up: ${c[engine]} ${engine} calls (raise E2E_MAX_${engine.toUpperCase()} or delete ${CALLS_FILE})`)
  c[engine]++
  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(CALLS_FILE, JSON.stringify(c))
}
