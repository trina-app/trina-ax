// A reinstall of the app, and ending the session the WebView kept. No native imports: tests load this file.
import type { Slot } from './device'
import { sameTeam } from './protocol'

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

/** True on a launch after the app was deleted and installed again, until the kept session was ended. iOS keeps the
 * keychain (the team address, and the id kept here) when the app is deleted, and the WebView's session survived it in
 * testing, but the app's files go: a keychain id without the file marker is a reinstall. The marker is written only
 * once the sign-out got its answer (reinstallDone), so a sign-out that did not reach the server is tried again at the
 * next launch, at most MAX_SIGN_OUT_LAUNCHES times. An update from a build that wrote neither, or a first install,
 * writes both and is no reinstall. When the marker cannot be written the answer is false, so a failing file system never
 * signs the person out at every launch. */
export async function wasReinstalled(d: InstallDeps): Promise<boolean> {
  const id = await d.keychain.get().catch(() => null)
  if (d.marker.exists()) { if (!id) await d.keychain.set(d.newId()).catch(() => {}); return false }
  if (!id) {
    try { d.marker.create() } catch { /* the next launch decides again */ }
    await d.keychain.set(d.newId()).catch(() => {})
    return false
  }
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
 * (204: the kept session is ended; 401: there was none), also after the person signed in again and switched teams. */
export class ReinstallSignOut {
  private pages = 0
  private done = false
  private token: string | null = null
  constructor(readonly origin: string, private finish: () => Promise<void>, private newToken: () => string) {}
  /** The script for the page at `url` of the team `origin`, or null. */
  script(origin: string, url: string): string | null {
    if (this.done || origin !== this.origin || !sameTeam(origin, url) || this.pages >= MAX_SIGN_OUT_PAGES) return null
    this.pages++
    this.token = this.newToken()
    return signOutScript(origin, this.token)
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
 * app with the one-time token, and the sign-in page once the session is gone. */
export function signOutScript(origin: string, token: string): string {
  return `fetch(${JSON.stringify(`${origin}/api/auth/logout`)},{method:'POST',credentials:'same-origin',headers:{'x-mycel-csrf':'1'}})`
    + `.then(function(r){return r.status},function(){return 0}).then(function(s){`
    + `try{window.ReactNativeWebView.postMessage(JSON.stringify({signOut:${JSON.stringify(token)},status:s}))}catch(e){}`
    + `if(s===204||s===401)location.replace('/login')});true;`
}
