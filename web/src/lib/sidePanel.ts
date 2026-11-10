// The one panel on the right of the chat: a file preview, an artifact, or the desktop app's Browser pane.
// On phones (< 768 px) it becomes a full-screen sheet.
import { useSyncExternalStore } from 'react'
import type { SourceLoc } from '@mycel/shared/api'

/** A file to preview: a team file (by path; `at`: the page, sheet or slide to open it at, from an answer's sources or
 * a link), a file sent in a team chat room (read through the room, its members only), or bytes we already have (a
 * picked file before sending). */
export type PreviewFile =
  | { source: 'team'; path: string; name: string; at?: SourceLoc }
  | { source: 'room'; roomId: string; fileId: string; name: string }
  | { source: 'local'; name: string; blob: Blob }

export type SidePanel =
  | { kind: 'browser' }
  | { kind: 'file'; file: PreviewFile; key: number }
  | { kind: 'artifact'; chatId: string; artifactKey: string; versionId?: string }

let current: SidePanel | null = null
/** "크게 보기": the panel fills the area beside the sidebar (components/Layout.tsx). Not remembered: it lasts while the
 * panel stays open (another file or artifact opened in it keeps it), and closing the panel or the Browser pane ends it. */
let expanded = false
const listeners = new Set<() => void>()
const notify = () => {
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** A file or an artifact can be shown big; the Browser pane cannot. */
export const expandable = (p: SidePanel | null) => !!p && p.kind !== 'browser'

export function setSidePanel(next: SidePanel | null) {
  current = next
  if (!expandable(next)) expanded = false
  notify()
}

export const getSidePanel = () => current

export function useSidePanel() {
  return useSyncExternalStore(subscribe, () => current)
}

/** Big or side by side (only a file or an artifact panel that is open can be big). */
export function setPanelExpanded(on: boolean) {
  const next = on && expandable(current)
  if (next === expanded) return
  expanded = next
  notify()
}

export const getPanelExpanded = () => expanded
export const usePanelExpanded = () => useSyncExternalStore(subscribe, getPanelExpanded)

/** The panel is big on screen now: a computer-width window (on a phone the panel is a full-screen sheet anyway, and
 * the state shows nothing there). */
export const panelExpandedNow = () => expanded && wideScreen()

const wideScreen = () => typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 768px)').matches

/** What Esc does in the app frame (components/Layout.tsx), the first that applies: an open dialog keeps its own Esc
 * (nothing here); the phone drawer closes; a big panel goes back side by side; the panel closes. A page's own Esc that
 * runs before (the Files page clears its selection) leaves a big panel alone: the page is hidden behind it. */
export function escapeAction(s: { dialog: boolean; drawer: boolean; expanded: boolean }): 'none' | 'drawer' | 'side-by-side' | 'close' {
  if (s.dialog) return 'none'
  if (s.drawer) return 'drawer'
  return s.expanded ? 'side-by-side' : 'close'
}

let seq = 0
export const openFilePreview = (file: PreviewFile) => setSidePanel({ kind: 'file', file, key: ++seq })
export const openTeamFile = (path: string, at?: SourceLoc | null) => openFilePreview({ source: 'team', path, name: path.slice(path.lastIndexOf('/') + 1), ...(at ? { at } : {}) })
/** A file sent in a room, as the preview panel opens it. */
export const roomPreview = (roomId: string, f: { id: string; name: string }): PreviewFile => ({ source: 'room', roomId, fileId: f.id, name: f.name })
export const openArtifact = (chatId: string, artifactKey: string, versionId?: string) => setSidePanel({ kind: 'artifact', chatId, artifactKey, versionId })
export const closeSidePanel = () => setSidePanel(null)

/** A file panel belongs to the page it was opened on (components/Layout.tsx). Moving from there (`from`) to `to` keeps
 * it only for the Files page (open in folder, a file link) or a new-chat page (Home, a project's page) becoming the chat
 * its first message made; another chat, a new chat or any other page closes it. */
export const keepsFilePanel = (from: string, to: string) =>
  to === '/files' || to.startsWith('/files/') || ((from === '/' || from.startsWith('/projects/')) && to.startsWith('/c/'))

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
