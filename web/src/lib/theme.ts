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
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', dark ? '#1b1a18' : '#faf9f6')
}

export function watchSystemTheme() {
  media ??= window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
  media?.addEventListener('change', () => current === 'system' && applyTheme('system'))
}
