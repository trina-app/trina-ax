// The files of each room box (a room's, a thread's: store/rooms.ts placeKey), kept above the room page like its draft
// (roomDrafts): a file that is still going up when the person opens another room, another page or closes the thread
// goes on, and its chip is in that box when they come back, with its percent, or failed with its reason. Nothing here
// sends anything: a file goes to a room only when the person presses send in that room's box (RoomComposer.tsx).
// While one is on its way: the room's row in the lists shows it (components/nav/RoomsList.tsx RoomUploadMark), the page
// does not reload by itself (lib/busy.ts, lib/reload-guard.ts), and closing or reloading the tab asks first (the
// browser's own "leave this page?"). While a box holds a file that is up and not sent yet (or one a reload stopped)
// the page does not reload by itself either (lib/reload-guard.ts, holdsRoomUploads): QA TC-4327, a 2 GB file was
// up, the page reloaded for an update a moment later and its chip was gone.
// A reload the person makes (the Reload button of "A new version is ready", the browser's own) keeps them: this tab
// remembers each box's files (sessionStorage, ROOM_UPLOADS_KEY; docs/decisions/20261117-room-uploads-survive-reload.md).
// A file that was up comes back as it was, ready to send (the server keeps a file not sent for a day: rooms/files.ts
// UNSENT_FILE_MS). One that was still on its way cannot go on by itself (a browser does not keep a File over a
// reload): its chip comes back saying so (`stopped`), and choosing the same file again in that box takes its place
// and continues from the pieces the server has (lib/upload.ts). Per tab, never per device: another tab of mine must
// not show, and send, the same file (a tab duplicated by the browser still can: the second send is refused and its
// file does not come back, store/rooms.ts). The desktop app restarting does not keep them (a new window, a new
// tab's memory); it does not restart by itself while there is one (window.__mycelBusy). Signing out stops every upload and drops
// what the server holds of them (dropRoomUploads, lib/logout.ts); a sign-in that ends any other way stops them and
// forgets them (forgetRoomUploads); a room I am no longer in loses its uploads (pruneRoomUploads). All three forget
// what the tab remembers too.
import { create } from 'zustand'
import type { RoomFile } from '@mycel/shared/api'
import { markBusy } from '../lib/busy'
import { ROOM_UPLOADS_KEY } from '../lib/localData'
import { cancelUpload, type UploadProgress } from '../lib/upload'
import { api } from '../lib/api'

export interface RoomUpload {
  key: number
  file: File
  status: 'uploading' | 'done' | 'failed'
  roomFile?: RoomFile
  /** how far a file from this computer is (a large one goes in pieces and says what happens: lib/upload.ts) */
  progress?: UploadProgress
  error?: string
  /** a storage-full refusal: the plan page it names, linked for the owner and admins (StoragePlansLink.tsx) */
  plans?: string
  /** refused because the team's disk is full (rooms/storageRefusal.tsx): the owner and admins get "See what takes space" */
  full?: boolean
  /** it was on its way when the page loaded again (restoreRoomUploads): a failed file whose words say so, in the
   * language of the moment (RoomComposer.tsx), and whose place the same file chosen again takes */
  stopped?: boolean
  abort: AbortController
  /** a team file (the attach sheet's team files): its team path, and once copied how many other members cannot open it */
  teamPath?: string
  unable?: number
}

export const NO_UPLOADS: RoomUpload[] = []
let uploadKey = 0
export const nextUploadKey = () => ++uploadKey

/** by place (placeKey: `<room id>` or `<room id>/<thread root id>`) */
export const useRoomUploads = create<{ byPlace: Record<string, RoomUpload[]> }>(() => ({ byPlace: {} }))

/** The files of a place, changed. Works with no box of that place on screen (an upload that ends while the person is
 * in another room). */
export function setPlaceUploads(place: string, next: RoomUpload[] | ((list: RoomUpload[]) => RoomUpload[])) {
  useRoomUploads.setState((s) => {
    const before = s.byPlace[place] ?? NO_UPLOADS
    const list = typeof next === 'function' ? next(before) : next
    if (list === before) return s
    const byPlace = { ...s.byPlace }
    if (list.length) byPlace[place] = list
    else delete byPlace[place]
    return { byPlace }
  })
}

/** the upload session target of a file from this computer in that room */
export const roomTarget = (roomId: string, file: Pick<File, 'name'>) => ({ kind: 'room' as const, roomId, name: file.name })
const roomOf = (place: string) => place.split('/')[0]!

/** a file of that room (its box or one of its threads) is on its way now */
export const uploadingIn = (s: { byPlace: Record<string, RoomUpload[]> }, roomId: string) =>
  Object.entries(s.byPlace).some(([place, list]) => roomOf(place) === roomId && list.some((f) => f.status === 'uploading'))
/** The server removes a file not sent within a day (rooms/files.ts UNSENT_FILE_MS); one that old is not brought back
 * and holds no reload (an hour before, so a chip is never trusted longer than its file). A room file's id starts with
 * the time it was made (UUID v7). */
