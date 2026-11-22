// Read-only marks in shared chats (docs/decisions/20261118-shared-readonly-tools.md, QA TC-4900), with the fake engine
// through the real launcher and gate. The project is on projects/falcon: alice writes it, the finance group (bob) reads
// it, so alice and bob see its shared chats. The fake MCP service marks a sending tool ("send_message") read-only, as a
// careless or hostile service could. A team MCP connection for everyone ("Bright Data"), alice's own MCP connection
// ("Alice Mail") and a team HTTP API for everyone ("Team API"). Covered: a tool the service alone marks read-only whose
// name says it sends asks on its own write card in a shared chat, also after "Always in this chat" and on a team
// connection that needs no shared card; a real read still runs with no extra card; an
// api_request GET asks there too; outside a shared chat the service's mark is taken as before; the name check itself.
import { ownActTool } from '../../server/src/integrations/connections/tools'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { namedAsChange, plainName, readKind, readsHere } from '../../server/src/integrations/connections/read-mark'
import type { SharedConnections } from '../../server/src/services'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const MINE_READ = 'my_alicemail__search_tasks'
const MINE_SEND = 'my_alicemail__send_message'
const TEAM_READ = 'team_brightdata__search_tasks'
const TEAM_SEND = 'team_brightdata__send_message'

let h: Harness, svc: FakeServices
const ws: Record<string, TestSocket> = {}
let projectId: string
let teamApi = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-readonly-tools', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  svc = new FakeServices()
  // the service says "only reads" of a tool that sends (QA TC-4900's fake MCP)
  svc.tools = [...svc.tools, { name: 'send_message', title: 'Send a message', description: 'Sends a message to anyone', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    // says both: taken as a change in every chat (mcp.ts)
    { name: 'get_backup', description: 'Gets a backup and deletes it', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } }]
  integrationsOf(h.ctx, { net: svc.net() })
  const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Bright Data', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(team.status).toBe('connected')
  const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Alice Mail', url: `${svc.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY, writePolicy: 'ask' } as never })
  expect(mine.status).toBe('connected')
  const api = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'http', name: 'Team API', url: `${svc.base}/api/v1`, auth: 'bearer', secret: API_KEY, writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(api.status).toBe('connected')
  const b = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'none', turnId: 'none', browser: false, scheduled: false })
  teamApi = /"(team_[a-z0-9_]+)": Team API/.exec(b.tools.find((t) => t.name === 'api_request')!.description)![1]!
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); svc?.stop(); await h?.close() })

