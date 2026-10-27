// Tab 5 "다국어": ko / en / id have the same keys (CI check), the same {placeholders}, no empty texts, no Korean left in
// the English and Indonesian texts, and no screen text in Korean outside the Korean dictionary.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE } from '@mycel/shared/api'
import { localizeStep, PRODUCT } from '@mycel/shared'
import { browserLocale, DICTS, format, LOCALES, pickLocale, placeholdersOf, translate } from '../../src/i18n'
import { ko } from '../../src/i18n/ko'

const placeholders = (s: string) => placeholdersOf(s)

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
  test('the product name is never written in a text: {product} / {productFile} fill it from PRODUCT', () => {
    for (const [loc, d] of Object.entries(DICTS)) {
      for (const [k, v] of Object.entries(d)) {
        for (const n of [PRODUCT.displayName, PRODUCT.shortName, PRODUCT.artifactBase]) expect({ loc, k, hardCoded: v.includes(n) }).toEqual({ loc, k, hardCoded: false })
      }
    }
    expect(translate('en', 'browser.desktopOnly')).toBe(`The in-app browser is only available in the ${PRODUCT.displayName} desktop app.`)
    expect(translate('ko', 'apps.winHow')).toContain(`${PRODUCT.artifactBase}-Setup-`)
    expect(format('{product}', { product: 'X' })).toBe('X') // a caller's own value wins
  })
  test('every audit action the server writes has words on the audit screen', () => {
    const server = path.resolve(import.meta.dir, '../../../server/src')
    const actions = new Set<string>()
    for (const f of fs.readdirSync(server, { recursive: true }).map(String).filter((x) => x.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(server, f), 'utf8')
      for (const m of text.matchAll(/action: '([a-z_]+(?:\.[a-z_]+)+|setup)'/g)) actions.add(m[1]!)
    }
    expect(actions.size).toBeGreaterThan(20)
    for (const a of actions) expect({ a, label: `audit.act.${a}` in ko }).toEqual({ a, label: true })
    // file events (migration 001 CHECK list)
    for (const a of ['create', 'update', 'delete', 'conflict', 'rejected', 'upload', 'restore']) expect(`audit.file.${a}` in ko).toBe(true)
  })
  test('format, fallback and locale choice: own choice, else the team default, else English', () => {
    expect(format('{a} and {b}', { a: 1 })).toBe('1 and {b}')
    expect(translate('en', 'chat.queued', { n: 3 })).toBe('Waiting · estimated position 3')
    expect(pickLocale(null, 'ko')).toBe('ko')
    expect(pickLocale('id', 'ko')).toBe('id')
    expect(pickLocale(null, null)).toBe('en')
    expect(DEFAULT_LOCALE).toBe('en')
    // pickers: English first, each language in its own language
    expect(LOCALES).toEqual([{ id: 'en', label: 'English' }, { id: 'ko', label: '한국어' }, { id: 'id', label: 'Bahasa Indonesia' }])
  })
  test('English counts take the singular or the plural form', () => {
    expect(translate('en', 'steps.summary', { n: 1 })).toBe('1 step')
    expect(translate('en', 'steps.summary', { n: 3 })).toBe('3 steps')
    expect(translate('en', 'files.summary.conflicts', { n: 1 })).toBe('1 conflict copy')
    expect(translate('en', 'members.days', { n: 1 })).toBe('1 day')
    expect(translate('en', 'rules.losingLine', { name: 'Lee', paths: 'a/', n: 1 })).toBe('Lee: a/ (1 chat continues without what the AI read there before)')
    expect(translate('ko', 'steps.summary', { n: 1 })).toContain('1')
    expect(placeholdersOf('{n, plural, one {# day} other {# days}} {x}')).toEqual(['n', 'x'])
    // "1 steps" style texts: a count right before an English plural noun must use the plural form
    for (const [k, v] of Object.entries(DICTS.en)) expect({ k, bare: /\{n\} \w+s\b/.test(v) }).toEqual({ k, bare: false })
  })
  test('steps of older answers follow the language on screen', () => {
    expect(localizeStep({ kind: 'tool', tool: 'read', label: 'Read · shared/fruit.md' }, 'ko').label).toBe('파일 읽기 · shared/fruit.md')
    expect(localizeStep({ kind: 'tool', tool: 'remember', label: '기억함: I prefer short answers.' }, 'en').label).toBe('Remembered: I prefer short answers.')
    expect(localizeStep({ kind: 'ask_user', tool: 'ask_user', label: 'Question: Which fruit?', detail: 'Not answered' }, 'ko')).toEqual({ label: '질문: Which fruit?', detail: '답하지 않음' })
    expect(localizeStep({ kind: 'thinking', label: '생각하는 중' }, 'id').label).toBe('Berpikir')
    expect(localizeStep({ kind: 'browser', tool: 'navigate', label: '페이지 열기 · https://a.example' }, 'en').label).toBe('Open page · https://a.example')
    expect(localizeStep({ kind: 'web_search', tool: 'WebSearch', label: 'Cari di web: durian' }, 'en').label).toBe('Web search: durian')
    // a label that is not ours stays as it is
    expect(localizeStep({ kind: 'tool', tool: 'mystery', label: 'Something else' }, 'ko').label).toBe('Something else')
  })
  test('English and Indonesian texts have no Korean left in them', () => {
    for (const loc of ['en', 'id'] as const) {
      for (const [k, v] of Object.entries(DICTS[loc])) expect({ loc, k, korean: HANGUL.test(v) }).toEqual({ loc, k, korean: false })
    }
  })
  test('pages outside src (index.html, the offline page of the service worker) are English', () => {
    const root = path.resolve(import.meta.dir, '../..')
    for (const f of ['index.html', ...fs.readdirSync(path.join(root, 'public')).filter((x) => /\.(js|html)$/.test(x)).map((x) => `public/${x}`)]) {
      const text = stripComments(fs.readFileSync(path.join(root, f), 'utf8'))
      expect({ f, korean: HANGUL.test(text), lang: /<html lang="(?!en")/.test(text) }).toEqual({ f, korean: false, lang: false })
    }
  })
  test('no Korean screen text outside the Korean dictionary (comments aside)', () => {
    const src = path.resolve(import.meta.dir, '../../src')
    // the one place that must recognise a Korean file name: conflict copies made by a Korean team ("충돌 사본")
    const allowed: Record<string, RegExp> = { 'lib/paths.ts': /충돌 사본\|conflict copy\|salinan konflik/ }
    const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f) && f !== path.join('i18n', 'ko.ts'))
    for (const f of files) {
      const lines = stripComments(fs.readFileSync(path.join(src, f), 'utf8')).split('\n')
      // (a regex literal can throw the comment stripper off: lines that look like comment lines are skipped too)
      const bad = lines.filter((l) => HANGUL.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l) && !(allowed[f]?.test(l)))
      expect({ f, bad }).toEqual({ f, bad: [] })
    }
  })
})

const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/

/** Source without // and /* *\/ comments (strings kept; a "//" inside a string ends nothing here: good enough). */
function stripComments(text: string): string {
  let out = ''
  let mode: 'code' | "'" | '"' | '`' | 'line' | 'block' = 'code'
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const n = text[i + 1]
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i++ } else if (c === '\n') out += c
      continue
    }
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i++; continue }
      if (c === '/' && n === '*') { mode = 'block'; i++; continue }
      if (c === "'" || c === '"' || c === '`') mode = c
      out += c
      continue
    }
    if (c === '\\') { out += c + (n ?? ''); i++; continue }
    if (c === mode || (c === '\n' && mode !== '`')) mode = 'code'
    out += c
  }
  return out
}

describe('browserLocale (first-run setup starts in the browser language)', () => {
  test('the first of the browser languages we have', () => {
    expect(browserLocale(['ko-KR', 'en-US'])).toBe('ko')
    expect(browserLocale(['fr-FR', 'id-ID', 'en'])).toBe('id')
    expect(browserLocale(['fr-FR'])).toBeNull()
    expect(browserLocale(undefined)).toBeNull()
  })
})
