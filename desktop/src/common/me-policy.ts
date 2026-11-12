// What the desktop app takes from the team server's GET /api/me for the in-app browser (common/site-permissions.ts):
// the team's "Allow all websites" policy (Me.team.browserAllowAll: off turns this browser back to asking) and the
// person's own switch for the AI's web reads (Me.user.webAllowAll: followed only when it goes from on to off; it never
// widens this browser, which takes the person's click in the app's own window). Called on every read of GET /api/me:
// when the team page opens, every minute, when Settings › Browser reads the setting, and before every AI browser call
// (AppWindow.ensureBrowserOwner), so an off reaches this browser before the AI's next browser step.

/** The pane's two policy setters (BrowserPane; a fake in tests/unit/e-desktop-common.test.ts). */
export interface MePolicyTarget {
  setTeamPolicy(allowAll: boolean): void
  setPersonPolicy(on: boolean): void
}

/** The part of Me this reads (an older server leaves either out). */
export interface MePolicy {
  team: { browserAllowAll?: boolean }
  user: { webAllowAll?: boolean }
}

export function applyMePolicy(pane: MePolicyTarget, me: MePolicy) {
  if (typeof me.team.browserAllowAll === 'boolean') pane.setTeamPolicy(me.team.browserAllowAll)
  pane.setPersonPolicy(me.user.webAllowAll === true)
}
