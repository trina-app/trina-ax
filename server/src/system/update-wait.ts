// An update that waits for running work before the server restarts (docs/DECISIONS.md "Updates wait for running work").
// Two sources say so:
// - this server's own update run (system/update-job.ts runUpdate: "Update now" and the Linux self-host's automatic
//   update), in memory;
// - root's `mycel-ctl update` (an administrator's run, the update timer, the dev server's timer), which writes
//   root/update-waiting.json {since, until} while it waits and removes it after (native/cmd/mycel-ctl/update.go).
// While an update waits, the server starts no scheduled run (chat/schedules.ts runDue: a missed run happens once after
// the restart) and refuses a long foreground dev-environment command (devenv/tool.ts: a job keeps running through the
// restart, a foreground command does not), and Admin shows "An update is waiting for N running tasks to finish".
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../app-config'
import { resolveLayout } from './layout'

export interface UpdateWait { since: string; until: string }

let local: UpdateWait | null = null

/** this server's own update run starts / ends its wait */
export function beginUpdateWait(now: Date, until: Date) { local = { since: now.toISOString(), until: until.toISOString() } }
export function endUpdateWait() { local = null }

/** a wait root wrote: read leniently (anything odd, a link, or an `until` that passed is none) */
function rootWait(rootDir: string | null | undefined, now: Date): UpdateWait | null {
  if (!rootDir) return null
  try {
    const p = path.join(rootDir, 'update-waiting.json')
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > 4096) return null
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { since?: unknown; until?: unknown }
    if (typeof j.since !== 'string' || typeof j.until !== 'string') return null
    const until = Date.parse(j.until)
    // a run killed in its wait leaves the file: it counts until its own deadline, and never longer than 2 hours
    if (!Number.isFinite(until) || until <= now.getTime() || until - now.getTime() > 2 * 3600_000) return null
    return { since: j.since, until: j.until }
  } catch { return null }
}

/** Is an update waiting for running work now? null: no. */
export function updateWaiting(o: { rootDir?: string | null; now?: Date } = {}): UpdateWait | null {
  const now = o.now ?? new Date()
  if (local && Date.parse(local.until) > now.getTime()) return local
  return rootWait(o.rootDir, now)
}

/** updateWaiting for this server (its root/ folder from the layout) */
export function updateWaitingFor(cfg: AppConfig, now?: Date): UpdateWait | null {
  let rootDir: string | null = null
  try { rootDir = resolveLayout(cfg).rootDir } catch {}
  return updateWaiting({ rootDir, now })
}

/** a foreground dev-environment command longer than this is refused while an update waits (devenv/tool.ts) */
export const LONG_COMMAND_SEC = 120

/** tests */
export function _resetUpdateWait() { local = null }
