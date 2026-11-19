// The Linux builds (docs/decisions/20261119-linux-desktop-app.md), the parts without Electron (unit-tested in
// tests/unit/e-desktop-linux.test.ts). The .deb installs a menu entry, the link handler and an AppArmor profile that
// lets Chromium's sandbox run on Ubuntu 24.04; the AppImage has none of them.

export interface LinuxStart {
  platform: string
  packaged: boolean
  env: Record<string, string | undefined>
  /** Chromium was started with --no-sandbox (app.commandLine.hasSwitch('no-sandbox')) */
  noSandbox?: boolean
}

/** a packaged app started from an AppImage (its runtime sets APPIMAGE to the file's path) */
export function runsAsAppImage(s: LinuxStart): boolean {
  return s.platform === 'linux' && s.packaged && !!s.env.APPIMAGE
}

/** The AppImage's AppRun adds --no-sandbox by itself where user namespaces are blocked (Ubuntu 24.04). The app loads team
 * pages and the AI's browser pane, so it never runs that way: it says to install the .deb and quits. */
export function refusesUnsandboxed(s: LinuxStart): boolean {
  return runsAsAppImage(s) && s.noSandbox === true
}

/** Only an installed app answers <scheme>:// links: on Linux the handler names the .deb's menu entry, which an AppImage
 * does not have (registering it would point the system at a file that is not there). */
export function registersLinkHandler(s: LinuxStart): boolean {
  return s.packaged && !runsAsAppImage(s)
}

/** variables the AppImage's runtime sets for the app itself */
const APPIMAGE_VARS = new Set(['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'])

/** a path inside the AppImage's mount (APPDIR), which holds the app's own libraries and programs */
export function insideAppDir(p: string, appDir: string | undefined): boolean {
  if (!appDir || !appDir.startsWith('/')) return false
  const root = appDir.replace(/\/+$/, '')
  return root !== '' && (p === root || p.startsWith(`${root}/`))
}

/** The environment a program started from the app gets, without the AppImage's own variables and without the mount's
 * entries in LD_LIBRARY_PATH (otherwise `npx` or `python` would load the app's libraries). Nothing changes when the app
 * does not run from an AppImage. */
export function withoutAppImage(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const appDir = env.APPDIR
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (APPIMAGE_VARS.has(k)) continue
    out[k] = v
  }
  if (appDir && out.LD_LIBRARY_PATH !== undefined) {
    const kept = out.LD_LIBRARY_PATH.split(':').filter((d) => d && !insideAppDir(d, appDir))
    if (kept.length) out.LD_LIBRARY_PATH = kept.join(':')
    else delete out.LD_LIBRARY_PATH
  }
  return out
}