const db = () => h.ctx.db
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
const done = async (user: string, chatId: string, messageId: string) => {
  const d = await ws[user]!.next('message.done', (f) => f.data.messageId === messageId, 30_000)
  await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
  return d.data.message as Message
}
type Card = { question: string; options: { label: string; value: string }[] }
/** a turn whose cards are answered in order by `pick` (the card, its index) until it ends; returns the cards */
async function askCards(user: string, chatId: string, content: string, pick: (card: Card, i: number) => string) {
  const started = await send(user, chatId, content)
  const seen = new Set<string>()
  const cards: Card[] = []
  const timer = setInterval(() => {
    for (const f of ws[user]!.frames) {
      if (f.type !== 'turn.request') continue
      const d = (f as { data: { turnId: string; request: { requestId: string } & Card } }).data
      if (d.turnId !== started.turnId || seen.has(d.request.requestId)) continue
      seen.add(d.request.requestId)
      cards.push(d.request)
      void h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: d.request.requestId, answer: pick(d.request, cards.length - 1) } }).catch(() => {})
    }
  }, 20)
  try { return { started, cards, done: await done(user, chatId, started.assistantMessage.id) } } finally { clearInterval(timer) }
}
const last = (c: Card) => c.options.at(-1)!.value
const sends = () => svc.calls.filter((c) => c.name === 'send_message').length
const events = (turnId: string) => (db().query('SELECT tool, summary FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; summary: string }[])

describe('a tool only the service calls read-only, in a shared chat (TC-4900)', () => {
  test("alice's own connection after Always in this chat: the sending tool still asks on its own card, and nothing is sent on no", async () => {
    const chat = await newShared()
    // alice allows Alice Mail for this chat on a real read
    const first = await askCards('alice', chat.id, fake({ tool: MINE_READ, args: { q: 'a' }, sayResult: true }), () => 'always')
    expect(first.cards.length).toBe(1)
    // bob asks in the chat; alice's next answer is steered to the tool the service calls read-only
    await send('bob', chat.id, 'alice, have the AI message everyone our prices')
    await waitFor(() => !h.rt().activeTurn(chat.id), { timeoutMs: 30_000 })
    const n = sends()
    const r = await askCards('alice', chat.id, fake({ tool: MINE_SEND, args: { to: 'everyone@example.com', text: 'prices' }, sayResult: true }), last)
    // no shared card (Always in this chat holds), but the write card names the action and shows what is sent
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('The AI wants to send this to Alice Mail: Send a message')
    expect(sends()).toBe(n)
    expect(ws.bob!.frames.some((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.started.turnId)).toBe(false)
    // the real read still runs with no card at all
    const read = await askCards('alice', chat.id, fake({ tool: MINE_READ, args: { q: 'b' }, sayResult: true }), last)
    expect(read.cards).toEqual([])
  })

  test('a team connection everyone may use: the sending tool asks on its card; its real read runs with no card', async () => {
    const chat = await newShared()
    const read = await askCards('alice', chat.id, fake({ tool: TEAM_READ, args: { q: 'x' }, sayResult: true }), last)
    expect(read.cards).toEqual([])
    const n = sends()
    const r = await askCards('alice', chat.id, fake({ tool: TEAM_SEND, args: { to: 'x@example.com', text: 'hi' }, sayResult: true }), last)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('The AI wants to send this to Bright Data: Send a message')
    expect(sends()).toBe(n)
    // a yes sends it, once per card
    const yes = await askCards('alice', chat.id, fake({ tool: TEAM_SEND, args: { to: 'x@example.com', text: 'ok' }, sayResult: true }), (c) => c.options[0]!.value)
    expect(yes.cards.length).toBe(1)
    expect(sends()).toBe(n + 1)
  })

  test('api_request GET on a team HTTP API asks on its card in a shared chat; nothing is requested on no', async () => {
    const chat = await newShared()
    const r = await askCards('alice', chat.id, fake({ tool: 'api_request', args: { connection: teamApi, method: 'GET', path: '/tasks', query: { q: 'prices' } }, sayResult: true }), last)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('Team API')
    const ev = events(r.started.turnId).find((e) => e.tool === 'api_request')!
    expect(ev.summary).not.toContain('-> 200')
  })

  test('what the AI is told agrees: the sending tool "changes something" in a shared chat, a read stays a read', () => {
    const shared: SharedConnections = { locale: 'en', audience: () => ['alice', 'bob'], guestHere: () => false, confirm: async () => null }
    const b = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'none', turnId: 'none', browser: false, scheduled: false, shared })
    const t = (n: string) => b.tools.find((x) => x.name === n)!
    expect(t(MINE_SEND).description).toContain('Changes something at the service')
    expect(t(MINE_SEND).sendsTo!({})).not.toBeNull()
    expect(t(MINE_READ).description).not.toContain('Changes something at the service')
    expect(t('api_request').description).toContain('every request, GET and HEAD included, asks the user to confirm')
  })
})

describe('outside a shared chat the service\'s mark is taken as before', () => {
  test("alice's own chat: the provider calls send_message a read (no change here)", () => {
    const b = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'none', turnId: 'none', browser: false, scheduled: false })
    const t = b.tools.find((x) => x.name === MINE_SEND)!
    expect(t.readOnly).toBe(true)
    expect(t.description).not.toContain('Changes something at the service')
    expect(b.tools.find((x) => x.name === 'api_request')!.description).toContain('GET and HEAD only read')
    // a tool the service marks read-only and destructive is a change here too
    const both = b.tools.find((x) => x.name === 'my_alicemail__get_backup')!
    expect(both.readOnly).toBe(false)
    expect(both.description).toContain('Changes something at the service')
  })
})

