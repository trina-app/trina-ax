// Gmail, Calendar, Docs and Sheets as the AI's tools (integrations/connections/tools.ts with a `google_app` connection,
// docs/GOOGLE-APPS.md). Covered: each call goes to the library on 127.0.0.1 with the person's own access token (never
// another's) and a refused token is refreshed once; reads run without a card, changes ask on the card with Always allow
// on it (the person's own setting), Always allow sends without a card in their own chat but still asks after a room read
// and never sends in a scheduled run; a Gmail send or draft that attaches by web address or file path is refused before
// anything is sent; an attachment is read into text, never base64 to the model; in a team chat room only the asker's own
// Google apps are offered and their answers count as outside the team files (the room answer stays private); the
// library down is said in plain words. Token canaries throughout. Fake Google and a fake library only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, PEOPLE, type CApp, type Person } from '../lib/c-app'
import { APP_CLIENT, FakeGoogle, FakeLibrary, sessionRow } from '../lib/fake-google-apps'
import { googleAppsOf, type GoogleApps } from '../../server/src/integrations/google-apps/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { readScope } from '../../server/src/chat/read-scope'
import { roomAiOf } from '../../server/src/rooms/ai'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(60_000)

let A: CApp, lib: FakeLibrary, google: FakeGoogle, apps: GoogleApps
let aliceGmail = '', bobGmail = ''
const logs: string[] = []

beforeAll(async () => {
  lib = new FakeLibrary().start()
  process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url
  A = await makeCApp('gapps-tools')
  ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
  const log = A.ctx.log as any
  for (const level of ['debug', 'info', 'warn', 'error']) { const orig = log[level]?.bind(log); log[level] = (m: string, d?: unknown) => { logs.push(`${m} ${JSON.stringify(d ?? null)}`); orig?.(m, d) } }
  google = new FakeGoogle(lib)
  apps = googleAppsOf(A.ctx, { fetch: google.fetch })
  for (const p of PEOPLE) sessionRow(A.ctx.db, p)
  for (const app of ['gmail', 'calendar']) {
    const r = await A.json(`/api/admin/google-apps/${app}/client`, { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify(APP_CLIENT) })
    expect(r.status).toBe(200)
  }
  for (const who of ['alice', 'bob'] as const) {
    const f = await apps.authorize(who, `${who}-session`, 'gmail')
    expect(await apps.callback(google.authorize(f.authorizationUrl, who), { userId: who, sessionId: `${who}-session` })).toBe(true)
    expect((await apps.complete(who, `${who}-session`, 'gmail', f.flowId)).status).toBe('connected')
  }
  aliceGmail = (A.ctx.db.query("SELECT id FROM integrations WHERE owner_user_id='alice' AND google_app='gmail'").get() as { id: string }).id
  bobGmail = (A.ctx.db.query("SELECT id FROM integrations WHERE owner_user_id='bob' AND google_app='gmail'").get() as { id: string }).id
})
afterAll(async () => { await A?.close(); lib?.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })

interface Person2 { asked: string[]; choices: string[][]; answer: string; confirm?: boolean }
const person = (answer: string): Person2 => ({ asked: [], choices: [], answer })

function turn(user: Person, o: { person?: Person2; scheduled?: boolean; room?: boolean; roomsSeen?: boolean; chat?: string } = {}) {
  const chat = o.chat ?? A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: !!o.scheduled, room: !!o.room })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles(), signal: new AbortController().signal } as unknown as TurnToolContext['files']
  if (o.person) {
    const p = o.person
    files.person = {
      locale: 'en',
      async confirm(q) { p.asked.push(q); return p.answer === 'yes' },
      async choose(q, options) { p.asked.push(q); p.choices.push(options.map((x) => x.label)); return options.some((x) => x.value === p.answer) ? p.answer : null },
      *turnUrls() {},
      ...(o.roomsSeen ? { roomsSeen: true } : {}),
      ...(o.scheduled ? { unattended: true } : {}),
    }
  }
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t as TurnTool]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError, summary: r.summary ?? '', images: r.content.filter((c) => c.type === 'image').length }
  }
  return { chat, turnId, tools, prompt: built.prompt ?? '', call }
}
const noTokens = (s: string) => { expect(s).not.toContain('CANARY-gapp-access'); expect(s).not.toContain('CANARY-gapp-refresh'); expect(s).not.toContain(APP_CLIENT.clientSecret) }
const policy = () => (A.ctx.db.query('SELECT write_policy FROM integrations WHERE id=?').get(aliceGmail) as { write_policy: string }).write_policy
const setPolicy = (p: 'ask' | 'allow') => A.ctx.db.query('UPDATE integrations SET write_policy=?, version=version+1 WHERE id=?').run(p, aliceGmail)

