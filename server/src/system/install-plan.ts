// What the installer does with app/current and app/state.json when it installs a bundle (design tab 6 "업데이트"):
// run by scripts/install-macos.sh as root with the bun and admin.js of the bundle it installs (`admin.js install-state`),
// never with app/current. Pure, so tests/unit/g-installer.test.ts covers every case without root.
//
//   no usable app/current      -> init:   current = the bundle
//   same version               -> repair: nothing changes (the version folder is copied fresh)
//   newer bundle               -> switch: current -> the bundle, recorded as a pending update with the running version
//                                         as previous; the bootstrap health-checks it and rolls back on failure,
//                                         exactly like an in-app update (state.previous stays for "Roll back")
//   older bundle               -> older:  nothing changes; the installer says how to go back (admin.js switch)
import { AppState, emptyAppState } from '@mycel/shared/install'
import { compareVersions } from './update'

export type InstallAction = 'init' | 'repair' | 'switch' | 'older'

export function planInstallState(o: { current: string | null; version: string; state: unknown; now?: Date }): { action: InstallAction; state: AppState } {
  const parsed = AppState.safeParse(o.state)
  const st: AppState = parsed.success ? parsed.data : emptyAppState()
  const now = (o.now ?? new Date()).toISOString()
  if (!o.current) return { action: 'init', state: { ...st, current: o.version, pending: null, pendingSince: null, attempts: 0 } }
  if (o.current === o.version) {
    // a pending update the installer repairs over: the bootstrap still watches it; a missing state gets the basics
    return { action: 'repair', state: parsed.success ? st : { ...st, current: o.current } }
  }
  if (compareVersions(o.version, o.current) > 0) {
    return { action: 'switch', state: { ...st, current: o.current, previous: o.current, pending: o.version, pendingSince: now, attempts: 0 } }
  }
  return { action: 'older', state: parsed.success ? st : { ...st, current: o.current } }
}
