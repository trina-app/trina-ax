// English is the default language, so every user-facing text table has English (and Indonesian) next to Korean, with
// no Korean left in them, and no Korean screen text hides outside those tables (docs/DECISIONS.md "언어").
// The web app's dictionaries are checked in web/test/unit/i18n.test.ts, the desktop app's in e-desktop-common.test.ts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ERROR_MESSAGES, LOCALE_NAMES, Locale } from '@mycel/shared/api'
import { AUTH_MESSAGES } from '../../server/src/auth/messages'
import { TEXT as CHAT_TEXT } from '../../server/src/chat/i18n'
import { M as SYSTEM_TEXT } from '../../server/src/system/messages'
import { MSG as FILE_TEXT } from '../../server/src/team-files/errors'
import { pageMessage, type PageKind } from '../../relay/src/pages'
import { BROWSER_STEP_VERB, FILE_STEP_VERB, STEP_TEXT } from '@mycel/shared'
import { PERIOD } from '../../server/src/admin/budgets'
import { T as ENGINE_TEXT } from '../../server/src/admin/engines'
import { ARCHIVE_DIR } from '../../server/src/admin/users'
import { CONFLICT_COPY } from '../../server/src/files/store'
import { INTERRUPTED } from '../../server/src/jobs/service'
import { LABELS as TRANSCRIBE_TEXT } from '../../server/src/jobs/transcribe'
import { NOTICES } from '../../server/src/relay-client/index'
import { T as SYSTEM_ROUTE_TEXT } from '../../server/src/routes/system'
import { MD_WORDS } from '../../server/src/system/export'
import { RESTORED } from '../../server/src/team-files/place'
import { TEXT as URL_GATE_TEXT } from '../../server/src/tools/url-gate'

const ROOT = path.resolve(import.meta.dir, '../..')
const HANGUL = /[ㄱ-ㆎ가-힣]/

function checkTable(name: string, table: Record<string, unknown>, atLeast = 4) {
  let n = 0
  for (const [k, v] of Object.entries(table)) {
    const entry = typeof v === 'function' ? (v as (...a: string[]) => unknown)('1', '2', '3') : v
    if (!entry || typeof entry !== 'object' || !('ko' in entry)) continue
    const e = entry as Record<string, unknown>
    for (const l of Locale.options) {
      const text = e[l]
      const s = typeof text === 'function' ? String((text as (n: number) => unknown)(1)) : text
      expect({ name, k, l, ok: typeof s === 'string' && s.trim().length > 0 }).toEqual({ name, k, l, ok: true })
      if (l !== 'ko') expect({ name, k, l, korean: HANGUL.test(String(s)) }).toEqual({ name, k, l, korean: false })
    }
    n++
  }
  expect({ name, n: n >= atLeast }).toEqual({ name, n: true })
}

describe('server and relay texts', () => {
  test('error messages, auth, chat, system and file texts have ko, en and id, without Korean in en / id', () => {
    checkTable('errors', ERROR_MESSAGES)
    checkTable('auth', AUTH_MESSAGES)
    checkTable('chat', CHAT_TEXT)
    checkTable('system', SYSTEM_TEXT)
    checkTable('files', FILE_TEXT)
    checkTable('steps', STEP_TEXT)
    checkTable('file step verbs', FILE_STEP_VERB)
    checkTable('browser step verbs', BROWSER_STEP_VERB)
    checkTable('engines', ENGINE_TEXT)
    checkTable('url gate', URL_GATE_TEXT, 2)
    checkTable('system routes', SYSTEM_ROUTE_TEXT)
    checkTable('relay notices', NOTICES, 2)
    checkTable('budget periods', PERIOD, 2)
    checkTable('transcription', TRANSCRIBE_TEXT, 3)
    checkTable('one-liners', { INTERRUPTED, ARCHIVE_DIR, CONFLICT_COPY, RESTORED }, 4)
    // export headings: a table per language
    checkTable('export words', Object.fromEntries(Object.keys(MD_WORDS.en).map((k) => [k, Object.fromEntries(Object.entries(MD_WORDS).map(([l, w]) => [l, (w as Record<string, string>)[k]]))])), 2)
  })
  test('relay pages', () => {
    const kinds: PageKind[] = ['team_offline', 'team_unknown', 'team_suspended', 'team_busy', 'team_timeout', 'team_connection_lost', 'bad_gateway', 'bad_request', 'request_timeout']
    for (const k of kinds) for (const l of ['en', 'id'] as const) expect({ k, l, korean: HANGUL.test(pageMessage(k, l, 120_000)) }).toEqual({ k, l, korean: false })
  })
  test('language pickers name each language in its own language', () => {
    expect(LOCALE_NAMES).toEqual({ en: 'English', ko: '한국어', id: 'Bahasa Indonesia' })
  })
})

/**
 * Files whose code may contain Korean, and why. Everything else (components, routes, services) must take its words
 * from a table: a new Korean string elsewhere is a text that English (the default) would never get. Within these
 * files only lines that are the Korean slot of a ko / en / id table entry (`ko: '…'`, or the first text of a
 * `t('…', 'English', 'Indonesian')` / `fail('…', …)` call) may hold Korean, plus the lines a file's own pattern names.
 */
