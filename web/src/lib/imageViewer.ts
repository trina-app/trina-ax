// The image viewer's state (components/ImageViewer.tsx): which picture or file is open, the pictures and files of the
// pane it was opened from, and the history entry that lets Back close it. docs/DECISIONS.md "One image viewer" and "The
// room file viewer".
// A pane (the room's timeline, a thread, the AI chat, a message box's pictures) is an ImageGroup: each picture in it
// registers itself (useViewerItem), and next/previous walks the group's pictures in the order they are on the page,
// which is message order. In a room, DM, group chat or thread the file chips register too (roomFileItem: a document
// drawn by FileBody, or its card), so ← → walks pictures and documents together. Only what is drawn on the page is in
// it: a file someone may not open is drawn as a lock, a hidden answer as a line, so they never are. A picture outside
// any group opens alone.
// Every address is one of the app's own, with its checks (a room file through the room, a team file by its path): no
// new address is made here.
// Phones: the file's thread or Trina side chat is a sheet over the viewer (ImageViewer.tsx), with a history entry of its
// own on top of the viewer's, so Back closes the sheet first, then the viewer, then leaves the page.
import { useSyncExternalStore } from 'react'
import { API, type Attachment, type Me, type RoomFile, type UserRef } from '@mycel/shared/api'
import { api, fileUrl, roomFileUrl, startDownload, thumbnailUrl } from './api'
import { opensWithoutServer, previewKind, previewLimit, roomNoPreview, serverPreview } from './preview'
import { roomPreview, type PreviewFile } from './sidePanel'

/** who sent the picture, for the bar: a person (null: one no longer known) or the AI */
export type ViewerSender = { kind: 'user'; user: UserRef | null } | { kind: 'ai' }

export interface ViewerItem {
  /** the same picture has the same key (focus goes back to it if its element was drawn again) */
  key: string
  name: string
  /** drawn at once while the original loads (a thumbnail, or the picture already on the page) */
  thumb?: string | null
  /** the full picture; null: none the browser can draw or within the preview limit (the thumbnail stays) */
  original: string | null
  /** bytes we have (a picture in a message box, the panel's picture): drawn from these, nothing is fetched */
  blob?: Blob
  /** the original's stored size, to lay it out before it loads */
  width?: number
  height?: number
  /** saves the original through its usual download (absent: a picture not sent yet) */
  download?: () => void
  /** the original for a new tab: plain browsers only (ImageViewer) */
  href?: string | null
  sender?: ViewerSender
  at?: string | null
  /** where it was sent, for the bar ("#마케팅에서"; ViewerMeta in RoomMessages) */
  where?: string | null
  /** 'file': a document on the document stage (components/ViewerDocument.tsx: FileBody, the side panel's body, or the
   * file's card); absent: a picture on the picture stage */
  kind?: 'file'
  /** a document's source, read as the side panel reads it (a room's file through the room) */
  file?: PreviewFile
  /** its size, for the card */
  size?: number
  /** a document with no preview here (lib/preview.ts roomNoPreview): its card at once, nothing read */
  card?: 'unsupported' | 'large'
  /** a file sent in a room and its message: once the message is deleted while it is open (store/rooms.ts
   * roomFileGone), the viewer says it is no longer available. The column beside it (components/rooms/ViewerColumn.tsx)
   * shows the message's thread: `rootId`, its root (a reply's thread root, else the message itself); `threadable`
   * false: a message that cannot have a thread (an AI answer only its asker sees), shown alone */
  room?: RoomPlace
}

/** Where a room's picture or file was sent: the room, the file, and the message with its thread (absent: one not sent
 * yet, in a message box). */
export interface RoomPlace { roomId: string; fileId: string; messageId?: string; rootId?: string; threadable?: boolean }

/** The bar's who, when and where, from the message around a picture or file (ViewerMeta in ImageViewer.tsx), and the
 * message it is in with its thread. */
export interface ViewerMetaValue { sender?: ViewerSender; at?: string | null; where?: string | null; messageId?: string; rootId?: string; threadable?: boolean }

