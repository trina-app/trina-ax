// The Steepling demo story (scripted demo and free roam in 6 languages, the built-in Gmail and Drive fakes) has no
// calendar dates: the launch is "Monday" and the offer runs "two weeks". The banners travel as files (Files, chat, the
// Gmail draft, the free-roam team folder), so a date written into the story goes stale the day it passes and the
// campaign looks over (scripts/demo/steepling/README.md, "Dates"). Lean on purpose: November/December in each
// language's forms, 11월/12월/11月/12月, ISO dates, n/n or n.n ranges, and a day of the month on its own ("the 23rd",
// 23일, 23日, "el 23", "tanggal 23"; a span of days like "2日ほど" or "8일 걸렸어요" is not a date). Older history ("October was our best month")
// still reads as history, so other months are left alone.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { STEEPLING_LOCALES } from '../../scripts/demo/steepling/make'
import { OWN_SKILLS } from '../../scripts/demo/steepling/rich'

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
  /十[一二]\s*月/, // Chinese months in characters: 十一月, 十二月
  /\b20\d\d-\d\d-\d\d\b/,
  /(?<![\d./])(1[0-2]|0?[1-9])\/\d{1,2}(?![\d/])/, // 11/23, 23/11 (a "/" only: "4.0 stars" and "$11.90" are not dates)
  /(?<![\d.])\d{1,2}\.\d{1,2}\s*[–~]/, // the Korean and Chinese range "11.23 ~ 12.6"
]
/** "since <a month>" in every language: a story that started in a named month goes stale as surely as a launch date
 * (the live ko caption said "8월부터" until 2026-11-21) */
const EN_MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'
const ES_MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre'
const ID_MONTHS = 'Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember'
const CN_MONTH = '(?:[一二三四五六七八九]|十[一二]?)\\s*月'
const SINCE: RegExp[] = [
  new RegExp(`\\b(since|from|starting in) (${EN_MONTHS})\\b`, 'i'),
  /(?<![\d.])(1[0-2]|0?[1-9])\s*월\s*(부터|이후)/,
  /(?<![\d.])(1[0-2]|0?[1-9])\s*月\s*(から|以来|起|开始)/,
  /从\s*(1[0-2]|0?[1-9])\s*月/,
  new RegExp(`从\\s*${CN_MONTH}|${CN_MONTH}\\s*(以来|起|开始)`),
  new RegExp(`\\b(desde|a partir de) (${ES_MONTHS})\\b`, 'i'),
  new RegExp(`\\b(sejak|mulai) (${ID_MONTHS})\\b`, 'i'),
]
/** the scripted story's own copy (its captions, mail and banners travel as files and pictures): no month at all, by name
 * or by number, in any language; Steepling's lived-in history ("the October summary") keeps its past months */
const STORY = /^scripts\/demo\/mina\//
const ANY_MONTH: RegExp[] = [
  new RegExp(`\\b(${EN_MONTHS})\\b`),
  /(?<![\d.])(1[0-2]|0?[1-9])\s*월(?!요일)/,
  /(?<![\d.])(1[0-2]|0?[1-9])\s*月(?!曜)/,
  new RegExp(CN_MONTH),
  new RegExp(`\\b(${ES_MONTHS})\\b`, 'i'),
  new RegExp(`\\b(${ID_MONTHS})\\b`),
]
ALL.push(...SINCE)

/** a day of the month without its month ("on track for the 23rd?", "23일 일정"), in every language. A span of days
 * ("2日ほど", "8일 걸렸어요", "10日前", "1日以内") is not one: the words after the number tell them apart. */
const DAY = '(?:[1-9]|[12]\\d|3[01])'
const DAYS: RegExp[] = [
  new RegExp(`\\b${DAY}(?:st|nd|rd|th)\\b`),
  new RegExp(`(?<![\\d.,])${DAY}\\s*일(?!\\s*(?:정도|동안|간|만에|이내|째|전|후|뒤|걸|까지\\s*걸|이상|씩|에\\s*한))`),
  new RegExp(`(?<![\\d.,])${DAY}\\s*[日号](?!\\s*(?:ほど|以内|以上|前|後|間|がかり|かか|も|分|中|内|天|左右|ごと|おき|に一))`),
  new RegExp(`\\bel (?:día )?${DAY}(?![\\d%.,:])\\b`, 'i'),
  new RegExp(`\\btanggal ${DAY}\\b`, 'i'),
]
ALL.push(...DAYS)

/** month names that are written lower case in a language (so matched without case) */
const BY_LOCALE: Record<string, RegExp[]> = {
  es: [/\b(noviembre|diciembre|nov|dic)\b/i],
  id: [/\b(november|desember|nov|des)\b/i],
}

/** the customer-review history in free roam (file "Reviews Oct–Nov.csv" and its month column) reads as the past, not as a
 * campaign window: kept, as the review of this change decided (slow drift, its own change if ever) */
