// The desktop app's id (electron-builder's appId) and the Windows AppUserModelID the running app gives itself.
// Windows shows a toast only when the app's AppUserModelID matches a Start menu shortcut that carries the same id.
// The NSIS installer writes appId into the Start menu and desktop shortcuts (System.AppUserModel.ID). Electron's own
// default id is "electron.app.<app name>", so without app.setAppUserModelId(DESKTOP_APP_ID) Windows drops every
// toast without an error: Electron's 'show' fires, nothing appears, and Windows never lists the app under Settings ›
// System › Notifications (QA TC-342, 0.4.0 and 0.5.5).
// A Microsoft Store (MSIX) build gets its id from the package identity: setting another one there breaks its toasts.
// Pure: unit-tested in tests/unit/e-notify.test.ts; used by desktop/electron-builder.config.ts and main/main.ts.

/** electron-builder's appId. Keep it fixed: Windows identifies the installed app by it (the NSIS uninstall entry and
 * its GUID, the shortcuts' AppUserModelID), so a change installs a second app and the old shortcuts lose toasts. */
export const DESKTOP_APP_ID = 'com.treesoop.mycel'

/** The AppUserModelID to set at start (app.setAppUserModelId), or null: only on Windows, never in a store build. */
export function windowsAppUserModelId(p: { platform: string; windowsStore?: boolean }): string | null {
  return p.platform === 'win32' && p.windowsStore !== true ? DESKTOP_APP_ID : null
}
