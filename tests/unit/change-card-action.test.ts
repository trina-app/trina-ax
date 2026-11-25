// The write card says what a call does (docs/decisions/20261125-change-card-action-verb.md; QA 11-25 on qa.trina.app: a
// Gmail draft and a Calendar event asked "Send it? Send once / Don't send"). Covered: every Google Workspace library
// change tool, "manage_*" tools by their own action argument, generic MCP names, a send word winning over any other.
import { describe, expect, test } from 'bun:test'
import { changeAction } from '../../server/src/integrations/connections/card-lines'
import { catalog } from '../../server/src/integrations/google-apps/catalog'

const a = (name: string, args?: unknown, title?: string) => changeAction({ name, title: title ?? null }, args)

describe('changeAction', () => {
  test('Gmail: send is a send, a draft is saved, labels are changed', () => {
    expect(a('send_gmail_message', {}, 'Send Gmail Message')).toBe('send')
    expect(a('draft_gmail_message', { to: 'a@b.example' }, 'Draft Gmail Message')).toBe('save')
    expect(a('modify_gmail_message_labels', {}, 'Modify Gmail Message Labels')).toBe('change')
    expect(a('batch_modify_gmail_message_labels')).toBe('change')
    expect(a('manage_gmail_label', { action: 'create', name: 'x' })).toBe('add')
    expect(a('manage_gmail_filter', { action: 'delete' })).toBe('delete')
  })

  test('Calendar: manage_event says what by its action argument', () => {
    expect(a('manage_event', { action: 'create', summary: 'Q4 review' }, 'Manage Event')).toBe('add')
    expect(a('manage_event', { action: 'update' }, 'Manage Event')).toBe('change')
    expect(a('manage_event', { action: 'delete' }, 'Manage Event')).toBe('delete')
    // no action said: a change, never a send
    expect(a('manage_event', {}, 'Manage Event')).toBe('change')
  })

  test('Docs and Sheets', () => {
    expect(a('create_doc')).toBe('add')
    expect(a('modify_doc_text')).toBe('change')
    expect(a('find_and_replace_doc')).toBe('change')
    expect(a('insert_doc_image')).toBe('add')
    expect(a('export_doc_to_pdf')).toBe('save')
    expect(a('append_table_rows')).toBe('add')
    expect(a('format_sheet_range')).toBe('change')
  })

  test('no Google change tool but Gmail send reads as a send', () => {
    const sends = (['gmail', 'calendar', 'docs', 'sheets'] as const).flatMap((app) => catalog(app)).filter((t) => t.changes && a(t.name, {}, t.title) === 'send').map((t) => t.name)
    expect(sends).toEqual(['send_gmail_message'])
  })

  test('generic MCP tools', () => {
    expect(a('create_task', {}, 'Create a task')).toBe('add')
    expect(a('delete_page')).toBe('delete')
    expect(a('trashFile')).toBe('delete')
    expect(a('update_issue')).toBe('change')
    expect(a('save_note')).toBe('save')
    expect(a('do_thing')).toBe('change')
  })

  test('a send word anywhere wins: never a quiet change for something that reaches people', () => {
    expect(a('create_and_send_invoice')).toBe('send')
    expect(a('draft_and_send')).toBe('send')
    expect(a('create_post')).toBe('send')
    expect(a('share_file')).toBe('send')
    expect(a('invite_member')).toBe('send')
    expect(a('reply_to_thread')).toBe('send')
    expect(a('slack_post_message')).toBe('send')
    // a message, mail or comment made or written with no other verb goes to people
    expect(a('create_message')).toBe('send')
    expect(a('schedule_email')).toBe('send')
    expect(a('email_team')).toBe('send')
    // the title says it when the name does not
    expect(a('do_it', {}, 'Send a message')).toBe('send')
    // the call's own action argument says it
    expect(a('manage_message', { action: 'send' })).toBe('send')
  })
})

describe('changeAction: who the call reaches', () => {
  test('a call that names people it reaches is a send, unless it only saves', () => {
    expect(a('create_task', { title: 'x', to: 'outside@evil.example' })).toBe('send')
    expect(a('manage_event', { action: 'create', summary: 'x', attendees: ['a@b.example'] })).toBe('send')
    // empty: nobody
    expect(a('manage_event', { action: 'create', summary: 'x', attendees: [] })).toBe('add')
    // a draft keeps its "to" and goes nowhere
    expect(a('draft_gmail_message', { to: 'a@b.example', subject: 's', body: 'b' })).toBe('save')
  })
})