/** The meta's parts that go on an item as they are (the message and its thread go into `room`). */
const shown = ({ messageId: _m, rootId: _r, threadable: _t, ...rest }: ViewerMetaValue) => rest
/** The room's place of a picture or file in a message. */
const placeOf = (roomId: string, fileId: string, meta: ViewerMetaValue): RoomPlace => ({
  roomId,
  fileId,
  ...(meta.messageId ? { messageId: meta.messageId, rootId: meta.rootId ?? meta.messageId, threadable: meta.threadable ?? true } : {}),
})

export interface ViewerEntry {
  item: ViewerItem
  el: HTMLElement | null
}

const IMAGE_MAX = previewLimit('image').max

/** A pane's pictures, in page order when asked. */
export class ViewerGroup {
  private entries = new Set<ViewerEntry>()
  private listeners = new Set<() => void>()
  private queued = false
  /** changes with the pictures (useSyncExternalStore's snapshot) */
  version = 0

  add(e: ViewerEntry): () => void {
    this.entries.add(e)
    this.changed()
    return () => {
      this.entries.delete(e)
      this.changed()
    }
  }

  /** the pictures still on the page, in the order they are drawn */
  list(): ViewerEntry[] {
    return orderEntries([...this.entries])
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** many pictures register at once when a room loads: one notice for them */
  private changed() {
    if (this.queued || !this.listeners.size) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      this.version += 1
      for (const l of this.listeners) l()
    })
  }
}

/** Entries on the page, in document order (an entry without an element, or one taken off the page, is left out). */
export function orderEntries(entries: readonly ViewerEntry[]): ViewerEntry[] {
  return entries
    .filter((e): e is ViewerEntry & { el: HTMLElement } => !!e.el?.isConnected)
    // 4: Node.DOCUMENT_POSITION_FOLLOWING (b comes after a)
    .sort((a, b) => (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1))
}

/** The one shown and the ones before and after it in the pane's list. One gone from the page meanwhile (its message
 * deleted) keeps its place: `before` is the list as it was when it was last on it, and the nearest ones around it there
 * that are still on the page (the same entry, or the same picture or file drawn anew) are the steps. */
export function stepTargets(list: readonly ViewerEntry[], cur: ViewerEntry, before: readonly ViewerEntry[] = []): { index: number; prev: ViewerEntry | null; next: ViewerEntry | null } {
  const i = list.indexOf(cur)
  if (i >= 0) return { index: i, prev: list[i - 1] ?? null, next: list[i + 1] ?? null }
  const byKey = new Map(list.map((e) => [e.item.key, e]))
  const still = (e: ViewerEntry | undefined) => (!e ? null : list.includes(e) ? e : (byKey.get(e.item.key) ?? null))
  const j = before.indexOf(cur)
  let prev: ViewerEntry | null = null
  let next: ViewerEntry | null = null
  for (let k = j - 1; j >= 0 && k >= 0 && !prev; k--) prev = still(before[k])
  for (let k = j + 1; j >= 0 && k < before.length && !next; k++) next = still(before[k])
  return { index: -1, prev, next }
}

/** A finger's swipe on a document (phones): sideways, clearly more than up or down, and quick enough; anything else is
 * the document's own scroll. */
export function documentSwipe(dx: number, dy: number, ms: number): 'next' | 'prev' | null {
  if (Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(dy) || ms > 700) return null
  return dx < 0 ? 'next' : 'prev'
}

/** Where the phone's sheet (the file's thread or Trina) settles when the finger leaves its handle: `height` is where it
 * was let go, `part` its usual height (70 % of the screen), `full` the whole height, `vy` the finger's speed (px/ms,
 * down positive). A flick goes its way (down from above `part` to `part`, from below it closed); a slow drag settles at
 * the nearer height, or closes once it is well below `part`. */
export function sheetSnap(height: number, part: number, full: number, vy: number): 'closed' | 'part' | 'full' {
  if (vy > 0.5) return height > part + 1 ? 'part' : 'closed'
  if (vy < -0.5) return 'full'
  if (height < part * 0.65) return 'closed'
  return height > (part + full) / 2 ? 'full' : 'part'
}

