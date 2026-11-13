// The web build's stand-in for bundled.ts (web/scripts/locales-on-demand.ts): no dictionary comes with the app's first
// files; each language is its own file, loaded when it is shown (index.ts loadLocale).
import type { Locale } from '@mycel/shared/api'
import type { MessageKey } from './ko'

export const BUNDLED: Partial<Record<Locale, Record<MessageKey, string>>> = {}
