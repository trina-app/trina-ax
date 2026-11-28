// The desktop app's pair page says the real reason it could not link (manual QA 2026-11-28, B: every failure read "the
// desktop app is not running"), and the extension's words follow the person's language and name the real menus (I).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChromeNativeRefusal } from '@mycel/shared/chrome-native'
import { PRODUCT } from '@mycel/shared'
import { FAILURE_TEXT, nativeFailure } from '../../chrome-extension/src/pair-errors'
import { extLocale, fill } from '../../chrome-extension/src/i18n'
import { LOCALES, MESSAGES } from '../../chrome-extension/src/messages'

describe('pair page reasons', () => {
  test('Chrome\'s own errors: no helper for this browser, our id not allowed, the helper died', () => {
    expect(nativeFailure('Specified native messaging host not found.')).toBe('no_host')
    expect(nativeFailure('Access to the specified native messaging host is forbidden.')).toBe('not_accepted')
    expect(nativeFailure('Native host has exited.')).toBe('helper_failed')
    expect(nativeFailure('Error when communicating with the native messaging host.')).toBe('helper_failed')
    expect(nativeFailure('something new')).toBe('no_host')
  })

  test('every reason the app or helper can give has its own sentence, in every language; only "not running" says so', () => {
    for (const r of ChromeNativeRefusal.options) expect(FAILURE_TEXT[r]).toBeDefined()
    expect(new Set(Object.values(FAILURE_TEXT)).size).toBe(Object.keys(FAILURE_TEXT).length)
    for (const loc of LOCALES) for (const key of Object.values(FAILURE_TEXT)) expect(MESSAGES[loc][key].length).toBeGreaterThan(10)
    for (const [why, key] of Object.entries(FAILURE_TEXT)) if (why !== 'app_not_running') expect(MESSAGES.en[key]).not.toContain('not running')
    expect(ChromeNativeRefusal.options).toContain('no_answer')
  })
})

describe('the extension\'s language', () => {
  test('a team language picks the extension\'s table (zh is zh_CN); anything else falls back to the browser\'s', () => {
    expect(extLocale('ko')).toBe('ko')
    expect(extLocale('zh')).toBe('zh_CN')
    expect(extLocale('fr')).toBeNull()
    expect(extLocale(undefined)).toBeNull()
  })

  test('fill puts in the product and the values, as Chrome does', () => {
    expect(fill(MESSAGES.en.connectedTo, ['Acme', 'Mina'])).toBe('Connected to Acme as Mina')
    expect(fill('Use {app}: $1 and $2', ['a$1', 'b'])).toBe(`Use ${PRODUCT.displayName}: a$1 and b`)
  })

  test('"Settings › Browser" in the extension is the web\'s own menu names in all six languages', () => {
    const web = (l: string, key: string) => {
      const src = readFileSync(join(import.meta.dir, `../../web/src/i18n/${l}.ts`), 'utf8')
      const m = new RegExp(`['"]${key.replace(/\./g, '\\.')}['"]: (['"])(.*?)\\1,`).exec(src)
      return m![2]!
    }
    const pairs: [string, string][] = [['en', 'en'], ['ko', 'ko'], ['ja', 'ja'], ['zh_CN', 'zh'], ['es', 'es'], ['id', 'id']]
    for (const [ext, w] of pairs) {
      const words = MESSAGES[ext as (typeof LOCALES)[number]].linksFull
      expect(words).toContain(`${web(w, 'settings.title')} › ${web(w, 'settings.browser')}`)
    }
  })
})