/** A PDF's page thumbnails are 128 px wide (viewers/PdfView `Thumbnails`, w-32). */
export const PDF_RAIL_PX = 128
/** The narrowest document worth a rail beside it: what a 1,024 px window leaves it (the rail's first width, step d). */
export const PDF_RAIL_DOCUMENT_PX = 896
/** The viewer's stage (the space left of the right column) has room for a PDF's thumbnails and a readable document:
 * the rail goes by the stage, not the window, so the column beside it takes the rail away before the document narrows
 * under 896 px. */
export function pdfRailFits(stageWidth: number): boolean {
  return stageWidth >= PDF_RAIL_PX + PDF_RAIL_DOCUMENT_PX
}

// ---------------- the pictures ----------------

/** A photo sent in a room: its thumbnail, then the original through the room (its members, on every read). A picture the
 * panel could not show either (a HEIC photo, one over the preview limit) keeps its thumbnail. */
export function roomItem(roomId: string, f: RoomFile, meta: ViewerMetaValue = {}): ViewerItem {
  const inline = roomFileUrl(roomId, f.id)
  const drawable = opensWithoutServer(f)
  return {
    key: `room:${roomId}:${f.id}`,
    name: f.name,
    thumb: f.thumb ? roomFileUrl(roomId, f.id, { thumb: '1' }) : null,
    original: drawable ? inline : null,
    width: f.width,
    height: f.height,
    download: () => startDownload(roomFileUrl(roomId, f.id, { download: '1' }), f.name),
    href: drawable ? inline : null,
    room: placeOf(roomId, f.id, meta),
    ...shown(meta),
  }
}

/** A file sent in a room, from its chip (a document, a sheet, slides, a Hangul file, text, audio or video, or one with
 * no preview here). A picture the browser draws that has no thumbnail is a picture all the same (roomItem). Any other
 * file is a document: read through the room as the side panel reads it (lib/sidePanel.ts roomPreview) and drawn by
 * FileBody, or its card at once when it has no preview here (`card`: nothing is read). The download is the room's. */
export function roomFileItem(roomId: string, f: RoomFile, me: Pick<Me, 'server'> | null | undefined, meta: ViewerMetaValue = {}): ViewerItem {
  if (previewKind(f.name) === 'image' && opensWithoutServer(f)) return roomItem(roomId, f, meta)
  const card = roomNoPreview(f, me)
  return {
    kind: 'file',
    key: `room:${roomId}:${f.id}`,
    name: f.name,
    original: null,
    file: roomPreview(roomId, f),
    size: f.size,
    ...(card ? { card } : {}),
    download: () => startDownload(roomFileUrl(roomId, f.id, { download: '1' }), f.name),
    room: placeOf(roomId, f.id, meta),
    ...shown(meta),
  }
}

/** A picture attached in the AI chat: its thumbnail, then the team file by its path (a HEIC photo as the server's JPEG). */
export function attachmentItem(a: Attachment, meta: ViewerMetaValue = {}): ViewerItem {
  const heic = serverPreview(a.name)
  const big = a.size > IMAGE_MAX
  return {
    key: `team:${a.path}`,
    name: a.name,
    thumb: thumbnailUrl(a.id),
    original: big ? null : heic ? api.url(API.preview, { query: { path: a.path } }) : fileUrl(a.path, 'inline'),
    width: a.width,
    height: a.height,
    download: () => startDownload(fileUrl(a.path), a.name),
    href: big || heic ? null : fileUrl(a.path, 'inline'),
    ...shown(meta),
  }
}

/** A team picture in an answer: the picture on the page is the original already. */
export function teamImageItem(path: string, name: string, meta: ViewerMetaValue = {}): ViewerItem {
  const inline = fileUrl(path, 'inline')
  return { key: `team:${path}`, name, thumb: inline, original: inline, download: () => startDownload(fileUrl(path), name), href: inline, ...shown(meta) }
}

