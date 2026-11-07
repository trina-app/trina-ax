// The person's text size (Settings > Profile > 글자 크기), like a phone's Text Size setting: one root font size on <html>
// that every rem size of the app follows (text, and the rows, buttons and gaps around it, so nothing gets cut). Saved
// like the theme (lib/theme.ts): in the person's prefs on the server, so every device they sign in on gets it, and, for
// the sign-in screens and the first paint, in localStorage.
import { useSyncExternalStore } from 'react'
import { TextSize } from '@mycel/shared/api'

/** smallest to largest, the order of the slider */
export const TEXT_SIZES: readonly TextSize[] = TextSize.options

/** Each step in percent of the browser's own font size (16px unless the person changed it in the browser, which still
 * counts). The largest step is what a 390px phone takes without anything sideways or cut (test/e2e/text-size.spec.ts). */
export const TEXT_SIZE_PERCENT: Record<TextSize, number> = { small: 90, default: 100, large: 112.5, larger: 125, largest: 140 }

const KEY = 'mycel.textSize'

/** `storage`: this browser's localStorage unless given (tests). Reading localStorage itself can throw when the browser
 * blocks storage, so it is read inside the try. */
export function storedTextSize(storage?: Pick<Storage, 'getItem'>): TextSize {
  try {
    const v = TextSize.safeParse((storage ?? globalThis.localStorage)?.getItem(KEY))
    if (v.success) return v.data
  } catch { /* storage blocked */ }
  return 'default'
}

export function storeTextSize(size: TextSize, storage?: Pick<Storage, 'setItem' | 'removeItem'>) {
  try {
    const s = storage ?? globalThis.localStorage
    if (size === 'default') s?.removeItem(KEY)
    else s?.setItem(KEY, size)
  } catch { /* storage blocked or full */ }
}

let current: TextSize = 'default'
/** The text size in use. */
export const currentTextSize = (): TextSize => current
const listeners = new Set<() => void>()
/** The text size in use, for what measures itself in px (the message boxes' height) or shows it (Settings). */
export function useTextSize(): TextSize {
  return useSyncExternalStore((l) => { listeners.add(l); return () => void listeners.delete(l) }, currentTextSize, currentTextSize)
}

let unsaved: TextSize | null = null
/** A size the person picked whose save to the account has not come back yet. An account read on its way meanwhile (a
 * reconnect, another save) carries the old size and must not put it back (store/session.ts applyMe). */
export const unsavedTextSize = (): TextSize | null => unsaved

/** The person picked a size: shown and kept on this device now, saved to the account by the caller. */
export function pickTextSize(size: TextSize) {
  unsaved = size
  storeTextSize(size)
  applyTextSize(size)
}

/** The account's save of `size` came back (saved or failed). */
export function textSizeSettled(size: TextSize) {
  if (unsaved === size) unsaved = null
}

/** The root font size of the step: none of its own at the default, so the page is exactly as without the setting. */
export function rootFontSize(size: TextSize): string {
  return size === 'default' ? '' : `${TEXT_SIZE_PERCENT[size]}%`
}

export function applyTextSize(size: TextSize) {
  const changed = size !== current
  current = size
  if (typeof document !== 'undefined') document.documentElement.style.fontSize = rootFontSize(size)
  if (changed) for (const l of listeners) l()
}
