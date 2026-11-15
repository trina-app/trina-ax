// "Find work files on this computer": what the app's own consent window shows (main/work-consent-window.ts draws it
// from src/ui/consent.html, a file of the app, never the team server). The main process builds every word here from
// the same roots and places the look then goes through (main/work-files.ts scan), so the list is always what is looked
// at; the window only gets this finished view and gives back yes or no. Pure: unit-tested in
// tests/unit/e-desktop-work-consent.test.ts.
import { t, type UiKey, type UiLocale } from './i18n'
import { isOwnUiUrl, UI_ORIGIN } from './trust'
import type { WorkRoot } from './work-files'
import type { Place } from './work-places'

export type ConsentIcon = 'documents' | 'desktop' | 'downloads' | 'folder' | 'cloud' | 'messenger' | 'recent' | 'file'
export interface ConsentPlace {
  icon: ConsentIcon
  name: string
  /** a second, quieter word after the name: "OneDrive", where the recent files are */
  note?: string
}
export interface ConsentView {
  /** look: before the look (the places); add: the files a VoiceOver or Voice Control user asked to add (addView) */
  kind?: 'look' | 'add'
  locale: UiLocale
  title: string
  sub: string
  placesLabel: string
  places: ConsentPlace[]
  /** under the list: how many more are not shown ("and 12 more files") */
  more?: string
  /** check: what the app promises; ai: what may leave the computer (said as plainly as the promises) */
  promises: { icon: 'check' | 'ai'; text: string }[]
  fine: string
  yes: string
  no: string
}

const FOLDER_KEY: Record<string, UiKey> = { documents: 'workFiles.documents', desktop: 'workFiles.desktop', downloads: 'workFiles.downloads' }

/** The view for a look through `roots` (the three folders) and, for a wide look, `places` and the recent files. */
export function consentView(L: UiLocale, platform: string, roots: WorkRoot[], places: Place[] | null): ConsentView {
  const mac = platform === 'darwin'
  const folders: ConsentPlace[] = roots.flatMap((r) => {
    const key = FOLDER_KEY[r.id]
    if (!key) return []
    return [{ icon: r.oneDrive ? 'cloud' : (r.id as ConsentIcon), name: t(L, key), ...(r.oneDrive ? { note: 'OneDrive' } : {}) }]
  })
  const wide: ConsentPlace[] = places
    ? [
        ...places.map((x): ConsentPlace => (x.kind === 'messenger' ? { icon: 'messenger', name: t(L, 'workFiles.messenger', { name: x.label }) } : { icon: x.kind === 'cloud' ? 'cloud' : 'folder', name: x.label })),
        { icon: 'recent', name: t(L, 'workFiles.recent'), note: t(L, mac ? 'workFiles.recentWhereMac' : 'workFiles.recentWhereWin') },
      ]
    : []
  const fine: UiKey = places ? (mac ? 'workFiles.fineWideMac' : 'workFiles.fineWide') : mac ? 'workFiles.fineMac' : 'workFiles.fine'
  return {
    locale: L,
    title: t(L, 'workFiles.consentTitle'),
    sub: t(L, 'workFiles.consentSub'),
    placesLabel: t(L, 'workFiles.placesLabel'),
    places: [...folders, ...wide],
    promises: [
      { icon: 'check', text: t(L, 'workFiles.promiseNames') },
      { icon: 'check', text: t(L, mac ? 'workFiles.promisePickMac' : 'workFiles.promisePick') },
      { icon: 'ai', text: t(L, 'workFiles.promiseAi') },
    ],
    fine: t(L, fine),
    yes: t(L, 'workFiles.find'),
    no: t(L, 'workFiles.notNow'),
  }
}

/** At most this many names in the Add window; the rest are counted ("and 12 more files"). */
export const ADD_SHOWN = 8

/** The Add window, only for a person using VoiceOver, Voice Control or other assistive technology (their "press" makes
 * no key or mouse event, so WorkFilesController.add asks here instead): the files by the names the look found, before
 * any of them is read. */
export function addView(L: UiLocale, files: readonly { name: string }[]): ConsentView {
  const n = String(files.length)
  const rest = files.length - ADD_SHOWN
  return {
    kind: 'add',
    locale: L,
    title: t(L, 'workFiles.addTitle', { n }),
    sub: t(L, 'workFiles.addSub'),
    placesLabel: t(L, 'workFiles.addTitle', { n }),
    places: files.slice(0, rest > 0 ? ADD_SHOWN : files.length).map((f) => ({ icon: 'file', name: f.name })),
    ...(rest > 0 ? { more: t(L, 'workFiles.addMore', { n: String(rest) }) } : {}),
    promises: [],
    fine: '',
    yes: t(L, 'workFiles.addYes', { n }),
    no: t(L, 'workFiles.addNo'),
  }
}

