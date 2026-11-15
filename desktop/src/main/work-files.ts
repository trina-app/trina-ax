// "Find work files on this computer" in the app (docs/DECISIONS.md "Find work files on this computer"): the team page's
// bridge calls (main.ts bridge:work-files-*) reach this, one controller per window. scan() shows the app's own consent
// window (main/work-consent-window.ts, which no web page draws or answers) and only after the person agrees looks through Documents,
// Desktop and Downloads (common/work-files.ts scanRoots) in this process: macOS's privacy questions then name the app,
// one folder after the other. read() gives one listed file's bytes, by id, from the latest look (WorkFileSessions).
// Not offered in the Mac App Store build (its sandbox reads only what the person picks) nor on Linux.
import { randomBytes } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { app, dialog, shell, type BaseWindow } from 'electron'
import { consentView, covered, memoryKey, PERSON_INPUT_MS, placeKeys, type ConsentMemory, type ConsentView } from '../common/work-consent'
import type { ConsentAsk } from './work-consent-window'
import { WORK_FILES_BRIDGE_VERSION, WORK_FILES_WIDE_VERSION, type FullDiskState, type WorkFileAdd, type WorkFileRead, type WorkFileScan, type WorkFolderId, type WorkRootId } from '@mycel/shared'
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
/** The reading strip goes when no added file has been read for this long */
const READING_IDLE_MS = 15_000

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
      /** the app's own consent window (main/work-consent-window.ts askConsent); a test gives its own */
      consent: (win: BaseWindow, view: ConsentView) => ConsentAsk
      /** when the person last pressed a key or the mouse on the team page (Electron's input events; 0: never) */
      lastInput: () => number
      /** the yeses remembered per team and person (a file in the app's data) */
      memory: { load(): ConsentMemory; save(m: ConsentMemory): void }
      /** the strip above the team page: files added and being read (0: none, the strip goes) */
      reading: (n: number) => void
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
    // the person's own press just before the page asked (taken now: Full Disk Access and the places take a moment)
    const pressed = Date.now() - this.o.lastInput() <= PERSON_INPUT_MS
    this.busy = true
    this.stopped = false
    const generation = this.generation
    try {
      const roots = this.roots()
      // the wide look (part 5) only where the app sees the places without a question per folder: Windows, and a Mac with
      // Full Disk Access (checked here, never taken from the page)
      const wide = !!ask.wide && (process.platform === 'win32' || (process.platform === 'darwin' && (await this.fullDisk()) === 'granted'))
      const places = wide ? await widePlaces(app.getPath('home'), ask.words ?? []).catch(() => [] as Place[]) : []
      // asked once (owner, 2026-11-15): a yes for this team and person that already covered every place of this look,
      // within 90 days, and the person's own press on the page just now, go straight to the look; else the window
      const keys = placeKeys(roots, wide ? places : null)
      const key = this.personId ? memoryKey(origin, this.personId) : null
      const memory = key ? this.o.memory.load() : {}
      const remembered = !!key && covered(memory[key], keys, Date.now()) && pressed
      const yes = remembered || (await this.consent(win, roots, wide ? places : null))
      // remembered only after a yes in the window ("Not now" keeps nothing), for the person signed in when it was asked
      if (yes && !remembered && key && generation === this.generation) {
        try {
          this.o.memory.save({ ...this.o.memory.load(), [key]: { at: Date.now(), places: keys } })
        } catch {
          /* read-only app data: asked again next time */
        }
      }
      this.quietUntil = Date.now() + COOLDOWN_MS
      if (!yes) return { state: 'cancelled' }
      // a stop sent while the dialog was up (the page's dialog closed and opened again, React's double start in
      // development) is for no look: the look starts now
      this.stopped = false
      if (generation !== this.generation) return { state: 'cancelled' }
      const r = wide ? await this.lookWide(roots, places, generation) : await this.look(roots, generation)
      if (generation !== this.generation) return { state: 'cancelled' }
      this.sessions.begin(origin, r.found)
      this.pending.clear()
      this.tellReading()
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
    // messengers' and work folders first (a messenger's folder inside Downloads keeps its name). Windows: then the three
    // folders, then the cloud drives (a Documents moved into OneDrive stays "Documents (OneDrive)"). A Mac: the cloud
    // drives before the three folders, whose walks could otherwise use up the look's time (their Spotlight rows are
    // asked for at the start anyway)
    const place = (x: Place): WorkRoot => ({ id: x.kind, path: x.path, oneDrive: false, place: x.label })
    const cloud = places.filter((x) => x.kind === 'cloud').map(place)
    const others = places.filter((x) => x.kind !== 'cloud').map(place)
    const roots: WorkRoot[] = process.platform === 'win32' ? [...others, ...folders, ...cloud] : [...others, ...cloud, ...folders]
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
        // a cloud drive's folder is never walked on Windows (a walk would touch online-only files): the index only
        noWalk: (root) => root.id === 'cloud' || root.oneDrive,
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
      // every root (iCloud's Desktop & Documents with Optimize Storage keeps folders in the cloud too); outside a cloud
      // drive only folders are asked about (scanRoots)
      placeholders: (paths) => macDatalessSet(paths),
      recent: () => macRecent(home, deadline),
    })
  }

  /** A Mac's Full Disk Access for the app (part 5): the probe, the Settings pane, a restart. */
  fullDisk(): Promise<FullDiskState> {
    return process.platform === 'darwin' && workFilesVersion({ platform: process.platform, mas: process.mas }) ? fullDiskState(app.getPath('home')) : Promise.resolve('unknown')
  }

  openFullDiskSettings() {
    if (process.platform !== 'darwin') return
    this.fullDiskSettingsAt = Date.now()
    void shell.openExternal(MAC_FULL_DISK_SETTINGS)
  }
  private fullDiskSettingsAt = 0

  /** "Reopen Trina": macOS gives Full Disk Access to an app that was running when it was turned on only after a restart.
   * Only within 15 minutes of Open Settings, while the app still has no access, and never during a look (a page cannot
   * restart the app at will). */
  async relaunch() {
    if (process.platform !== 'darwin' || this.busy || !this.fullDiskSettingsAt || Date.now() - this.fullDiskSettingsAt > 15 * 60_000) return
    if ((await this.fullDisk()) === 'granted') return
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

  /** The app's own question: its own window (main/work-consent-window.ts; no web page draws or answers it), listing the
   * same roots and places the look then goes through. Closing it, Escape and Not now answer no; a yes counts only once
   * the window has been seen without typing (ConsentGate), so a page that asks while the person types gets no yes from
   * their next Enter. */
  private async consent(win: BaseWindow, roots: WorkRoot[], places: Place[] | null): Promise<boolean> {
    const ask = this.o.consent(win, consentView(this.o.locale(), process.platform, roots, places))
    this.asking = ask
    try {
      return (await ask.result) === true && !win.isDestroyed()
    } finally {
      if (this.asking === ask) this.asking = null
    }
  }
  /** the consent window open now (forget() closes it as a no) */
  private asking: ConsentAsk | null = null

  /** Add (TC-3300): the page names the files the person ticked, by id, right as they press Add. No window (owner,
   * 2026-11-15): the add counts only within 2 s of the person's own key or mouse press on the team page (Electron's
   * input events, which no page script can make), only for ids of this origin's latest look, each once, within the read
   * limits. Only files added this way are read (WorkFileSessions.read refuses every other id). This proves a person is
   * there, not which files they chose: docs/DECISIONS.md "Find work files: asked once, reads only what is added". */
  add(origin: string, ids: string[]): WorkFileAdd {
    if (!workFilesVersion({ platform: process.platform, mas: process.mas })) return { state: 'unavailable' }
    if (Date.now() - this.o.lastInput() > PERSON_INPUT_MS) return { state: 'refused' }
    if (!this.sessions.toAdd(origin, ids) || !this.sessions.allow(origin, ids)) return { state: 'refused' }
    for (const id of ids) this.pending.add(id)
    this.tellReading(true)
    return { state: 'added' }
  }

  /** The strip "Trina is reading N files from this computer": files added and not read yet, and every read of an added
   * file while it runs (a read late or again shows it again; it never stays hidden while one runs). It hides itself
   * after a while with no read; a new look or another person clears what is waiting. */
  private pending = new Set<string>()
  private inFlight = 0
  private stripOn = false
  private readingIdle?: NodeJS.Timeout
  private tellReading(active = false) {
    if (active) this.stripOn = true
    clearTimeout(this.readingIdle)
    if (!this.pending.size && !this.inFlight) this.stripOn = false
    if (this.stripOn && !this.inFlight) this.readingIdle = setTimeout(() => { this.stripOn = false; this.tellReading() }, READING_IDLE_MS)
    this.o.reading(this.inFlight || this.stripOn ? Math.max(this.pending.size, this.inFlight, 1) : 0)
  }

  stop() {
    if (this.busy) this.stopped = true
  }

  async read(origin: string, id: string): Promise<WorkFileRead> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, reason: 'unknown' }
    // only an added file is ever read (WorkFileSessions); each such read shows the strip while it runs
    if (!this.sessions.isAdded(origin, id)) return this.sessions.read(origin, id)
    this.inFlight++
    this.tellReading(true)
    try {
      return await this.sessions.read(origin, id)
    } finally {
      this.inFlight--
      this.pending.delete(id)
      this.tellReading(true)
    }
  }

  /** macOS only: the Files & Folders settings (a fixed address; the page names nothing). */
  openSettings() {
    if (process.platform === 'darwin') void shell.openExternal(MAC_FILES_SETTINGS)
  }

  /** Who is signed in to the team page now: a sign-out or another person forgets the look (and stops one running). */
  person(me: MeResult) {
    this.personId = me.signedIn ? me.userId : null
    if (this.sessions.person(me)) this.forget()
  }
  /** who is signed in to the team page (the remembered yes is theirs) */
  private personId: string | null = null

  /** Another team, the team page gone: nothing of the look stays readable, one running gives nothing. */
  forget() {
    this.asking?.close()
    this.pending.clear()
    this.tellReading()
    this.generation++
    this.stopped = true
    this.sessions.forget()
  }
}
