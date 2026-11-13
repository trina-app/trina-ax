// "다른 팀으로 전환" (UX review S6, docs/DECISIONS.md "Switching teams from the logo menu and 나"): only where one app holds
// several teams. The desktop app: its own menu of teams under the pointer, the OS menu's 팀 list (⌘1–9) and "팀 목록…"
// (DesktopBridge.teamMenu; an older app opens its team list). The phone app: its own "다른 팀에 연결" screen over the team
// (change-team-v1), the one its signed-out footer opens. A plain browser, phone or computer, is one team per address:
// nothing is offered there. The page never learns the person's other teams: the app draws the list.
import { useSyncExternalStore } from 'react'
import { desktop } from './desktop'
import { appChangesTeam, changeTeamInApp } from './mobile'

export type TeamSwitchWay = 'desktop' | 'app'

/** How this window switches teams, or null (a plain browser: no item) */
export function teamSwitchWay(): TeamSwitchWay | null {
  if (desktop()) return 'desktop'
  if (appChangesTeam()) return 'app'
  return null
}

/** teamSwitchWay, again when the phone app's bridge arrives (it is set after the page loads: 나 may be the first screen) */
export function useTeamSwitchWay(): TeamSwitchWay | null {
  return useSyncExternalStore(
    (on) => {
      window.addEventListener('mycel:mobile-ready', on)
      return () => window.removeEventListener('mycel:mobile-ready', on)
    },
    teamSwitchWay,
    () => null,
  )
}

/** Opens the app's own team switch (nothing in a plain browser). */
export function switchTeam(): void {
  const d = desktop()
  if (d) return void (d.teamMenu ? d.teamMenu() : d.openTeams())
  if (appChangesTeam()) void changeTeamInApp().catch(() => {})
}