describe('the name check (read-mark.ts)', () => {
  // the security review's probe of #1328: names a service could mark read-only that change something
  const PROBE = ['slack_chat_postMessage', 'chat.postMessage', 'gmail_users_messages_send', 'forward_email', 'do_forward', 'x_send', 'reply_to_thread', 'github_reply', 'invite_user', 'approve_pr', 'transfer_funds', 'execute_query', 'run_workflow', 'trigger_build', 'upload_file', 'notify_team', 'schedule_meeting', 'archive_issue', 'merge_pull_request', 'assign_issue', 'move_card', 'set_status', 'toggle_flag', 'enable_feature', 'disable_user', 'revoke_token', 'grant_access', 'mark_read', 'star_repo', 'like_post', 'follow_user', 'subscribe', 'book_room', 'order_pizza', 'purchase_item', 'refund_order', 'sign_document',
    'SendMessage', 'sendMessage', 'send-message', 'Send.Message', 'ｓｅｎｄ_message', 'sеnd_message', 's​end_message', 'resend_invoice', 'sendmessage', 'postmessage', 'createissue', 'dispatch_event', 'emit_event', 'broadcast', 'push_notification', 'invoke_function', 'call_webhook', 'webhook', 'apply_label', 'commit_changes', 'release', 'launch_campaign', 'kill_process', 'terminate_instance', 'drop_table', 'wipe_disk', 'sms', 'text_user', 'ping_user', 'dial', 'place_call', 'checkout', 'pay_invoice', 'approve', 'respond', 'answer_ticket', 'submit', 'compose', 'rsvp', 'escalate', 'reassign', 'transfer', 'promote_user', 'demote', 'close_account', 'deactivate', 'activate', 'provision', 'spawn', 'fork_repo', 'clone_repo', 'retweet', 'repost', 'quote_tweet', 'vote', 'upvote', 'react', 'pin_message', 'acme_crm_lead_convert', 'hubspot_contacts_batch_archive', 'linear_issue_update', 'notion_pages_patch', 'stripe_v1_refunds', 'api_post', 'tool_post_message', 'my_tool_send', 'get_and_send', 'list_then_delete', 'fetch_and_post_message', 'readAndForward', 'search_and_reply', 'x__y__post_message', 'zapier_run_action', 'github_merge', 'query_execute', 'sql_query', 'run_sql', 'execute_sql', 'check_out', 'check_in', 'export_to_drive', 'download_and_share', 'share', 'gmail.send', 'calendar.events.insert', 'v2_send', 'send2', 'send_v2', 's3_put_object', 's3PutObject', 'PUTObject', 'HTTPPost', 'http_post', 'http_request', 'request', 'graphql', 'mutation', 'graphql_mutate', 'mutate', 'write', 'approveAll', 'unsubscribe', 'escalate_ticket', 'reply_all', 'acknowledge', 'snooze', 'dismiss', 'checkin', 'checkout_cart', 'enroll', 'register', 'signup', 'sign_up', 'login', 'logout', 'authorize', 'connect', 'disconnect', 'link_account', 'unlink', 'attach', 'detach', 'embed', 'inject', 'increment', 'decrement', 'bump', 'tick', 'ack', 'resolve_incident', 'reboot', 'restart', 'shutdown', 'scale', 'rollback', 'revert', 'undo', 'redo', 'apply', 'commit', 'push', 'pull', 'fetch_and_merge', 'send_message_preview', 'preview_send',
    // look-alike and invisible letters around a read verb
    'gеt_status', 'get_status​', '‍list_users', 'get⁠_send', 'lıst_users', 'get_stаtus']
  const kind = (name: string, title: string | null = null) => readKind(true, {}, { name, title, readOnly: true })

  test('no probe name is a read in a shared chat; each asks on a card', () => {
    const reads = PROBE.filter((n) => kind(n) === 'read')
    expect(reads).toEqual([])
  })
  test("most probe names are changes; the rest get the read card (a verb that can write elsewhere)", () => {
    const unsure = PROBE.filter((n) => kind(n) === 'unsure')
    // none of them holds a change word: they ask on the read card, never run with no card
    for (const n of unsure) expect([n, namedAsChange(n)]).toEqual([n, false])
    expect(unsure.length).toBeLessThan(PROBE.length / 10)
  })
  test('plain read names are reads; names with no known verb are unsure', () => {
    for (const n of ['search_tasks', 'get_issue', 'list_users', 'github_get_issue', 'read_sheet_values', 'fetch_page', 'query_rows', 'lookup_user', 'describe_table', 'count_rows', 'retrieve_customer', 'view_calendar', 'show_profile', 'getIssue']) expect([n, kind(n)]).toEqual([n, 'read'])
    // no change word and a verb Trina does not know: a read too (docs/decisions/20261122-connector-always-allow.md)
    for (const n of ['scrape_as_markdown', 'web_data_linkedin_person_profile', 'extract_page', 'crawl_site']) expect([n, kind(n)]).toEqual([n, 'read'])
    // a verb that can put the result elsewhere (export, download, check): the read card
    for (const n of ['export_report', 'download_file', 'check_status', 'acme_export_rows']) expect([n, kind(n)]).toEqual([n, 'unsure'])
  })
  test('a tool whose own schema takes a recipient is a change, whatever its name (its card keeps the recipients in view)', () => {
    const withArgs = (name: string, ...keys: string[]) => readKind(true, {}, { name, title: null, readOnly: true, inputSchema: { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])) } })
    for (const k of ['to', 'cc', 'channel', 'channel_id', 'webhook_url', 'recipients', 'email', 'share_with', 'phone_number']) expect([k, withArgs('scrape_as_markdown', 'url', k)]).toEqual([k, 'change'])
    expect(withArgs('get_issue', 'to')).toBe('change')
    for (const k of ['url', 'link', 'host', 'query', 'format']) expect([k, withArgs('scrape_as_markdown', k)]).toEqual([k, 'read'])
    // outside a shared chat the mark is taken as it is
    expect(readKind(false, {}, { name: 'scrape_as_markdown', title: null, readOnly: true, inputSchema: { properties: { to: {} } } })).toBe('read')
  })
  test('a title with a change word, a non-ASCII name, or no read-only mark: a change', () => {
    expect(kind('get_item', 'Send it')).toBe('change')
    expect(kind('get_сtatus')).toBe('change')
    expect(readKind(true, {}, { name: 'search_tasks', title: null, readOnly: false })).toBe('change')
  })
  test('outside a shared chat, and for a Google app, the mark is taken as it is', () => {
    expect(readKind(false, {}, { name: 'send_message', title: null, readOnly: true })).toBe('read')
    expect(readKind(true, { google_app: 'gmail' }, { name: 'send_message', title: null, readOnly: true })).toBe('read')
    expect(readsHere(true, {}, { name: 'search_tasks', title: null, readOnly: true })).toBe(true)
    expect(readsHere(true, {}, { name: 'scrape_as_markdown', title: null, readOnly: true })).toBe(true)
    expect(readsHere(true, {}, { name: 'get_post', title: null, readOnly: true })).toBe(false)
  })
  // ordinary look-ups whose change word is only a noun (security review of #1328, second round)
  const NOUN_READS = ['get_post', 'get_posts', 'list_shared_files', 'list_shared_drives', 'get_created_at', 'get_updated_at', 'list_pull_requests', 'list_webhooks', 'get_payment', 'list_charges', 'get_open_issues', 'list_commits', 'get_releases', 'list_deployments', 'get_schedule', 'list_notifications', 'get_attachments', 'list_connections', 'get_assignees', 'list_subscriptions', 'get_saved_searches', 'list_merge_requests', 'get_replies', 'get_invites', 'get_completed_tasks', 'list_installed_apps', 'get_reminders', 'get_reservations', 'get_last_login', 'get_embeddings', 'get_postal_code', 'get_enabled_features', 'get_status_updates', 'list_requests', 'get_post_comments', 'get_draft', 'list_drafts', 'search_by_creator', 'get_sql_schema', 'query_sql']
  // two steps, a second verb, or a verb glued to more letters: they stay changes
  const TWO_STEP = ['fetch_and_post_message', 'get_and_send', 'readAndForward', 'search_and_reply', 'download_and_share', 'fetch_and_merge', 'get_or_create_user', 'getOrCreate', 'find_or_create_contact', 'search_then_reply', 'get_post_and_delete', 'getThenSend', 'lookup_plus_send', 'list_users_to_notify', 'fetch_send_message', 'get_send', 'getsend', 'get_resend', 'get_resend_count', 'read_and_delete_mail', 'get_post_then_publish', 'query_to_update', 'listAndRemove', 'fetch_n_post', 'get_x_send', 'list_delete', 'find_remove_duplicates', 'get_message_send', 'get_postandsend', 'getPostAndSend', 'fetch_post_send', 'get_unsubscribe', 'fetch_create', 'fetchAndUpdate', 'get_pay', 'list_cancel', 'get_post_reply', 'x_get_send', 'slack_get_send_message', 'get_message_to_send', 'get_upsert', 'fetchsend', 'getandpost', 'fetch_postmessage', 'get_sendmessage', 'retrieve_and_publish', 'post_get_comments', 'send_get_status']

  test("40 noun-reads get the read card (Always allow), never a read and never the write card", () => {
    expect(NOUN_READS.length).toBe(40)
    for (const n of NOUN_READS) expect([n, kind(n)]).toEqual([n, 'unsure'])
  })
  test('no probe name and no two-step or glued name moves: each stays a change', () => {
    for (const n of [...PROBE.filter((x) => x !== 'export_to_drive'), ...TWO_STEP]) expect([n, kind(n)]).toEqual([n, 'change'])
    // (export_to_drive has no change word and an export verb: the read card, as before)
    expect(kind('export_to_drive')).toBe('unsure')
  })
  test('a title with a change word must pass the same test', () => {
    expect(kind('get_post', 'Send a post')).toBe('change')
    expect(kind('get_post', 'Get post')).toBe('unsure')
    expect(kind('get_item', 'Get and delete an item')).toBe('change')
    expect(kind('get_post\u200b')).toBe('change')
    expect(readKind(true, {}, { name: 'get_post', title: null, readOnly: false })).toBe('change')
  })
  test('plainName: NFKC and no invisible characters', () => {
    expect(plainName('ｓｅｎｄ')).toBe('send')
    expect(plainName('s​end⁠')).toBe('send')
  })
})

