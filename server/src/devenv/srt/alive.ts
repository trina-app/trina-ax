// Is a dev environment run of this person alive now (docs/decisions/20261116-folder-share-widening.md)? A run keeps
// the folder view it started with (access.ts folderView): one made before a folder of the person was shared can still
// write in that folder. So a folder share cannot be added while such a run is alive (files/folder-shares.ts, 409
// folder_share_run_active). Every run may write the person's own folder (access.ts runMayWrite), so any running job,
// dev server or command of the person counts. A job still waiting in the queue does not: it gets its view when it
// starts, with the shared folder read-only.
import type { Database } from 'bun:sqlite'
import { heldCommands } from './queue'

/** runs of this process being started now (their view is made before their row says running): person -> how many */
const starting = new Map<string, number>()
/** A run of `userId` is being started (runner.ts startRow): it counts as alive until the returned function is called. */
export function startingRun(userId: string): () => void {
  starting.set(userId, (starting.get(userId) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (starting.get(userId) ?? 1) - 1
    if (n > 0) starting.set(userId, n); else starting.delete(userId)
  }
}

/** Does `userId` have a job or dev server running or being started, or a command holding a slot of this process? */
export function devRunAlive(db: Database, userId: string): boolean {
  if (heldCommands().includes(userId) || starting.has(userId)) return true
  return !!db.query("SELECT 1 FROM dev_env_runs WHERE user_id = ? AND ended_at IS NULL AND state = 'running' LIMIT 1").get(userId)
}
