// The files of each room box (a room's, a thread's: store/rooms.ts placeKey), kept above the room page like its draft
// (roomDrafts): a file that is still going up when the person opens another room, another page or closes the thread
// goes on, and its chip is in that box when they come back, with its percent, or failed with its reason. Nothing here
// sends anything: a file goes to a room only when the person presses send in that room's box (RoomComposer.tsx).
// While one is on its way: the room's row in the lists shows it (components/nav/RoomsList.tsx RoomUploadMark), the page
// does not reload by itself (lib/busy.ts, lib/reload-guard.ts), and closing or reloading the tab asks first (the
// browser's own "leave this page?"). After a reload the chip is gone like any file not sent; picking the same file
// again in that room continues from the pieces the server has (lib/upload.ts). Signing out stops every upload and drops
// what the server holds of them (dropRoomUploads, lib/logout.ts); a sign-in that ends any other way stops them and
// forgets them (forgetRoomUploads); a room I am no longer in loses its uploads (pruneRoomUploads).
import { create } from 'zustand'
import type { RoomFile } from '@mycel/shared/api'
import { markBusy } from '../lib/busy'
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

/** Signing out (lib/logout.ts), before the session ends: every upload stops, the pieces the server holds of the large
 * ones are dropped, and no chip is left for whoever signs in next on this computer. */
export async function dropRoomUploads(): Promise<void> {
  const all = Object.entries(useRoomUploads.getState().byPlace)
  useRoomUploads.setState({ byPlace: {} })
  await Promise.all(all.flatMap(([place, list]) => list.map((f) => stop(place, f, true))))
}

// while a file is on its way: an "upload" for lib/busy.ts (no reload by itself), and the browser asks before the tab
// closes or reloads (as a folder upload does, components/FolderUploads.tsx)
let release: (() => void) | null = null
const stay = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
useRoomUploads.subscribe((s) => {
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
