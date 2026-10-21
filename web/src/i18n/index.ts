// Screen text by key (tab 5 "다국어"): ko / en / id must have the same keys (TypeScript checks it; test/unit/i18n.test.ts
// also checks the {placeholders}, empty texts and Korean left in the English and Indonesian texts).
// Which language (docs/DECISIONS.md "언어"): signed in, the person's own choice, else the team default; before sign-in,
// what the visitor picked on the sign-in screen (kept in this browser), else the team default (GET /api/setup), else
// English. The browser's language does not decide.
import { create } from 'zustand'
import { getDesktopBridge } from '@mycel/shared'
import { DEFAULT_LOCALE, LOCALE_NAMES, LOCALE_ORDER, asLocale, type Locale } from '@mycel/shared/api'
import { en } from './en'
import { id } from './id'
import { ko, type MessageKey } from './ko'

export type { MessageKey }
export const DICTS: Record<Locale, Record<MessageKey, string>> = { ko, en, id }
/** Each language named in its own language, English first. */
export const LOCALES: { id: Locale; label: string }[] = LOCALE_ORDER.map((l) => ({ id: l, label: LOCALE_NAMES[l] }))

export type Params = Record<string, string | number>

/** "{n, plural, one {# step} other {# steps}}": the form Intl.PluralRules picks for the number, # = the number. */
const PLURAL = /\{(\w+), plural,((?:\s*(?:zero|one|two|few|many|other)\s*\{[^{}]*\})+)\s*\}/g
const FORM = /(zero|one|two|few|many|other)\s*\{([^{}]*)\}/g
const pluralRules = new Map<string, Intl.PluralRules>()
function pluralForm(locale: string, n: number): string {
  let r = pluralRules.get(locale)
  if (!r) {
    try {
      r = new Intl.PluralRules(locale)
    } catch {
      r = new Intl.PluralRules('en')
    }
    pluralRules.set(locale, r)
  }
  return r.select(n)
}

/** The placeholders of a text, plural ones included (the same in every language). */
export function placeholdersOf(template: string): string[] {
  const names = new Set<string>()
  for (const m of template.matchAll(PLURAL)) names.add(m[1]!)
  for (const m of template.replace(PLURAL, '').matchAll(/\{(\w+)\}/g)) names.add(m[1]!)
  return [...names].sort()
}

export function format(template: string, params?: Params, locale: string = DEFAULT_LOCALE): string {
  if (!params) return template
  const withPlurals = template.replace(PLURAL, (all, k: string, forms: string) => {
    const v = params[k]
    const n = typeof v === 'number' ? v : Number(v)
    if (v === undefined || !Number.isFinite(n)) return all
    const byForm = new Map([...forms.matchAll(FORM)].map((m) => [m[1]!, m[2]!]))
    const text = byForm.get(pluralForm(locale, n)) ?? byForm.get('other') ?? ''
    return text.replace(/#/g, String(v))
  })
  return withPlurals.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] !== undefined ? String(params[k]) : all))
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return format(DICTS[locale]?.[key] ?? DICTS[DEFAULT_LOCALE][key] ?? key, params, locale)
}

/** The person's own choice (signed in), else the team default, else English. */
export function pickLocale(user: Locale | null | undefined, teamDefault: Locale | null | undefined): Locale {
  return user ?? teamDefault ?? DEFAULT_LOCALE
}

const STORED_KEY = 'mycel.locale'
/** The language picked on the sign-in / invite / reset / setup screens (this browser only), or null. */
export function storedLocale(): Locale | null {
  try {
    return asLocale(localStorage.getItem(STORED_KEY))
  } catch {
    return null // storage blocked (private window, previews): no remembered choice
  }
}
export function storeLocale(l: Locale | null): void {
  try {
    if (l) localStorage.setItem(STORED_KEY, l)
    else localStorage.removeItem(STORED_KEY)
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

interface LocaleState {
  locale: Locale
  /** show this language now (no reload: every screen reads it through useT / useLocale) */
  setLocale: (l: Locale) => void
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: storedLocale() ?? DEFAULT_LOCALE,
  setLocale: (locale) => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale
      // the relay's own pages (team server offline) read it: relay/src/pages.ts LOCALE_COOKIE
      try {
        document.cookie = `mycel_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
      } catch {
        /* cookies blocked: relay pages fall back to English */
      }
    }
    // the desktop app's own screens, menus and prompts follow the page (older desktop apps lack setLocale)
    try {
      getDesktopBridge()?.setLocale?.(locale)
    } catch {
      /* not in the desktop app */
    }
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
