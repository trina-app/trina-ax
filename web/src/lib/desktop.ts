// The desktop app (component E, desktop/) exposes `window.mycelDesktop` through its preload script; in a normal
// browser or the PWA it is undefined. The contract is shared/src/desktop-bridge.ts (DesktopBridge): this page hands
// browser.call to it (lib/browserRelay.ts) and opens / closes the in-app Browser pane. The pane itself, its tabs,
// address bar, site prompts and the "AI is using it" frame are drawn by the desktop app next to this page, so a page
// served through the relay can drive browser tools but can never answer the person's site prompts.
import { useSyncExternalStore } from 'react'
import { mobileApp } from './mobile'
import { getDesktopBridge, type DesktopBridge, type DesktopPaneState } from '@mycel/shared'

export type { DesktopBridge, DesktopPaneState }

export const desktop = (): DesktopBridge | null => getDesktopBridge()
export const isDesktop = () => !!desktop()

// ---- pane state, shared by every component that shows it (one subscription to the desktop app)
const CLOSED: DesktopPaneState = { open: false, tabs: [], driving: false }
let paneState: DesktopPaneState = CLOSED
let off: (() => void) | null = null
const listeners = new Set<() => void>()

function subscribe(l: () => void) {
  listeners.add(l)
  const app = desktop()
  if (app && !off) {
    const set = (s: DesktopPaneState | null) => {
      paneState = s ?? CLOSED
      for (const f of listeners) f()
    }
    off = app.pane.onState(set)
    void app.pane.getState().then(set, () => {})
  }
  return () => {
    listeners.delete(l)
    if (!listeners.size && off) {
      off()
      off = null
    }
  }
}

/** The desktop app's Browser pane (closed and empty outside the desktop app). */
export function usePaneState(): DesktopPaneState {
  return useSyncExternalStore(subscribe, () => paneState, () => CLOSED)
}

/** What this window signs in as. The server offers browser tools only to turns sent from a desktop-app session
 * (its window has the pane), so sign-in inside the desktop app must say so. */
export const clientKind = (): 'web' | 'desktop' | 'mobile' => (isDesktop() ? 'desktop' : mobileApp() ? 'mobile' : 'web')
