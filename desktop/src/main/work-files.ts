// "Find work files on this computer" in the app (docs/DECISIONS.md "Find work files on this computer"): the team page's
// bridge calls (main.ts bridge:work-files-*) reach this, one controller per window. scan() shows the app's own dialog
// (dialog.showMessageBox, which no web page draws or answers) and only after the person agrees looks through Documents,
// Desktop and Downloads (common/work-files.ts scanRoots) in this process: macOS's privacy questions then name the app,
// one folder after the other. read() gives one listed file's bytes, by id, from the latest look (WorkFileSessions).
// Not offered in the Mac App Store build (its sandbox reads only what the person picks) nor on Linux.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { app, dialog, shell, type BaseWindow } from 'electron'
import { WORK_FILES_BRIDGE_VERSION, type WorkFileRead, type WorkFileScan, type WorkRootId } from '@mycel/shared'
import { t, type UiKey, type UiLocale } from '../common/i18n'
import { opensHome } from '../common/folder-access'
import { inOneDrive, scanRoots, WORK_ROOTS, WorkFileSessions, type WorkFs, type WorkRoot, type WorkStat } from '../common/work-files'
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

const ROOT_KEY: Record<WorkRootId, UiKey> = { documents: 'workFiles.documents', desktop: 'workFiles.desktop', downloads: 'workFiles.downloads' }

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
      progress: (p: { root: WorkRootId; checked: number; docs: number }) => void
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
  async scan(origin: string): Promise<WorkFileScan> {
    const win = this.o.win()
    if (!win || win.isDestroyed() || !workFilesVersion({ platform: process.platform, mas: process.mas })) return { state: 'unavailable' }
    if (this.busy || Date.now() < this.quietUntil) return { state: 'busy' }
    this.busy = true
    this.stopped = false
    const generation = this.generation
    try {
      const roots = this.roots()
      const yes = await this.consent(win, roots)
      this.quietUntil = Date.now() + COOLDOWN_MS
      if (!yes) return { state: 'cancelled' }
      // a stop sent while the dialog was up (the page's dialog closed and opened again, React's double start in
      // development) is for no look: the look starts now
      this.stopped = false
      if (generation !== this.generation) return { state: 'cancelled' }
      const r = await scanRoots(roots, NODE_WORK_FS, {
        platform: process.platform,
        stopped: () => this.stopped || generation !== this.generation,
        onProgress: (p) => { if (generation === this.generation) this.o.progress(p) },
        // never the home folder or one that holds it (Documents moved to C:\Users\alex, a Desktop linked to home)
        allowed: async (root) => !(await opensHome(root.path, FOLDER_SYSTEM, process.platform)),
        newId: () => randomBytes(12).toString('base64url'),
      })
      if (generation !== this.generation) return { state: 'cancelled' }
      this.sessions.begin(origin, r.found)
      return { state: 'done', stopped: r.stopped, roots: r.roots, files: r.files }
    } finally {
      this.busy = false
    }
  }

  /** The app's own question (no web page draws it). Cancel is the default: Enter, Escape and closing it answer no, so a
   * page that asks while the person types gets no yes from their next Enter (as the allow-all dialog). */
  private async consent(win: BaseWindow, roots: WorkRoot[]): Promise<boolean> {
    const L = this.o.locale()
    const names = roots.map((r) => (r.oneDrive ? t(L, 'workFiles.oneDrive', { folder: t(L, ROOT_KEY[r.id]) }) : t(L, ROOT_KEY[r.id])))
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      message: t(L, 'workFiles.title'),
      detail: `${names.map((n) => `· ${n}`).join('\n')}\n\n${t(L, process.platform === 'darwin' ? 'workFiles.detailMac' : 'workFiles.detail')}`,
      buttons: [t(L, 'workFiles.look'), t(L, 'workFiles.cancel')],
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
