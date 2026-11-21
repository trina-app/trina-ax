// The send card on a demo server (free-roam demo QA 2026-11-22 F1, F2; server/src/integrations/connections/tools.ts
// gate, practiceRow). Covered: on a server without demo fakes the Gmail send card is unchanged (Send once, Always allow,
// Don't send, the Always allow note, no practice line); on a demo server with fakes the card for a connection the fakes
// answer (Gmail, Higgsfield) starts with the practice line and is Send / Don't send only, with no note, and a second send
// of the same mail in the chat asks no second card; another connection's card has no practice line; Drive results on a
// demo server carry no drive.google.com link, and a Drive file saved there names its source "Google Drive: <name>".
// Fake Google, a fake library and the demo's own fakes only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, PEOPLE, type CApp, type Person } from '../lib/c-app'
import { APP_CLIENT, FakeGoogle, FakeLibrary, sessionRow } from '../lib/fake-google-apps'
import { DRIVE_CONFIG } from '../lib/fake-google-drive'
import { demoFakesOf, type DemoFakes } from '../../server/src/demo/fakes'
import { googleAppsOf } from '../../server/src/integrations/google-apps/service'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider, practiceRow } from '../../server/src/integrations/connections/tools'
import { say } from '../../server/src/integrations/connections/text'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { demoGoogleOn } from '../../server/src/integrations/google-drive/client'
import { registerDriveTools } from '../../server/src/tools/drive'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'
import type { Locale } from '@mycel/shared/api'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(60_000)

interface Asker { asked: string[]; choices: string[][]; notes: string[]; confirms: string[][]; answer: string }
const asker = (answer: string): Asker => ({ asked: [], choices: [], notes: [], confirms: [], answer })

function turnOf(A: CApp, user: Person, o: { person?: Asker; chat?: string; locale?: Locale } = {}) {
  const chat = o.chat ?? A.chat(user)
  const turnId = A.turn(user, chat)
  const locale = o.locale ?? 'en'
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: false })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles(), signal: new AbortController().signal } as unknown as TurnToolContext['files']
  if (o.person) {
    const p = o.person
    files.person = {
      locale,
      async confirm(q, allow, deny, extra) { p.asked.push(q); p.confirms.push([allow ?? '', deny ?? '', String((extra as { note?: string } | undefined)?.note ?? '')]); return p.answer === 'yes' },
      async choose(q, options, opts) { p.asked.push(q); p.notes.push(String((opts as { note?: string } | undefined)?.note ?? '')); p.choices.push(options.map((x) => x.label)); const want = p.answer === 'yes' ? 'allow' : p.answer === 'no' ? 'deny' : p.answer; return options.some((x) => x.value === want) ? want : null },
      *turnUrls() {},
      allSitesHere: () => true,
      cardApprovals: () => true,
    }
  }
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale, signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t as TurnTool]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError }
  }
  return { chat, tools, call }
}
const MAIL = { to: 'chris.walker@fieldnote.example', subject: 'Thanks', body: 'See you Monday' }
const card = (L: Locale, name: string, what: string, lead = '') => `${lead}${say('confirm', L, { name, what })}\n\n${say('checkBelow', L)}\n\n${say('ask', L)}`

