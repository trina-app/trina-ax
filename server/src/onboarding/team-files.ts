// 팀 파일 recorded done in the welcome steps (docs/DECISIONS.md "W6 — Onboarding v6: 팀 파일 recommendations"): the
// page's upload run of the step reports the first file that landed (POST /api/onboarding/files/landed), from any page
// and whoever of the owners and admins started it. Not through PATCH /api/onboarding/welcome, which is the owner's:
// after a transfer the old owner is an admin, and the run they started still records the step. The file must be there,
// in a group's folder, readable by the caller; the step is recorded once, and only on a team whose steps were opened
// (a team from before them never gets a progress row from an upload). The file must have been written within the hour.
import type { Role } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { authorize } from '../policy/authorize'
import { readWelcome, updateWelcome } from './welcome'

/** A landed file was written at most this long ago. */
const LANDED_MS = 60 * 60_000

/** The path is inside one of the groups' folders (the team's own or another group's). */
function inGroupFolder(ctx: AppContext, path: string): boolean {
  const folders = ctx.db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id').all() as { path: string }[]
  const p = path.normalize('NFC').toLowerCase()
  return folders.some((f) => p.startsWith(`${f.path.normalize('NFC').toLowerCase()}/`))
}

/** 팀 파일 done now (true), or nothing changed (false: done before, no welcome row, not a file of a group folder the
 * caller can read). */
export function recordTeamFilesLanded(ctx: AppContext, who: { id: string; role: Role }, path: string): boolean {
  if (who.role !== 'owner' && who.role !== 'admin') return false
  const p = readWelcome(ctx)
  if (!p || p.steps.files === 'done') return false
  if (!inGroupFolder(ctx, path)) return false
  try {
    const r = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(who.id), path, 'read')
    // a file that just landed: written within the hour (an old file of the folder records nothing)
    if (!r.st?.isFile() || Date.now() - r.st.mtimeMs > LANDED_MS) return false
  } catch {
    return false
  }
  // the steps are the owner's: what ends them runs for the owner (onWelcomeEnded hooks), not for an admin
  const owner = ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string } | null
  updateWelcome(ctx, owner?.id ?? who.id, { step: { id: 'files', state: 'done' } })
  return true
}
