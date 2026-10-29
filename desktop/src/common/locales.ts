// The desktop app's languages, without any other import (the own screens' bundles use it too: no shared runtime code).
export type UiLocale = 'ko' | 'en' | 'id' | 'ja' | 'es'

/** Language before the team page or the person said otherwise. */
export const DEFAULT_UI_LOCALE: UiLocale = 'en'

/** Each language named in its own language, in the order the picker lists them. */
export const UI_LOCALES: { id: UiLocale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'ko', label: '한국어' },
  { id: 'id', label: 'Bahasa Indonesia' },
  { id: 'ja', label: '日本語' },
  { id: 'es', label: 'Español' },
]

/** "ko" / "ko-KR" / "in" -> one of ours, else null (anything that is not a language code is refused). */
export function asUiLocale(v: unknown): UiLocale | null {
  if (typeof v !== 'string' || v.length > 16) return null
  const base = v.toLowerCase().split(/[-_]/)[0]
  if (base === 'ko' || base === 'en' || base === 'id' || base === 'ja' || base === 'es') return base
  if (base === 'in') return 'id' // old Java/Android code for Indonesian
  return null
}
