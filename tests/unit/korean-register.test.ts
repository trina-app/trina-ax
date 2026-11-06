// Korean in 해요체 outside the web app and the server's tables too (docs/DESIGN-SYSTEM.md "Copy and languages"): the
// office Mac's menu bar app, its installer's terminal output and README, and the app messages the install guide quotes.
// The older 합니다체 wording stays only where it matches what was saved (shared/src/api/errors.ts, step-labels.ts) and
// in quotes of other programs' own words (macOS, the browsers).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_ERROR_MESSAGES, ERROR_MESSAGES } from '@mycel/shared/api'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
/** a Korean sentence ending in 합니다체 (…습니다, …합니다, …됩니다, …입니다, …니까) */
const FORMAL = /[가-힣](니다|니까)(?![가-힣])/

/** the lines of `text` with Korean in 합니다체 */
const formalLines = (text: string) => text.split('\n').map((l, i) => `${i + 1}: ${l.trim()}`).filter((l) => FORMAL.test(l))

describe('the office Mac speaks 해요체', () => {
  test('menu bar app: the Korean of every status line', () => {
    // the Korean slot of each T.s(lang, "ko", "en", …) call
    const src = read('menubar/Sources/StatusModel.swift')
    const ko = [...src.matchAll(/T\.s\(lang, "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!)
    expect(ko.length).toBeGreaterThan(10)
    expect(ko.filter((s) => FORMAL.test(s))).toEqual([])
  })
  test("installer's terminal output and the bundle's README", () => {
    expect(formalLines(read('scripts/office/office-install.sh'))).toEqual([])
    expect(formalLines(read('scripts/office/README.txt'))).toEqual([])
  })
})

describe('the install guide quotes what the app says now', () => {
  const guide = read('docs/install/guide.html')
  test('no message that no longer exists', () => {
    expect(guide).not.toContain('팀의 Claude 구독이 아직 연결되지 않았습니다')
    expect(guide).not.toContain('지금은 AI 엔진을 쓸 수 없습니다')
  })
  test('the current wording of a missing Claude connection and an unavailable engine', () => {
    expect(guide).toContain(`“${CHAT_ERROR_MESSAGES.no_credential.ko}”`)
    expect(guide).toContain(`“${CHAT_ERROR_MESSAGES.no_credential.ko.split('.')[0]}”`)
    expect(guide).toContain(`“${ERROR_MESSAGES.engine_unavailable.ko.split('(')[0]!.replace(/\.$/, '')}…”`)
  })
  test('every quoted Korean sentence in 합니다체 is the words of macOS or a browser', () => {
    const OTHERS = ['연결이 비공개로 설정되어 있지 않습니다', '이 연결은 비공개 연결이 아닙니다', 'Trina AX이(가) 차단되었습니다']
    const quoted = [...guide.matchAll(/“([^”]*)”/g)].map((m) => m[1]!).filter((q) => FORMAL.test(q))
    expect([...new Set(quoted)].filter((q) => !OTHERS.includes(q))).toEqual([])
  })
})
