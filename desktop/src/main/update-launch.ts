// What a starting app does about an update an earlier run left ready (common/update-guard.ts launchDecision): step
// aside while ShipIt installs it (macOS), forget it once installed, or count a start that is still on the old version.
// Runs before any window, right after the single-instance lock, in the packaged self-updating app only.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleIdOf, bundleOf, launchctlPid, launchDecision, MAC_WAITER, parsePending, parseResume, PENDING_FILE, RESUME_FILE, shipItLabel, type LaunchDecision, type Pending, type Resume } from '../common/update-guard'
import { debug } from './debug'

const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return null } }

export function readPending(userData: string): Pending | null {
  return parsePending(read(join(userData, PENDING_FILE)))
}

export function writePending(userData: string, p: Pending | null) {
  const f = join(userData, PENDING_FILE)
  try { if (p) writeFileSync(f, JSON.stringify(p)); else rmSync(f, { force: true }) } catch {}
}

/** ShipIt (Squirrel.Mac's installer) has a process for this app right now */
function shipItRunning(bundleId: string): boolean {
  try {
    return launchctlPid(execFileSync('/bin/launchctl', ['list', shipItLabel(bundleId)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })) !== null
  } catch {
    return false // not loaded
  }
}

/** Decide at start. 'wait': the caller quits at once (app.exit); a detached waiter opens the app when ShipIt is done. */
export function onLaunch(o: { userData: string; version: string; platform: NodeJS.Platform; execPath: string }): LaunchDecision {
  const pending = readPending(o.userData)
  if (!pending) return { kind: 'none' }
  const bundle = o.platform === 'darwin' ? bundleOf(o.execPath) : null
  const bundleId = bundle ? bundleIdOf(read(join(bundle, 'Contents', 'Info.plist'))) : null
  const d = launchDecision({ pending, current: o.version, installing: !!bundleId && shipItRunning(bundleId), now: Date.now() })
  debug('update at launch', d.kind, pending.version)
  if (d.kind === 'updated') writePending(o.userData, null)
  else if (d.kind === 'failed') writePending(o.userData, d.pending)
  else if (d.kind === 'wait' && bundle && bundleId) {
    writePending(o.userData, d.pending)
    try {
      spawn('/bin/sh', ['-c', MAC_WAITER, shipItLabel(bundleId), bundle], { detached: true, stdio: 'ignore' }).unref()
    } catch (e) {
      debug('update waiter', (e as Error).message)
    }
  }
  return d
}

/** the page to open again after the app restarted by itself to update (read once, then forgotten) */
export function takeResume(userData: string): Resume | null {
  const f = join(userData, RESUME_FILE)
  const r = parseResume(read(f), Date.now())
  try { rmSync(f, { force: true }) } catch {}
  return r
}

export function writeResume(userData: string, r: Resume | null) {
  const f = join(userData, RESUME_FILE)
  try { if (r) writeFileSync(f, JSON.stringify(r)); else rmSync(f, { force: true }) } catch {}
}
