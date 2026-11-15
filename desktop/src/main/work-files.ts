// "Find work files on this computer" in the app (docs/DECISIONS.md "Find work files on this computer"): the team page's
// bridge calls (main.ts bridge:work-files-*) reach this, one controller per window. scan() shows the app's own dialog
// (dialog.showMessageBox, which no web page draws or answers) and only after the person agrees looks through Documents,
// Desktop and Downloads (common/work-files.ts scanRoots) in this process: macOS's privacy questions then name the app,
// one folder after the other. read() gives one listed file's bytes, by id, from the latest look (WorkFileSessions).
// Not offered in the Mac App Store build (its sandbox reads only what the person picks) nor on Linux.
import { randomBytes } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { app, dialog, shell, type BaseWindow } from 'electron'
import { WORK_FILES_BRIDGE_VERSION, WORK_FILES_WIDE_VERSION, type FullDiskState, type WorkFileRead, type WorkFileScan, type WorkFolderId, type WorkRootId } from '@mycel/shared'
import { t, type UiKey, type UiLocale } from '../common/i18n'
import { opensHome } from '../common/folder-access'
import { inOneDrive, lookRoots, lookWide, WORK_ROOTS, WorkFileSessions, type WorkFs, type WorkRoot, type WorkStat } from '../common/work-files'
import type { IndexedFile } from '../common/work-index'
import type { Place } from '../common/work-places'
import { macHints, windowsFixedDrives, windowsIndex } from './work-index-run'
import { fullDiskState, macDatalessSet, macPlaceIndex, macRecent, MAC_FULL_DISK_SETTINGS, widePlaces } from './work-places-run'
import type { MeResult } from '../common/browser-owner'
import { FOLDER_SYSTEM } from './security'

/** The bridge's workFiles version this app offers, or 0: only the direct-download Mac app and Windows. */
export function workFilesVersion(p: { platform: string; mas?: boolean }): number {
  if (p.platform === 'win32') return WORK_FILES_BRIDGE_VERSION
  if (p.platform === 'darwin' && p.mas !== true) return WORK_FILES_BRIDGE_VERSION
  return 0
}

/** System Settings › Privacy & Security › Files & Folders (macOS 13 and later take the same address). */
export const MAC_FILES_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'

/** After the dialog (yes or no), it is not shown again for this long (a page asking in a loop). */
const COOLDOWN_MS = 3000

const kindOf = (d: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): WorkStat['kind'] =>
  d.isSymbolicLink() ? 'link' : d.isFile() ? 'file' : d.isDirectory() ? 'dir' : 'other'

/** node:fs as the look and the reads see it: lstat and readdir never follow a link; open adds O_NOFOLLOW where the
 * system has it (Windows has none: the read checks the file's identity after opening instead). */
export const NODE_WORK_FS: WorkFs = {
  // opendir, read entry by entry: a folder of millions stops at `max`
  readdir: async (path, max) => {
    const out: { name: string; kind: WorkStat['kind'] }[] = []
    const d = await opendir(path)
    try {
      for (let e = await d.read(); e && out.length < max; e = await d.read()) out.push({ name: e.name, kind: kindOf(e) })
    } finally {
      await d.close().catch(() => {})
    }
    return out
  },
  lstat: async (path) => {
    const s = await lstat(path, { bigint: true })
    return { kind: kindOf(s), size: Number(s.size), mtimeMs: Number(s.mtimeMs), dev: s.dev, ino: s.ino }
  },
  realpath: (path) => realpath(path),
  open: async (path) => {
    const h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    return {
      stat: async () => {
        const s = await h.stat({ bigint: true })
        return { kind: kindOf(s), size: Number(s.size), mtimeMs: Number(s.mtimeMs), dev: s.dev, ino: s.ino }
      },
      read: async (size) => {
        const buf = new Uint8Array(size)
        let at = 0
        while (at < size) {
          const { bytesRead } = await h.read(buf, at, size - at, at)
          if (!bytesRead) break
          at += bytesRead
        }
        return at === size ? buf : buf.subarray(0, at)
      },
      close: () => h.close(),
    }
  },
}