describe('a server without demo fakes', () => {
  let A: CApp, lib: FakeLibrary
  beforeAll(async () => {
    lib = new FakeLibrary().start()
    process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url
    A = await makeCApp('card-demo-real')
    ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
    const google = new FakeGoogle(lib)
    const apps = googleAppsOf(A.ctx, { fetch: google.fetch })
    for (const p of PEOPLE) sessionRow(A.ctx.db, p)
    expect((await A.json('/api/admin/google-apps/gmail/client', { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify(APP_CLIENT) })).status).toBe(200)
    const f = await apps.authorize('alice', 'alice-session', 'gmail')
    expect(await apps.callback(google.authorize(f.authorizationUrl, 'alice'), { userId: 'alice', sessionId: 'alice-session' })).toBe(true)
    expect((await apps.complete('alice', 'alice-session', 'gmail', f.flowId)).status).toBe('connected')
  })
  afterAll(async () => { await A?.close(); lib?.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })

  test('the send card is unchanged: Send once, Always allow, Don\'t send, the note, no practice line', async () => {
    const no = asker('no')
    const r = await turnOf(A, 'alice', { person: no }).call('my_gmail__send_gmail_message', MAIL)
    expect(r.isError).toBe(true)
    expect(no.choices).toEqual([['Send once', 'Always allow', 'Don’t send']])
    expect(no.notes).toEqual([say('alwaysNote', 'en', { name: 'Gmail' })])
    expect(no.asked).toEqual([card('en', 'Gmail', 'Send email')])
    expect(no.asked[0]).not.toContain(say('practiceLead', 'en'))
    expect(lib.calls.filter((c) => c.name === 'send_gmail_message')).toEqual([])
  })

  test('the step and the card name the Gmail tool in the person\'s language', async () => {
    const no = asker('no')
    const t = turnOf(A, 'alice', { person: no, locale: 'ko' })
    expect(t.tools.get('my_gmail__search_gmail_messages')!.label!({}, 'ko')).toBe('Gmail · 메일 찾기')
    expect(t.tools.get('my_gmail__search_gmail_messages')!.label!({}, 'en')).toBe('Gmail · Search mail')
    await t.call('my_gmail__send_gmail_message', { ...MAIL, thread_id: 'th-1', in_reply_to: '<a@x>' })
    expect(no.asked[0]).toStartWith('AI가 Gmail에 이 내용을 보내려고 해요: 메일 보내기')
    expect(practiceRow({ google_app: 'gmail', url: 'https://google-apps.invalid/gmail' })).toBe(false)
    // Drive results keep their drive.google.com link here (read.ts webLink)
    expect(demoGoogleOn()).toBe(false)
  })
})

