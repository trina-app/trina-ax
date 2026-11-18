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
  /** Lists the folder's first entry and nothing more (macOS only, after a pick: FolderGrants.problem). Rejects with the
   * file system's error (EPERM when macOS privacy keeps the app out of Documents, Desktop or Downloads). Optional: a
   * system without it never reports a problem. */
  readable?(path: string): Promise<void>
  /** Windows: the system's own names for its folders (%SystemRoot%, %ProgramFiles%, %ProgramData%, %APPDATA% …) that a
   * share under a name of its own must not lead into (opensHome shares). Optional: home's drive gives the usual ones. */
  systemFolders?(): string[]
}

/**
 * Why a picked folder gave the team page nothing to read, for the page's own words (shared/src/desktop-bridge.ts
 * folderProblem): 'mac-blocked', macOS privacy keeps the app out of it (the person said Don't Allow, or Files and Folders
 * has the app off). The page reads only an empty folder then and would say "이 폴더엔 문서가 없어요" (QA TC-049).
 */
export type FolderProblem = 'mac-blocked'

/** A read error macOS privacy (TCC) gives: EPERM, or EACCES, on macOS only. Never the error's own text. */
export function macBlocked(err: unknown, platform: string): boolean {
  if (platform !== 'darwin') return false
  const code = (err as { code?: unknown } | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/** How long the page's question waits for the readability check (a slow network folder): then no problem is told. */
export const FOLDER_PROBLEM_MS = 5000

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

/** A Windows device path (\\?\…, \\.\…): a drive, a volume or a share under another name; never a folder a person
 * picks. */
function isDevicePath(path: string): boolean {
  return /^[\\/]{2}[?.](?:[\\/]|$)/.test(path)
}

/**
 * A network path that may be picked as a share (\\nas\company\Sales, and a mapped drive that resolves to one), or why
 * not. Refused, whatever the server: a device path; a drive's or the system's admin share (C$, ADMIN$, IPC$, PRINT$),
 * which opens a drive's top, the profile folders or Windows itself under another name; WSL's own (\\wsl$,
 * \\wsl.localhost: a Linux home, not a share); a path with no share name. Anything else still goes through opensHome's
 * name and identity checks (a share of the profile or of a folder above it) and pickRefused (the apps' data, the
 * system's folders on a share of a drive's top).
 */
export function refusedShare(path: string, platform: string): boolean {
  if (platform !== 'win32' || !isUncPath(path, platform)) return false
  if (isDevicePath(path)) return true
  const [host = '', share = ''] = path.replace(/^[\\/]+/, '').split(/[\\/]+/)
  const h = host.toLowerCase()
  // Windows drops trailing dots and spaces from a name ("C$." is C$)
  const s = share.toLowerCase().replace(/[. ]+$/, '')
  if (!h || !s || /[?*]/.test(h) || h === '.' || h === '..') return true
  if (h === 'wsl$' || h === 'wsl.localhost') return true
  return /^[a-z]\$$/.test(s) || s === 'admin$' || s === 'ipc$' || s === 'print$'
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
 * told counts as opening home: no home, a home on a network path, a realpath or stat that fails or takes too long, an
 * identity of 0. A network path on Windows counts as home too, without asking the network, unless `o.shares`: the
 * person's own pick in the system's folder window ("Choose a folder…" in find work files, main/work-files.ts), where a
 * NAS or company share must work. Then a share goes through the same checks (the network is asked: the person's pick
 * already reached it), and a device path, an admin share or WSL's stays refused, as written and resolved (refusedShare).
 */
export async function opensHome(path: string, sys: FolderSystem, platform: string, o: { shares?: boolean } = {}): Promise<boolean> {
  try {
    const home = sys.home()
    if (!home || !path) return true
    if (isUncPath(home, platform)) return true
    if (isUncPath(path, platform) && (!o.shares || refusedShare(path, platform))) return true
    const [realPath, realHome] = await Promise.all([sys.realpath(path), sys.realpath(home)])
    if (!realPath || !realHome) return true
    if (o.shares && refusedShare(realPath, platform)) return true
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
    if (homeIds.some((h) => h.dev === pick.dev && h.ino === pick.ino)) return true
    // a share keeps its own names after realpath (the server resolves its links): what it leads into is told by identity
    if (o.shares && isUncPath(realPath, platform)) return await shareLeadsAside(realPath, [home, realHome], sys)
    return false
  } catch {
    return true
  }
}

/** Windows' folders a share under a name of its own, or a folder a walk reaches through a reparse point, must not be:
 * Windows, the program folders, ProgramData, the recycle bin and recovery folders of home's drive, the person's AppData
 * (and Roaming, Local, LocalLow), and the system's own names for these (FolderSystem.systemFolders). */
function guardedFolders(homes: string[], sys: FolderSystem): Set<string> {
  const guarded = new Set<string>()
  for (const h of homes) {
    const drive = win32.parse(h).root
    if (drive) for (const n of ['Windows', 'Windows\\System32', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin', 'System Volume Information', 'Recovery', 'PerfLogs']) guarded.add(win32.join(drive, n))
    for (const n of ['AppData', 'AppData\\Roaming', 'AppData\\Local', 'AppData\\LocalLow']) guarded.add(win32.join(h, n))
  }
  for (const f of sys.systemFolders?.() ?? []) if (f && !isUncPath(f, 'win32')) guarded.add(f)
  return guarded
}

/**
 * The identities a folder of a walk that the file system reached through a reparse point must not have (common/
 * work-files.ts scanRoots guard): home and every folder above it (as written and resolved: the drive's top, C:\Users), and
 * on Windows the guarded system folders (guardedFolders). Rejects when home or a folder above it cannot be told (no
 * home, a home on a network path, a failed or late lookup, an identity of 0): the walk then enters no such folder. A
 * system folder this computer does not have is left out.
 */
export async function guardedIdentities(sys: FolderSystem, platform: string): Promise<FolderIdentity[]> {
  const home = sys.home()
  if (!home || isUncPath(home, platform)) throw new Error('no home')
  const realHome = await sys.realpath(home)
  if (!realHome || isUncPath(realHome, platform)) throw new Error('no home')
  const above = [...new Set([...withParents(home, platform), ...withParents(realHome, platform)])]
  const ids = await Promise.all(above.map((a) => sys.identity(a)))
  if (ids.some((id) => !id || unknownIdentity(id))) throw new Error('home cannot be told')
  if (platform === 'win32') {
    const more = await Promise.all([...guardedFolders([home, realHome], sys)].map((g) => sys.identity(g).catch(() => null)))
    for (const id of more) if (id && !unknownIdentity(id)) ids.push(id)
  }
  return ids
}

/**
 * A share under a name of its own (\\pc\Everyone for C:\Users, \\pc\Roam for AppData, a junction on a share that the
 * server resolves) leads into a folder pickRefused would refuse by its local name: the pick or a folder above it, up to
 * the share's top, has the identity of Windows, a program folder, ProgramData or the person's AppData, or of the folder
 * that holds home (C:\Users) while the folder below it is not the person's own or Public. Only the pick's own server
 * and this computer's folders are asked. A pick or a folder above it that cannot be told counts as leading aside; a
 * system folder this computer does not have is left out. Not caught: a junction on a share made to lead deeper into one
 * of these (AppData\Roaming\Microsoft) or into another person's profile; Windows' own permissions keep other profiles.
 */
async function shareLeadsAside(realPath: string, homes: string[], sys: FolderSystem): Promise<boolean> {
  const chain = withParents(realPath, 'win32')
  const guarded = guardedFolders(homes, sys)
  const users = [...new Set(homes.map((h) => win32.dirname(win32.normalize(h))))]
  const own = new Set([...homes.map((h) => win32.basename(win32.normalize(h)).toLowerCase()), 'public'])
  const maybe = (p: string) => sys.identity(p).catch(() => null)
  const [ids, guardIds, userIds] = await Promise.all([Promise.all(chain.map((c) => sys.identity(c))), Promise.all([...guarded].map(maybe)), Promise.all(users.map(maybe))])
  const same = (a: FolderIdentity | null, b: FolderIdentity) => !!a && !unknownIdentity(a) && a.dev === b.dev && a.ino === b.ino
  for (const [i, id] of ids.entries()) {
    if (!id || unknownIdentity(id)) return true
    if (guardIds.some((g) => same(g, id))) return true
    if (userIds.some((u) => same(u, id))) {
      // the folder holding home itself was refused above; below it only the person's own folder or Public
      const below = i > 0 ? win32.basename(chain[i - 1]!).toLowerCase() : ''
      if (!own.has(below)) return true
    }
  }
  return false
}

/** The folders picked in one team session's window while the app runs, by origin, for the person signed in. */
export class FolderGrants {
  private readonly picked = new Map<string, Set<string>>()
  /** whom the picks belong to (common/browser-owner.ts); null: nobody yet, or signed out */
  private owner: string | null = null
  /** bumped by every change of person: a pick still being checked when the person changes is not remembered */
  private generation = 0
  /** each origin's newest pick on macOS: its folder's name and whether macOS let the app read it (problem) */
  private readonly lastPick = new Map<string, { name: string; problem: Promise<FolderProblem | null> }>()

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
    this.probe(origin, d.filePath)
    return true
  }

  /** macOS: does the app itself get into the picked folder (its first entry only)? Not on Windows or Linux. */
  private probe(origin: string, path: string) {
    if (this.platform !== 'darwin' || !this.sys.readable) {
      this.lastPick.delete(origin)
      return
    }
    const problem = this.sys.readable(path).then(
      () => null,
      (e: unknown): FolderProblem | null => (macBlocked(e, this.platform) ? 'mac-blocked' : null),
    )
    this.lastPick.set(origin, { name: posix.basename(folderKey(path, this.platform)).normalize('NFC'), problem })
  }

  /**
   * The page found nothing to read in the folder it picked last (by the folder's name, as its handle gives it): why,
   * when macOS kept the app out of it ('mac-blocked'); null for anything else (an empty folder, another origin, another
   * folder, not macOS, no answer in FOLDER_PROBLEM_MS).
   */
  async problem(requestingOrigin: string, name: string, allowedOrigins: readonly string[], waitMs = FOLDER_PROBLEM_MS): Promise<FolderProblem | null> {
    const origin = originOf(requestingOrigin)
    if (!origin || !allowedOrigins.includes(origin)) return null
    const last = this.lastPick.get(origin)
    if (!last || !name || last.name !== name.normalize('NFC')) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), waitMs) })
    try {
      return await Promise.race([last.problem, late])
    } finally {
      clearTimeout(timer)
    }
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
      this.lastPick.clear()
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

/**
 * Why a folder restrictedFolderAction refused was refused, for the message the app shows (main/app-window.ts): the
 * page only gets an AbortError, the same as Cancel, so it said nothing and the person did not know why (QA TC-219).
 * 'home': the home folder or a folder that holds it (or one whose place cannot be told: opensHome counts it as home);
 * 'blocked': anything else Chromium blocks (~/Library, system folders). null: no message, the refusal stays silent:
 * not a folder picked by the team page's top frame at an allowed origin (another page never raises the app's dialogs).
 */
export async function refusedFolderReason(d: RestrictedFolder, allowedOrigins: readonly string[], platform: string, sys: FolderSystem): Promise<'home' | 'blocked' | null> {
  const origin = originOf(d.origin)
  if (!d.isTopFrame || !d.isDirectory || !d.path || !origin || !allowedOrigins.includes(origin)) return null
  return (await opensHome(d.path, sys, platform)) ? 'home' : 'blocked'
}
