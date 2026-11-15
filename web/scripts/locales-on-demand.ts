// The web build loads one language, not six (docs/DECISIONS.md "First load: compressed files, one language, formatting on demand"):
// src/i18n/index.ts imports `./bundled`, which has every dictionary for Bun (tests, scripts); in the build and the dev
// server that import is src/i18n/bundled.web.ts instead (no dictionary), and index.ts loads each language's own file
// when it is shown (loadLocale).
import path from 'node:path'
import type { Plugin } from 'vite'

const I18N = path.resolve(import.meta.dirname, '../src/i18n')
export const BUNDLED_WEB = path.join(I18N, 'bundled.web.ts')

export function localesOnDemand(): Plugin {
  return {
    name: 'mycel-locales-on-demand',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './bundled' || !importer) return null
      return path.resolve(path.dirname(importer.split('?')[0]!)) === I18N ? BUNDLED_WEB : null
    },
  }
}