/** A wide look (part 5) ends by this long, whatever is left (the list must come quickly). */
const WIDE_MS = 20_000
/** A place beyond the three folders gets a short walk when the index knows nothing of it. */
const PLACE_LIMITS = { depth: 4, walkFiles: 10_000, rootMs: 4000 } as const

const ROOT_KEY: Record<WorkFolderId, UiKey> = { documents: 'workFiles.documents', desktop: 'workFiles.desktop', downloads: 'workFiles.downloads' }

export class WorkFilesController {
  private readonly sessions = new WorkFileSessions(NODE_WORK_FS, process.platform)
  private busy = false
  private stopped = false
  private quietUntil = 0
  /** bumped by a sign-out, another person or another team: a look still running then gives nothing */
  private generation = 0

  constructor(
    private readonly o: {
      win: () => BaseWindow | null
      locale: () => UiLocale
      /** the page's progress event (bridge:work-files-progress) */
      progress: (p: { root: WorkRootId; place?: string; checked: number; docs: number; done: number }) => void
    },
  ) {}

  /** The three folders, in the order looked at. A folder app.getPath cannot tell is left out. */
  roots(): WorkRoot[] {
    return WORK_ROOTS.flatMap((id) => {
      try {
        const path = app.getPath(id)
        return path ? [{ id, path, oneDrive: inOneDrive(path, process.platform) }] : []
      } catch {
        return []
      }
    })
  }

  /** The page asked to look: the app's own dialog first; the look only after the person's yes there. */
  async scan(origin: string, ask: { wide?: boolean; words?: string[] } = {}): Promise<WorkFileScan> {
    const win = this.o.win()
    if (!win || win.isDestroyed() || !workFilesVersion({ platform: process.platform, mas: process.mas })) return { state: 'unavailable' }
    if (this.busy || Date.now() < this.quietUntil) return { state: 'busy' }
    this.busy = true
    this.stopped = false
    const generation = this.generation
    try {
      const roots = this.roots()
      // the wide look (part 5) only where the app sees the places without a question per folder: Windows, and a Mac with
      // Full Disk Access (checked here, never taken from the page)
      const wide = !!ask.wide && (process.platform === 'win32' || (process.platform === 'darwin' && (await this.fullDisk()) === 'granted'))
      const places = wide ? await widePlaces(app.getPath('home'), ask.words ?? []).catch(() => [] as Place[]) : []
      const yes = await this.consent(win, roots, wide ? places : null)
      this.quietUntil = Date.now() + COOLDOWN_MS
      if (!yes) return { state: 'cancelled' }
      // a stop sent while the dialog was up (the page's dialog closed and opened again, React's double start in
      // development) is for no look: the look starts now
      this.stopped = false
      if (generation !== this.generation) return { state: 'cancelled' }
      const r = wide ? await this.lookWide(roots, places, generation) : await this.look(roots, generation)
      if (generation !== this.generation) return { state: 'cancelled' }
      this.sessions.begin(origin, r.found)
      return { state: 'done', stopped: r.stopped, roots: r.roots, files: r.files }
    } finally {
      this.busy = false
    }
  }

  /** The roots looked at: the index first (one Windows Search run for all of them; Spotlight per folder, after its
   * question), the walk when there is none (common/work-files.ts lookRoots). */
  private look(roots: WorkRoot[], generation: number) {
    let win: Promise<IndexedFile[] | null> | null = null
    const downloads = roots.find((r) => r.id === 'downloads')?.path ?? null
    return lookRoots(roots, NODE_WORK_FS, {
      platform: process.platform,
      stopped: () => this.stopped || generation !== this.generation,
      onProgress: (p) => { if (generation === this.generation) this.o.progress(p) },
      // never the home folder or one that holds it (Documents moved to C:\Users\alex, a Desktop linked to home)
      allowed: async (root) => !(await opensHome(root.path, FOLDER_SYSTEM, process.platform)),
      // Windows: Windows Search with the recent lists; a Mac walks (faster than listing through Spotlight) and asks
      // Spotlight about the newest documents
      index: async () => (process.platform === 'win32' ? (win ??= windowsIndex(roots.map((r) => r.path), downloads)) : null),
      ...(process.platform === 'darwin' ? { enrich: (paths: string[], until: { deadline: number; stopped: () => boolean }) => macHints(paths, until) } : {}),
      newId: () => randomBytes(12).toString('base64url'),
    })
  }

