// Every dictionary, loaded with the module: what Bun gets (the unit tests, the e2e specs, scripts/check-i18n.ts, the
// build's own scripts). The web build never ships this file: web/scripts/locales-on-demand.ts puts bundled.web.ts in
// its place, so a page downloads only the language it shows (index.ts loadLocale).
import type { Locale } from '@mycel/shared/api'
import { en } from './en'
import { es } from './es'
import { id } from './id'
import { ja } from './ja'
import { ko, type MessageKey } from './ko'
import { zh } from './zh'

export const BUNDLED: Partial<Record<Locale, Record<MessageKey, string>>> = { ko, en, id, ja, es, zh }
