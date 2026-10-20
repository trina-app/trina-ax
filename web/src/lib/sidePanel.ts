// The one panel on the right of the chat: a file preview, an artifact, or the desktop app's Browser pane.
// On phones (< 768 px) it becomes a full-screen sheet.
import { useSyncExternalStore } from 'react'

/** A file to preview: a team file (by path), or bytes we already have (a picked file before sending). */
export type PreviewFile =
  | { source: 'team'; path: string; name: string }
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
export const openTeamFile = (path: string) => openFilePreview({ source: 'team', path, name: path.slice(path.lastIndexOf('/') + 1) })
export const openArtifact = (chatId: string, artifactKey: string, versionId?: string) => setSidePanel({ kind: 'artifact', chatId, artifactKey, versionId })
export const closeSidePanel = () => setSidePanel(null)
