// A Google Workspace library tool's words on steps and cards in the person's language (free-roam demo QA 2026-11-22
// F4; connections/text.ts GOOGLE_TOOL_WORDS, connections/card-lines.ts toolTitle and fieldWord, text.ts MAIL_FIELD_WORDS).
// Covered: a Gmail tool on a library connection gets Trina's own words in all six languages; another MCP server keeps
// its own title; without a locale the title is as before; the mail field words apply only on a library connection's
// card, so another service's thread_id or references keeps its own words.
import { describe, expect, test } from 'bun:test'
import { Locale } from '@mycel/shared/api'
import { APP_IDS, catalog } from '../../server/src/integrations/google-apps/catalog'
import { cardLines, fieldWord, shownName, toolKindOf, toolTitle, valueWord } from '../../server/src/integrations/connections/card-lines'
import { DEMO_HIGGSFIELD_TOOL_WORDS, FIELD_WORDS, GOOGLE_FIELD_WORDS, GOOGLE_TOOL_WORDS, GOOGLE_VALUE_WORDS, MAIL_FIELD_WORDS } from '../../server/src/integrations/connections/text'
import { HIGGSFIELD_TOOLS } from '../../server/src/demo/fakes/higgsfield'

// demo re-test 11-22: the demo's Higgsfield step stayed "Higgsfield · Generate image" in a Korean chat
describe("the demo Higgsfield's tool titles", () => {
  test('every fake tool in all six languages; a real Higgsfield connection keeps its own title', () => {
    expect(toolTitle({ name: 'generate_image', title: 'Generate image' }, 'ko', 'demo-higgsfield')).toBe('이미지 만들기')
    expect(toolTitle({ name: 'generate_image', title: 'Generate image' }, 'en', 'demo-higgsfield')).toBe('Generate image')
    expect(toolTitle({ name: 'generate_image', title: 'Generate image' }, 'ko')).toBe('Generate image')
    // a tool the fake does not list keeps the service's title
    expect(toolTitle({ name: 'upscale_image', title: 'Upscale image' }, 'ko', 'demo-higgsfield')).toBe('Upscale image')
    for (const tool of HIGGSFIELD_TOOLS) {
      for (const L of Locale.options) expect({ tool: tool.name, L, ok: !!DEMO_HIGGSFIELD_TOOL_WORDS[tool.name]?.[L]?.trim() }).toEqual({ tool: tool.name, L, ok: true })
      expect(DEMO_HIGGSFIELD_TOOL_WORDS[tool.name]!.en).toBe(tool.title)
    }
  })
})

describe('tool titles', () => {
  test('a Gmail tool on the library connection in the person\'s language', () => {
    expect(toolTitle({ name: 'send_gmail_message', title: 'Send Gmail Message' }, 'ko', 'google-apps')).toBe('메일 보내기')
    expect(toolTitle({ name: 'send_gmail_message', title: 'Send Gmail Message' }, 'en', 'google-apps')).toBe('Send email')
    expect(toolTitle({ name: 'search_gmail_messages', title: 'Search Gmail Messages' }, 'ko', 'google-apps')).toBe('메일 찾기')
    expect(toolTitle({ name: 'batch_modify_gmail_message_labels' }, 'en', 'google-apps')).toBe('Change labels on several messages')
  })

  test('another MCP server keeps its own title; no locale keeps it too', () => {
    expect(toolTitle({ name: 'send_gmail_message', title: 'Send Gmail Message' }, 'ko')).toBe('Send Gmail Message')
    expect(toolTitle({ name: 'send_gmail_message', title: 'Send Gmail Message' }, 'ko', toolKindOf({ google_app: null }))).toBe('Send Gmail Message')
    expect(toolTitle({ name: 'send_gmail_message', title: 'Send Gmail Message' }, undefined, 'google-apps')).toBe('Send Gmail Message')
    expect(toolTitle({ name: 'create_page', title: 'Create a page' }, 'ko', 'google-apps')).toBe('Create a page')
    // Calendar, Docs and Sheets in Trina's words too (QA 11-25: "Manage Event" on a Korean card)
    expect(toolTitle({ name: 'manage_event', title: 'Manage Event' }, 'ko', 'google-apps')).toBe('일정 관리')
    expect(toolTitle({ name: 'manage_event', title: 'Manage Event' }, 'ko')).toBe('Manage Event')
    expect(toolKindOf({ google_app: 'gmail' })).toBe('google-apps')
  })

  test('every catalog tool of every app has all six languages', () => {
    for (const tool of APP_IDS.flatMap((a) => catalog(a))) {
      for (const L of Locale.options) expect({ tool: tool.name, L, ok: !!GOOGLE_TOOL_WORDS[tool.name]?.[L]?.trim() }).toEqual({ tool: tool.name, L, ok: true })
    }
  })
})