  /** The wide look (part 5): the places first (a messenger's folder inside Downloads gets its name), then the three
   * folders, then the files opened lately anywhere in the home folder (and, on Windows, other drives and shares). */
  private async lookWide(folders: WorkRoot[], places: Place[], generation: number) {
    const home = app.getPath('home')
    const deadline = Date.now() + WIDE_MS
    const roots: WorkRoot[] = [...places.map((x) => ({ id: x.kind, path: x.path, oneDrive: false, place: x.label })), ...folders]
    const stopped = () => this.stopped || generation !== this.generation
    const common = {
      platform: process.platform,
      home,
      deadline,
      stopped,
      onProgress: (p: { root: WorkRootId; place?: string; checked: number; docs: number; done: number }) => { if (generation === this.generation) this.o.progress(p) },
      allowed: async (root: WorkRoot) => !(await opensHome(root.path, FOLDER_SYSTEM, process.platform)),
      rootLimits: (root: WorkRoot) => (root.place !== undefined ? PLACE_LIMITS : {}),
      newId: () => randomBytes(12).toString('base64url'),
    }
    if (process.platform === 'win32') {
      const outside = places.filter((x) => !x.path.toLowerCase().startsWith(home.toLowerCase().replace(/\\?$/, '\\'))).map((x) => x.path)
      const all = windowsIndex([home, ...outside], folders.find((r) => r.id === 'downloads')?.path ?? null, { home, drives: true })
      const fixed = windowsFixedDrives()
      const fixedNow = await fixed
      return lookWide(roots, NODE_WORK_FS, {
        ...common,
        index: async () => all,
        recent: async () => (await all) ?? [],
        network: (path) => path.startsWith('\\\\') || !fixedNow.some((d) => path.toLowerCase().startsWith(d.toLowerCase())),
      })
    }
    // a Mac with Full Disk Access: Spotlight for each place at once (no question per folder now), the walk for the three
    const pre = new Map(places.map((x) => [x.path, macPlaceIndex({ path: x.path, id: x.kind }, deadline)]))
    return lookWide(roots, NODE_WORK_FS, {
      ...common,
      index: async (_real, root) => (root.place !== undefined ? (pre.get(root.path) ?? null) : null),
      enrich: (paths: string[], until: { deadline: number; stopped: () => boolean }) => macHints(paths, until),
      placeholders: (paths, root) => (root.id === 'cloud' ? macDatalessSet(paths) : Promise.resolve(new Set<string>())),
      recent: () => macRecent(home, deadline),
    })
  }

  /** A Mac's Full Disk Access for the app (part 5): the probe, the Settings pane, a restart. */
  fullDisk(): Promise<FullDiskState> {
    return process.platform === 'darwin' && workFilesVersion({ platform: process.platform, mas: process.mas }) ? fullDiskState(app.getPath('home')) : Promise.resolve('unknown')
  }

  openFullDiskSettings() {
    if (process.platform === 'darwin') void shell.openExternal(MAC_FULL_DISK_SETTINGS)
  }

  /** "Reopen Trina": macOS gives Full Disk Access to an app that was running when it was turned on only after a restart. */
  relaunch() {
    if (process.platform !== 'darwin' || this.busy) return
    app.relaunch()
    app.quit()
  }

