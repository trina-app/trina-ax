// All five app dictionaries share keys and placeholders (bun run check:i18n).
// Account choice wins, then team default, then English. Browser detection is only for first-run setup.
import { create } from 'zustand'
import { getDesktopBridge, PRODUCT } from '@mycel/shared'
import { DEFAULT_LOCALE, LOCALE_NAMES, LOCALE_ORDER, asLocale, type Locale } from '@mycel/shared/api'
import { dropDoubleHonorifics } from '@mycel/shared/honorific'
import { PLURAL_PATTERN, fillPlurals, pluralNames } from '@mycel/shared/plural'
import { RECENT_LOCALE_KEY, SIGN_IN_LOCALE_KEY } from './recovery-locale'
import { BUNDLED } from './bundled'
import type { MessageKey } from './ko'

export type { MessageKey }
type Dictionary = Record<MessageKey, string>

/**
 * Each language is its own file (about 400 KB each), loaded when it is first shown: the first visit downloads one, not
 * all five (docs/DECISIONS.md "First load: compressed files, one language, formatting on demand"). main.tsx waits for the starting
 * language before the first render, and useLocaleStore.setLocale switches only once the new one is here, so t() always
 * has the words of the language on screen. Under Bun (tests, scripts) bundled.ts has all five from the start.
 */
const LOADERS: Record<Locale, () => Promise<Dictionary>> = {
  ko: () => import('./ko').then((m) => m.ko),
  en: () => import('./en').then((m) => m.en),
  id: () => import('./id').then((m) => m.id),
  ja: () => import('./ja').then((m) => m.ja),
  es: () => import('./es').then((m) => m.es),
}
const loaded: Partial<Record<Locale, Dictionary>> = { ...BUNDLED }
const loading = new Map<Locale, Promise<void>>()

/**
 * The dictionaries loaded so far: all five under Bun (the tests and scripts read them here), in the web build only the
 * languages shown so far. App code reads words through translate / messageOf / hasMessage, never through this
 * (web/test/unit/i18n-on-demand.test.ts checks that).
 */
export const DICTS = loaded as Record<Locale, Dictionary>

export const localeLoaded = (l: Locale): boolean => !!loaded[l]
/** A language as if not loaded yet (web/test/unit/i18n-on-demand.test.ts); loadLocale loads it again. */
export function forgetLocaleForTest(l: Locale) { delete loaded[l] }

/** Load a language's words (once; a load already on its way is shared). Rejects when the file cannot be fetched
 * (offline, or a tab still on an older build after an update): the language on screen stays. */
export function loadLocale(l: Locale): Promise<void> {
  if (loaded[l]) return Promise.resolve()
  let p = loading.get(l)
  if (!p) {
    p = LOADERS[l]().then((d) => { loaded[l] = d }).finally(() => loading.delete(l))
    loading.set(l, p)
  }
  return p
}

/** A text's template in a language (English when that language lacks it), or undefined for an unknown key. */
export function messageOf(locale: Locale, key: MessageKey): string | undefined {
  return loaded[locale]?.[key] ?? loaded[DEFAULT_LOCALE]?.[key]
}

/** Is this a key of the dictionaries (an id the server sent: an audit action, a refusal reason)? Every dictionary has
 * the same keys (bun run check:i18n), so the one on screen answers. */
export function hasMessage(key: string): key is MessageKey {
  const dict = loaded[currentLocale()] ?? Object.values(loaded)[0]
  return !!dict && Object.hasOwn(dict, key)
}
/** Each language named in its own language, English first. */
export const LOCALES: { id: Locale; label: string }[] = LOCALE_ORDER.map((l) => ({ id: l, label: LOCALE_NAMES[l] }))

export type Params = Record<string, string | number>

/** The placeholders of a text, plural ones included ("{n, plural, one {# step} other {# steps}}"; the same in every
 * language). */
export function placeholdersOf(template: string): string[] {
  const names = new Set<string>(pluralNames(template))
  for (const m of template.replace(PLURAL_PATTERN, '').matchAll(/\{(\w+)\}/g)) names.add(m[1]!)
  return [...names].sort()
}

/** Filled in every text without the caller passing them: the product's name lives in shared/src/product.ts only. */
export const PRODUCT_PARAMS: Params = { product: PRODUCT.displayName, productFile: PRODUCT.artifactBase }