describe('mail field words', () => {
  test('on a library connection\'s card', () => {
    expect(fieldWord('thread_id', 'ko', MAIL_FIELD_WORDS)).toBe('메일 대화')
    expect(fieldWord('in_reply_to', 'en', MAIL_FIELD_WORDS)).toBe('Reply to')
    expect(fieldWord('references', 'ko', MAIL_FIELD_WORDS)).toBe('이전 메일')
    // the common words still hold
    expect(fieldWord('subject', 'ko', MAIL_FIELD_WORDS)).toBe('제목')
    for (const k of Object.keys(MAIL_FIELD_WORDS)) for (const L of Locale.options) expect(MAIL_FIELD_WORDS[k]![L]?.trim()).toBeTruthy()
    const lines = cardLines({ to: 'a@b.example', thread_id: 'th-1', in_reply_to: '<m@x>' }, 'ko', (k) => k === 'to', () => false, MAIL_FIELD_WORDS)!
    expect(lines.map((l) => l.name)).toEqual(['받는 사람', '메일 대화', '답장할 메일'])
  })

  test('another service keeps its own words', () => {
    expect(fieldWord('thread_id', 'ko')).toBe('Thread id')
    expect(fieldWord('references', 'en')).toBe('References')
    expect(cardLines({ thread_id: 'th-1' }, 'en', () => false)!.map((l) => l.name)).toEqual(['Thread id'])
  })
})

// QA 11-25 on qa.trina.app: a Korean Calendar card said "Action  create", "Start time", "Timezone"
describe('Google field and value words', () => {
  const google = { ...MAIL_FIELD_WORDS, ...GOOGLE_FIELD_WORDS }
  test('an event card in Korean: every name and the action in words; other values as sent', () => {
    const lines = cardLines({ action: 'create', summary: '주간 회의', start_time: '2026-11-26T14:00:00', end_time: '2026-11-26T15:00:00', timezone: 'Asia/Seoul', event_id: 'e1' }, 'ko', () => false, () => false, google, GOOGLE_VALUE_WORDS)!
    expect(lines).toEqual([
      { name: '작업', value: '만들기' }, { name: '제목', value: '주간 회의' }, { name: '시작 시간', value: '2026-11-26T14:00:00' },
      { name: '종료 시간', value: '2026-11-26T15:00:00' }, { name: '시간대', value: 'Asia/Seoul' }, { name: '일정 ID', value: 'e1' },
    ])
    expect(cardLines({ action: 'delete', send_updates: 'externalOnly' }, 'en', () => false, () => false, google, GOOGLE_VALUE_WORDS)).toEqual([{ name: 'Action', value: 'Delete' }, { name: 'Notify guests', value: 'Only guests outside the team' }])
    // a value Trina does not know is shown as sent
    expect(valueWord('action', 'explode', 'ko', GOOGLE_VALUE_WORDS)).toBeNull()
  })

  test('another service: the common words for its names, its values as sent, its summary a summary', () => {
    const lines = cardLines({ action: 'create', start_time: '9:00', summary: 'x' }, 'ko', () => false)!
    expect(lines).toEqual([{ name: '작업', value: 'create' }, { name: '시작 시간', value: '9:00' }, { name: '요약', value: 'x' }])
    // a name in no list: its own words, as before
    expect(fieldWord('conference_passcode', 'ko')).toBe('Conference passcode')
  })

  test('every word in all six languages', () => {
    for (const table of [FIELD_WORDS, GOOGLE_FIELD_WORDS, ...Object.values(GOOGLE_VALUE_WORDS)])
      for (const [k, w] of Object.entries(table)) for (const L of Locale.options) expect({ k, L, ok: !!w[L]?.trim() }).toEqual({ k, L, ok: true })
  })

  test('a service\'s name for a thing on one line, without invisible characters, clipped', () => {
    expect(shownName('  Weekly\n  sync\u200b ')).toBe('Weekly sync')
    expect(shownName('x'.repeat(300))!.length).toBe(120)
    expect(shownName('\u200b')).toBeNull()
    expect(shownName(null)).toBeNull()
  })
})
