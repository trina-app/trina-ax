// Screen text by key (tab 5 "다국어"): Korean is the source and the default, English and Indonesian must have the
// same keys (TypeScript checks it; test/unit/i18n.test.ts also checks the {placeholders}).
// Locale: the person's users.locale → the browser's language → the team default (ko). Same before sign-in.
import { create } from 'zustand'
import { DEFAULT_LOCALE, type Locale } from '@mycel/shared/api'
import { en } from './en'
import { id } from './id'
import { ko, type MessageKey } from './ko'

export type { MessageKey }
export const DICTS: Record<Locale, Record<MessageKey, string>> = { ko, en, id }
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
  { id: 'id', label: 'Bahasa Indonesia' },
]

export type Params = Record<string, string | number>

export function format(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] !== undefined ? String(params[k]) : all))
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return format(DICTS[locale][key] ?? ko[key] ?? key, params)
}

/** Browser preference among ko / en / id, or null. */
export function browserLocale(langs: readonly (string | undefined)[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]): Locale | null {
  for (const tag of langs) {
    if (!tag) continue
    const base = tag.toLowerCase().split('-')[0]
    if (base === 'ko' || base === 'en') return base
    if (base === 'id' || base === 'in') return 'id'
  }
  return null
}

export function pickLocale(user: Locale | null | undefined, teamDefault: Locale | null | undefined, langs?: readonly string[]): Locale {
  return user ?? browserLocale(langs) ?? teamDefault ?? DEFAULT_LOCALE
}

interface LocaleState {
  locale: Locale
  setLocale: (l: Locale) => void
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: pickLocale(null, null),
  setLocale: (locale) => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale
    set({ locale })
  },
}))

export const currentLocale = () => useLocaleStore.getState().locale
export const t = (key: MessageKey, params?: Params) => translate(currentLocale(), key, params)

/** t() bound to the current locale; re-renders when the language changes. */
export function useT() {
  const locale = useLocaleStore((s) => s.locale)
  return (key: MessageKey, params?: Params) => translate(locale, key, params)
}
export const useLocale = () => useLocaleStore((s) => s.locale)
