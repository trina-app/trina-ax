// The read that names what a Google app change acts on, for its card's first line (google-apps/names.ts; QA 11-25: a
// Calendar delete card showed only the event's id). Covered: which calls read a name (an event to change, delete or
// answer; a message whose labels change; a spreadsheet a Sheets change writes to) and which do not (a new event, Docs,
// an id that is not text); the library's answers parsed, its own words for "none" read as nothing known.
import { describe, expect, test } from 'bun:test'
import { answerText, nameReadOf } from '../../server/src/integrations/google-apps/names'

describe('which change reads a name', () => {
  test('an event that is there already, a message, a spreadsheet', () => {
    expect(nameReadOf('manage_event', { action: 'delete', event_id: 'e1', calendar_id: 'team@acme.example' })).toMatchObject({ tool: 'get_events', args: { event_id: 'e1', calendar_id: 'team@acme.example' }, word: 'targetEvent' })
    expect(nameReadOf('manage_event', { action: 'UPDATE', event_id: 'e1' })?.args).toEqual({ event_id: 'e1' })
    expect(nameReadOf('manage_focus_time', { action: 'delete', event_id: 'f1' })?.tool).toBe('get_events')
    expect(nameReadOf('modify_gmail_message_labels', { message_id: 'm1' })).toMatchObject({ tool: 'get_gmail_message_content', args: { message_id: 'm1', format: 'metadata' } })
    expect(nameReadOf('modify_sheet_values', { spreadsheet_id: 's1', range_name: 'A1' })).toMatchObject({ tool: 'get_spreadsheet_info', args: { spreadsheet_id: 's1' } })
  })

  test('nothing to name: a new event, no id, Docs, another tool', () => {
    expect(nameReadOf('manage_event', { action: 'create', event_id: 'e1' })).toBeNull()
    expect(nameReadOf('manage_event', { action: 'delete' })).toBeNull()
    expect(nameReadOf('manage_event', { action: 'delete', event_id: 42 })).toBeNull()
    expect(nameReadOf('modify_doc_text', { document_id: 'd1' })).toBeNull()
    expect(nameReadOf('create_spreadsheet', { title: 'x' })).toBeNull()
    expect(nameReadOf('send_gmail_message', { message_id: 'm1' })).toBeNull()
    expect(nameReadOf('manage_event', null)).toBeNull()
  })
})

describe("the library's answers", () => {
  const event = nameReadOf('manage_event', { action: 'delete', event_id: 'e1' })!
  const mail = nameReadOf('modify_gmail_message_labels', { message_id: 'm1' })!
  const sheet = nameReadOf('create_sheet', { spreadsheet_id: 's1' })!
  test('the name, or nothing for the library\'s own "none"', () => {
    expect(event.parse('Successfully retrieved event from calendar \'primary\' for a@acme.example:\n- "Say "hi" to Bo" (Starts: 2026-11-26T14:00:00, Ends: 2026-11-26T15:00:00) ID: e1 | Link: x')).toBe('Say "hi" to Bo')
    expect(event.parse('- "No Title" (Starts: a, Ends: b) ID: e1')).toBeNull()
    expect(event.parse("Event with ID 'e1' not found in calendar 'primary'.")).toBeNull()
    expect(mail.parse('Subject: Lunch on Friday\nFrom: bob@acme.example')).toBe('Lunch on Friday')
    expect(mail.parse('Subject: (no subject)\nFrom: x')).toBeNull()
    expect(sheet.parse('Spreadsheet: "Q4 budget" (ID: s1) | Locale: en_US\nSheets (1):')).toBe('Q4 budget')
  })

  test('an answer\'s text; an error answer is nothing', () => {
    expect(answerText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(answerText({ content: [{ type: 'text', text: 'a' }], isError: true })).toBeNull()
    expect(answerText(null)).toBeNull()
  })
})
