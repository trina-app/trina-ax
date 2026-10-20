// Tab 5 "다국어": ko / en / id have the same keys (CI check), the same {placeholders}, and no empty texts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { browserLocale, DICTS, format, pickLocale, translate } from '../../src/i18n'
import { ko } from '../../src/i18n/ko'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('translations', () => {
  test('every language has exactly the Korean keys', () => {
    const keys = Object.keys(ko).sort()
    for (const [loc, d] of Object.entries(DICTS)) expect({ loc, keys: Object.keys(d).sort() }).toEqual({ loc, keys })
  })
  test('placeholders match and no text is empty', () => {
    for (const [loc, d] of Object.entries(DICTS)) {
      for (const [k, v] of Object.entries(d)) {
        expect({ loc, k, empty: !v.trim() }).toEqual({ loc, k, empty: false })
        expect({ loc, k, p: placeholders(v) }).toEqual({ loc, k, p: placeholders(ko[k as keyof typeof ko]) })
      }
    }
  })
  test('no screen text is hard-coded where a key belongs: product name comes from PRODUCT, not "Saram"', () => {
    const src = path.resolve(import.meta.dir, '../../src')
    const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => /\.(tsx?|css)$/.test(f))
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), 'utf8')
      expect({ f, saram: /\bSaram\b/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')) }).toEqual({ f, saram: false })
    }
  })
  test('format, fallback and locale choice', () => {
    expect(format('{a} and {b}', { a: 1 })).toBe('1 and {b}')
    expect(translate('en', 'chat.queued', { n: 3 })).toBe('Waiting (3 ahead)')
    expect(browserLocale(['in-ID'])).toBe('id')
    expect(browserLocale(['fr-FR', 'en-GB'])).toBe('en')
    expect(browserLocale(['fr', undefined])).toBeNull()
    expect(pickLocale(null, 'en', ['fr'])).toBe('en')
    expect(pickLocale('id', 'en', ['ko'])).toBe('id')
    expect(pickLocale(null, null, [])).toBe('ko')
  })
})