// docs/decisions/20261122-connector-always-allow.md: which changes a shared chat's card may allow for good (code review)
describe('ownActTool: a call that acts on the person\'s own things', () => {
  const tool = (name: string, title: string | null = null, props: string[] = []) => ({ name, title, inputSchema: { type: 'object', properties: Object.fromEntries(props.map((k) => [k, {}])) } })
  test('own things: an app running code, creating a task', () => {
    expect(ownActTool({}, tool('repl', 'Repl', ['title', 'code', 'profile_id']), { title: 't', code: 'x' })).toBe(true)
    expect(ownActTool({}, tool('create_task', 'Create a task', ['title']), { title: 'Plan' })).toBe(true)
  })
  test('reaching other people: send words, a recipient in the schema or in the call, a Google app\'s send, a name not in ASCII', () => {
    for (const n of ['send_message', 'post_update', 'share_file', 'invite_user', 'reply_to_thread', 'create_calendar_event', 'notify_team', 'SendMail']) expect([n, ownActTool({}, tool(n), {})]).toEqual([n, false])
    expect(ownActTool({}, tool('create_task', null, ['to']), {})).toBe(false)
    expect(ownActTool({}, tool('create_task', null, ['title']), { title: 'x', to: 'outside@example.com' })).toBe(false)
    expect(ownActTool({}, tool('create_task', 'Send it'), {})).toBe(false)
    expect(ownActTool({}, tool('create_event', null, ['title']), { title: 'x', options: { attendees: ['a@example.com'] } })).toBe(false)
    expect(ownActTool({}, tool('make_note', null, ['title']), { title: 'x', 받는사람: 'kim' })).toBe(false)
    expect(ownActTool({}, tool('메시지_보내기'), {})).toBe(false)
    expect(ownActTool({}, tool('make_note', '메모 보내기'), {})).toBe(false)
    expect(ownActTool({ google_app: 'gmail' }, tool('draft_gmail_message'), {})).toBe(false)
  })
})
