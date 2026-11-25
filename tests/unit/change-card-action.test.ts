// The write card says what a call does (docs/decisions/20261125-change-card-action-verb.md; QA 11-25 on qa.trina.app: a
// Gmail draft and a Calendar event asked "Send it? Send once / Don't send"). The default is "send": the card says save,
// add, delete or change only when Trina is sure nothing reaches anyone (review of #585).
import { describe, expect, test } from 'bun:test'
import { changeAction } from '../../server/src/integrations/connections/card-lines'
import { catalog } from '../../server/src/integrations/google-apps/catalog'

const a = (name: string, args?: unknown, title?: string) => changeAction({ name, title: title ?? null }, args)
const g = (name: string, args?: unknown, title?: string) => changeAction({ name, title: title ?? null }, args, { googleApp: true })

describe('the Google Workspace library (Trina\'s own list)', () => {
  test('Gmail: send is a send, a draft is saved (its "to" goes nowhere), labels are changed', () => {
    expect(g('send_gmail_message', {}, 'Send Gmail Message')).toBe('send')
    expect(g('draft_gmail_message', { subject: 's', body: 'b' }, 'Draft Gmail Message')).toBe('save')
    expect(g('draft_gmail_message', { to: 'a@b.example', subject: 's', body: 'Mail me at c@d.example' }, 'Draft Gmail Message')).toBe('save')
    expect(g('my_gmail__draft_gmail_message', { to: 'a@b.example' })).toBe('save')
    expect(g('modify_gmail_message_labels', { message_id: 'm1', add_label_ids: ['L1'] }, 'Modify Gmail Message Labels')).toBe('change')
    expect(g('manage_gmail_label', { action: 'create', name: 'x' })).toBe('add')
    expect(g('manage_gmail_filter', { action: 'delete', filter_id: 'f1' })).toBe('delete')
  })

  test('Calendar: manage_event by its action argument, people in it make it a send', () => {
    expect(g('manage_event', { action: 'create', summary: 'Q4 review', start_time: '2026-11-26T14:00:00', end_time: '2026-11-26T15:00:00' }, 'Manage Event')).toBe('add')
    expect(g('manage_event', { action: 'update', event_id: 'e1', summary: 'x' }, 'Manage Event')).toBe('change')
    expect(g('manage_event', { action: 'delete', event_id: 'e1' }, 'Manage Event')).toBe('delete')
    expect(g('manage_event', { action: 'create', summary: 'x', attendees: [] })).toBe('add')
    expect(g('manage_event', { action: 'create', summary: 'x', attendees: ['a@b.example'] })).toBe('send')
    // the call's own action word picks only among the non-send actions; anything else or nothing said is a send
    expect(g('manage_event', { action: 'send', summary: 'x' })).toBe('send')
    expect(g('manage_event', { summary: 'x' })).toBe('send')
  })

  test('Docs and Sheets', () => {
    expect(g('create_doc', { title: 'Plan' })).toBe('add')
    expect(g('modify_doc_text', { document_id: 'd', text: 'added' })).toBe('change')
    expect(g('export_doc_to_pdf', { document_id: 'd' })).toBe('save')
    expect(g('append_table_rows', { values: [['1']] })).toBe('add')
  })

  test('every Google change tool is on Trina\'s list; only Gmail send reads as a send with no people in the call', () => {
    const all = (['gmail', 'calendar', 'docs', 'sheets'] as const).flatMap((app) => catalog(app)).filter((t) => t.changes)
    const sends = all.filter((t) => g(t.name, { action: 'create' }, t.title) === 'send').map((t) => t.name)
    expect(sends).toEqual(['send_gmail_message'])
  })
})

describe('any other tool', () => {
  test('a clear non-send verb, nothing reaching anyone', () => {
    expect(a('create_task', { title: 'x' }, 'Create a task')).toBe('add')
    expect(a('delete_page', { page_id: 'p' })).toBe('delete')
    expect(a('trashFile', { id: 'f' })).toBe('delete')
    expect(a('update_task', { id: 't', title: 'y' })).toBe('change')
    expect(a('save_note', { text: 'n' })).toBe('save')
    expect(a('notion_create_page', { title: 'x' })).toBe('add')
    // the name says nothing: the title may
    expect(a('do_it', {}, 'Create a page')).toBe('add')
  })

  test('not sure: send', () => {
    expect(a('do_thing')).toBe('send')
    expect(a('manage_tags', { action: 'create' })).toBe('send')
  })

  // review of #585: each of these reaches people and must read "send"
  test.each([
    ['message_create', {}], ['messages.create', {}], ['comment_create', {}], ['commentCreate', {}], ['chatMessage_create', {}], ['email_new', {}],
    ['메일_보내기', {}], ['送信', {}], ['enviar_correo', {}],
    ['export_dashboard', { recipients: ['a@b.example'] }], ['backup_and_email', { to: 'a@b.example' }], ['store_file', { share_with: 'team' }],
    ['slack_tool', { op: 'store', channel: 'C1', text: 'hi' }], ['gmail_tool', { action: 'draft', to: 'a@b.example' }],
    ['submit_pending_pull_request_review', {}], ['create_pull_request_review', {}], ['submit_form', {}], ['mention_user', {}],
    ['launch_campaign', {}], ['execute_campaign', {}], ['finalize_invoice', {}], ['transfer_ownership', { new_owner: 'bob' }],
    ['call_phone', {}], ['toot', {}], ['create_status', {}], ['create_story', {}], ['upload_video', { privacy: 'public' }],
    ['create_campaign', {}], ['schedule_campaign', {}], ['create_issue', { title: 't', body: '@bob please look' }],
    ['manage_event', { action: 'update', attendee_emails: ['a@b.example'] }], ['update_event', { add_attendees: ['a@b.example'] }],
    ['book_meeting', { invitee_email: 'a@b.example' }], ['assign_task', { assignee_id: 'u1' }], ['create_task', { owner_email: 'a@b.example' }],
    ['add_permission', { user: 'a@b.example' }], ['add_users_to_group', { user_ids: ['u1'] }],
    ['create_task', { title: 'x', to: 'outside@evil.example' }], ['create_and_send_invoice', {}], ['share_file', {}], ['invite_member', {}],
  ] as const)('%s reads "send"', (name, args) => {
    expect(a(name, args)).toBe('send')
  })

  test('a non-ASCII title, or a title that reaches people, is a send', () => {
    expect(a('do_it', {}, '메일 보내기')).toBe('send')
    expect(a('create_item', {}, 'Create a message')).toBe('send')
  })

  test('Google library tools reach their own checks: a filter that forwards is a send', () => {
    expect(g('manage_gmail_filter', { action: 'create', filter_action: { forward: 'x@y.example' } })).toBe('send')
    expect(g('manage_event', { action: 'update', attendee_emails: ['a@b.example'] })).toBe('send')
    // a Google name on a connection that is not the library: words only
    expect(a('manage_event', { action: 'create', summary: 'x' })).toBe('send')
  })
})

describe('argsReach on long values', () => {
  test('a long text with no address is read in linear time', () => {
    const t0 = performance.now()
    expect(a('create_page', { body: 'x'.repeat(400_000) + ' a.b.c '.repeat(20_000) })).toBe('add')
    expect(performance.now() - t0).toBeLessThan(500)
    expect(a('create_page', { body: `${'word '.repeat(50_000)}write to bob@acme.example.` })).toBe('send')
  })
})
