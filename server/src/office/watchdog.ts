// The office supervisor's watchdog (office.js run, cli.ts): the same rule as a Linux or Mac install's bootstrap
// (native/cmd/mycel-bootstrap/watchdog.go, docs/decisions/20261127-restart.md).
// - Counts only after this start of the server answered /api/health once (a restore at start, migrations before it
//   listens are never a hang); a 503 "migrating" answer is an answer.
// - Every 30 s one health request (3 s timeout, as the bootstrap's); 10 failures in a row (about 5 minutes) is a hang.
// - Kill switch: TEAMAX_WATCHDOG_KILL=1 in config/office.env (office rewrites server.json at every start, so the
//   switch lives with the other office settings), read at every hang. Off by default: the hang is logged only.
// - At most 3 kills an hour, then data/liveness.json {gaveUp, since, detail} (Admin › System › Health reads it) until
//   the next healthy answer, which removes it.
// Pure: the supervisor gives it each answer and does what it says.
import fs from 'node:fs'
import path from 'node:path'
import { isMigrating, type HealthAnswer } from './health'

export const WATCH_EVERY_MS = 30_000
export const WATCH_TIMEOUT_MS = 3000
export const WATCH_FAILURES = 10
export const WATCH_MAX_KILLS = 3
export const WATCH_KILL_WINDOW_MS = 3600_000
/** the give-up file in the office data folder (system/restart.ts reads it in office mode) */
export const LIVENESS_FILE = 'liveness.json'

export interface WatchOptions { failures?: number; maxKills?: number; windowMs?: number; everyMs?: number }

/** what the supervisor does with one answer: nothing, log a hang it may not kill, stop and start the server, give up,
 * or say the server answers again after a give-up */
export type WatchAction = null | { kind: 'log' | 'kill' | 'gave-up'; line: string } | { kind: 'recovered'; line: string }

export class OfficeWatchdog {
  private armed = false
  private fails = 0
  private logged = false
  private kills: number[] = []
  constructor(private dataDir: string, private o: WatchOptions = {}) {}

  get gaveUp(): boolean { return readLiveness(this.dataDir) !== null }

  /** a new start of the server: watched once it answers */
  started() { this.armed = false; this.fails = 0; this.logged = false }

  /** one health answer; kill: TEAMAX_WATCHDOG_KILL is on */
  look(h: HealthAnswer, kill: boolean, now = Date.now()): WatchAction {
    if (typeof h === 'string') {
      this.armed = true; this.fails = 0; this.logged = false
      if (this.gaveUp) { clearLiveness(this.dataDir); return { kind: 'recovered', line: 'watchdog: the server answers again; it restarts a hung server again from now on' } }
      return null
    }
    if (isMigrating(h)) { this.fails = 0; return null }
    if (!this.armed) return null
    this.fails++
    const need = this.o.failures ?? WATCH_FAILURES
    if (this.fails < need) return null
    const hung = `the server did not answer health ${this.fails} times in a row (every ${(this.o.everyMs ?? WATCH_EVERY_MS) / 1000} s)`
    if (this.gaveUp) return null
    if (!kill) {
      if (this.logged) return null
      this.logged = true
      return { kind: 'log', line: `watchdog: ${hung}; not restarting it: TEAMAX_WATCHDOG_KILL is off (log only)` }
    }
    const win = this.o.windowMs ?? WATCH_KILL_WINDOW_MS
    this.kills = this.kills.filter((t) => now - t < win)
    const max = this.o.maxKills ?? WATCH_MAX_KILLS
    if (this.kills.length >= max) {
      const detail = `${hung}; restarted ${this.kills.length} times within an hour already, so it is left running until it answers again`
      writeLiveness(this.dataDir, { gaveUp: true, since: new Date(now).toISOString(), detail })
      return { kind: 'gave-up', line: `watchdog: gave up: ${detail}` }
    }
    this.kills.push(now)
    this.fails = 0
    return { kind: 'kill', line: `watchdog: ${hung}; restarting it (${this.kills.length} of ${max} within an hour)` }
  }
}

export interface Liveness { gaveUp: boolean; since: string; detail: string }

/** data/liveness.json, read leniently (anything odd is none) */
export function readLiveness(dataDir: string): Liveness | null {
  try {
    const f = path.join(dataDir, LIVENESS_FILE)
    const st = fs.lstatSync(f)
    if (!st.isFile() || st.size > 4096) return null
    const j = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<Liveness>
    return j.gaveUp === true && typeof j.since === 'string' ? { gaveUp: true, since: j.since, detail: typeof j.detail === 'string' ? j.detail : '' } : null
  } catch { return null }
}
function writeLiveness(dataDir: string, l: Liveness) {
  try { fs.writeFileSync(path.join(dataDir, LIVENESS_FILE), JSON.stringify(l) + '\n', { mode: 0o600 }) } catch {}
}
function clearLiveness(dataDir: string) {
  try { fs.rmSync(path.join(dataDir, LIVENESS_FILE), { force: true }) } catch {}
}

/** TEAMAX_WATCHDOG_KILL=1 in config/office.env (settings.ts reads it the same way) */
export function officeWatchdogKills(envText: string | null): boolean {
  if (!envText) return false
  const m = /^\s*TEAMAX_WATCHDOG_KILL\s*=\s*(\S+)\s*$/m.exec(envText)
  return !!m && m[1] === '1'
}
