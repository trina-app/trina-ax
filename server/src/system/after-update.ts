// After-update to-dos. Release notes are not read, so when an update leaves something for an admin to do, the app says so
// itself: Admin > Home lists it with a button. One entry here per thing: a stable id, the version it came with, a check
// that decides on the server whether it applies to this team right now (it goes away by itself once the thing is done),
// and where its button goes. An admin can dismiss one ("not needed"); that is kept for the team in the `settings` table
// (key below), so it survives restarts and shows for no admin again. Clients show only the ids they know.
import type { AfterUpdateAction } from '@mycel/shared/api'
import { HWP_PLUGIN_ID } from '@mycel/shared/hwp'
import type { AppContext } from '../context'
import { getSetting, setSetting } from '../admin/settings'
import { pluginsOf } from '../plugins/manager'

export const AFTER_UPDATE_DISMISSED = 'afterUpdate.dismissed'

interface Entry extends AfterUpdateAction {
  /** does it apply to this team now? (a throw counts as "no") */
  check: (ctx: AppContext) => boolean
}

/** why an installed plugin can never run on this server (turning it on would not help) */
const CANNOT_HERE = ['os', 'arch', 'libc', 'product', 'api', 'revoked']

/** HWP plugin gate (0.4.0-beta.2): the AI makes .hwpx and fills .hwp/.hwpx forms only while "HWP Preview" is installed
 * and on. Applies while it is not, and only where the plugin can be had here (installed and not unsupported for good, or
 * listed as installable): on a server that cannot run it (Debian 12) Admin > Plugins already says so and this stays silent. */
export function hwpPluginNeeded(ctx: AppContext): boolean {
  const m = pluginsOf(ctx)
  if (m.hwpWriting()) return false
  const l = m.list('en')
  const inst = l.installed.find((p) => p.id === HWP_PLUGIN_ID)
  // installed but off: turning it on is the thing to do, unless this server can never run it or the build was withdrawn
  if (inst) return !(inst.unsupported && CANNOT_HERE.includes(inst.unsupported))
  const c = l.catalog.find((p) => p.id === HWP_PLUGIN_ID)
  return !!c && (c.availability === 'available' || c.availability === 'file')
}

export const AFTER_UPDATE_ACTIONS: Entry[] = [
  { id: 'hwp-plugin', since: '0.4.0-beta.2', to: `/admin/plugins?focus=${HWP_PLUGIN_ID}`, check: hwpPluginNeeded },
]

export function dismissedAfterUpdate(ctx: AppContext): string[] {
  const v = getSetting<unknown>(ctx.db, AFTER_UPDATE_DISMISSED)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** The to-dos that apply to this team now and are not dismissed. */
export function pendingAfterUpdate(ctx: AppContext): AfterUpdateAction[] {
  const gone = new Set(dismissedAfterUpdate(ctx))
  return AFTER_UPDATE_ACTIONS.filter((a) => {
    if (gone.has(a.id)) return false
    try { return a.check(ctx) } catch { return false }
  }).map(({ id, since, to }) => ({ id, since, to }))
}

/** false: no such to-do */
export function dismissAfterUpdate(ctx: AppContext, id: string): boolean {
  if (!AFTER_UPDATE_ACTIONS.some((a) => a.id === id)) return false
  const now = dismissedAfterUpdate(ctx)
  if (!now.includes(id)) setSetting(ctx.db, AFTER_UPDATE_DISMISSED, [...now, id])
  return true
}
