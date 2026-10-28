// English is the default language, so every user-facing text table has English (and Indonesian) next to Korean, with
// no Korean left in them, and no Korean screen text hides outside those tables (docs/DECISIONS.md "언어").
// The web app's dictionaries are checked in web/test/unit/i18n.test.ts, the desktop app's in e-desktop-common.test.ts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_ERROR_MESSAGES, chatErrorReason, ERROR_MESSAGES, LOCALE_NAMES, Locale, type ChatErrorReason } from '@mycel/shared/api'
import { AUTH_MESSAGES } from '../../server/src/auth/messages'
import { engineError, TEXT as CHAT_TEXT } from '../../server/src/chat/i18n'
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
import { TEXT as FILE_MOVE_TEXT } from '../../server/src/tools/file-moves'
import { TEXT as INTEGRATION_TEXT } from '../../server/src/integrations/connections/text'
import { TEXT as TEAM_ICON_TEXT } from '../../server/src/admin/team-icon'
import { TEXT as PUSH_TEXT } from '../../server/src/notifications/text'

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
    checkTable('chat errors', CHAT_ERROR_MESSAGES)
    checkTable('auth', AUTH_MESSAGES)
    checkTable('chat', CHAT_TEXT)
    checkTable('system', SYSTEM_TEXT)
    checkTable('files', FILE_TEXT)
    checkTable('steps', STEP_TEXT)
    checkTable('file step verbs', FILE_STEP_VERB)
    checkTable('browser step verbs', BROWSER_STEP_VERB)
    checkTable('engines', ENGINE_TEXT)
    checkTable('url gate', URL_GATE_TEXT, 2)
    checkTable('file moves', FILE_MOVE_TEXT)
    checkTable('external-service connections', INTEGRATION_TEXT)
    checkTable('team logo', TEAM_ICON_TEXT)
    checkTable('push notifications', PUSH_TEXT)
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
  'server/src/notifications/text.ts': { why: 'generic push notification texts (ko next to en and id)' },
  'desktop/src/common/i18n.ts': { why: 'the desktop dictionary (ko next to en and id)', also: /^\s*'[\w.]+': '/ },
  'desktop/src/common/locales.ts': { why: 'the name 한국어 in the language picker', also: /label: '한국어'/ },
  'desktop/src/main/pane/page-script.js': { why: 'Korean synonyms the AI\'s "find" understands on Korean pages (not screen text)', also: /./ },
  'relay/src/pages.ts': { why: 'relay page texts (ko next to en and id)', also: /if \(lang === 'ko'\)/ },
  'shared/src/api/common.ts': { why: 'the name 한국어 in language pickers', also: /ko: '한국어'/ },
  'shared/src/api/errors.ts': { why: 'error messages (ko next to en and id)' },
  'shared/src/step-labels.ts': { why: 'step words (ko next to en and id)' },
  'shared/src/secrets.ts': { why: 'Korean words that announce a password or token in pasted text (not screen text)', also: /비밀번호\|비번\|패스워드/ },
  'server/src/admin/budgets.ts': { why: 'budget texts (ko next to en and id)' },
  'server/src/files/hwp.ts': { why: 'the HWP term 배포용 in a note to the AI about a distribution document (not screen text)', also: /\(배포용\)/ },
  'server/src/admin/engines.ts': { why: 'engine status texts (ko next to en and id)' },
  'server/src/admin/users.ts': { why: 'archived-accounts folder name (ko next to en and id)' },
  'server/src/auth/messages.ts': { why: 'auth messages (ko next to en and id)' },
  'server/src/chat/i18n.ts': { why: 'chat texts (ko next to en and id)' },
  'server/src/credentials/i18n.ts': { why: 'AI connection texts: states, checks, notices (ko next to en and id)' },
  'server/src/credentials/migrate.ts': { why: 'names of connections moved from the older setup (ko next to en and id)' },
  'server/src/skills/text.ts': { why: 'team skills texts: the confirmation card, notices, errors (ko next to en and id)' },
  'server/src/chat/prompt.ts': { why: 'the language name given to the model', also: /ko: 'Korean \(한국어\)'/ },
  'server/src/files/store.ts': { why: 'conflict copy names (ko next to en and id)', also: /충돌 사본\|/ },
  'server/src/jobs/service.ts': { why: 'job texts (ko next to en and id)' },
  'server/src/jobs/transcribe.ts': { why: 'transcription texts (ko next to en and id) and a whisper marker', also: /^\s*'[^']*',$|MUSIC\|음악/ },
  'server/src/office/cli.ts': { why: 'office-mode terminal output for the office owner, Korean and English side by side (docs/OFFICE.md)', also: /./ },
  'server/src/office/update-cli.ts': { why: 'teamax update terminal output for the office owner, Korean and English side by side (docs/OFFICE.md)', also: /./ },
  'server/src/office/helper.ts': { why: 'the office certificate page, Korean then English on one page (no session, no language picker; docs/OFFICE.md)', also: /./ },
  'server/src/policy/names.ts': { why: 'invisible Hangul filler characters refused in names', also: /const INVISIBLE/ },
  'server/src/routes/office-update.ts': { why: 'automatic update messages (ko next to en and id)' },
  'server/src/relay-client/index.ts': { why: 'relay notices (ko next to en and id)' },
  'server/src/routes/system.ts': { why: 'system screen texts (ko next to en and id)' },
  'server/src/system/export.ts': { why: 'export headings (ko next to en and id)' },
  'server/src/system/messages.ts': { why: 'diagnostics texts (ko next to en and id)' },
  'server/src/team-files/errors.ts': { why: 'file errors (ko next to en and id)' },
  'server/src/team-files/place.ts': { why: 'restored names (ko next to en and id)', also: /복원됨\|/ },
  'server/src/tools/make-file.ts': { why: 'a wide-character range for table widths', also: /가-힣|\\uAC00|ᄀ/ },
  'server/src/tools/url-gate.ts': { why: 'confirmation texts (ko next to en and id)' },
  'server/src/tools/file-moves.ts': { why: 'the move / copy confirmation texts (ko next to en and id)' },
  'server/src/integrations/connections/text.ts': { why: 'external-service connection texts: the confirmation card, refusals, check results (ko next to en and id)' },
  'server/src/admin/team-icon.ts': { why: 'team logo upload refusals (ko next to en and id)' },
  'server/src/tools/higgsfield.ts': { why: 'the video confirmation card (ko next to en and id)' },
  'server/src/chat/runtime.ts': { why: 'queue-full messages (ko next to en and id)' },
  'server/src/system/limits.ts': { why: 'plan limit messages: seats, concurrency (ko next to en and id)' },
  'server/src/system/storage.ts': { why: 'the storage notice (ko next to en and id)' },
  'server/src/system/egress.ts': { why: 'the cloud API address refusal (ko next to en and id)' },
  'server/src/system/messages-linux.ts': { why: 'Linux and cloud diagnostics texts (ko next to en and id)' },
  'server/src/system/update-job.ts': { why: 'update progress lines (ko next to en and id)' },
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

describe('stored chat error reasons', () => {
  test('new errors preserve the reason, retry delay and localized fallback in every language', () => {
    for (const reason of Object.keys(CHAT_ERROR_MESSAGES) as ChatErrorReason[]) {
      for (const locale of Locale.options) {
        const error = engineError(reason, locale, 17)
        expect(error).toEqual({ code: CHAT_ERROR_MESSAGES[reason].code, message: CHAT_ERROR_MESSAGES[reason][locale], params: { reason }, retryAfter: 17 })
        expect(chatErrorReason({ ...error, message: 'An older fallback phrase' })).toBe(reason)
      }
    }
  })
  test('legacy official phrases match exactly, with their code, for all three languages', () => {
    for (const reason of Object.keys(CHAT_ERROR_MESSAGES) as ChatErrorReason[]) {
      const text = CHAT_ERROR_MESSAGES[reason]
      for (const locale of Locale.options) {
        expect(chatErrorReason({ code: text.code, message: text[locale] })).toBe(reason)
        expect(chatErrorReason({ code: 'bad_request', message: text[locale] })).toBeNull()
        expect(chatErrorReason({ code: text.code, message: text[locale] + ' Details.' })).toBeNull()
      }
    }
  })
  test('unknown reasons or messages and mismatched codes are not reinterpreted', () => {
    const error = engineError('auth', 'ko')
    for (const reason of ['future_failure', '__proto__', 'toString', 1, false]) {
      expect(chatErrorReason({ ...error, params: { reason } })).toBeNull()
    }
    expect(chatErrorReason({ ...error, code: 'forbidden' })).toBeNull()
    expect(chatErrorReason({ code: 'engine_unavailable', message: 'Unknown upstream failure' })).toBeNull()
    expect(chatErrorReason({ code: 'engine_unavailable', message: ` ${error.message}` })).toBeNull()
  })
  test('auth, absent credentials, proxy startup and missing engines remain different reasons', () => {
    const reasons = ['auth', 'no_credential', 'proxy_down', 'engine_missing'] as const
    expect(reasons.map(reason => engineError(reason, 'ko').code)).toEqual(reasons.map(() => 'engine_unavailable'))
    expect(new Set(reasons.map(reason => engineError(reason, 'id').message)).size).toBe(reasons.length)
    expect(chatErrorReason(engineError('wall_timeout', 'ko'))).toBe('wall_timeout')
    expect(chatErrorReason(engineError('timeout', 'ko'))).toBe('timeout')
  })
})
