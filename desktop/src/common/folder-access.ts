// The team page's folder window (File System Access, showDirectoryPicker) in the desktop app (docs/DECISIONS.md "W6").
// Electron 44 asks the team session three things (main/security.ts hardenAppSession):
//  - request (setPermissionRequestHandler, 'fileSystem'): right after the person picks a folder in the window, for that
//    folder. Chromium asks it for a pick only: a page's own requestPermission() is answered by the check alone, because
//    with a check handler set a grant is never "ask";
//  - check (setPermissionCheckHandler, 'fileSystem'): before every read through a handle, for the folder the handle
//    came from, with the grant's origin as a URL ("https://acme.treesoop.com/", trailing slash) and no frame;
//  - file-system-access-restricted: a folder Chromium's blocklist refuses (home, Desktop, Documents and Downloads
//    themselves; ~/Library, ~/.ssh, app data and the like with everything in them). Desktop, Documents and Downloads
//    are allowed; the home folder and everything else stay refused (PICKABLE_BLOCKED_ROOTS).
// What the page gets: read only, for the folders the person picked in the window while the app runs and what is inside
// them. A pick counts only from the team page's top frame at an allowed origin; a read counts for that origin (Electron
// gives no frame with a check, so whatever of that origin holds the handle reads it). A dropped folder handle, or one
// the page saved and loads in a later run, is not readable until the person picks it again. The request handler cannot
// tell a pick from the page's own requestPermission(): that this never reaches it is Electron's doing (the check answers
// first), pinned by desktop/e2e/folder-window.spec.ts. Only folders are remembered. Never the home folder or a folder
// that holds it, whatever the path looks like (a Desktop linked to home, Documents moved to C:\Users\<name> or C:\, the
// Data volume's name on macOS, a mapped drive, junction or subst drive onto the profile): see opensHome. The picks are
// forgotten when the person signs out or someone else signs in. Pure (the file system comes in as FolderSystem):
// unit-tested in tests/unit/e-desktop-folder-window.test.ts.
import { posix, win32 } from 'node:path'
import { originOf } from './address'
import { browserOwnerChange, type MeResult } from './browser-owner'

/**
 * Chromium's refused roots the person may pick anyway, as app.getPath names. Not 'home': a picked home folder would let
 * the page read ~/.config (the GitHub CLI's token among others), ~/.aws, ~/.netrc, ~/.codex/auth.json and the like
 * (Chromium blocks only ~/.ssh, ~/.gnupg, ~/Library and app data under it), and nothing here can narrow what is
 * readable inside a pick: every read through a handle is checked against the picked folder itself.
 */
export const PICKABLE_BLOCKED_ROOTS = ['desktop', 'documents', 'downloads'] as const

/** A folder's identity on the computer (fs.stat with bigint: device and file number, links followed). */
export interface FolderIdentity {
  dev: bigint
  ino: bigint
}

/**
 * What the rules need of the computer (main/security.ts: app.getPath('home'), fs.promises.realpath and fs.promises.stat,
 * each given a few seconds). Either call rejects when it cannot tell, in time; then the pick is refused.
 */
export interface FolderSystem {
  /** the person's home folder; '' when it cannot be told (then nothing is allowed) */
  home(): string
  /** the path with its links resolved */
  realpath(path: string): Promise<string>
  /** the folder's identity, links followed */
  identity(path: string): Promise<FolderIdentity>
}

