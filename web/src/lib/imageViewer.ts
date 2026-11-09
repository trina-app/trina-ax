// The image viewer's state (components/ImageViewer.tsx): which picture is open, the pictures of the pane it was opened
// from, and the history entry that lets Back close it. docs/DECISIONS.md "One image viewer".
// A pane (the room's timeline, a thread, the AI chat, a message box's pictures) is an ImageGroup: each picture in it
// registers itself (useViewerItem), and next/previous walks the group's pictures in the order they are on the page,
// which is message order. Only pictures drawn on the page are in it: a file someone may not open is drawn as a lock, a
// hidden answer as a line, so they never are. A picture outside any group opens alone.
// Every address is one of the app's own, with its checks (a room file through the room, a team file by its path): no
// new address is made here.
import { useSyncExternalStore } from 'react'
import { API, type Attachment, type RoomFile, type UserRef } from '@mycel/shared/api'
import { api, fileUrl, roomFileUrl, startDownload, thumbnailUrl } from './api'
import { opensWithoutServer, previewLimit, serverPreview } from './preview'

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
}

/** The bar's who and when, from the message around a picture (ViewerMeta in ImageViewer.tsx). */
export interface ViewerMetaValue { sender?: ViewerSender; at?: string | null }

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
    ...meta,
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
    ...meta,
  }
}

/** A team picture in an answer: the picture on the page is the original already. */
export function teamImageItem(path: string, name: string, meta: ViewerMetaValue = {}): ViewerItem {
  const inline = fileUrl(path, 'inline')
  return { key: `team:${path}`, name, thumb: inline, original: inline, download: () => startDownload(fileUrl(path), name), href: inline, ...meta }
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
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export const getImageViewer = () => current

export function useImageViewer(): ViewerOpen | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
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
const MARK = '__imageViewer'
let token = 0
/** a history.back() of ours is on its way: a viewer opened meanwhile adds its entry once it has landed */
let backPending = false
let pushOwed = false

type HistoryState = Record<string, unknown> | null
const stateNow = () => window.history.state as HistoryState
const onOurEntry = () => stateNow()?.[MARK] === token
const idxOf = (s: HistoryState) => (typeof s?.idx === 'number' ? s.idx : null)

function onPop() {
  if (current && !onOurEntry()) shut()
}

function pushEntry() {
  token += 1
  try {
    window.history.pushState({ ...(stateNow() ?? {}), [MARK]: token }, '')
  } catch {
    // a history the page may not change (a sandbox): the viewer still opens, Back just leaves the page as before
  }
  window.addEventListener('popstate', onPop)
}

function onBackDone() {
  window.removeEventListener('popstate', onBackDone)
  backPending = false
  if (pushOwed && current) {
    pushOwed = false
    pushEntry()
  }
}

/** closed: no picture, no listener */
function shut() {
  current = null
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
}

/** Close it (✕, Esc, the backdrop, a swipe; `back` false for a route change, which left our entry already). */
export function closeImageViewer(back = true) {
  if (!current) return
  shut()
  if (back && typeof window !== 'undefined' && onOurEntry()) {
    backPending = true
    window.addEventListener('popstate', onBackDone)
    window.history.back()
  }
}

// A viewer's entry is left behind when the page changed while it was open (a notice opened another page on top of it).
// Back from that page would land on it: the same page again, a Back that does nothing. So a popstate that lands on such
// an entry with no viewer open goes on, the way it came (ImageViewerHost listens; React Router's idx tells the way).
/** the router's entry number of the page last shown (ImageViewerHost notes it on every page change) */
let shownIdx: number | null = null
export function notePage() {
  shownIdx = typeof window === 'undefined' ? null : idxOf(stateNow())
}

/** For ImageViewerHost's popstate listener (added before any viewer's own, so it runs first). */
export function skipLeftEntry() {
  const s = stateNow()
  if (current || backPending || !s?.[MARK]) return
  const idx = idxOf(s)
  if (idx === null || shownIdx === null) return
  if (idx < shownIdx) window.history.back()
  else window.history.forward()
}
