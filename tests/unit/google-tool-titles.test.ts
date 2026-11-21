// A Google Workspace library tool's words on steps and cards in the person's language (free-roam demo QA 2026-11-22
// F4; connections/text.ts GOOGLE_TOOL_WORDS, connections/card-lines.ts toolTitle and fieldWord, text.ts MAIL_FIELD_WORDS).
// Covered: a Gmail tool on a library connection gets Trina's own words in all six languages; another MCP server keeps
// its own title; without a locale the title is as before; the mail field words apply only on a library connection's
// card, so another service's thread_id or references keeps its own words.
import { describe, expect, test } from 'bun:test'
import { Locale } from '@mycel/shared/api'
import { catalog } from '../../server/src/integrations/google-apps/catalog'
import { cardLines, fieldWord, toolKindOf, toolTitle } from '../../server/src/integrations/connections/card-lines'
import { GOOGLE_TOOL_WORDS, MAIL_FIELD_WORDS } from '../../server/src/integrations/connections/text'

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
    // Calendar keeps the library's title for now
    expect(toolTitle({ name: 'manage_event', title: 'Manage Event' }, 'ko', 'google-apps')).toBe('Manage Event')
    expect(toolKindOf({ google_app: 'gmail' })).toBe('google-apps')
  })

  test('every Gmail catalog tool has all six languages', () => {
    for (const tool of catalog('gmail')) {
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
