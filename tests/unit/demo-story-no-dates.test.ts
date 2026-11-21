// The Steepling demo story (scripted demo in 6 languages, free roam en/ko, the built-in Gmail and Drive fakes) has no
// calendar dates: the launch is "Monday" and the offer runs "two weeks". The banners travel as files (Files, chat, the
// Gmail draft, the free-roam team folder), so a date written into the story goes stale the day it passes and the
// campaign looks over (scripts/demo/steepling/README.md, "Dates"). Lean on purpose: November/December in each
// language's forms, 11월/12월/11月/12月, ISO dates and n/n or n.n ranges. Older history ("October was our best month")
// still reads as history, so other months are left alone.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dir, '..', '..')

const SOURCES = [
  'scripts/demo/mina/strings',
  'scripts/demo/mina/assets',
  'scripts/demo/mina/source/banners',
  'scripts/demo/mina/story.ts',
  'scripts/demo/steepling/strings',
  'scripts/demo/steepling/assets',
  'scripts/demo/steepling/make.ts',
  'scripts/demo/steepling/rich.ts',
  'server/src/demo/fakes/gmail.ts',
  'server/src/demo/fakes/drive.ts',
]

const TEXT = /\.(ts|md|json)$/
const files = SOURCES.flatMap((s) => {
  const full = path.join(ROOT, s)
  if (fs.statSync(full).isFile()) return [s]
  return fs.readdirSync(full).filter((f) => TEXT.test(f)).map((f) => `${s}/${f}`)
})

/** every language's patterns */
const ALL: RegExp[] = [
  /\b(Nov|Dec|November|December)\b/, // English names are case-sensitive: "dec" and "nov" are not words a story uses
  /1[12]\s*월/,
  /1[12]\s*月/,
  /\b20\d\d-\d\d-\d\d\b/,
  /(?<![\d./])(1[0-2]|0?[1-9])\/\d{1,2}(?![\d/])/, // 11/23, 23/11 (a "/" only: "4.0 stars" and "$11.90" are not dates)
  /(?<![\d.])\d{1,2}\.\d{1,2}\s*[–~]/, // the Korean and Chinese range "11.23 ~ 12.6"
]
/** month names that are written lower case in a language (so matched without case) */
const BY_LOCALE: Record<string, RegExp[]> = {
  es: [/\b(noviembre|diciembre|nov|dic)\b/i],
  id: [/\b(november|desember|nov|des)\b/i],
}

/** the customer-review history in free roam (file "Reviews Oct–Nov.csv" and its month column) reads as the past, not as a
 * campaign window: kept, as the review of this change decided (slow drift, its own change if ever) */
const ALLOWED = [/Oct–Nov|10–11월/, /^\s*\['(Nov|11월)',/]

const localeOf = (f: string) => /(?:^|[./])(en|ko|ja|zh|es|id)\.(?:ts|md|json)$/.exec(f)?.[1]

describe('the demo story has no calendar dates', () => {
  test('the scan finds the story files', () => {
    expect(files.length).toBeGreaterThan(60)
    expect(files).toContain('scripts/demo/mina/source/banners/copy.ja.json')
    expect(files).toContain('scripts/demo/steepling/strings/rich.ko.ts')
  })

  test('no file names a launch-window date', () => {
    const hits: string[] = []
    for (const f of files) {
      const rules = [...ALL, ...(BY_LOCALE[localeOf(f) ?? ''] ?? [])]
      fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        if (ALLOWED.some((a) => a.test(line))) return
        for (const r of rules) {
          const m = r.exec(line)
          if (m) hits.push(`${f}:${i + 1} "${m[0]}": ${line.trim().slice(0, 120)}`)
        }
      })
    }
    expect(hits).toEqual([])
  })

  test('the patterns catch the forms the story used to have', () => {
    const caught = (s: string, loc = 'en') => [...ALL, ...(BY_LOCALE[loc] ?? [])].some((r) => r.test(s))
    for (const s of ['Monday Nov 23', 'until December 6', '11월 23일', '12月6日まで', '11/23 ~ 12/6', '11.23 – 12.6', '2026-11-23']) expect(caught(s)).toBe(true)
    expect(caught('23 nov – 6 dic', 'es')).toBe(true)
    expect(caught('23 Nov – 6 Des', 'id')).toBe(true)
    for (const s of ['4.0 stars', '$11.90 for 10 bags', 'Bun 1.3.12', '월 40박스', '2日ほど', '월요일', '1200×628', '1:1 and 9:16']) expect(caught(s)).toBe(false)
  })
})
