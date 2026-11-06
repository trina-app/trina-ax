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

/** A phone-width screen, where the panel is a full-screen sheet over the chat, while the person is writing in a text
 * field (the composer with a draft in it): a panel that would open by itself is left to their own tap on its card then
 * (components/Layout.tsx). Focus alone is not writing: a narrow computer window focuses the composer by itself. */
export function typingOnPhone(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia?.('(max-width: 767.98px)').matches) return false
  const el = document.activeElement as (HTMLElement & { value?: unknown; type?: string }) | null
  if (!el) return false
  if (el.isContentEditable) return !!el.textContent?.trim()
  const field = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|range|color|image|hidden)$/i.test(el.type ?? ''))
  return field && typeof el.value === 'string' && el.value.trim() !== ''
}