const KOREAN_ALLOWED: Record<string, { why: string; also?: RegExp }> = {
  'desktop/src/common/i18n.ts': { why: 'the desktop dictionary (ko next to en and id)', also: /^\s*'[\w.]+': '/ },
  'desktop/src/common/locales.ts': { why: 'the name 한국어 in the language picker', also: /label: '한국어'/ },
  'desktop/src/main/pane/page-script.js': { why: 'Korean synonyms the AI\'s "find" understands on Korean pages (not screen text)', also: /./ },
  'relay/src/pages.ts': { why: 'relay page texts (ko next to en and id)', also: /if \(lang === 'ko'\)/ },
  'shared/src/api/common.ts': { why: 'the name 한국어 in language pickers', also: /ko: '한국어'/ },
  'shared/src/api/errors.ts': { why: 'error messages (ko next to en and id)' },
  'shared/src/step-labels.ts': { why: 'step words (ko next to en and id)' },
  'server/src/admin/budgets.ts': { why: 'budget texts (ko next to en and id)' },
  'server/src/admin/engines.ts': { why: 'engine status texts (ko next to en and id)' },
  'server/src/admin/users.ts': { why: 'archived-accounts folder name (ko next to en and id)' },
  'server/src/auth/messages.ts': { why: 'auth messages (ko next to en and id)' },
  'server/src/chat/i18n.ts': { why: 'chat texts (ko next to en and id)' },
  'server/src/chat/prompt.ts': { why: 'the language name given to the model', also: /ko: 'Korean \(한국어\)'/ },
  'server/src/files/store.ts': { why: 'conflict copy names (ko next to en and id)', also: /충돌 사본\|/ },
  'server/src/jobs/service.ts': { why: 'job texts (ko next to en and id)' },
  'server/src/jobs/transcribe.ts': { why: 'transcription texts (ko next to en and id) and a whisper marker', also: /^\s*'[^']*',$|MUSIC\|음악/ },
  'server/src/office/cli.ts': { why: 'office-mode terminal output for the clinic owner, Korean and English side by side (docs/OFFICE.md)', also: /./ },
  'server/src/office/helper.ts': { why: 'the office certificate page, Korean then English on one page (no session, no language picker; docs/OFFICE.md)', also: /./ },
  'server/src/policy/names.ts': { why: 'invisible Hangul filler characters refused in names', also: /const INVISIBLE/ },
  'server/src/relay-client/index.ts': { why: 'relay notices (ko next to en and id)' },
  'server/src/routes/system.ts': { why: 'system screen texts (ko next to en and id)' },
  'server/src/system/export.ts': { why: 'export headings (ko next to en and id)' },
  'server/src/system/messages.ts': { why: 'diagnostics texts (ko next to en and id)' },
  'server/src/team-files/errors.ts': { why: 'file errors (ko next to en and id)' },
  'server/src/team-files/place.ts': { why: 'restored names (ko next to en and id)', also: /복원됨\|/ },
  'server/src/tools/make-file.ts': { why: 'a wide-character range for table widths', also: /가-힣|\\uAC00|ᄀ/ },
  'server/src/tools/url-gate.ts': { why: 'confirmation texts (ko next to en and id)' },
}

/** Whether every Korean text on the line is the Korean slot of a table entry: `ko: '…'` (or `ko: (n) => `…``, or
 * `ko: { title: '…', … }`), or
 * the first text of `t('…', '…', '…')` / `fail('…', …)`. */
function isKoreanSlot(line: string): boolean {
  const rest = line
    .replace(/\bko:\s*\{[^{}]*\}/g, '')
    .replace(/\bko:\s*(?:\([^)]*\)\s*=>\s*)?(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '')
    .replace(/\b(?:t|fail)\(\s*(['"`])(?:\\.|(?!\1)[\s\S])*\1(?=\s*,)/g, '')
  return !HANGUL.test(rest)
}

/** Source without comments (strings kept). Lines that still look like comment lines are dropped as well. */
function codeLines(text: string): string[] {
  let out = ''
  let mode: 'code' | "'" | '"' | '`' | 'line' | 'block' = 'code'
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const n = text[i + 1]
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } continue }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i++ } else if (c === '\n') out += c; continue }
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
  return out.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
}

describe('no Korean screen text outside the language tables', () => {
  test('server, desktop, relay and shared code', () => {
    const found = new Set<string>()
    for (const dir of ['server/src', 'desktop/src', 'relay/src', 'shared/src']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir), { recursive: true }).map(String)) {
        if (!/\.(ts|tsx|js)$/.test(f)) continue
        const rel = `${dir}/${f}`
        if (codeLines(fs.readFileSync(path.join(ROOT, rel), 'utf8')).some((l) => HANGUL.test(l))) found.add(rel)
      }
    }
    const unexpected = [...found].filter((f) => !(f in KOREAN_ALLOWED))
    expect(unexpected).toEqual([])
  })
  test('in the files that may hold Korean, only the Korean slots of language tables do', () => {
    for (const [f, rule] of Object.entries(KOREAN_ALLOWED)) {
      const bad = codeLines(fs.readFileSync(path.join(ROOT, f), 'utf8')).filter((l) => HANGUL.test(l) && !isKoreanSlot(l) && !rule.also?.test(l))
      expect({ f, bad }).toEqual({ f, bad: [] })
    }
  })
  test('menubar app: every text is given in Korean, English and Indonesian', () => {
    for (const f of ['menubar/Sources/App.swift', 'menubar/Sources/StatusModel.swift']) {
      const lines = codeLines(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      for (const l of lines.filter((x) => HANGUL.test(x))) expect({ f, l, tri: /T\.s\(lang,\s*"|label\("/.test(l) }).toEqual({ f, l, tri: true })
    }
  })
})
