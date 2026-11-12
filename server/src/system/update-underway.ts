// Is this server stopping for an update? (QA TC-338) The answers a stop ends then say that Trina was updating, not that
// the server restarted. Every update path changes something on disk before it stops the server:
//
// - the team server's own update (Admin › System, system/update-job.ts) and `mycel-ctl update` (admin.js switch):
//   app/current points at another version than the one running
// - office mode (office/update.ts): the update agent's run is recorded in <home>/update/state.json while it runs
//
// Any failure to read reads as "no": the plain restart words are never wrong.
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../app-config'
import { readUpdateState } from '../office/update'
import { officeHomeOf } from '../routes/office-update'
import { resolveLayout } from './layout'

export function updateUnderway(cfg: AppConfig, version: string): boolean {
  try {
    const home = officeHomeOf(cfg)
    if (home && readUpdateState(home).running) return true
  } catch {}
  try {
    const appDir = resolveLayout(cfg).appDir
    if (!appDir) return false
    const target = path.basename(fs.readlinkSync(path.join(appDir, 'current')))
    return !!target && target !== version
  } catch { return false }
}
