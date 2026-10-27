// What the hosted service's operator puts into a tenant for the team server to show (control-plane 3.5.6, SV-1/SV-2):
//   <base>/root/notices.json   NoticesFile (shared/src/cloud-protocol/files.ts): notices for the web banner by role
//   <base>/root/plan.json      PlanFile: read by system/limits.ts; this module adds the admin screen's view of it
// Both are written by root only (`mycel-ctl notices-set` / `apply-plan`, run by the control plane through ax-hostd),
// mode 0644: the server account reads them and cannot change them. A self-hosted install has neither: no banner, no
// plan card, everything as before. The files are read at start, again when their mtime changes (checked at most every
// 30 s for the notices, 60 s for the plan) and at once on SIGHUP (main.ts -> reloadManagedFiles: mycel-ctl signals
// after it wrote one). A file that does not parse keeps the last good one in force and shows in Diagnostics.
import fs from 'node:fs'
import type { Database } from 'bun:sqlite'
import { NoticesFile } from '@mycel/shared/cloud-protocol'
import type { Locale, ManagedNotice, PlanStatus, Role } from '@mycel/shared/api'
import { currentPlan, effectiveConcurrency, forgetPlanCheck, seatsUsed } from './limits'

interface Loaded { file: string; mtimeMs: number; size: number; notices: NoticesFile | null; checkedAt: number }
let configured: string | null = null
let loaded: Loaded | null = null
let override: { notices: NoticesFile | null } | null = null
let problem: { at: string; error: string } | null = null
let warn: (m: string, d?: object) => void = () => {}
const RECHECK_MS = 30_000

/** $MYCEL_NOTICES_FILE, else the install layout's <base>/root/notices.json (null in dev). */
export function noticesFile(): string | null { return process.env.MYCEL_NOTICES_FILE || configured }

/** Called once at start by the ops service (system/ops.ts) with the install layout's notices file. */
export function configureNotices(o: { file: string | null; log?: { warn(m: string, d?: object): void } }) {
  configured = o.file
  if (o.log) warn = (m, d) => o.log!.warn(m, d)
  loaded = null
  problem = null
}

/** Tests: fixed notices (null = none) instead of the file; undefined = back to the file. */
export function setNoticesForTests(n: NoticesFile | null | undefined) { override = n === undefined ? null : { notices: n } }

/** SIGHUP: read notices.json and plan.json again at their next use, whatever their mtime says. */
export function reloadManagedFiles() {
  if (loaded) loaded.checkedAt = -Infinity
  forgetPlanCheck()
}

/** The notices file as last read (null: none). A file that does not parse is reported, the previous notices stay. */
export function currentNotices(now = Date.now()): NoticesFile | null {
  if (override) return override.notices
  const file = noticesFile()
  if (!file) return null
  if (loaded && loaded.file === file && now - loaded.checkedAt < RECHECK_MS) return loaded.notices
  let st: fs.Stats
  try { st = fs.statSync(file) } catch {
    loaded = { file, mtimeMs: 0, size: 0, notices: null, checkedAt: now }
    problem = null
    return null
  }
  if (loaded && loaded.file === file && loaded.mtimeMs === st.mtimeMs && loaded.size === st.size) { loaded.checkedAt = now; return loaded.notices }
  let notices: NoticesFile | null = loaded?.file === file ? loaded.notices : null
  try {
    if (st.size > 256 * 1024) throw new Error(`${st.size} bytes is too large for notices.json`)
    notices = NoticesFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    problem = null
  } catch (e) {
    problem = { at: new Date(now).toISOString(), error: String(e).slice(0, 300) }
    warn('the notices file is not valid; the previous notices stay', { file, err: problem.error })
  }
  loaded = { file, mtimeMs: st.mtimeMs, size: st.size, notices, checkedAt: now }
  return notices
}

/** The notices file did not parse the last time it changed, else null (Diagnostics). */
export function noticesFileProblem(): { at: string; error: string } | null { currentNotices(); return problem }

const RANK = { critical: 0, warn: 1, info: 2 } as const
/** who sees a notice: 'everyone' all, 'admins' owner and admins, 'owner' the owner only */
export function noticeVisibleTo(audience: 'owner' | 'admins' | 'everyone', role: Role): boolean {
  return audience === 'everyone' || (audience === 'admins' ? role === 'owner' || role === 'admin' : role === 'owner')
}

/** GET /api/managed/notices: the notices for this role that have not run out, critical first, in the caller's
 * language. info / warn may be hidden per browser; critical ones stay (the web banner). */
export function noticesFor(role: Role, locale: Locale, now = Date.now()): ManagedNotice[] {
  const f = currentNotices(now)
  if (!f) return []
  return f.notices
    .filter((n) => noticeVisibleTo(n.audience, role) && (n.until === null || Date.parse(n.until) > now))
    .map((n, i) => ({ n, i }))
    .sort((a, b) => RANK[a.n.level] - RANK[b.n.level] || a.i - b.i)
    .map(({ n }) => ({ id: n.id, level: n.level, text: n.text[locale] ?? n.text.en, link: n.link, until: n.until, dismissible: n.level !== 'critical' }))
}

/** GET /api/admin/plan (Admin > System > Plan). */
export function planStatus(db: Database, locale: Locale): PlanStatus {
  const p = currentPlan()
  if (!p) return { plan: null }
  return {
    plan: {
      id: p.plan,
      name: p.display?.name[locale] ?? p.display?.name.en ?? p.plan,
      maxConcurrency: p.maxConcurrency,
      concurrency: effectiveConcurrency(db),
      maxActiveMembers: p.maxActiveMembers,
      activeMembers: seatsUsed(db),
      diskGiB: p.diskGiB,
      memoryMiB: p.memoryMiB,
      cpuCores: p.cpuCores,
      localBackupRetentionDays: p.localBackupRetentionDays,
      links: p.links,
      updatedAt: p.updatedAt ?? null,
    },
  }
}