const ALLOWED = [/Oct–Nov|10–11월|十月–十一月/, /^\s*\['(Nov|11월|十一月)',/]

/** a line's words, without a leading record key (`'cv.november': ...`): the keys are rich.ts's shared English ids, never
 * shown, so only the values are checked (the same key is written plainly in every language) */
const visible = (line: string) => line.replace(/^\s*'[\w.-]+':\s*/, '')

const localeOf = (f: string) => /(?:^|[./])(en|ko|ja|zh|es|id)\.(?:ts|md|json)$/.exec(f)?.[1]

describe('the demo story has no calendar dates', () => {
  test('the scan finds the story files', () => {
    expect(files.length).toBeGreaterThan(60)
    expect(files).toContain('scripts/demo/mina/source/banners/copy.ja.json')
    expect(files).toContain('scripts/demo/steepling/strings/rich.ko.ts')
    // every language Steepling is written in: its words, its richer team's words, its own skills
    for (const l of STEEPLING_LOCALES) {
      expect(files).toContain(`scripts/demo/steepling/strings/${l}.ts`)
      expect(files).toContain(`scripts/demo/steepling/strings/rich.${l}.ts`)
      for (const k of OWN_SKILLS) expect(files).toContain(`scripts/demo/steepling/assets/skill-${k}.${l}.md`)
    }
  })

  test('a record key is not words, but a month in its value still is, in every language', () => {
    const hit = (line: string, loc: string) => [...ALL, ...(BY_LOCALE[loc] ?? [])].some((r) => r.test(visible(line)))
    for (const l of STEEPLING_LOCALES) expect(hit(`  'cv.november': 'This month so far: 7 reviews',`, l), l).toBe(false)
    const months: Record<(typeof STEEPLING_LOCALES)[number], string> = {
      en: 'Launch on Nov 23', ko: '11월 23일 런칭', ja: '12月6日まで', zh: '十二月六日截止', es: 'Lanzamiento el 23 de noviembre', id: 'Peluncuran 23 November',
    }
    for (const l of STEEPLING_LOCALES) expect(hit(`  'cv.launch': '${months[l]}',`, l), l).toBe(true)

    // "since <month>" anywhere, in every language (the ko caption's "8월부터")
    for (const line of ['drinking this since August', '저희 팀은 8월부터 몰래', 'チームでは8月からこっそり', '我们团队从 8 月就在', '从八月起', 'lo bebemos desde agosto', 'sudah minum sejak Agustus']) expect(hit(line, 'en'), line).toBe(true)
    // and in the scripted story's copy, any month at all; Monday stays a word
    const story = (line: string) => ANY_MONTH.some((r) => r.test(line))
    for (const line of ['busy August', '바빴던 8월', '忙しかった8月', '八月辛苦了', 'un agosto de trabajo', 'bulan Agustus']) expect(story(line), line).toBe(true)
    for (const line of ['월요일부터', '月曜日から', 'from Monday', 'for months', '몇 달 전부터']) expect(story(line) || hit(line, 'en'), line).toBe(false)
  })

  test('no file names a launch-window date', () => {
    const hits: string[] = []
    for (const f of files) {
      const rules = [...ALL, ...(BY_LOCALE[localeOf(f) ?? ''] ?? []), ...(STORY.test(f) ? ANY_MONTH : [])]
      fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        if (ALLOWED.some((a) => a.test(line))) return
        for (const r of rules) {
          const m = r.exec(visible(line))
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

  test('a day of the month on its own fails in every language; a span of days does not', () => {
    const caught = (s: string, loc: string) => [...ALL, ...(BY_LOCALE[loc] ?? [])].some((r) => r.test(visible(s)))
    // each language's leftover from before Monday (the en and ko lines said "the 23rd" and "23일 일정" until 2026-11-21)
    const day: Record<(typeof STEEPLING_LOCALES)[number], string> = {
      en: `  'mkt.track': 'Quick check: are we on track for the 23rd?',`,
      ko: `  'mkt.track': '하나만 확인할게요. 23일 일정 문제없죠?',`,
      ja: `  'mkt.track': 'ひとつだけ確認です。23日の予定どおりですよね？',`,
      zh: `  'mkt.track': '确认一下：23号上市没问题吧？',`,
      es: `  'mkt.track': 'Una pregunta rápida: ¿vamos bien para el 23?',`,
      id: `  'mkt.track': 'Cek satu hal ya: kita aman untuk tanggal 23, kan?',`,
    }
    for (const l of STEEPLING_LOCALES) expect(caught(day[l], l), l).toBe(true)
    for (const s of ['on the 1st', 'by the 2nd', '5일까지 보내 주세요', '6日まで', '23日に', '23日发布', 'el día 6', 'El 23 de noviembre', 'Tanggal 6']) expect(caught(s, 'en'), s).toBe(true)
    // the same lines as written now, and spans of days the story keeps
    for (const s of ['Quick check: are we on track for Monday?', '하나만 확인할게요. 월요일 일정 문제없죠?', 'ふつうは2日ほど', '보통은 2일 정도', '차는 좋은데 도착까지 8일 걸렸어요.', '10일 전', '10日前', '営業日1日以内に返信',
      '届くまで8日かかりました。', 'ローンチの3日前', '1日がかりで撮影', '최대 8일까지 걸렸어요', 'el 20% de descuento', 'el lunes', 'Top 3 posts', '4.0 stars']) expect(caught(s, 'en'), s).toBe(false)
  })
})
