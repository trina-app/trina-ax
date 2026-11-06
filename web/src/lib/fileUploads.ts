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
  abort: AbortController
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

/** Sign-out or the end of a session: the next person in this tab sees no name of the last one's files, and none of them
 * goes on uploading. */
export function forgetFileUploads() {
  for (const u of useFileUploads.getState().items) u.abort.abort(SIGNED_OUT)
  useFileUploads.setState({ items: [] })
}