/** Korean "(으)로" after a filled-in value, when its last sound can be told: 로 after a vowel or ㄹ, 으로 after another
 * final consonant. A number ends as it is read: 1 2 4 5 7 8 9 (일 이 사 오 칠 팔 구) take 로, 0 3 6 (영·십 삼 육) take
 * 으로, so "v{version}(으)로" reads "v1로", "v3으로". Latin letters and signs keep "(으)로". A value in quotes or
 * brackets is read by its last word ("'주간 회의'로"). */
export function koRo(value: string): string {
  const last = [...value.trim().replace(/['"’”」』»)\]]+$/u, '')].pop() ?? ''
  const c = last.codePointAt(0) ?? 0
  if (c >= 0xac00 && c <= 0xd7a3) return [0, 8].includes((c - 0xac00) % 28) ? '로' : '으로'
  if (/[0-9]/.test(last)) return '036'.includes(last) ? '으로' : '로'
  return '(으)로'
}

/** Korean "(을)를" after a filled-in value, when its last sound can be told: 을 after a final consonant, 를 after a
 * vowel. A number ends as it is read: 2 4 5 9 (이 사 오 구) take 를, the others 을, so "{section}(을)를" reads "숫자를",
 * "제품을", "2를". Latin letters and signs keep "(을)를". */
export function koEul(value: string): string {
  const last = [...value.trim()].pop() ?? ''
  const c = last.codePointAt(0) ?? 0
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? '를' : '을'
  if (/[0-9]/.test(last)) return '2459'.includes(last) ? '를' : '을'
  return '(을)를'
}

export function format(template: string, callerParams?: Params, locale: string = DEFAULT_LOCALE): string {
  const params: Params = { ...PRODUCT_PARAMS, ...callerParams }
  // "{n, plural, one {# step} other {# steps}}": the form for the number in this language (shared/src/plural.ts); the
  // text's own honorific (님, さん) left out when the name has one already, with or without a space before it:
  // "{name}님" and "{name} 님" with 대표님 read "대표님", never "대표님님" (shared/src/honorific.ts); after a value,
  // "(으)로" and "(을)를" as it is read (koRo, koEul)
  return dropDoubleHonorifics(fillPlurals(template, params, locale), params).replace(/\{(\w+)\}(\(으\)로|\(을\)를)?/g, (all, k: string, mark?: string) => {
    if (params[k] === undefined) return all
    const v = String(params[k])
    if (!mark) return v
    if (locale !== 'ko') return v + mark
    return v + (mark === '(으)로' ? koRo(v) : koEul(v))
  })
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return format(messageOf(locale, key) ?? key, params, locale)
}

/** The person's own choice (signed in), else the team default, else English. */
export function pickLocale(user: Locale | null | undefined, teamDefault: Locale | null | undefined): Locale {
  return user ?? teamDefault ?? DEFAULT_LOCALE
}

/** The first of the browser's languages we have (navigator.languages: "ko-KR", "en-US" ...), or null. The first-run
 * setup screen starts in it: before setup there is no team language yet, and a Korean office should not see English. */
export function browserLocale(languages: readonly string[] | undefined): Locale | null {
  for (const l of languages ?? []) {
    const x = asLocale(l)
    if (x) return x
  }
  return null
}

const STORED_KEY = SIGN_IN_LOCALE_KEY
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

const RECENT_KEY = RECENT_LOCALE_KEY
/** Last signed-in screen language, scoped to this team origin. Never a sign-in choice to adopt into an account. */
export function recentLocale(): Locale | null {
  try {
    return asLocale(localStorage.getItem(RECENT_KEY))
  } catch {
    return null
  }
}

export function storeRecentLocale(l: Locale | null): void {
  try {
    if (l) localStorage.setItem(RECENT_KEY, l)
    else localStorage.removeItem(RECENT_KEY)
  } catch {
    /* storage blocked: recovery uses the usual sign-in/default language */
  }
}

interface LocaleState {
  locale: Locale
  /** show this language now (no reload: every screen reads it through useT / useLocale) */
  setLocale: (l: Locale) => void
}

/** the latest language asked for: a load that ends after a later choice does not switch to its language */
let wanted: Locale | null = null

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: storedLocale() ?? DEFAULT_LOCALE,
  setLocale: (locale) => {
    wanted = locale
    if (!loaded[locale]) {
      // shown once its words are here; until then (a moment, or never when offline) the screen keeps its language
      loadLocale(locale).then(
        () => { if (wanted === locale) useLocaleStore.getState().setLocale(locale) },
        () => { /* not loaded: the language on screen stays */ },
      )
      return
    }
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