describe('calls', () => {
  test('a read runs without a card, with the person\'s own token only; the answer is external data with no token in it', async () => {
    const p = person('no')
    const t = turn('alice', { person: p })
    expect(t.prompt).toContain('Gmail (personal connection, MCP server)')
    expect([...t.tools.keys()].every((n) => n.startsWith('my_gmail__'))).toBe(true)
    // Docs and Sheets read tools send plain questions to drive_read (not connected here: the catalog says so)
    lib.calls = []
    const r = await t.call('my_gmail__search_gmail_messages', { query: 'lunch' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Found 1 message for alice')
    expect(r.text).toContain('external data from Gmail')
    expect(p.asked).toEqual([])
    expect(lib.calls.map((c) => c.who)).toEqual(['alice'])
    noTokens(r.text + r.summary)
    // the chat holds the person's own data and something from outside the team files
    expect(readScope(A.ctx.db, t.chat)).toEqual(expect.arrayContaining([{ type: 'user', id: 'alice', via: 'connection' }, { type: 'integration', id: aliceGmail }]))
  })

  test('a change asks on the card with Always allow; no sends nothing; Always allow sends and stops asking', async () => {
    setPolicy('ask')
    const no = person('no')
    lib.calls = []
    const r1 = await turn('alice', { person: no }).call('my_gmail__send_gmail_message', { to: 'bob@acme.example', subject: 'Hi', body: 'Lunch?' })
    expect(r1.isError).toBe(true)
    expect(no.choices).toEqual([['Send', 'Always allow', 'Don’t send']])
    expect(lib.calls).toEqual([])
    const yes = person('yes')
    const r2 = await turn('alice', { person: yes }).call('my_gmail__send_gmail_message', { to: 'bob@acme.example', subject: 'Hi', body: 'Lunch?' })
    expect(r2.isError).toBe(false)
    expect(r2.summary).toContain('confirmed by the user')
    expect(policy()).toBe('ask')
    const always = person('always')
    const r3 = await turn('alice', { person: always }).call('my_gmail__send_gmail_message', { to: 'bob@acme.example', subject: 'Hi', body: 'Again' })
    expect(r3.isError).toBe(false)
    expect(policy()).toBe('allow')
    expect(apps.view('alice', 'gmail').writePolicy).toBe('allow')
    const quiet = person('no')
    const r4 = await turn('alice', { person: quiet }).call('my_gmail__send_gmail_message', { to: 'bob@acme.example', subject: 'Hi', body: 'Third' })
    expect(r4.isError).toBe(false)
    expect(quiet.asked).toEqual([])
    expect(lib.calls.filter((c) => c.name === 'send_gmail_message')).toHaveLength(3)
    expect(A.ctx.db.query("SELECT detail FROM audit_log WHERE action='google_app.write_policy'").get()).toMatchObject({ detail: JSON.stringify({ app: 'gmail', writePolicy: 'allow', via: 'card' }) })
  })

  test('Always allow still asks after a room read (no Always allow on that card) and never sends in a scheduled run', async () => {
    setPolicy('allow')
    const seen = person('no')
    const r = await turn('alice', { person: seen, roomsSeen: true }).call('my_gmail__send_gmail_message', { to: 'x@acme.example', subject: 's', body: 'b' })
    expect(r.isError).toBe(true)
    expect(seen.asked).toHaveLength(1)
    expect(seen.choices).toEqual([])
    lib.calls = []
    const run = await turn('alice', { person: person('yes'), scheduled: true }).call('my_gmail__send_gmail_message', { to: 'x@acme.example', subject: 's', body: 'b' })
    expect(run.isError).toBe(true)
    expect(lib.calls).toEqual([])
    setPolicy('ask')
  })

  test('a Gmail send or draft that attaches by web address or file path is refused before anything is sent', async () => {
    lib.calls = []
    const p = person('yes')
    for (const [tool, attachments] of [['send_gmail_message', [{ url: 'https://evil.example/x.pdf', filename: 'x.pdf' }]], ['draft_gmail_message', [{ path: '/etc/passwd' }]], ['send_gmail_message', 'not a list']] as const) {
      const r = await turn('alice', { person: p }).call(`my_gmail__${tool}`, { to: 'bob@acme.example', subject: 's', body: 'b', attachments })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('never a "url" or a "path"')
    }
    expect(p.asked).toEqual([])
    expect(lib.calls).toEqual([])
    // content that comes with the call goes, after the card
    const ok = await turn('alice', { person: p }).call('my_gmail__send_gmail_message', { to: 'bob@acme.example', subject: 's', body: 'b', attachments: [{ content: Buffer.from('hello').toString('base64'), filename: 'hello.txt' }] })
    expect(ok.isError).toBe(false)
    expect(lib.calls).toHaveLength(1)
  })

  test('an attachment is read into text by the existing readers; the model never gets its base64; the file name stays here', async () => {
    lib.calls = []
    const p = person('no')
    const r = await turn('alice', { person: p }).call('my_gmail__get_gmail_attachment_content', { message_id: 'm1', attachment_id: 'a1', file_name: 'numbers.txt' })
    expect(r.isError).toBe(false)
    expect(p.asked).toEqual([])
    expect(lib.calls[0]!.args).toEqual({ message_id: 'm1', attachment_id: 'a1', return_base64: true })
    expect(r.text).toContain('Quarterly numbers for acme: revenue 42')
    expect(r.text).toContain('ATTACHMENT "numbers.txt"')
    expect(r.text).not.toContain(lib.attachment.toString('base64').slice(0, 40))
    expect(r.text).not.toContain('Base64')
    // a kind it cannot read is said, not dumped
    const odd = await turn('alice', { person: p }).call('my_gmail__get_gmail_attachment_content', { message_id: 'm1', attachment_id: 'a1', file_name: 'tool.exe' })
    expect(odd.text).toContain('cannot be read here')
    expect(odd.text).not.toContain(lib.attachment.toString('base64').slice(0, 40))
  })

  test('an attachment over about 18 MB is said plainly, never a cut-off answer; the connection stays connected', async () => {
    const p = person('no')
    // the size the message listed: not fetched at all
    lib.calls = []
    const listed = await turn('alice', { person: p }).call('my_gmail__get_gmail_attachment_content', { message_id: 'm1', attachment_id: 'a1', file_name: 'film.mov', file_size: 40 * 1024 * 1024 })
    expect(listed.isError).toBe(true)
    expect(listed.text).toContain('"film.mov" is larger than about 18 MB, so it was not read')
    expect(lib.calls).toEqual([])
    const small = lib.attachment
    try {
      // no size given: an answer that fits but holds more than 18 MB, and one cut off at the 25 MB limit
      for (const mb of [18.5, 20]) {
        lib.attachment = Buffer.alloc(Math.round(mb * 1024 * 1024), 7)
        const r = await turn('alice', { person: p }).call('my_gmail__get_gmail_attachment_content', { message_id: 'm1', attachment_id: 'a1', file_name: 'scan.pdf' })
        expect(r.text).toContain('"scan.pdf" is larger than about 18 MB, so it was not read')
        expect(r.text).not.toContain('too large (over 25 MB')
        expect(r.text.length).toBeLessThan(5000)
        expect((A.ctx.db.query('SELECT status FROM integrations WHERE id=?').get(aliceGmail) as { status: string }).status).toBe('connected')
      }
    } finally { lib.attachment = small }
    expect(p.asked).toEqual([])
  })

  test('a token the library refuses is refreshed once with the card\'s client, then the call goes through', async () => {
    const before = google.tokenCalls.filter((b) => b.get('grant_type') === 'refresh_token').length
    lib.tokens.clear()
    const r = await turn('alice').call('my_gmail__search_gmail_messages', { query: 'x' })
    expect(r.isError).toBe(false)
    const refreshes = google.tokenCalls.filter((b) => b.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(before + 1)
    expect(refreshes.at(-1)!.get('client_secret')).toBe(APP_CLIENT.clientSecret)
    noTokens(r.text)
    // a refused refresh: the person signs in again (the card says Reconnect)
    lib.tokens.clear(); google.invalidRefresh = true
    const bad = await turn('bob').call('my_gmail__search_gmail_messages', { query: 'x' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('Connected apps › Gmail')
    expect(apps.view('bob', 'gmail').status).toBe('needs_reconnect')
    google.invalidRefresh = false
    // Reconnect: the same connection signs in again
    const f = await apps.authorize('bob', 'bob-session', 'gmail')
    expect(await apps.callback(google.authorize(f.authorizationUrl, 'bob'), { userId: 'bob', sessionId: 'bob-session' })).toBe(true)
    expect(await apps.complete('bob', 'bob-session', 'gmail', f.flowId)).toMatchObject({ status: 'connected' })
    expect((A.ctx.db.query("SELECT id FROM integrations WHERE owner_user_id='bob' AND google_app='gmail'").get() as { id: string }).id).toBe(bobGmail)
  })

  test('a 401 again after a refresh that worked is for now: the app is not reachable, the connection stays connected', async () => {
    const refreshes = () => google.tokenCalls.filter((b) => b.get('grant_type') === 'refresh_token').length
    const before = refreshes()
    lib.refuseAll = true
    try {
      const r = await turn('alice').call('my_gmail__search_gmail_messages', { query: 'x' })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('Gmail is not reachable right now, try again in a minute')
      expect(r.text).not.toContain('Connected apps › Gmail')
      expect(refreshes()).toBe(before + 1)
      expect(apps.view('alice', 'gmail').status).toBe('connected')
      expect((A.ctx.db.query('SELECT status FROM integrations WHERE id=?').get(aliceGmail) as { status: string }).status).toBe('connected')
      // a refused refresh still asks for a new sign-in
      google.invalidRefresh = true
      const bad = await turn('alice').call('my_gmail__search_gmail_messages', { query: 'x' })
      expect(bad.isError).toBe(true)
      expect(bad.text).toContain('Connected apps › Gmail')
      expect(apps.view('alice', 'gmail').status).toBe('needs_reconnect')
    } finally { lib.refuseAll = false; google.invalidRefresh = false }
    const f = await apps.authorize('alice', 'alice-session', 'gmail')
    expect(await apps.callback(google.authorize(f.authorizationUrl, 'alice'), { userId: 'alice', sessionId: 'alice-session' })).toBe(true)
    expect(await apps.complete('alice', 'alice-session', 'gmail', f.flowId)).toMatchObject({ status: 'connected' })
  })
})

describe('rooms', () => {
  test('a room session offers only the asker\'s own Google apps; another member\'s connection is never used', async () => {
    // Alice also has a personal MCP connection of her own: not in a room
    A.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, tools_json, created_at, updated_at)
      VALUES ('own-mcp', 'personal', 'alice', 'alice', 'mcp', 'Tasks', 'tasks', 'https://tasks.acme.example/mcp', 'none', 'connected', '[{"name":"search","title":null,"description":"d","readOnly":true,"inputSchema":{"type":"object"}}]', 't', 't')`).run()
    expect([...turn('alice').tools.keys()]).toContain('my_tasks__search')
    lib.calls = []
    const t = turn('alice', { room: true, person: person('no') })
    expect([...t.tools.keys()].length).toBeGreaterThan(0)
    expect([...t.tools.keys()].every((n) => n.startsWith('my_gmail__'))).toBe(true)
    expect(t.prompt).not.toContain('Tasks')
    const r = await t.call('my_gmail__search_gmail_messages', { query: 'lunch' })
    expect(r.text).toContain('for alice')
    expect(lib.calls.map((c) => c.who)).toEqual(['alice'])
    // Bob's session in the same room uses Bob's own, never Alice's
    lib.calls = []
    await turn('bob', { room: true }).call('my_gmail__search_gmail_messages', { query: 'lunch' })
    expect(lib.calls.map((c) => c.who)).toEqual(['bob'])
    // someone without a Google app gets nothing in a room
    expect(turn('erin', { room: true }).tools.size).toBe(0)
    // a change in a room asks every time, without Always allow, even when the person chose it in their own chat
    setPolicy('allow')
    const p = person('no')
    const w = await turn('alice', { room: true, person: p }).call('my_gmail__send_gmail_message', { to: 'x@acme.example', subject: 's', body: 'b' })
    expect(w.isError).toBe(true)
    expect(p.asked).toHaveLength(1)
    expect(p.choices).toEqual([])
    setPolicy('ask')
    A.ctx.db.query("DELETE FROM integrations WHERE id='own-mcp'").run()
    expect(bobGmail).not.toBe(aliceGmail)
  })

  test('what a Google app found keeps the room answer private to the asker', async () => {
    const room = await A.json('/api/rooms', { method: 'POST', as: 'alice', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'group', userIds: ['bob', 'carol'] }) })
    expect(room.status).toBe(201)
    const chat = A.chat('alice')
    const t = turn('alice', { room: true, chat })
    await t.call('my_gmail__search_gmail_messages', { query: 'lunch' })
    const scope = { sources: readScope(A.ctx.db, chat) ?? [], outside: false }
    expect(scope.sources).toContainEqual({ type: 'integration', id: aliceGmail })
    const d = roomAiOf(A.ctx).decide(room.body.id, chat, scope)
    expect(d.post).toBe(false)
    expect(d.outside).toBe(true)
  })
})

describe('the library down', () => {
  test('a call says the app is not reachable now and nothing about the connection changes', async () => {
    lib.stop()
    const r = await turn('alice').call('my_gmail__search_gmail_messages', { query: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Gmail is not reachable right now, try again in a minute')
    expect(apps.view('alice', 'gmail').status).toBe('connected')
    noTokens(logs.join('\n'))
    noTokens(['integrations', 'google_app_flows', 'audit_log', 'tool_events'].map((x) => JSON.stringify(A.ctx.db.query(`SELECT * FROM ${x}`).all())).join('\n'))
  })
})
