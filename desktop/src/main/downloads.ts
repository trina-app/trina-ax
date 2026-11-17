// The team page's downloads go straight into the computer's Downloads folder, with no save window (QA TC-4638,
// docs/decisions/20261117-desktop-direct-downloads.md): Download on a room's file, a chat's attachment, a file in Files,
// a preview, an export the page made itself (a blob), and 이미지 저장 in the right-click menu. All of them reach the
// team's app session as one `will-download`. The name is cleaned and never replaces a file (common/downloads.ts).
// When a download ends the page is told (bridge:download) and shows its own notice; "Show in folder" comes back as
// the download's number only: the page never names a path, and only a file this app saved is shown.
//
// The save window stays, as before, when: the page has not said it shows the notice (a team server from before this:
// a file would land with no word), the Mac App Store build (it may not write to Downloads without the window), or the
// folder cannot be used.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { shell, type Session, type WebContents } from 'electron'
import { downloadOutcome, pickDownloadPath } from '../common/downloads'
import { debug } from './debug'

/** What the page hears when a download ends (DesktopBridge.downloads.onDone). */
export interface DownloadDone { id: number; name: string; ok: boolean }

/** How many finished downloads "Show in folder" still knows. */
const REMEMBERED = 50

export class DirectDownloads {
  /** paths downloads are on their way to (lower case: the Mac's and Windows' folders do not tell case apart) */
  private inFlight = new Set<string>()
  private saved = new Map<number, string>()
  private ready = new WeakSet<WebContents>()
  private watched = new WeakSet<WebContents>()
  private next = 1

  /** `dir`: the Downloads folder, or null where the save window stays (the Mac App Store build). */
  constructor(private o: { dir: () => string | null }) {}

  /** The page shows the notice (it listens to bridge:download); until its next page load. */
  pageReady(wc: WebContents) {
    this.ready.add(wc)
    if (this.watched.has(wc)) return
    this.watched.add(wc)
    wc.on('did-navigate', () => this.ready.delete(wc))
  }

  /** Once for each team session. */
  attach(ses: Session) {
    ses.on('will-download', (_e, item, wc) => {
      let dir: string | null = null
      try {
        dir = this.o.dir()
      } catch {
        dir = null
      }
      if (!dir || !wc || wc.isDestroyed() || !this.ready.has(wc)) return
      let path: string | null = null
      try {
        mkdirSync(dir, { recursive: true })
        path = pickDownloadPath(dir, item.getFilename(), (p) => this.inFlight.has(p.toLowerCase()) || existsSync(p))
      } catch (err) {
        debug('downloads folder', err)
      }
      if (!path) return
      const key = path.toLowerCase()
      const picked = path
      this.inFlight.add(key)
      item.setSavePath(picked)
      const id = this.next++
      item.once('done', (_done, state) => {
        this.inFlight.delete(key)
        const outcome = downloadOutcome(state)
        const at = item.getSavePath() || picked
        // a part of a file that did not arrive is not left behind (the path was free when it was picked)
        if (outcome !== 'saved') {
          try {
            rmSync(picked, { force: true })
          } catch {
            // nothing was written, or it is gone already
          }
        }
        if (!outcome) return
        if (outcome === 'saved') {
          this.saved.set(id, at)
          for (const old of this.saved.keys()) {
            if (this.saved.size <= REMEMBERED) break
            this.saved.delete(old)
          }
        }
        if (!wc.isDestroyed()) wc.send('bridge:download', { id, name: basename(at), ok: outcome === 'saved' } satisfies DownloadDone)
      })
    })
  }

  /** "Show in folder" on the page's notice: the file in its folder, or the Downloads folder when it was moved since. */
  show(id: number) {
    const path = this.saved.get(id)
    if (!path) return
    if (existsSync(path)) shell.showItemInFolder(path)
    else {
      try {
        const dir = this.o.dir()
        if (dir) void shell.openPath(dir)
      } catch {
        // no folder to open
      }
    }
  }
}
