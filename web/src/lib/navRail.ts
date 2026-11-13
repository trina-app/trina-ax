// Is the new navigation on (docs/AGENTS/plan/20261112-1839-nav-rail.md §5.1): one switch per server, `navRail` in
// server.json (Me.server.navRail), on by default since P6 (`false` is the operator's kill switch). It sets both layouts at once, the
// computer's rail (lib/rail.ts) and the phone's new tabs; there is no per-browser override, so nobody sees half of it.
// Read by the computer's rail (components/Layout.tsx, rail/, panels/, phase P1) and the phone's tabs (lib/tabs.ts
// phoneTabsV2, phase P5: the tables of lib/tabs.ts and lib/screens.ts are plain functions, so the switch is set there).
import { setOwnFolderWord } from '@mycel/shared'
import type { Me } from '@mycel/shared/api'
import { useMe, useSession } from '../store/session'
import { setPhoneTabsV2 } from './tabs'

export const navRailOn = (me: Pick<Me, 'server'> | null | undefined) => !!me?.server?.navRail

// the person's own folder is "내 파일" with the new navigation (shared/src/folder-labels.ts; the server's AI says the same):
// set before the screens that name it draw again (this listener is the store's first)
const meOf = (s: ReturnType<typeof useSession.getState>) => (s.status.kind === 'signed-in' ? s.status.me : null)
const apply = (on: boolean) => {
  setOwnFolderWord(on ? 'files' : 'folder')
  setPhoneTabsV2(on)
}
apply(navRailOn(meOf(useSession.getState())))
useSession.subscribe((s) => apply(navRailOn(meOf(s))))

export function useNavRail(): boolean {
  return navRailOn(useMe())
}
