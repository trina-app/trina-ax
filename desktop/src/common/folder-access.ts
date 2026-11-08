// The team page's folder window (File System Access, showDirectoryPicker) in the desktop app (docs/DECISIONS.md "W6").
// Electron 44 asks the team session three things (main/security.ts hardenAppSession):
//  - request (setPermissionRequestHandler, 'fileSystem'): right after the person picks a folder in the window, for that
//    folder. Chromium asks it for a pick only: a page's own requestPermission() is answered by the check alone, because
//    with a check handler set a grant is never "ask";
//  - check (setPermissionCheckHandler, 'fileSystem'): before every read through a handle, for the folder the handle
//    came from, with the grant's origin as a URL ("https://acme.treesoop.com/", trailing slash) and no frame;
//  - file-system-access-restricted: a folder Chromium's blocklist refuses (home, Desktop, Documents and Downloads
//    themselves; ~/Library, ~/.ssh, app data and the like with everything in them).
// What the page gets: read only, from the team page's top frame at an allowed origin, for the folders the person picked
// in the window while the app runs and what is inside them. A dropped folder handle, or one the page saved and loads
// in a later run, is not readable until the person picks it again. Pure: unit-tested in
// tests/unit/e-desktop-folder-window.test.ts.
import { originOf } from './address'

/** what Electron sends with a 'fileSystem' request (PermissionRequest + FilesystemPermissionRequest) */
export interface FolderRequest {
  requestingUrl?: string
  isMainFrame?: boolean
  fileAccessType?: string
  filePath?: string
}

/** what Electron sends with a 'fileSystem' check (PermissionCheckHandlerHandlerDetails) */
export interface FolderCheck {
  fileAccessType?: string
  filePath?: string
}

/** file-system-access-restricted's details, with the frame reduced to "the top frame" */
export interface RestrictedFolder {
  origin: string
  path: string
  isDirectory: boolean
  isTopFrame: boolean
}

/** A path as compared here: Windows ignores case and takes either slash; no trailing separator except at a root. */
export function folderKey(path: string, platform: string): string {
  if (platform === 'win32') {
    const p = path.replace(/\//g, '\\').toLowerCase()
    return /^[a-z]:\\$/.test(p) || p === '\\' ? p : p.replace(/\\+$/, '')
  }
  return path === '/' ? path : path.replace(/\/+$/, '')
}

/** path is folder or somewhere inside it (both already folderKey'd) */
function inside(path: string, folder: string, platform: string): boolean {
  if (!folder) return false
  const sep = platform === 'win32' ? '\\' : '/'
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
}

/** The folders picked in one team session's window while the app runs, by origin. */
export class FolderGrants {
  private readonly picked = new Map<string, Set<string>>()

  constructor(private readonly platform: string) {}

  /** A pick: read only, the top frame at an allowed origin. Remembers the folder for the checks. */
  request(d: FolderRequest, allowedOrigins: readonly string[]): boolean {
    const origin = originOf(d.requestingUrl ?? '')
    if (d.isMainFrame !== true || d.fileAccessType !== 'readable' || !d.filePath) return false
    if (!origin || !allowedOrigins.includes(origin)) return false
    let folders = this.picked.get(origin)
    if (!folders) this.picked.set(origin, (folders = new Set()))
    folders.add(folderKey(d.filePath, this.platform))
    return true
  }

  /** A read: the origin is still allowed, and the folder (or one it is inside) was picked for that origin. */
  check(requestingOrigin: string, d: FolderCheck, allowedOrigins: readonly string[]): boolean {
    const origin = originOf(requestingOrigin)
    if (d.fileAccessType !== 'readable' || !d.filePath) return false
    if (!origin || !allowedOrigins.includes(origin)) return false
    const path = folderKey(d.filePath, this.platform)
    for (const folder of this.picked.get(origin) ?? []) if (inside(path, folder, this.platform)) return true
    return false
  }
}

/**
 * A folder Chromium refuses: 'allow' exactly the home folder, Desktop, Documents and Downloads (roots: app.getPath),
 * picked as a folder by the team page's top frame at an allowed origin. Everything else stays refused ('deny' is the
 * page's AbortError, the same as Cancel). Lifting the block decides nothing about access: the request and the check
 * still give read only.
 */
export function restrictedFolderAction(d: RestrictedFolder, allowedOrigins: readonly string[], roots: readonly string[], platform: string): 'allow' | 'deny' {
  const origin = originOf(d.origin)
  if (!d.isTopFrame || !d.isDirectory || !d.path || !origin || !allowedOrigins.includes(origin)) return 'deny'
  const path = folderKey(d.path, platform)
  return roots.some((r) => r && folderKey(r, platform) === path) ? 'allow' : 'deny'
}
