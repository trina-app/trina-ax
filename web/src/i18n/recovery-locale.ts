import type { Locale } from '@mycel/shared/api'

export const RECENT_LOCALE_KEY = 'mycel.recentLocale'
export const SIGN_IN_LOCALE_KEY = 'mycel.locale'

/** Recovery only: never adopt the previous account's language into the next account. `device`: the browser's own
 * language, used only when nothing is stored here (a phone that opened the team but never signed in, QA TC-207).
 * Self-contained so the PWA build can embed this same bounded policy in its offline document. */
export function recoveryLocale(recent: unknown, signIn: unknown, device: unknown = null): Locale {
  for (const value of [recent, signIn, device]) {
    if (value === 'ko' || value === 'en' || value === 'id' || value === 'ja' || value === 'es') return value
  }
  return 'en'
}