/** A picture in a message box, not sent yet: drawn from its own bytes; nothing to download or open. */
export function localItem(key: string, file: Blob, name: string): ViewerItem {
  return { key: `local:${key}`, name, original: null, blob: file }
}

// ---------------- open / close ----------------

export interface ViewerOpen {
  group: ViewerGroup | null
  /** the picture shown (kept when its message goes away meanwhile) */
  entry: ViewerEntry
  /** the element that opened it, and its picture's key (found again if it was drawn anew): focus goes back there */
  opener: HTMLElement | null
  openerKey: string
}

let current: ViewerOpen | null = null
/** the phone's sheet over the viewer (the file's thread or Trina) is open */
let sheet = false
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const getImageViewer = () => current

export function useImageViewer(): ViewerOpen | null {
  return useSyncExternalStore(subscribe, () => current)
}

/** Whether the phone's sheet over the viewer is open (ImageViewer.tsx draws it; Back closes it before the viewer). */
export const getViewerSheet = () => sheet
export function useViewerSheet(): boolean {
  return useSyncExternalStore(subscribe, () => sheet)
}

/** Show another picture of the same pane (next / previous). */
export function showEntry(entry: ViewerEntry) {
  if (!current || current.entry === entry) return
  current = { ...current, entry }
  emit()
}

// Back closes the viewer: opening adds one history entry at the same address, with the state React Router keeps there
// copied (its idx, key and usr), so the router and the app's own back (lib/back.ts) see the page they saw before. A
// popstate that leaves that entry (the browser's Back, Android's back through the phone app's WebView, iOS's edge
// swipe) closes the viewer; closing it any other way goes back off that entry, so none is left behind.
// The phone's sheet adds one more entry on top, a copy of the viewer's marked as the sheet's: Back from it lands on the
// viewer's and closes only the sheet; Forward onto it opens the sheet again. Closing the viewer with the sheet open goes
// back off both, one at a time (each once the last has landed).
const MARK = '__imageViewer'
const SHEET = '__viewerSheet'
let token = 0
/** a history.back() of ours is on its way: a viewer opened meanwhile adds its entry once it has landed */
let backPending = false
let pushOwed = false

type HistoryState = Record<string, unknown> | null
const stateNow = () => window.history.state as HistoryState
const onOurEntry = () => stateNow()?.[MARK] === token
const onSheetEntry = () => onOurEntry() && stateNow()?.[SHEET] === token
const idxOf = (s: HistoryState) => (typeof s?.idx === 'number' ? s.idx : null)
/** An entry of a viewer's (`mark`: its viewer; `sheet`: the sheet's on top of it), or null: the router's own. */
type Spot = { mark: unknown; sheet: boolean } | null
const spotOf = (s: HistoryState): Spot => (s?.[MARK] === undefined ? null : { mark: s[MARK], sheet: s[SHEET] !== undefined && s[SHEET] === s[MARK] })
/** the entry the page is on as last seen (a push of ours, a page shown, a popstate): where the next popstate came from */
let here: Spot = null

function onPop() {
  if (!current) return
  if (!onOurEntry()) return shut()
  // on the viewer's own entry the sheet is closed, on the sheet's it is open
  const on = onSheetEntry()
  if (on !== sheet) {
    sheet = on
    emit()
  }
}

function pushEntry() {
  token += 1
  try {
    window.history.pushState({ ...(stateNow() ?? {}), [MARK]: token }, '')
    here = spotOf(stateNow())
  } catch {
    // a history the page may not change (a sandbox): the viewer still opens, Back just leaves the page as before
  }
  window.addEventListener('popstate', onPop)
}

/** what waits for our history.back() to land (closeImageViewer's `then`, the next step back) */
let afterBack: (() => void)[] = []

function onBackDone() {
  window.removeEventListener('popstate', onBackDone)
  backPending = false
  const then = afterBack
  afterBack = []
  for (const f of then) f()
  // a viewer opened while we were going back: its entry, once the last of our backs has landed
  if (!backPending && pushOwed && current) {
    pushOwed = false
    pushEntry()
  }
}

