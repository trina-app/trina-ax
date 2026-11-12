// Light / dark / follow the system. The choice is saved in the person's prefs (server) and, for the sign-in
// screens and the first paint, in localStorage.
import { useSyncExternalStore } from 'react'
import type { Theme } from '@mycel/shared/api'

const KEY = 'mycel.theme'

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* storage blocked */ }
  return 'system'
}

export function storeTheme(t: Theme) {
  try { localStorage.setItem(KEY, t) } catch { /* ignore */ }
}

let media: MediaQueryList | null = null
let current: Theme = 'system'
/** The theme in use: light, dark, or system (follows the device). */
export const currentTheme = (): Theme => current

export function applyTheme(t: Theme) {
  current = t
  if (typeof window === 'undefined') return
  media ??= window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
  const dark = t === 'dark' || (t === 'system' && !!media?.matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  // index.html has one per system scheme; the chosen look wins over the system's, so both get its colour
  const color = themeColor(dark)
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', color)
  // the phone app colours its status bar text by the page's look (lib/mobile.ts, appearance-v1)
  window.dispatchEvent?.(new Event('mycel:theme'))
}

/** The browser bar colour: the page background (--c-canvas) of the look in use, so it follows the edition's theme
 * (theme.edition.css) and not only the core one. Before the stylesheet has loaded, the edition's canvas values. */
export function themeColor(dark: boolean): string {
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--c-canvas').trim()
  return /^#[0-9a-f]{6}$/i.test(canvas) ? canvas : dark ? '#0e0c0b' : '#fcfbf8'
}

export function watchSystemTheme() {
  media ??= window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
  media?.addEventListener('change', () => current === 'system' && applyTheme('system'))
}

/** Whether the page is drawn dark now (the `dark` class applyTheme sets): for what draws its own colours (a Mermaid
 * diagram). Re-renders when the look changes, the system's too. */
export const isDarkTheme = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
const onThemeChange = (cb: () => void) => {
  window.addEventListener('mycel:theme', cb)
  return () => window.removeEventListener('mycel:theme', cb)
}
export const useDarkTheme = () => useSyncExternalStore(onThemeChange, isDarkTheme, () => false)
