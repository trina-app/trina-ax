// The web build loads one language at a time (src/i18n/index.ts loadLocale, scripts/locales-on-demand.ts; docs/
// DECISIONS.md "First load: compressed files, one language, formatting on demand"). Under Bun every dictionary is there from the start
// (bundled.ts), so these tests take a language away (forgetLocaleForTest) to see the step before it is loaded.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DICTS, forgetLocaleForTest, hasMessage, loadLocale, localeLoaded, messageOf, translate, useLocaleStore } from '../../src/i18n'
import { BUNDLED_WEB, localesOnDemand } from '../../scripts/locales-on-demand'

const SRC = path.resolve(import.meta.dir, '../../src')
const I18N = path.join(SRC, 'i18n')

afterEach(async () => {
  for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) await loadLocale(l)
  useLocaleStore.getState().setLocale('en')
})

test('a language that is not loaded is shown once its words are here, not before', async () => {
  useLocaleStore.getState().setLocale('en')
  forgetLocaleForTest('ja')
  expect(localeLoaded('ja')).toBe(false)
  useLocaleStore.getState().setLocale('ja')
  // the screen keeps English meanwhile: t() never shows keys or another language's words in the wrong place
  expect(useLocaleStore.getState().locale).toBe('en')
  await loadLocale('ja')
  await Promise.resolve()
  expect(useLocaleStore.getState().locale).toBe('ja')
  expect(translate('ja', 'common.retry')).toBe(DICTS.ja['common.retry'])
})

test('the latest choice wins over a language still loading', async () => {
  useLocaleStore.getState().setLocale('en')
  forgetLocaleForTest('es')
  useLocaleStore.getState().setLocale('es')
  useLocaleStore.getState().setLocale('ko')
  expect(useLocaleStore.getState().locale).toBe('ko')
  await loadLocale('es')
  await Promise.resolve()
  expect(useLocaleStore.getState().locale).toBe('ko')
})

test('one load per language, shared while it is on its way', async () => {
  forgetLocaleForTest('id')
  const a = loadLocale('id')
  const b = loadLocale('id')
  expect(a).toBe(b)
  await a
  expect(localeLoaded('id')).toBe(true)
})

test('words fall back to English, then to the key; hasMessage answers from the language on screen', () => {
  forgetLocaleForTest('ja')
  expect(messageOf('ja', 'common.retry')).toBe(DICTS.en['common.retry'])
  expect(hasMessage('common.retry')).toBe(true)
  expect(hasMessage('audit.act.no-such-action')).toBe(false)
  expect(hasMessage('constructor')).toBe(false)
})

test('app code reads words through translate / messageOf / hasMessage, never the dictionaries themselves', () => {
  const offenders: string[] = []
  for (const f of fs.readdirSync(SRC, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f))) {
    const file = path.join(SRC, f)
    if (path.dirname(file) === I18N) continue
    const text = fs.readFileSync(file, 'utf8')
    // a value import of a dictionary file (a type import of MessageKey is fine: it leaves nothing in the build)
    if (/^import\s+(?!type\b)[^;\n]*from\s+'[./]*(?:\.\.\/)*i18n\/(?:ko|en|id|ja|es|bundled)'/m.test(text)) offenders.push(`${f}: imports a dictionary`)
    if (/\bDICTS\b/.test(text)) offenders.push(`${f}: reads DICTS`)
  }
  expect(offenders).toEqual([])
})

test('the build swaps the bundled dictionaries for none, only for i18n/index.ts', () => {
  const plugin = localesOnDemand() as unknown as { resolveId: (s: string, i?: string) => string | null }
  expect(plugin.resolveId('./bundled', path.join(I18N, 'index.ts'))).toBe(BUNDLED_WEB)
  expect(plugin.resolveId('./bundled', path.join(SRC, 'lib', 'x.ts'))).toBeNull()
  expect(plugin.resolveId('./ko', path.join(I18N, 'index.ts'))).toBeNull()
  // the stand-in has the same export, with nothing in it
  expect(fs.readFileSync(BUNDLED_WEB, 'utf8')).toMatch(/export const BUNDLED: [^=]+= \{\}/)
  // and index.ts loads every language by a dynamic import of its own file
  const index = fs.readFileSync(path.join(I18N, 'index.ts'), 'utf8')
  for (const l of ['ko', 'en', 'id', 'ja', 'es']) expect(index).toContain(`import('./${l}')`)
})