export const KEPT_UPLOAD_MS = 23 * 3600_000
const madeAt = (id: string) => Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
const fresh = (f: RoomFile, now: number) => madeAt(f.id) > now - KEPT_UPLOAD_MS

/** A room box holds a file a reload by itself would take from under the person's hands: on its way, up and not sent
 * (while the server still has it), or stopped by a reload. One that failed for its own reason holds nothing: it
 * cannot be sent, and no reload keeps it (lib/reload-guard.ts). */
export const holdsRoomUploads = (now = Date.now()) =>
  Object.values(useRoomUploads.getState().byPlace).some((list) => list.some((f) => f.status === 'uploading' || !!f.stopped || (f.status === 'done' && !!f.roomFile && fresh(f.roomFile, now))))

/** the team files copied in this tab (by the copy's id): their team path and how many more people they reach, so a send
 * the server refused brings them back into the box with the line under the files (RoomComposer.tsx) */
export const teamCopies = new Map<string, { path: string; unable: number }>()
const anyUploading = (s: { byPlace: Record<string, RoomUpload[]> }) => Object.values(s.byPlace).some((list) => list.some((f) => f.status === 'uploading'))

/** One upload stopped; with `drop`, the pieces the server holds of a large one are dropped too (needs the session). */
function stop(place: string, f: RoomUpload, drop: boolean): Promise<void> | null {
  if (f.status === 'done') return null
  f.abort.abort()
  return drop && !f.teamPath ? cancelUpload(f.file, roomTarget(roomOf(place), f.file), api) : null
}

/** The sign-in ended any other way (expired, ended by the server, the account removed, another person signing in over
 * this one: App.tsx dropPersonStores): every upload stops at once and no chip, file name or picture of the person who
 * was here stays in memory. Nothing is asked of the server (there is no session to ask with); what it holds of an
 * unfinished file goes by itself (uploads/sessions.ts). */
export function forgetRoomUploads(): void {
  const all = Object.entries(useRoomUploads.getState().byPlace)
  useRoomUploads.setState({ byPlace: {} })
  // (a page that never had its person, signed out or without an answer from the server, leaves what the tab
  // remembers alone: the reload that got here may still bring it back)
  owner = null
  for (const [place, list] of all) for (const f of list) stop(place, f, false)
}

/** Rooms I am no longer in (left, taken out, archived; store/rooms.ts tells with every change of my room list): their
 * uploads stop and their files go, with what the server holds of the large ones. A room that is gone has no row to
 * show an upload on and no box to take a failed file out of. */
export function pruneRoomUploads(mine: (roomId: string) => boolean): void {
  const gone = Object.entries(useRoomUploads.getState().byPlace).filter(([place]) => !mine(roomOf(place)))
  if (!gone.length) return
  useRoomUploads.setState((s) => ({ byPlace: Object.fromEntries(Object.entries(s.byPlace).filter(([place]) => mine(roomOf(place)))) }))
  for (const [place, list] of gone) for (const f of list) void stop(place, f, true)?.catch(() => {})
}

/** how long signing out waits for the server to drop the uploads' pieces before it goes on */
export const SIGN_OUT_WAIT_MS = 2000

/** Signing out (lib/logout.ts), before the session ends: every upload stops, the pieces the server holds of the large
 * ones are dropped, and no chip is left for whoever signs in next on this computer. */
export async function dropRoomUploads(waitMs = SIGN_OUT_WAIT_MS): Promise<void> {
  const all = Object.entries(useRoomUploads.getState().byPlace)
  useRoomUploads.setState({ byPlace: {} })
  forgetKept()
  owner = null
  // every upload is stopped here and now; the drops are asked of the server at once and go on by themselves
  const drops = Promise.all(all.flatMap(([place, list]) => list.map((f) => stop(place, f, true)))).then(() => {}, () => {})
  // ...but signing out does not wait for them: the server answers a drop only after a file it is putting in place is
  // there (a file of several GB: tens of seconds), and the person asked to leave now
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([drops, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs) })])
  clearTimeout(timer)
}

// while a file is on its way: an "upload" for lib/busy.ts (no reload by itself), and the browser asks before the tab
// closes or reloads (as a folder upload does, components/FolderUploads.tsx)
// ── kept over a reload, in this tab ──────────────────────────────────────────────────────────────────────────────────
type TabStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
function tab(): TabStore | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}
/** a box's file as the tab remembers it: with `roomFile` it was up (and not sent), without it it was on its way */
interface KeptUpload { name: string; size: number; lastModified?: number; roomFile?: RoomFile; teamPath?: string; unable?: number }
/** the person whose files the tab remembers from now on (restoreRoomUploads): nothing is written before */
let owner: string | null = null
let written: string | null = null

