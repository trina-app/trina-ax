// The app's own "Find work files on this computer" window (docs/DECISIONS.md "Find work files: the app's own consent
// window"). A small modal window over the app window (a sheet on macOS) that loads src/ui/consent.html from the app's
// own mycel-ui:// scheme (files of the app bundle, never the team server) with preload/consent.ts. The words come
// finished from common/work-consent.ts; the window only gives back yes or no, and only this process decides whether a
// yes counts (ConsentGate: once, and not before the window has been seen without typing). The team page asks through
// bridge:work-files-scan and gets only the scan's result: it can neither read the window nor answer it (the two
// channels below answer only a window this file opened, at its own address, in its top frame).
import { BrowserWindow, ipcMain, type BaseWindow, type IpcMainEvent, type WebContents } from 'electron'
import { PRODUCT } from '@mycel/shared/product'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CONSENT_URL, ConsentGate, consentSender, parseMemory, type ConsentMemory, type ConsentView } from '../common/work-consent'
import { APP_WEB_PREFERENCES, guardUiView } from './security'

// wide enough that each promise line stays on one line in Korean (at 440 they broke as "내용은 열지 / 않아요"); the app
// window is at least 900 wide, so it always fits
const WIDTH = 640

interface Open {
  view: ConsentView
  gate: ConsentGate
  done: (yes: boolean) => void
}
/** the consent windows open now, by their page (at most one: WorkFilesController asks one at a time) */
const open = new Map<WebContents, Open>()


let wired = false
function wire() {
  if (wired) return
  wired = true
  ipcMain.on('consent:view', (e: IpcMainEvent) => {
    e.returnValue = consentSender(e, open) ? open.get(e.sender)!.view : null
  })
  ipcMain.on('consent:answer', (e: IpcMainEvent, yes: unknown) => {
    if (!consentSender(e, open)) return
    const o = open.get(e.sender)!
    const r = o.gate.answer(yes === true)
    if (r !== null) o.done(r)
  })
}

export interface ConsentAsk {
  /** true only after the person's yes in the window */
  result: Promise<boolean>
  /** close it as a no (another person, another team, the team page gone) */
  close(): void
}

/** Open the window over `parent` and wait for the person. Closing it in any way is a no. */
export function askConsent(o: { parent: BaseWindow; preload: string; view: ConsentView }): ConsentAsk {
  wire()
  const mac = process.platform === 'darwin'
  const w = new BrowserWindow({
    parent: o.parent,
    modal: true,
    show: false,
    width: WIDTH,
    height: 480,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // a sheet on macOS (no title bar); on Windows a small window with the app's name in its title bar (the page has the
    // question as its heading)
    title: PRODUCT.displayName,
    webPreferences: { preload: o.preload, ...APP_WEB_PREFERENCES, partition: 'mycel-ui' },
  })
  w.setMenu?.(null)
  const wc = w.webContents
  guardUiView(wc)
  const gate = new ConsentGate()
  let resolve!: (yes: boolean) => void
  const result = new Promise<boolean>((r) => (resolve = r))
  let settled = false
  const done = (yes: boolean) => {
    if (settled) return
    settled = true
    open.delete(wc)
    resolve(yes)
    if (!w.isDestroyed()) w.close()
  }
  open.set(wc, { view: o.view, gate, done })
  // a key typed into the window (not Tab, Enter, Escape, the arrows) holds a yes back a little (ConsentGate)
  // Escape is a no here, whatever the page does
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape') {
      e.preventDefault()
      done(false)
      return
    }
    gate.key(input.key, input.isAutoRepeat)
  })
  wc.on('render-process-gone', () => done(false))
  w.on('closed', () => {
    gate.close()
    done(false)
  })
  wc.once('did-finish-load', async () => {
    // as high as the words need (long languages, many places), never higher than the app window
    const h = await wc.executeJavaScript('[...document.getElementById("root").children].reduce((a, c) => a + c.scrollHeight, 0)').catch(() => 480)
    if (w.isDestroyed()) return
    const room = o.parent.isDestroyed() ? 720 : o.parent.getContentBounds().height - 40
    w.setContentSize(WIDTH, Math.round(Math.max(260, Math.min(Number(h) || 480, room, 760))))
    if (!mac) w.center()
    w.show()
    w.focus()
    gate.shown()
  })
  wc.once('did-fail-load', () => done(false))
  void wc.loadURL(CONSENT_URL).catch(() => done(false))
  return { result, close: () => done(false) }
}

/** The yeses remembered per team and person (common/work-consent.ts covered), in a small file in the app's data. A
 * missing or broken file remembers nothing (the window comes again). */
export function consentMemoryFile(path: string): { load(): ConsentMemory; save(m: ConsentMemory): void } {
  return {
    load: () => {
      try {
        return parseMemory(JSON.parse(readFileSync(path, 'utf8')), Date.now())
      } catch {
        return {}
      }
    },
    save: (m) => {
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(parseMemory(m, Date.now())), { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}