describe('a demo server with fakes', () => {
  let A: CApp, fakes: DemoFakes
  beforeAll(async () => {
    A = await makeCApp('card-demo-fakes')
    ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
    ;(A.ctx.config as any).demo = { company: 'Steepling', password: 'demo-password-1', personas: [], fakes: {} }
    fakes = demoFakesOf(A.ctx)!
    expect(fakes).toBeTruthy()
    for (const p of PEOPLE) sessionRow(A.ctx.db, p)
    integrationsOf(A.ctx, { net: { lookup: async () => { throw new Error('no lookups in this test') } } })
    const apps = googleAppsOf(A.ctx)
    expect((await A.json('/api/admin/google-apps/gmail/client', { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify(APP_CLIENT) })).status).toBe(200)
    const f = await apps.authorize('alice', 'alice-session', 'gmail')
    const state = new URL(f.authorizationUrl).searchParams.get('state')!
    expect(await apps.callback({ code: 'demo-code', state }, { userId: 'alice', sessionId: 'alice-session' })).toBe(true)
    expect((await apps.complete('alice', 'alice-session', 'gmail', f.flowId)).status).toBe('connected')
  })
  afterAll(async () => { await A?.close() })

  test('the Gmail send card starts with the practice line and is Send / Don\'t send only, with no note', async () => {
    const no = asker('no')
    const r = await turnOf(A, 'alice', { person: no }).call('my_gmail__send_gmail_message', MAIL)
    expect(r.isError).toBe(true)
    expect(no.choices).toEqual([])
    expect(no.asked).toEqual([card('en', 'Gmail', 'Send email', `${say('practiceLead', 'en')}\n\n`)])
    expect(no.confirms).toEqual([['Send', 'Don’t send', '']])
    expect(no.asked[0]).not.toContain(say('alwaysNote', 'en', { name: 'Gmail' }))
    expect(fakes.gmail.sent()).toHaveLength(0)
    // in Korean
    const ko = asker('no')
    await turnOf(A, 'alice', { person: ko, locale: 'ko' }).call('my_gmail__send_gmail_message', MAIL)
    expect(ko.asked[0]).toStartWith('연습용 연결이에요. 실제로는 아무것도 나가지 않아요.\n\nAI가 Gmail에 이 내용을 보내려고 해요: 메일 보내기')
  })

  test('yes sends to the fake; the same mail again in the chat asks no second card', async () => {
    const yes = asker('yes')
    const t = turnOf(A, 'alice', { person: yes })
    expect((await t.call('my_gmail__send_gmail_message', MAIL)).isError).toBe(false)
    expect(yes.asked).toHaveLength(1)
    const again = asker('no')
    expect((await turnOf(A, 'alice', { person: again, chat: t.chat }).call('my_gmail__send_gmail_message', MAIL)).isError).toBe(false)
    expect(again.asked).toEqual([])
    expect(fakes.gmail.sent()).toHaveLength(2)
  })

  test('the practice line only on connections the fakes answer', () => {
    expect(practiceRow({ google_app: 'gmail', url: 'https://google-apps.invalid/gmail' })).toBe(true)
    expect(practiceRow({ google_app: null, url: 'https://mcp.higgsfield.ai/mcp' })).toBe(true)
    expect(practiceRow({ google_app: null, url: 'https://mcp.notion.com/mcp' })).toBe(false)
    expect(practiceRow({ google_app: null, url: 'https://higgsfield.ai.example/mcp' })).toBe(false)
    expect(practiceRow({ google_app: null, url: 'not a url' })).toBe(false)
  })

  test('a Higgsfield card says practice too', async () => {
    const r = await A.json('/api/admin/integrations', { method: 'POST', as: 'carol', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mcp', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp', auth: 'none', access: { everyone: true, groups: [], users: [] } }) })
    expect(r.status).toBe(201)
    const no = asker('no')
    const g = await turnOf(A, 'alice', { person: no }).call('team_higgsfield__generate_image', { prompt: 'a pouch of yuzu ginger tea' })
    expect(g.isError).toBe(true)
    expect(no.choices).toEqual([])
    expect(no.asked).toHaveLength(1)
    expect(no.asked[0]).toStartWith(`${say('practiceLead', 'en')}\n\n`)
  })

  test('Drive results have no drive.google.com link; a saved Drive file names its source as Drive\'s', async () => {
    expect(demoGoogleOn()).toBe(true)
    const svc = googleDriveOf(A.ctx, { config: DRIVE_CONFIG })
    const f = svc.authorize('alice', 'alice-session')
    const state = new URL(f.authorizationUrl).searchParams.get('state')!
    await svc.callback({ code: 'demo-code', state }, { userId: 'alice', sessionId: 'alice-session' })
    svc.complete('alice', 'alice-session', f.flowId)
    const reg = toolRegistry(A.ctx.files)
    registerDriveTools(A.ctx, reg)
    const call = (name: string, input: unknown) => { const chat = A.chat('alice'), t = A.turn('alice', chat); return reg.call(name, input, A.toolCtx('alice', t)) }
    const found = await call('drive_search', { query: 'yuzu' })
    expect(found.isError).not.toBe(true)
    expect(found.text).toContain('Tea recipes.md')
    expect(found.text).not.toContain('drive.google.com')
    const root = await call('drive_list', { folderId: 'root' })
    expect(root.text).toContain('Marketing')
    expect(root.text).not.toContain('drive.google.com')
    const urls: string[] = []
    const on = (e: { url: string }) => urls.push(e.url)
    A.ctx.files.events.on('external', on)
    try {
      const saved = await call('save_connector_file', { file: 'drive:media-plan' })
      expect(saved.isError).not.toBe(true)
      expect(JSON.stringify(saved)).not.toContain('drive.google.com')
      expect(saved.summary).toMatch(/from Google Drive: .+/)
      expect(urls).toHaveLength(1)
      expect(urls[0]).toStartWith('Google Drive: ')
    } finally { A.ctx.files.events.off('external', on) }
  })
})