function kept(f: RoomUpload): KeptUpload | null {
  const base = { name: f.file.name, size: f.file.size, ...(typeof f.file.lastModified === 'number' ? { lastModified: f.file.lastModified } : {}), ...(f.teamPath ? { teamPath: f.teamPath } : {}) }
  if (f.status === 'done' && f.roomFile) return { ...base, roomFile: f.roomFile, ...(f.unable ? { unable: f.unable } : {}) }
  // on its way from this computer, or stopped by a reload before this one. Not kept: a file that failed for a reason
  // of its own, and a team file still being copied (the server finishes the copy by itself, and picking it again
  // gets that copy: rooms/files.ts teamCopy)
  return (f.status === 'uploading' && !f.teamPath) || f.stopped ? base : null
}

function forgetKept(s: TabStore | null = tab()) {
  written = null
  try { s?.removeItem(ROOM_UPLOADS_KEY) } catch { /* storage blocked */ }
}

/** every box's files as they are now, into this tab (after each change, once the person is known) */
function keep(byPlace: Record<string, RoomUpload[]>, s: TabStore | null = tab()) {
  if (!owner || !s) return
  const places: Record<string, KeptUpload[]> = {}
  for (const [place, list] of Object.entries(byPlace)) {
    const k = list.map(kept).filter((x): x is KeptUpload => !!x)
    if (k.length) places[place] = k
  }
  if (!Object.keys(places).length) {
    if (written !== '') forgetKept(s)
    written = ''
    return
  }
  const next = JSON.stringify({ userId: owner, byPlace: places })
  // (a large file's percent changes many times a second: the same words are not written again)
  if (next === written) return
  try { s.setItem(ROOM_UPLOADS_KEY, next); written = next } catch { /* storage full or blocked: the files are only in memory, as before */ }
}

const isKept = (x: unknown): x is KeptUpload => {
  const k = x as KeptUpload
  if (!k || typeof k !== 'object' || typeof k.name !== 'string' || !k.name || !Number.isFinite(k.size) || k.size < 0) return false
  if (k.lastModified !== undefined && typeof k.lastModified !== 'number') return false
  if (k.teamPath !== undefined && typeof k.teamPath !== 'string') return false
  const f = k.roomFile
  return f === undefined || (!!f && typeof f === 'object' && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.size === 'number' && typeof f.kind === 'string' && typeof f.mime === 'string')
}

/**
 * The person is signed in (App.tsx, before their screens draw): the files this tab remembers of theirs are their
 * boxes' files again, once per page load. Up and not sent: ready to send, as it was. On its way when the page loaded
 * again: failed and `stopped`. What another person left here, or a file the server has removed by now, is dropped.
 * From here on every change is remembered (keep).
 */
export function restoreRoomUploads(userId: string, s: TabStore | null = tab(), now = Date.now()): void {
  if (owner === userId) return
  owner = userId
  written = null
  let raw: string | null = null
  try { raw = s?.getItem(ROOM_UPLOADS_KEY) ?? null } catch { /* storage blocked */ }
  const here = useRoomUploads.getState().byPlace
  if (raw && !Object.keys(here).length) {
    const byPlace: Record<string, RoomUpload[]> = {}
    try {
      const v = JSON.parse(raw) as { userId?: unknown; byPlace?: unknown }
      if (v.userId === userId && v.byPlace && typeof v.byPlace === 'object') {
        for (const [place, list] of Object.entries(v.byPlace as Record<string, unknown>)) {
          if (!Array.isArray(list)) continue
          const files = list.filter(isKept).flatMap((k): RoomUpload[] => {
            const file = { name: k.name, size: k.size, ...(k.lastModified !== undefined ? { lastModified: k.lastModified } : {}) } as File
            if (!k.roomFile) return k.teamPath ? [] : [{ key: nextUploadKey(), file, status: 'failed', stopped: true, abort: new AbortController() }]
            if (!fresh(k.roomFile, now)) return []
            if (k.teamPath) teamCopies.set(k.roomFile.id, { path: k.teamPath, unable: k.unable ?? 0 })
            return [{ key: nextUploadKey(), file, status: 'done', roomFile: k.roomFile, abort: new AbortController(), ...(k.teamPath ? { teamPath: k.teamPath, unable: k.unable ?? 0 } : {}) }]
          })
          if (files.length) byPlace[place] = files
        }
      }
    } catch { /* not ours */ }
    if (Object.keys(byPlace).length) return void useRoomUploads.setState({ byPlace })
  }
  keep(here, s)
}

/** tests only: a new page load (nothing in memory, no person yet); what the tab remembers stays */
export function _reloadRoomUploadsForTest() {
  owner = null
  written = null
  useRoomUploads.setState({ byPlace: {} })
}

let release: (() => void) | null = null
const stay = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
useRoomUploads.subscribe((s) => {
  keep(s.byPlace)
  const on = anyUploading(s)
  if (on === !!release) return
  if (on) {
    release = markBusy('upload')
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', stay)
  } else {
    release?.()
    release = null
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', stay)
  }
})
