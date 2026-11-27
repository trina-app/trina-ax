// The team page's downloads go straight into the computer's Downloads folder, with no save window (QA TC-4638,
// docs/decisions/20261117-desktop-direct-downloads.md): Download on a room's file, a chat's attachment, a file in Files,
// a preview, an export the page made itself (a blob), and 이미지 저장 in the right-click menu. All of them reach the
// team's app session as one `will-download`. The name is cleaned and never replaces a file (common/downloads.ts).
// When a download ends the page is told (bridge:download) and shows its own notice; "Show in folder" comes back as
// the download's number only: the page never names a path, and only a file this app saved is shown.
//
// The save window stays, as before, when: the page has not said it shows the notice (a team server from before this:
// a file would land with no word), the Mac App Store build (it may not write to Downloads without the window), the
// folder cannot be used, the file is of a type that runs code (common/downloads.ts runsCode), or the page already saved
// DIRECT_SAVES_MAX files within DIRECT_SAVES_WINDOW_MS. A saved file gets the "downloaded from the internet" mark that
// Electron does not add by itself (the Mac's quarantine, Windows' Zone.Identifier), so the system still asks before it
// opens something risky.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFile } from 'node:fs'
import { basename } from 'node:path'
import { PRODUCT } from '@mycel/shared/product'
import type { Session, WebContents } from 'electron'
import { SaveBurst, downloadOutcome, pickDownloadPath, quarantineValue, runsCode, zoneIdentifierText } from '../common/downloads'
import { debug } from './debug'

// Electron is loaded only where it is used (show), so a test can load this file with no Electron mock
const electron = (): typeof import('electron') => require('electron')

/** What the page hears when a download ends (DesktopBridge.downloads.onDone). */
export interface DownloadDone { id: number; name: string; ok: boolean }

/** How many finished downloads "Show in folder" still knows. */
const REMEMBERED = 50

/**
 * Marks a saved file as downloaded, as a browser does: the Mac's com.apple.quarantine (Gatekeeper asks before it opens
 * an app or script) or Windows' Zone.Identifier (SmartScreen, Office's Protected View). Never throws: a failure is logged.
 */
export function markDownloaded(path: string, o: { url?: string; referrer?: string; platform?: NodeJS.Platform; now?: number } = {}): Promise<void> {
  const platform = o.platform ?? process.platform
  return new Promise((done) => {
    try {
      if (platform === 'darwin') {
        execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue(o.now ?? Date.now(), PRODUCT.displayName), path], (err) => {
          if (err) debug('downloads quarantine', err.message)
          done()
        })
      } else if (platform === 'win32') {
        writeFile(`${path}:Zone.Identifier`, zoneIdentifierText({ url: o.url, referrer: o.referrer }), (err) => {
          if (err) debug('downloads zone', err.message)
          done()
        })
      } else done()
    } catch (err) {
      debug('downloads mark', err)
      done()
    }
  })
}

export class DirectDownloads {
  /** paths downloads are on their way to (lower case: the Mac's and Windows' folders do not tell case apart) */
  private inFlight = new Set<string>()
  private saved = new Map<number, string>()
  private ready = new WeakSet<WebContents>()
  private watched = new WeakSet<WebContents>()
  private bursts = new WeakMap<WebContents, SaveBurst>()
  private next = 1

  /**
   * `dir`: the Downloads folder, or null where the save window stays (the Mac App Store build). `mark` and `mas` stand in
   * for markDownloaded and process.mas in a test.
   */
  constructor(private o: { dir: () => string | null; mark?: typeof markDownloaded; mas?: boolean }) {}

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
      const url = item.getURL()
      const referrer = wc && !wc.isDestroyed() ? wc.getURL() : ''
      /** set below when the app saves it itself (no save window) */
      let direct: { id: number; key: string; picked: string } | null = null
      // every finished download is marked, the ones the person saved through the save window too (a runnable file
      // goes that way); the Mac App Store sandbox marks its own files
      item.once('done', async (_done, state) => {
        if (direct) this.inFlight.delete(direct.key)
        const outcome = downloadOutcome(state)
        const at = item.getSavePath() || direct?.picked || ''
        if (outcome === 'saved' && at && !(this.o.mas ?? process.mas)) await (this.o.mark ?? markDownloaded)(at, { url, referrer })
        if (!direct || !outcome || !wc) return
        const { id } = direct
        if (outcome === 'saved') {
          this.saved.set(id, at)
          for (const old of this.saved.keys()) {
            if (this.saved.size <= REMEMBERED) break
            this.saved.delete(old)
          }
        }
        // the saved name, "(1)" and all: the person has to know which file it is
        if (!wc.isDestroyed()) wc.send('bridge:download', { id, name: basename(at), ok: outcome === 'saved' } satisfies DownloadDone)
      })

      let dir: string | null = null
      try {
        dir = this.o.dir()
      } catch {
        dir = null
      }
      if (!dir || !wc || wc.isDestroyed() || !this.ready.has(wc)) return
      // a file that runs code is never dropped without the person choosing it
      if (runsCode(item.getFilename())) return
      let path: string | null = null
      try {
        mkdirSync(dir, { recursive: true })
        path = pickDownloadPath(dir, item.getFilename(), (p) => this.inFlight.has(p.toLowerCase()) || existsSync(p))
      } catch (err) {
        debug('downloads folder', err)
      }
      if (!path) return
      // many files at once from one page: the save window again (a browser asks before "multiple downloads")
      let burst = this.bursts.get(wc)
      if (!burst) this.bursts.set(wc, (burst = new SaveBurst()))
      if (!burst.take()) return
      const key = path.toLowerCase()
      this.inFlight.add(key)
      item.setSavePath(path)
      direct = { id: this.next++, key, picked: path }
      // an interrupted download that cannot go on frees its name at once (Chromium removes the part that arrived)
      item.on('updated', (_e, state) => {
        if (state === 'interrupted' && !item.canResume()) this.inFlight.delete(key)
      })
    })
  }

  /** "Show in folder" on the page's notice: the file in its folder, or the Downloads folder when it was moved since. */
  show(id: number) {
    const path = this.saved.get(id)
    if (!path) return
    if (existsSync(path)) electron().shell.showItemInFolder(path)
    else {
      try {
        const dir = this.o.dir()
        if (dir) void electron().shell.openPath(dir)
      } catch {
        // no folder to open
      }
    }
  }
}
