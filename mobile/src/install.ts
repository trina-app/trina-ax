// A reinstall of the app, and ending the session the WebView kept. No native imports: tests load this file.
import type { Slot } from './device'
import { sameTeam } from './protocol'
import { JOIN_TOKEN_KEY, wipeJs } from './leave'

export interface InstallDeps {
  /** an id in the keychain, which iOS keeps when the app is deleted */
  keychain: Slot
  /** launches that tried the sign-out after a reinstall without an answer from the server (keychain) */
  tries: Slot
  /** a file in the app's documents, which deletion removes */
  marker: { exists(): boolean; create(): void; remove(): void }
  newId(): string
}
/** Launches that try the sign-out before the app gives up (the team server stayed unreachable), and page loads per launch. */
export const MAX_SIGN_OUT_LAUNCHES = 5
export const MAX_SIGN_OUT_PAGES = 3

/** True on a launch after the app was deleted and installed again, until the kept session was ended. Only on iOS:
 * Android removes the app's storage (SecureStore included, which is kept out of backups) on uninstall, so it never has
 * an id to survive; the check does nothing there at all. iOS keeps the
 * keychain (the team address, and the id kept here) when the app is deleted, and the WebView's session survived it in
 * testing, but the app's files go: a keychain id without the file marker is a reinstall. The marker is written only
 * once the sign-out got its answer (reinstallDone), so a sign-out that did not reach the server is tried again at the
 * next launch, at most MAX_SIGN_OUT_LAUNCHES times. An update from a build that wrote neither, or a first install,
 * writes both and is no reinstall. When the marker cannot be written the answer is false, so a failing file system never
 * signs the person out at every launch. */
export async function wasReinstalled(d: InstallDeps, launch: { ios: boolean; hasTeam: boolean }): Promise<boolean> {
  if (!launch.ios) return false
  const id = await d.keychain.get().catch(() => null)
  if (d.marker.exists()) { if (!id) await d.keychain.set(d.newId()).catch(() => {}); return false }
  if (!id) {
    // the id only with the marker: an id without one would read as a reinstall at the next launch
    try { d.marker.create() } catch { return false }
    await d.keychain.set(d.newId()).catch(() => {})
    return false
  }
  // no team saved: no session to end (a sign-in made later in this launch must not be signed out at the next one)
  if (!launch.hasTeam) { await reinstallDone(d); return false }
  try { d.marker.create(); d.marker.remove() } catch { return false }
  const tries = Number(await d.tries.get().catch(() => null)) || 0
  if (tries >= MAX_SIGN_OUT_LAUNCHES) { await reinstallDone(d); return false }
  await d.tries.set(String(tries + 1)).catch(() => {})
  return true
}
/** The sign-out after a reinstall got its answer: no more reinstall until the app is deleted again. */
export async function reinstallDone(d: InstallDeps): Promise<void> {
  try { d.marker.create() } catch { /* tried again at the next launch */ }
  await d.tries.set(null).catch(() => {})
}

/** The sign-out after a reinstall, for one launch. Only on the team saved at launch and only on a page of it whose
 * bridge the app has just installed; at most MAX_SIGN_OUT_PAGES page loads; never again once the server answered
 * (204: the kept session is ended; 401: there was none), also after the person signed in again and switched teams.
 * Also the sign-out owed to a team this phone left while its server did not answer (src/leave.ts), with `wipe`: the
 * page's storage is emptied too. */
export class ReinstallSignOut {
  private pages = 0
  private done = false
  private token: string | null = null
  constructor(readonly origin: string, private finish: () => Promise<void>, private newToken: () => string, private wipe = false) {}
  /** The script for the page at `url` of the team `origin`, or null. `entry`: the address the phone opened the team at
   * (a link's /join#t=… or /invite/<token>), where the owed sign-out goes back to after the server's 204. */
  script(origin: string, url: string, entry?: string): string | null {
    if (this.done || origin !== this.origin || !sameTeam(origin, url) || this.pages >= MAX_SIGN_OUT_PAGES) return null
    this.pages++
    this.token = this.newToken()
    return signOutScript(origin, this.token, this.wipe, entry && sameTeam(origin, entry) ? entry : undefined)
  }
  /** A message from the page: true when it was this sign-out's answer (then it is not a bridge message). */
  answer(raw: string): boolean {
    if (!this.token || raw.length > 300) return false
    let m: unknown
    try { m = JSON.parse(raw) } catch { return false }
    if (!m || typeof m !== 'object' || (m as { signOut?: unknown }).signOut !== this.token) return false
    this.token = null
    const status = (m as { status?: unknown }).status
    if (status === 204 || status === 401) { this.done = true; void this.finish().catch(() => {}) }
    return true
  }
  get finished() { return this.done }
}

/** POST <team>/api/auth/logout (the server removes this phone's push device with the session), the answer back to the
 * app with the one-time token, and the sign-in page once the session is gone. The sign-out owed to a team left
 * (`wipe`) keeps the page the person opened (an invite link's /invite/<token> or /join#t=…): the join page's token
 * stays in session storage, and after a 204 the page loads `entry` (the address the phone opened, with its #t=; signed
 * in, /join had sent the person Home and the address no longer has it), else the page on screen again. The same path
 * with only another #fragment would not load: the address is set first, then reloaded. Left as it is after a 401
 * (there was no session). */
export function signOutScript(origin: string, token: string, wipe = false, entry?: string): string {
  const reopen = entry
    ? `try{var e=new URL(${JSON.stringify(entry)});if(e.pathname+e.search===location.pathname+location.search){history.replaceState(history.state,'',e.href);location.reload()}else location.replace(e.href)}catch(x){location.reload()}`
    : 'location.reload()'
  return (wipe ? wipeJs([JOIN_TOKEN_KEY]) : '') + `fetch(${JSON.stringify(`${origin}/api/auth/logout`)},{method:'POST',credentials:'same-origin',headers:{'x-mycel-csrf':'1'}})`
    + `.then(function(r){return r.status},function(){return 0}).then(function(s){`
    + `try{window.ReactNativeWebView.postMessage(JSON.stringify({signOut:${JSON.stringify(token)},status:s}))}catch(e){}`
    + (wipe ? `if(s===204){${reopen}}});true;` : `if(s===204||s===401)location.replace('/login')});true;`)
}
