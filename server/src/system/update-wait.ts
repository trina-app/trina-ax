// An update that waits for running work before the server restarts (docs/DECISIONS.md "Updates wait for running work").
// Two sources say so:
// - this server's own update run (system/update-job.ts runUpdate: "Update now" and the Linux self-host's automatic
//   update), in memory, from its start until it restarts the server or fails (the backup and the download after the
//   wait are covered too: what started then would be cut);
// - root's `mycel-ctl update` (an administrator's run, the update timer, the dev server's timer), which writes
//   root/update-waiting.json {since, until} once it starts waiting and removes it when the run ends
//   (native/cmd/mycel-ctl/update.go).
// `until` is the end of the wait for running work. While an update runs, the server starts no scheduled run
// (chat/schedules.ts runDue: a missed run happens once after the restart) and refuses a foreground dev-environment
// command that could not end before `until` (devenv/tool.ts: a job keeps running through the restart, a foreground
// command does not), and Admin says "An update is waiting for N running tasks to finish".
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../app-config'
import { resolveLayout } from './layout'

export interface UpdateWait {
  since: string
  /** the end of the wait for running work (the restart follows) */
  until: string
  /** this server's own run, still in its wait: "Update now anyway" can end the wait (skipUpdateWait) */
  skippable: boolean
}

/** root's marker counts this long past its `until`: the run still copies, switches and restarts, then removes it (a
 * run killed meanwhile leaves the file, which stops counting then) */
export const ROOT_WAIT_GRACE_MS = 15 * 60_000

let local: { since: string; until: string; waiting: boolean; skip: boolean; endsBy?: number } | null = null

/** this server's own update run starts (until: the end of its wait) / its wait ends / the run ends */
export function beginUpdateWait(now: Date, until: Date) { local = { since: now.toISOString(), until: until.toISOString(), waiting: true, skip: false } }
/** the wait is over: the restart comes next (after the backup and the download), so `until` is now */
export function updateWaitOver() { if (local) { local.waiting = false; local.until = new Date().toISOString() } }
export function endUpdateWait() { local = null }
/** the run switched and asked for its restart: the mark stays until then, and stops counting at `by` */
export function updateWaitEndsBy(by: Date) { if (local) { local.waiting = false; local.endsBy = by.getTime() } }
/** "Update now anyway" while this server's own update waits: its wait ends at the next look. false: none waits. */
export function skipUpdateWait(): boolean {
  if (!local?.waiting) return false
  local.skip = true
  return true
}
/** the run's wait loop asks */
export const updateWaitSkipped = () => !!local?.skip

/** a wait root wrote: read leniently (anything odd, a link, or an `until` long past is none) */
function rootWait(rootDir: string | null | undefined, now: Date): UpdateWait | null {
  if (!rootDir) return null
  try {
    const p = path.join(rootDir, 'update-waiting.json')
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > 4096) return null
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { since?: unknown; until?: unknown }
    if (typeof j.since !== 'string' || typeof j.until !== 'string') return null
    const until = Date.parse(j.until)
    if (!Number.isFinite(until) || until + ROOT_WAIT_GRACE_MS <= now.getTime() || until - now.getTime() > 3 * 3600_000) return null
    return { since: j.since, until: j.until, skippable: false }
  } catch { return null }
}

/** Is an update under way that waits (or waited) for running work? null: no. */
export function updateWaiting(o: { rootDir?: string | null; now?: Date } = {}): UpdateWait | null {
  if (local && local.endsBy !== undefined && Date.now() >= local.endsBy) local = null
  if (local) return { since: local.since, until: local.until, skippable: local.waiting && !local.skip }
  return rootWait(o.rootDir, o.now ?? new Date())
}

/** updateWaiting for this server (its root/ folder from the layout) */
export function updateWaitingFor(cfg: AppConfig, now?: Date): UpdateWait | null {
  let rootDir: string | null = null
  try { rootDir = resolveLayout(cfg).rootDir } catch {}
  return updateWaiting({ rootDir, now })
}

/** tests */
export function _resetUpdateWait() { local = null }