/** what Electron sends with a 'fileSystem' request (PermissionRequest + FilesystemPermissionRequest) */
export interface FolderRequest {
  requestingUrl?: string
  isMainFrame?: boolean
  fileAccessType?: string
  filePath?: string
  isDirectory?: boolean
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

/** A path as compared here: `.` and `..` resolved, Windows ignores case and takes either slash; no trailing separator
 * except at a root. */
export function folderKey(path: string, platform: string): string {
  if (platform === 'win32') {
    const p = win32.normalize(path).toLowerCase()
    return /^[a-z]:\\$/.test(p) || p === '\\' ? p : p.replace(/\\+$/, '')
  }
  const p = posix.normalize(path)
  return p === '/' ? p : p.replace(/\/+$/, '')
}

/** path is folder or somewhere inside it (both already folderKey'd) */
function inside(path: string, folder: string, platform: string): boolean {
  if (!folder) return false
  const sep = platform === 'win32' ? '\\' : '/'
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
}

/** macOS shows the user folders under this name too (the Data volume's firmlinks): /System/Volumes/Data/Users/alex */
const MAC_DATA_VOLUME = '/System/Volumes/Data'

/** A path the way the home check compares names: folderKey, and on macOS ignoring case (APFS's default). */
function homeKey(path: string, platform: string): string {
  const k = folderKey(path, platform)
  return platform === 'darwin' ? k.toLowerCase() : k
}

/** A network or device path on Windows (\\server\share, \\?\…, \\.\…): refused without asking the network. */
export function isUncPath(path: string, platform: string): boolean {
  return platform === 'win32' && /^[\\/]{2}/.test(path)
}

/** The folder and each folder above it, up to the root. */
function withParents(path: string, platform: string): string[] {
  const p = platform === 'win32' ? win32 : posix
  const out: string[] = []
  for (let cur = p.normalize(path), i = 0; i < 64; i++) {
    out.push(cur)
    const up = p.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return out
}

/** An identity Node could not really tell (some network shares and file systems give 0). */
const unknownIdentity = (id: FolderIdentity) => id.dev === 0n || id.ino === 0n

/**
 * Would a pick of `path` let the page read the home folder: it is home or a folder that holds home. Checked by name (as
 * written and with links resolved, against home as written, resolved and, on macOS, under the Data volume's name;
 * Windows and macOS without case) and by identity (the pick's device and file number against home's and each folder
 * above it: a mapped drive, a share of the profile, a junction or a subst drive onto home). Anything that cannot be
 * told counts as opening home: no home, a network path on Windows, a realpath or stat that fails or takes too long, an
 * identity of 0.
 */
export async function opensHome(path: string, sys: FolderSystem, platform: string): Promise<boolean> {
  try {
    const home = sys.home()
    if (!home || !path) return true
    if (isUncPath(path, platform) || isUncPath(home, platform)) return true
    const [realPath, realHome] = await Promise.all([sys.realpath(path), sys.realpath(home)])
    if (!realPath || !realHome) return true
    // by name
    const homes = new Set<string>()
    for (const h of [home, realHome]) {
      const k = homeKey(h, platform)
      homes.add(k)
      if (platform === 'darwin') {
        const data = MAC_DATA_VOLUME.toLowerCase()
        if (k === data || k.startsWith(data + '/')) homes.add(k.slice(data.length) || '/')
        else homes.add(data + k)
      }
    }
    for (const p of [path, realPath]) {
      const k = homeKey(p, platform)
      for (const h of homes) if (inside(h, k, platform)) return true
    }
    // by identity: home and every folder above it
    const above = [...new Set([...withParents(home, platform), ...withParents(realHome, platform)])]
    const [pick, ...homeIds] = await Promise.all([sys.identity(path), ...above.map((a) => sys.identity(a))])
    if (!pick || unknownIdentity(pick) || homeIds.some((h) => !h || unknownIdentity(h))) return true
    return homeIds.some((h) => h.dev === pick.dev && h.ino === pick.ino)
  } catch {
    return true
  }
}

/** The folders picked in one team session's window while the app runs, by origin, for the person signed in. */
export class FolderGrants {
  private readonly picked = new Map<string, Set<string>>()
  /** whom the picks belong to (common/browser-owner.ts); null: nobody yet, or signed out */
  private owner: string | null = null
  /** bumped by every change of person: a pick still being checked when the person changes is not remembered */
  private generation = 0

  constructor(
    private readonly platform: string,
    private readonly sys: FolderSystem,
  ) {}

  /** A pick: a folder, read only, the top frame at an allowed origin, never home or a folder holding it. Remembers it. */
  async request(d: FolderRequest, allowedOrigins: readonly string[]): Promise<boolean> {
    const origin = originOf(d.requestingUrl ?? '')
    if (d.isMainFrame !== true || d.fileAccessType !== 'readable' || d.isDirectory !== true || !d.filePath) return false
    if (!origin || !allowedOrigins.includes(origin)) return false
    const generation = this.generation
    if (await opensHome(d.filePath, this.sys, this.platform)) return false
    if (generation !== this.generation) return false
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

  /** Who is signed in to the team page now (GET /api/me): a sign-out or another person forgets every pick. */
  person(me: MeResult) {
    const change = browserOwnerChange(this.owner, me)
    if (change.clear) {
      this.picked.clear()
      this.generation++
    }
    this.owner = change.owner
  }
}

/**
 * A folder Chromium refuses: 'allow' exactly one of the roots (PICKABLE_BLOCKED_ROOTS through app.getPath: Desktop,
 * Documents, Downloads), picked as a folder by the team page's top frame at an allowed origin, unless that root is home
 * or holds it (opensHome: a Desktop linked to home, Documents moved to C:\Users\<name> or C:\). Everything else stays
 * refused, the home folder included ('deny' is the page's AbortError, the same as Cancel). Lifting the block decides
 * nothing about access: the request and the check still give read only.
 */
export async function restrictedFolderAction(d: RestrictedFolder, allowedOrigins: readonly string[], roots: readonly string[], platform: string, sys: FolderSystem): Promise<'allow' | 'deny'> {
  const origin = originOf(d.origin)
  if (!d.isTopFrame || !d.isDirectory || !d.path || !origin || !allowedOrigins.includes(origin)) return 'deny'
  const path = folderKey(d.path, platform)
  if (!roots.some((r) => r && folderKey(r, platform) === path)) return 'deny'
  return (await opensHome(d.path, sys, platform)) ? 'deny' : 'allow'
}
