// The files going up from the file screen, one row each (components/FileUploads.tsx). They stay here and not in the page:
// a progress report must redraw the row, not the whole file list, and the row is there when the person comes back.
import { create } from 'zustand'
import { SIGNED_OUT } from './localData'
import type { UploadProgress } from './upload'

export interface FileUpload {
  id: number
  name: string
  /** the folder it goes to */
  folder: string
  progress: UploadProgress | null
  status: 'uploading' | 'done' | 'failed'
  error?: string
  /** a storage-full refusal: the plan page it names, linked for the owner and admins (components/StoragePlansLink.tsx) */
  plans?: string
  abort: AbortController
  /** a failed upload: the same file again (a large one goes on from the chunks the server has; QA TC-223) */
  retry?: () => void
  /** done: the path it was saved at (a kept-both name can differ from `name`) */
  saved?: string
}

export const useFileUploads = create<{ items: FileUpload[] }>(() => ({ items: [] }))

let seq = 0

export function addFileUpload(name: string, folder: string): FileUpload {
  const item: FileUpload = { id: ++seq, name, folder, progress: null, status: 'uploading', abort: new AbortController() }
  useFileUploads.setState((s) => ({ items: [...s.items, item] }))
  return item
}

export function patchFileUpload(id: number, patch: Partial<FileUpload>) {
  useFileUploads.setState((s) => ({ items: s.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
}

export function dropFileUpload(id: number) {
  useFileUploads.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }))
}

/** Files picked on a page with no folder of its own (최근 파일), handed to the Files page of the folder they go to (내 파일:
 * docs/decisions/20261125-upload-destination.md), which uploads them as its own. Kept in memory only, never stored. */
let handed: { files: File[]; folder: string; at: number } | null = null
/** how long a hand-off waits for its folder to open; an older one is dropped, never uploaded on a later visit */
const HAND_MS = 60_000
export function handUploads(files: File[], folder: string) {
  handed = files.length ? { files, folder, at: Date.now() } : null
}
/** The files handed to `folder`, once (and only while fresh). */
export function takeHandedUploads(folder: string): File[] | null {
  if (!handed || handed.folder !== folder) return null
  const { files, at } = handed
  handed = null
  return Date.now() - at <= HAND_MS ? files : null
}
/** The page could not take them (its folder did not open, another folder opened): dropped. True when there were some. */
export function dropHandedUploads(): boolean {
  const had = !!handed
  handed = null
  return had
}

/** Sign-out or the end of a session: the next person in this tab sees no name of the last one's files, and none of them
 * goes on uploading. */
export function forgetFileUploads() {
  for (const u of useFileUploads.getState().items) u.abort.abort(SIGNED_OUT)
  useFileUploads.setState({ items: [] })
  handed = null
}
