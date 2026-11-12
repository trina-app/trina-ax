// Is the new navigation on (docs/AGENTS/plan/20261112-1839-nav-rail.md §5.1): one switch per server, `navRail` in
// server.json (Me.server.navRail), off by default until every phase is in. It turns on both layouts at once, the
// computer's rail (lib/rail.ts) and the phone's new tabs; there is no per-browser override, so nobody sees half of it.
// Nothing reads it yet: the layouts that use it come in the next phases.
import type { Me } from '@mycel/shared/api'
import { useMe } from '../store/session'

export const navRailOn = (me: Pick<Me, 'server'> | null | undefined) => !!me?.server?.navRail

export function useNavRail(): boolean {
  return navRailOn(useMe())
}
