// Tab 5 "다국어": ko / en / id have the same keys (CI check), the same {placeholders}, no empty texts, no Korean left in
// the English and Indonesian texts, and no screen text in Korean outside the Korean dictionary.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE } from '@mycel/shared/api'
import { DICTS, format, LOCALES, pickLocale, translate } from '../../src/i18n'
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
    expect(translate('en', 'chat.queued', { n: 3 })).toBe('Waiting (3 ahead)')
    expect(pickLocale(null, 'ko')).toBe('ko')
    expect(pickLocale('id', 'ko')).toBe('id')
    expect(pickLocale(null, null)).toBe('en')
    expect(DEFAULT_LOCALE).toBe('en')
    // pickers: English first, each language in its own language
    expect(LOCALES).toEqual([{ id: 'en', label: 'English' }, { id: 'ko', label: '한국어' }, { id: 'id', label: 'Bahasa Indonesia' }])
  })
  test('English and Indonesian texts have no Korean left in them', () => {
    for (const loc of ['en', 'id'] as const) {
      for (const [k, v] of Object.entries(DICTS[loc])) expect({ loc, k, korean: HANGUL.test(v) }).toEqual({ loc, k, korean: false })
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