/** one step back, with `then` once it has landed */
function goBack(then?: () => void) {
  backPending = true
  if (then) afterBack.push(then)
  window.addEventListener('popstate', onBackDone)
  window.history.back()
}

/** Back off the entries of the viewer that had `mine` (the sheet's, then its own), one at a time, then `then`. */
function backOff(mine: number, then?: () => void) {
  if (backPending) return void afterBack.push(() => backOff(mine, then))
  if (stateNow()?.[MARK] !== mine) return then?.()
  goBack(() => backOff(mine, then))
}

/** closed: no picture, no sheet, no listener */
function shut() {
  current = null
  sheet = false
  pushOwed = false
  if (typeof window !== 'undefined') window.removeEventListener('popstate', onPop)
  emit()
}

export function openImageViewer(open: ViewerOpen) {
  const was = current
  current = open
  if (!was && typeof window !== 'undefined') {
    if (backPending) pushOwed = true
    else pushEntry()
  }
  emit()
  // a picture or file opened from the sheet (its thread's): shown whole, the sheet gives way
  if (was) closeViewerSheet()
}

/** Close it (✕, Esc, the backdrop, a swipe; `back` false for a route change, which left our entries already). `then`
 * runs once the page is back where it was (after our history entries are gone): a change of address it makes (the room
 * page closing its thread) is not undone by that Back. */
export function closeImageViewer(back = true, then?: () => void) {
  if (!current) return then?.()
  const mine = token
  shut()
  if (back && typeof window !== 'undefined') backOff(mine, then)
  else then?.()
}

/** Open the phone's sheet over the viewer, with its own history entry (none while a back of ours is on its way: Back
 * then closes the viewer, as before). */
export function openViewerSheet() {
  if (!current || sheet) return
  sheet = true
  if (typeof window !== 'undefined' && !backPending && onOurEntry()) {
    try {
      window.history.pushState({ ...(stateNow() ?? {}), [SHEET]: token }, '')
      here = spotOf(stateNow())
    } catch {
      // a history the page may not change: Back closes the viewer, sheet and all
    }
  }
  emit()
}

/** Close the phone's sheet (its ✕ or ‹, a drag down, a tap beside it, Esc): back off its entry. */
export function closeViewerSheet() {
  if (!sheet) return
  sheet = false
  emit()
  if (typeof window !== 'undefined' && !backPending && onSheetEntry()) goBack()
}

// A viewer's entries are left behind when the page changed while it was open (a notice opened another page on top of
// it, a link in the sheet), and stay ahead of the page as Forward entries once it closed. Landing on them is the same
// page again, a Back or Forward that does nothing. So a popstate that lands on such an entry with no viewer open goes
// on, the way it came (ImageViewerHost listens): from the other entry of the same viewer, the sheet's to the viewer's
// is back and the viewer's to the sheet's forward (both have the page's idx); from any other entry, React Router's idx
// tells the way. A Forward with nothing after the sheet's entry stays there, and the next Back goes past both.
/** the router's entry number of the page last shown (ImageViewerHost notes it on every page change) */
let shownIdx: number | null = null
export function notePage() {
  if (typeof window === 'undefined') return void (shownIdx = null)
  shownIdx = idxOf(stateNow())
  here = spotOf(stateNow())
}

/** For ImageViewerHost's popstate listener (added before any viewer's own, so it runs first). */
export function skipLeftEntry() {
  const s = stateNow()
  const from = here
  const at = spotOf(s)
  here = at
  if (current || backPending || !at) return
  let way: -1 | 1 | 0
  if (from && from.mark === at.mark && from.sheet !== at.sheet) way = from.sheet ? -1 : 1
  else {
    const idx = idxOf(s)
    way = idx === null || shownIdx === null ? 0 : idx < shownIdx ? -1 : 1
  }
  if (way < 0) window.history.back()
  else if (way > 0) window.history.forward()
}
