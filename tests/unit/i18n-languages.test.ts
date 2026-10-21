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

const ROOT = path.resolve(import.meta.dir, '../..')
const HANGUL = /[ㄱ-ㆎ가-힣]/

function checkTable(name: string, table: Record<string, unknown>) {
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
  expect(n).toBeGreaterThan(3)
}

describe('server and relay texts', () => {
  test('error messages, auth, chat, system and file texts have ko, en and id, without Korean in en / id', () => {
    checkTable('errors', ERROR_MESSAGES)
    checkTable('auth', AUTH_MESSAGES)
    checkTable('chat', CHAT_TEXT)
    checkTable('system', SYSTEM_TEXT)
    checkTable('files', FILE_TEXT)
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
 * from a table: a new Korean string elsewhere is a text that English (the default) would never get.
 */
const KOREAN_ALLOWED: Record<string, string> = {
  'desktop/src/common/i18n.ts': 'the desktop dictionary (ko next to en and id)',
  'desktop/src/common/locales.ts': 'the name 한국어 in the language picker',
  'desktop/src/main/pane/page-script.js': 'Korean synonyms the AI\'s "find" understands on Korean pages (not screen text)',
  'relay/src/pages.ts': 'relay page texts (ko next to en and id)',
  'shared/src/api/common.ts': 'the name 한국어 in language pickers',
  'shared/src/api/errors.ts': 'error messages (ko next to en and id)',
  'server/src/admin/budgets.ts': 'budget texts (ko next to en and id)',
  'server/src/admin/engines.ts': 'engine status texts (ko next to en and id)',
  'server/src/admin/users.ts': 'archived-accounts folder name (ko next to en and id)',
  'server/src/auth/messages.ts': 'auth messages (ko next to en and id)',
  'server/src/chat/i18n.ts': 'chat texts (ko next to en and id)',
  'server/src/chat/prompt.ts': 'the language name given to the model',
  'server/src/files/store.ts': 'conflict copy names (ko next to en and id)',
  'server/src/jobs/service.ts': 'job texts (ko next to en and id)',
  'server/src/jobs/transcribe.ts': 'transcription texts (ko next to en and id) and a whisper marker',
  'server/src/policy/names.ts': 'invisible Hangul filler characters refused in names',
  'server/src/relay-client/index.ts': 'relay notices (ko next to en and id)',
  'server/src/routes/system.ts': 'system screen texts (ko next to en and id)',
  'server/src/system/export.ts': 'export headings (ko next to en and id)',
  'server/src/system/messages.ts': 'diagnostics texts (ko next to en and id)',
  'server/src/team-files/errors.ts': 'file errors (ko next to en and id)',
  'server/src/team-files/place.ts': 'restored names (ko next to en and id)',
  'server/src/tools/make-file.ts': 'a wide-character range for table widths',
  'server/src/tools/url-gate.ts': 'confirmation texts (ko next to en and id)',
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
  test('menubar app: every text is given in Korean, English and Indonesian', () => {
    for (const f of ['menubar/Sources/App.swift', 'menubar/Sources/StatusModel.swift']) {
      const lines = codeLines(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      for (const l of lines.filter((x) => HANGUL.test(x))) expect({ f, l, tri: /T\.s\(lang,\s*"|label\("/.test(l) }).toEqual({ f, l, tri: true })
    }
  })
})