  /** "Choose it yourself": macOS kept the app out of a folder. The system's folder window opens at it; the person's pick
   * there is their permission. Only that folder or one inside it (never home or above); its files join the latest look. */
  async pickRoot(origin: string, id: WorkFolderId): Promise<WorkFileScan> {
    const win = this.o.win()
    const root = this.roots().find((r) => r.id === id)
    if (!win || win.isDestroyed() || !root || !workFilesVersion({ platform: process.platform, mas: process.mas })) return { state: 'unavailable' }
    if (this.busy) return { state: 'busy' }
    this.busy = true
    this.stopped = false
    const generation = this.generation
    try {
      const L = this.o.locale()
      const r = await dialog.showOpenDialog(win, { defaultPath: root.path, properties: ['openDirectory'], message: t(L, 'workFiles.pickMessage', { folder: t(L, ROOT_KEY[root.id as WorkFolderId]) }), buttonLabel: t(L, 'workFiles.pickButton') })
      const picked = r.canceled ? null : r.filePaths[0]
      if (!picked || generation !== this.generation || !this.sessions.has(origin)) return { state: 'cancelled' }
      // the folder as it really is (a link in the pick would lead elsewhere): inside the root's real path, never home
      const lib = process.platform === 'win32' ? win32 : posix
      const reals = await Promise.all([realpath(picked), realpath(root.path)]).catch(() => null)
      if (!reals) return { state: 'cancelled' }
      const [realPicked, realRoot] = reals
      const fold = (x: string) => (process.platform === 'win32' || process.platform === 'darwin' ? lib.normalize(x).toLowerCase() : lib.normalize(x))
      const rel = lib.relative(fold(realRoot), fold(realPicked))
      if (rel.startsWith('..') || lib.isAbsolute(rel) || (await opensHome(realPicked, FOLDER_SYSTEM, process.platform))) return { state: 'cancelled' }
      const res = await this.look([{ ...root, path: realPicked }], generation)
      if (generation !== this.generation || !this.sessions.extend(origin, res.found)) return { state: 'cancelled' }
      // the files are named from the folder the person picked (under its root's name)
      const prefix = rel ? lib.relative(realRoot, realPicked).split(lib.sep).join('/') : ''
      return { state: 'done', stopped: res.stopped, roots: res.roots, files: res.files.map((f) => ({ ...f, folder: [prefix, f.folder].filter(Boolean).join('/') })) }
    } finally {
      this.busy = false
    }
  }

  /** The app's own question (no web page draws it). Cancel is the default: Enter, Escape and closing it answer no, so a
   * page that asks while the person types gets no yes from their next Enter (as the allow-all dialog). */
  private async consent(win: BaseWindow, roots: WorkRoot[], places: Place[] | null): Promise<boolean> {
    const L = this.o.locale()
    const folder = (r: WorkRoot) => { const k = ROOT_KEY[r.id as WorkFolderId]; return r.oneDrive ? t(L, 'workFiles.oneDrive', { folder: t(L, k) }) : t(L, k) }
    // a wide look lists every place by name, and the recent files anywhere in the home folder last
    const names = places
      ? [...roots.map(folder), ...places.map((x) => (x.kind === 'messenger' ? t(L, 'workFiles.messenger', { name: x.label }) : x.label)), t(L, process.platform === 'win32' ? 'workFiles.recentWin' : 'workFiles.recentMac')]
      : roots.map(folder)
    const detail = places ? (process.platform === 'darwin' ? 'workFiles.detailWideMac' : 'workFiles.detailWide') : process.platform === 'darwin' ? 'workFiles.detailMac' : 'workFiles.detail'
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      message: t(L, 'workFiles.title'),
      detail: `${names.map((n) => `· ${n}`).join('\n')}\n\n${t(L, detail)}`,
      buttons: [t(L, places ? 'workFiles.lookWide' : 'workFiles.look'), t(L, 'workFiles.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return r.response === 0 && !win.isDestroyed()
  }

  stop() {
    if (this.busy) this.stopped = true
  }

  read(origin: string, id: string): Promise<WorkFileRead> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return Promise.resolve({ ok: false, reason: 'unknown' })
    return this.sessions.read(origin, id)
  }

  /** macOS only: the Files & Folders settings (a fixed address; the page names nothing). */
  openSettings() {
    if (process.platform === 'darwin') void shell.openExternal(MAC_FILES_SETTINGS)
  }

  /** Who is signed in to the team page now: a sign-out or another person forgets the look (and stops one running). */
  person(me: MeResult) {
    if (this.sessions.person(me)) this.forget()
  }

  /** Another team, the team page gone: nothing of the look stays readable, one running gives nothing. */
  forget() {
    this.generation++
    this.stopped = true
    this.sessions.forget()
  }
}
