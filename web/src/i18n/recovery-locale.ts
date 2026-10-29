import type { Locale } from '@mycel/shared/api'

export const RECENT_LOCALE_KEY = 'mycel.recentLocale'
export const SIGN_IN_LOCALE_KEY = 'mycel.locale'

/** Recovery only: never adopt the previous account's language into the next account.
 * Self-contained so the PWA build can embed this same bounded policy in its offline document. */
export function recoveryLocale(recent: unknown, signIn: unknown): Locale {
  for (const value of [recent, signIn]) {
    if (value === 'ko' || value === 'en' || value === 'id') return value
  }
  return 'en'
}
