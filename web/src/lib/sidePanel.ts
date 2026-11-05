// The one panel on the right of the chat: a file preview, an artifact, or the desktop app's Browser pane.
// On phones (< 768 px) it becomes a full-screen sheet.
import { useSyncExternalStore } from 'react'
import type { SourceLoc } from '@mycel/shared/api'

/** A file to preview: a team file (by path; `at`: the page, sheet or slide to open it at, from an answer's sources or
 * a link), or bytes we already have (a picked file before sending). */
export type PreviewFile =
  | { source: 'team'; path: string; name: string; at?: SourceLoc }
  | { source: 'local'; name: string; blob: Blob }

export type SidePanel =
  | { kind: 'browser' }
  | { kind: 'file'; file: PreviewFile; key: number }
  | { kind: 'artifact'; chatId: string; artifactKey: string; versionId?: string }

let current: SidePanel | null = null
const listeners = new Set<() => void>()

export function setSidePanel(next: SidePanel | null) {
  current = next
  for (const l of listeners) l()
}

export const getSidePanel = () => current

export function useSidePanel() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}

let seq = 0
export const openFilePreview = (file: PreviewFile) => setSidePanel({ kind: 'file', file, key: ++seq })
export const openTeamFile = (path: string, at?: SourceLoc | null) => openFilePreview({ source: 'team', path, name: path.slice(path.lastIndexOf('/') + 1), ...(at ? { at } : {}) })
export const openArtifact = (chatId: string, artifactKey: string, versionId?: string) => setSidePanel({ kind: 'artifact', chatId, artifactKey, versionId })
export const closeSidePanel = () => setSidePanel(null)

/** A file panel belongs to the page it was opened on (components/Layout.tsx). Moving from there (`from`) to `to` keeps
 * it only for the Files page (open in folder, a file link) or a new-chat page (Home, a project's page) becoming the chat
 * its first message made; another chat, a new chat or any other page closes it. */
export const keepsFilePanel = (from: string, to: string) =>
  to === '/files' || to.startsWith('/files/') || ((from === '/' || from.startsWith('/projects/')) && to.startsWith('/c/'))
