// Light / dark / follow the system. The choice is saved in the person's prefs (server) and, for the sign-in
// screens and the first paint, in localStorage.
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
