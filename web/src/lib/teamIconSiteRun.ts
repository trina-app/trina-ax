// The team logo from the website, with the team's AI (docs/decisions/20261128-team-icon-ai-assist.md): the press
// answers at once and the AI checks or finds the logo in the background (about a minute and a half at most). The
// pressing window asks GET /api/admin/team-icon/from-site (its own last run) every 2 s until it ended, outside any one
// screen, so the onboarding steps go on and the toast still comes.
import type { TeamIconSiteRun } from '@mycel/shared/api'
import { api, API } from './api'

export const SITE_RUN_POLL_MS = 2_000
/** the server's run ends within about 90 s (the rules 30 s, the AI 60 s); a little more for the last poll */
export const SITE_RUN_WATCH_MS = 120_000

let watching: { stop: () => void } | null = null

/** Watch the caller's run until it ends: `onSet` with the new logo's version, `onNone` with the server's words; nothing
 * when it was lost (a restart: idle) or the time is up. One watch at a time (a new press replaces the old watch). */
export function watchSiteRun(o: { onSet: (version: string, run: Extract<TeamIconSiteRun, { status: 'set' }>) => void; onNone?: (message: string) => void; onEnd?: () => void; pollMs?: number; maxMs?: number }): () => void {
  watching?.stop()
  let live = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const until = Date.now() + (o.maxMs ?? SITE_RUN_WATCH_MS)
  const end = () => { if (!live) return; live = false; clearTimeout(timer); if (watching === me) watching = null; o.onEnd?.() }
  const me = { stop: () => { live = false; clearTimeout(timer); if (watching === me) watching = null } }
  watching = me
  const tick = async () => {
    if (!live) return
    let r: TeamIconSiteRun | null = null
    try { r = await api.call(API.teamIconSiteRun) } catch { r = null }
    if (!live) return
    if (r?.status === 'set') { o.onSet(r.version, r); return end() }
    if (r?.status === 'none') { o.onNone?.(r.message); return end() }
    if (r?.status === 'idle' || Date.now() >= until) return end()
    timer = setTimeout(() => void tick(), o.pollMs ?? SITE_RUN_POLL_MS)
  }
  timer = setTimeout(() => void tick(), o.pollMs ?? SITE_RUN_POLL_MS)
  return me.stop
}