/** A yes counts only this long after the window is shown and after the last key typed into it (other than Tab, Shift,
 * Enter, Space, Escape, the arrows) or the last yes that came too early (clicking or tapping Enter on and on never arms it): a page that opens the window while the person types gets no yes from their next Enter
 * (they were typing into the team page and did not see it), and a click that was meant for the page under it, no yes
 * either. Escape and Not now are never held back. */
export const CONSENT_ARM_MS = 800
const QUIET_KEYS = new Set(['Tab', 'Shift', 'Enter', 'Return', ' ', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

/** One consent's state in the main process: the answer counts once, a yes only when armed. */
export class ConsentGate {
  private shownAt: number | null = null
  private lastKeyAt = 0
  private answered = false
  constructor(private readonly now: () => number = Date.now) {}
  shown() {
    this.shownAt ??= this.now()
  }
  /** a key pressed in the consent window (Electron's before-input-event; `repeat`: a held key) */
  key(key: string, repeat = false) {
    if (repeat || !QUIET_KEYS.has(key)) this.lastKeyAt = this.now()
  }
  armed(): boolean {
    if (this.shownAt === null) return false
    const now = this.now()
    return now - this.shownAt >= CONSENT_ARM_MS && now - this.lastKeyAt >= CONSENT_ARM_MS
  }
  /** the window's answer: `true` yes, `false` no, `null` too early (the window stays and waits). Only the first counts. */
  answer(yes: unknown): boolean | null {
    if (this.answered) return null
    if (yes !== true) {
      this.answered = true
      return false
    }
    if (!this.armed()) {
      // too early: the wait starts again, so a stream of clicks or Enters never gets through
      if (this.shownAt !== null) this.lastKeyAt = this.now()
      return null
    }
    this.answered = true
    return true
  }
  /** closed, the page gone, another team: no */
  close(): false | null {
    if (this.answered) return null
    this.answered = true
    return false
  }
}

/** The consent page's own address (src/ui/consent.html, served from the app's files by main.ts serveUi). */
export const CONSENT_URL = `${UI_ORIGIN}/consent.html`

/** An IPC message comes from one of the open consent windows (`windows`: their pages), from its top frame at the
 * consent page's own address. The team page, its frames and any other window of the app are refused. */
export function consentSender<W>(e: { sender: W; senderFrame: { url: string; parent: unknown } | null }, windows: { has(w: W): boolean }): boolean {
  return Boolean(windows.has(e.sender) && e.senderFrame && e.senderFrame.parent === null && isOwnUiUrl(e.senderFrame.url) && e.senderFrame.url.split(/[?#]/)[0] === CONSENT_URL)
}

// ------------------------------------------------- asked once (owner, 2026-11-15: "창 좀 그만 띄워")

/** A yes in the consent window is remembered this long for that team and person; then the window comes again. */
export const CONSENT_REMEMBER_MS = 90 * 24 * 60 * 60 * 1000
/** Without the window (a remembered yes), a look and an add count only this soon after the person's own key or mouse
 * press on the team page (Electron's input events, which no page script can make). */
export const PERSON_INPUT_MS = 2000

/** The places a look goes through, as words that stay the same from one look to the next. */
export function placeKeys(roots: readonly WorkRoot[], places: readonly Place[] | null): string[] {
  const keys = roots.map((r) => `folder:${r.id}${r.oneDrive ? ':onedrive' : ''}`)
  if (places) keys.push(...places.map((x) => `${x.kind}:${x.label.normalize('NFC')}`), 'recent')
  return [...new Set(keys)].sort()
}

export interface RememberedYes {
  at: number
  places: string[]
}
/** One remembered yes per team and person ("<origin> <user id>"). */
export type ConsentMemory = Record<string, RememberedYes>
export const memoryKey = (origin: string, person: string) => `${origin} ${person}`

/** The earlier yes covers this look: not older than 90 days, and every place of it was in the window then (a new place,
 * such as Full Disk Access turned on, asks again). */
export function covered(yes: RememberedYes | undefined, keys: readonly string[], now: number): boolean {
  if (!yes || !Number.isFinite(yes.at) || now - yes.at > CONSENT_REMEMBER_MS || now < yes.at || !Array.isArray(yes.places)) return false
  const had = new Set(yes.places)
  return keys.every((k) => had.has(k))
}

/** The memory file as read (anything else: nothing remembered); at most 50 teams, the newest kept. */
export function parseMemory(raw: unknown, now: number): ConsentMemory {
  const out: ConsentMemory = {}
  if (!raw || typeof raw !== 'object') return out
  const rows = Object.entries(raw as Record<string, unknown>)
    .filter((e): e is [string, RememberedYes] => {
      const v = e[1] as RememberedYes
      return typeof e[0] === 'string' && e[0].length < 600 && !!v && typeof v.at === 'number' && Array.isArray(v.places) && v.places.every((p) => typeof p === 'string') && now - v.at <= CONSENT_REMEMBER_MS
    })
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 50)
  for (const [k, v] of rows) out[k] = { at: v.at, places: v.places.slice(0, 200) }
  return out
}
