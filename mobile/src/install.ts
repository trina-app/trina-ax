// A reinstall of the app. No native imports: tests load this file.
import type { Slot } from './device'

export interface InstallDeps { keychain: Slot; marker: { exists(): boolean; create(): void }; newId(): string }

/** True on the first launch after the app was deleted and installed again. iOS keeps the keychain (the team address,
 * and the id kept here) when the app is deleted, and the WebView's session survived it in testing, but the app's files
 * go: a keychain id without the file marker is a reinstall. An update from a build that wrote neither, or a first
 * install, writes both and is no reinstall. When the marker cannot be written the answer is false, so a failing file
 * system never signs the person out at every launch. */
export async function wasReinstalled(d: InstallDeps): Promise<boolean> {
  const id = await d.keychain.get().catch(() => null)
  if (d.marker.exists()) { if (!id) await d.keychain.set(d.newId()).catch(() => {}); return false }
  try { d.marker.create() } catch { return false }
  if (!id) { await d.keychain.set(d.newId()).catch(() => {}); return false }
  return true
}

/** On the team page after a reinstall: end the session the WebView kept (POST /api/auth/logout; the server removes this
 * phone's push device with it) and open the sign-in page. */
export const SIGN_OUT_SCRIPT = "fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'x-mycel-csrf':'1'}}).catch(function(){}).then(function(){location.replace('/login')});true;"
