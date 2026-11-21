// The demo's fake services (server/src/demo/fakes/, docs/decisions/20261119-demo-fakes.md). Covered: with a demo file
// that asks for fakes, a Gmail sign-in, its tool list and every Gmail call are answered in this process (the library
// state ready without a Python program, the tokens a year long, refresh answered locally); a send asks on the product's
// confirm card, is stored in <data>/demo-fakes/state.json and is never sent; Drive's sign-in, list, search and read come
// from the fake file tree; the Higgsfield connection answers its small tool list, a picture comes back inline and at a
// download address only the fake answers, a video is refused; and every other outside call (connections, web_fetch,
// downloads, Slack, fetch, WebSocket, DNS, sockets, http(s)) is refused, with DNS and socket stubs that fail the test if
// they are reached. Loopback keeps working, and closing the server takes the fence away. Fake data only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import dns from 'node:dns'
import dnsp from 'node:dns/promises'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { makeCApp, PEOPLE, type CApp, type Person } from '../lib/c-app'
import { APP_CLIENT, sessionRow } from '../lib/fake-google-apps'
import { DRIVE_CONFIG } from '../lib/fake-google-drive'
import { activeDemoFakes, demoFakesOf, DEMO_OFFLINE_TEXT, type DemoFakes } from '../../server/src/demo/fakes'
import { demoOffline } from '../../server/src/demo/fakes/offline'
import { FakeState, STATE_DIR, STATE_FILE } from '../../server/src/demo/fakes/state'
import { FakeHiggsfield, HIGGSFIELD_TOOLS, loadPictures, MEDIA_HOST, noPictureText, pickPicture, PREPARED_PHOTO, SAVE_NEXT, VIDEO_REFUSED } from '../../server/src/demo/fakes/higgsfield'
import { HIGGSFIELD_PICTURE } from '../../scripts/demo/steepling/make'
import { SCENE_PICTURES } from '../../scripts/demo/steepling/banner/kit'
import { googleAppsOf, type GoogleApps } from '../../server/src/integrations/google-apps/service'
import { workspaceLibraryOf } from '../../server/src/integrations/google-apps/library'
import { refreshGoogleApp } from '../../server/src/integrations/google-apps/tokens'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { NetError, serviceRequest } from '../../server/src/integrations/connections/net'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { registerDriveTools } from '../../server/src/tools/drive'
import { toolRegistry } from '../../server/src/tools/registry'
import { webFetch } from '../../server/src/tools/web-fetch'
import { downloadToFile } from '../../server/src/tools/download'
import { SlackApi, SlackApiError } from '../../server/src/integrations/slack/api'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(60_000)

// ---- stubs that fail the test if a lookup or a socket to the outside is ever reached ----
const reached: string[] = []
const loop = (h: unknown) => typeof h === 'string' && (h === 'localhost' || h === '::1' || h.startsWith('127.'))
const saved: { obj: any; key: string; orig: any }[] = []
// a loopback name lookup through the promise API is answered here, not by the layer below: in one process with the whole
// tests/unit run another file may have left its own throwing dns/promises lookup in place (b-safety-cards-wait does)
const loopAnswer = (h: string, o: any) => { const a = { address: h === '::1' ? '::1' : '127.0.0.1', family: h === '::1' ? 6 : 4 }; return Promise.resolve(o && typeof o === 'object' && o.all ? [a] : a) }
function stub(obj: any, key: string, host: (args: any[]) => unknown) {
  const orig = obj[key]
  saved.push({ obj, key, orig })
  obj[key] = (...args: any[]) => {
    const h = host(args)
    if (obj === dnsp && key === 'lookup' && loop(h)) return loopAnswer(h as string, args[1])
    if (h === null || loop(h)) return orig.apply(obj, args)
    reached.push(`${key}:${String(h)}`)
    throw new Error(`STUB REACHED ${key} ${String(h)}`)
  }
}
const sockHost = (a: any[]) => (a[0] && typeof a[0] === 'object' ? (a[0].path ? null : a[0].host ?? 'localhost') : typeof a[0] === 'string' && !/^\d+$/.test(a[0]) ? null : a[1] ?? 'localhost')
const throwingLookup = async (h: string): Promise<never> => { reached.push(`lookup-option:${h}`); throw new Error('STUB REACHED lookup option') }
const origFetch = globalThis.fetch

let A: CApp, fakes: DemoFakes, apps: GoogleApps
let carolHiggsfield = ''

beforeAll(async () => {
  for (const k of ['lookup', 'resolve4']) { stub(dnsp, k, (a) => a[0]); stub(dns, k, (a) => a[0]) }
  stub(net, 'connect', sockHost); stub(net, 'createConnection', sockHost); stub(tls, 'connect', sockHost)
  A = await makeCApp('demo-fakes')
  ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
  // the demo file's fakes, with the built-in data
  ;(A.ctx.config as any).demo = { company: 'Steepling', password: 'demo-password-1', personas: [], fakes: {} }
  fakes = demoFakesOf(A.ctx)!
  expect(fakes).toBeTruthy()
  expect(demoOffline()).toBe(true)
  for (const p of PEOPLE) sessionRow(A.ctx.db, p)
  integrationsOf(A.ctx, { net: { lookup: throwingLookup } })
  apps = googleAppsOf(A.ctx)
})
afterAll(async () => {
  await A?.close()
  for (const s of saved.reverse()) s.obj[s.key] = s.orig
})

interface Asker { asked: string[]; choices: string[][]; answer: string }
const asker = (answer: string): Asker => ({ asked: [], choices: [], answer })
function turn(user: Person, o: { person?: Asker } = {}) {
  const chat = A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: false })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles(), signal: new AbortController().signal } as unknown as TurnToolContext['files']
  if (o.person) {
    const p = o.person
    files.person = {
      locale: 'en',
      async confirm(q) { p.asked.push(q); return p.answer === 'yes' },
      async choose(q, options) { p.asked.push(q); p.choices.push(options.map((x) => x.label)); const want = p.answer === 'yes' ? 'allow' : p.answer === 'no' ? 'deny' : p.answer; return options.some((x) => x.value === want) ? want : null },
      *turnUrls() {},
      allSitesHere: () => true,
    }
  }
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t as TurnTool]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError, images: r.content.filter((c) => c.type === 'image').length }
  }
  return { tools, call }
}

describe('Gmail', () => {
  test('the library is ready with no Python program; a sign-in is answered here; tokens last a year', async () => {
    expect(workspaceLibraryOf(A.ctx).state()).toBe('ready')
    expect(await workspaceLibraryOf(A.ctx).whenReady(10)).toBe(true)
    const r = await A.json('/api/admin/google-apps/gmail/client', { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify(APP_CLIENT) })
    expect(r.status).toBe(200)
    const f = await apps.authorize('alice', 'alice-session', 'gmail')
    const state = new URL(f.authorizationUrl).searchParams.get('state')!
    expect(await apps.callback({ code: 'demo-code', state }, { userId: 'alice', sessionId: 'alice-session' })).toBe(true)
    expect((await apps.complete('alice', 'alice-session', 'gmail', f.flowId)).status).toBe('connected')
    // Google's token and userinfo were the fake's
    expect(fakes.google.calls).toEqual(expect.arrayContaining(['POST https://oauth2.googleapis.com/token', 'GET https://openidconnect.googleapis.com/v1/userinfo']))
    // a refresh is answered here, a year long, without asking anyone
    const now = Date.now()
    const t = await refreshGoogleApp(A.ctx, { tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: now }, google: { app: 'gmail', key: 'whatever', mode: 'direct' } } as any, now)
    expect(t.refreshToken).toBe('r')
    expect(t.expiresAt! - now).toBeGreaterThan(360 * 86_400_000)
  })

  test('every Gmail read is answered from the fake mailbox', async () => {
    const t = turn('alice', { person: asker('no') })
    const names = [...t.tools.keys()].filter((n) => n.startsWith('my_gmail__'))
    expect(names).toEqual(expect.arrayContaining(['my_gmail__search_gmail_messages', 'my_gmail__get_gmail_message_content', 'my_gmail__send_gmail_message', 'my_gmail__draft_gmail_message']))
    const s = await t.call('my_gmail__search_gmail_messages', { query: 'from:chris' })
    expect(s.isError).toBe(false)
    expect(s.text).toContain('Message ID: chris-reply')
    expect(s.text).toContain('external data from Gmail')
    const m = await t.call('my_gmail__get_gmail_message_content', { message_id: 'chris-reply' })
    expect(m.text).toContain('Looks great, running it Monday.')
    expect((await t.call('my_gmail__get_gmail_thread_content', { thread_id: 'banner' })).text).toContain('Final banner for Monday')
    expect((await t.call('my_gmail__get_gmail_messages_content_batch', { message_ids: ['welcome', 'it-setup'] })).text).toContain('Your laptop and accounts')
    expect((await t.call('my_gmail__list_gmail_labels', {})).text).toContain('INBOX')
    const sent = await t.call('my_gmail__search_gmail_messages', { query: 'in:sent' })
    expect(sent.text).toContain('banner-sent')
  })

  test('a send asks on the confirm card; no sends nothing; yes stores it and never sends it', async () => {
    const no = asker('no')
    const r1 = await turn('alice', { person: no }).call('my_gmail__send_gmail_message', { to: 'chris.walker@fieldnote.example', subject: 'Thanks', body: 'See you Monday' })
    expect(r1.isError).toBe(true)
    // a demo server's card is Send / Don't send, no Always allow (connection-card-demo.test.ts)
    expect(no.choices).toEqual([])
    expect(no.asked).toHaveLength(1)
    expect(fakes.gmail.sent()).toHaveLength(0)
    const yes = asker('yes')
    const r2 = await turn('alice', { person: yes }).call('my_gmail__send_gmail_message', { to: 'chris.walker@fieldnote.example', subject: 'Thanks', body: 'See you Monday' })
    expect(yes.asked).toHaveLength(1)
    expect(r2.isError).toBe(false)
    expect(r2.text).toMatch(/Email sent! Message ID: m[a-z0-9]+/)
    expect(fakes.gmail.sent()).toHaveLength(1)
    expect(fakes.gmail.sent()[0]).toMatchObject({ to: 'chris.walker@fieldnote.example', subject: 'Thanks', labels: ['SENT'] })
    // kept on disk for this instance, and found again by a search
    const file = path.join(A.ctx.config.dataDir, STATE_DIR, STATE_FILE)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(new FakeState(A.ctx.config.dataDir).get().sent[0]!.subject).toBe('Thanks')
    expect((await turn('alice').call('my_gmail__search_gmail_messages', { query: 'in:sent thanks' })).text).toContain('Thanks')
    // a draft is stored too
    const d = await turn('alice', { person: asker('yes') }).call('my_gmail__draft_gmail_message', { subject: 'Draft', body: 'later' })
    expect(d.text).toContain('Draft created!')
    expect(fakes.gmail.drafts()).toHaveLength(1)
    expect(reached).toEqual([])
  })
})

describe('Drive', () => {
  test('sign-in, list, search and read come from the fake file tree', async () => {
    const svc = googleDriveOf(A.ctx, { config: DRIVE_CONFIG })
    const f = svc.authorize('alice', 'alice-session')
    const state = new URL(f.authorizationUrl).searchParams.get('state')!
    await svc.callback({ code: 'demo-code', state }, { userId: 'alice', sessionId: 'alice-session' })
    svc.complete('alice', 'alice-session', f.flowId)
    registerDriveTools(A.ctx, toolRegistry(A.ctx.files))
    const call = (name: string, input: unknown) => { const chat = A.chat('alice'), t = A.turn('alice', chat); return toolRegistry(A.ctx.files).call(name, input, A.toolCtx('alice', t)) }
    const root = await call('drive_list', { folderId: 'root' })
    expect(root.isError).not.toBe(true)
    expect(root.text).toContain('Marketing')
    expect(root.text).toContain('Team handbook')
    const inside = await call('drive_list', { folderId: 'launch' })
    expect(inside.text).toContain('Yuzu Ginger launch brief')
    const found = await call('drive_search', { query: 'yuzu' })
    expect(found.text).toContain('Tea recipes.md')
    const doc = await call('drive_read', { fileId: 'brief' })
    expect(doc.isError).not.toBe(true)
    expect(doc.text).toContain('Winter Yuzu Ginger')
    const csv = await call('drive_read', { fileId: 'media-plan' })
    expect(csv.text).toContain('Fieldnote')
    expect(fakes.google.calls.some((c) => c.includes('/drive/v3/files/brief/export'))).toBe(true)
    // a Google sheet (TC-5885): the reader's xlsx export is built from the seeded CSV and read as a sheet
    const sheet = await call('drive_read', { fileId: 'price-sheet' })
    expect(sheet.isError).not.toBe(true)
    expect(sheet.text).toContain('Winter Yuzu Ginger')
    expect(sheet.text).toContain('£6.50')
    expect(fakes.google.calls.some((c) => c.includes('/drive/v3/files/price-sheet/export'))).toBe(true)
    // asked for CSV (Google answers a sheet as CSV too), the text as it was seeded; a sheet has no size, like Drive's own
    const auth = { headers: { authorization: 'Bearer demo-access-x' } }
    const asCsv = await fakes.google.fetch('https://www.googleapis.com/drive/v3/files/price-sheet/export?mimeType=text%2Fcsv', auth)
    expect(asCsv.status).toBe(200)
    expect(await asCsv.text()).toContain('Earl Grey,£5.00,£5.40')
    expect((await (await fakes.google.fetch('https://www.googleapis.com/drive/v3/files/price-sheet', auth)).json()).size).toBeUndefined()
    // a sheet's raw bytes stay refused, like Drive (only an export reads it)
    expect((await fakes.google.fetch('https://www.googleapis.com/drive/v3/files/price-sheet?alt=media', auth)).status).toBe(403)
    expect(reached).toEqual([])
  })
})

describe('Higgsfield', () => {
  test('a team connection answers the small tool list; a picture comes inline and downloads; a video is refused', async () => {
    const r = await A.json('/api/admin/integrations', { method: 'POST', as: 'carol', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mcp', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp', auth: 'none', access: { everyone: true, groups: [], users: [] } }) })
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('connected')
    carolHiggsfield = r.body.id
    const t = turn('alice', { person: asker('yes') })
    expect([...t.tools.keys()].filter((n) => n.startsWith('team_higgsfield__')).sort()).toEqual(['team_higgsfield__balance', 'team_higgsfield__generate_image', 'team_higgsfield__generate_video', 'team_higgsfield__job_display', 'team_higgsfield__show_generations'])
    // a banner's words are the server's own change_banner_text (tools/demo-banner.ts), never a Higgsfield tool; with the
    // built-in data (no banner kit) it is not offered at all
    expect(toolRegistry(A.ctx.files).available('change_banner_text')).toBe(false)
    expect((await t.call('team_higgsfield__balance', {})).text).toContain('credits')
    const g = await t.call('team_higgsfield__generate_image', { prompt: 'a pouch of yuzu ginger tea by a frosted window' })
    expect(g.isError).toBe(false)
    expect(g.text).toContain(MEDIA_HOST)
    // QA TC-6792 / TC-6791: the result says the photo is a prepared one, and that it is saved and shown next
    expect(g.text).toContain(PREPARED_PHOTO)
    expect(g.text).toContain(SAVE_NEXT)
    const desc = HIGGSFIELD_TOOLS.find((x) => x.name === 'generate_image')!.description
    expect(desc).toContain("demo's prepared photos")
    expect(desc).toContain('save_connector_file right away')
    expect(desc).toContain('change_banner_text')
    expect(g.text).toMatch(/mcp-file:[A-Za-z0-9_-]{22}/)
    const job = /"job_id":"(job[a-z0-9]+)"/.exec(g.text)?.[1]
    expect(job).toBeTruthy()
    expect((await t.call('team_higgsfield__job_display', { job_id: job })).text).toContain('completed')
    expect((await t.call('team_higgsfield__show_generations', {})).text).toContain(job!)
    const v = await t.call('team_higgsfield__generate_video', { prompt: 'a cup steaming' })
    expect(v.isError).toBe(true)
    expect(v.text).toContain(VIDEO_REFUSED)
    // the download address is the fake's own (tools/download.ts)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-fakes-'))
    const dst = path.join(dir, 'pic.png')
    const d = await downloadToFile(`https://${MEDIA_HOST}/${job}.png`, dst, { httpsOnly: true, maxBytes: 10_000_000, lookup: throwingLookup })
    expect(d.contentType).toBe('image/png')
    expect(fs.readFileSync(dst).subarray(1, 4).toString()).toBe('PNG')
    fs.rmSync(dir, { recursive: true, force: true })
    expect(reached).toEqual([])
  })

  test('the picture is picked by the words of its file name', () => {
    const p = (name: string) => ({ name, mime: 'image/jpeg', words: name.replace(/\.\w+$/, '').split('-'), read: () => Buffer.alloc(0) })
    const pics = [p('office-desk.jpg'), p('yuzu-ginger-window.jpg'), p('iced-tea-glass.jpg')]
    expect(pickPicture(pics, 'Yuzu ginger pouch by a frosted window')!.name).toBe('yuzu-ginger-window.jpg')
    // no word in common: no picture (QA 11-22 A4: it gave the first one, the same photo again)
    expect(pickPicture(pics, 'something else')).toBeNull()
    expect(pickPicture([], 'x')).toBeNull()
    // Steepling's story photo: named "00-…" so it sorts first and wins a tie, with the story's words in English and
    // Korean (the review of the richer Steepling)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pics-'))
    fs.mkdirSync(path.join(dir, 'higgsfield'))
    for (const n of [HIGGSFIELD_PICTURE, 'zz-office-desk.jpg']) fs.writeFileSync(path.join(dir, 'higgsfield', n), 'x')
    const story = loadPictures(dir)
    expect(story[0]!.name.normalize('NFC')).toBe(HIGGSFIELD_PICTURE.normalize('NFC'))
    for (const prompt of ['유자 진저 파우치, 창가 아침 햇살', 'Yuzu ginger pouch by a frosted window']) expect(pickPicture(story, prompt)!.name.normalize('NFC'), prompt).toBe(HIGGSFIELD_PICTURE.normalize('NFC'))
    expect(pickPicture(story, '새 배경 만들어 줘')).toBeNull()
    expect(pickPicture(story, 'an office desk')!.name).toBe('zz-office-desk.jpg')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("Steepling's Higgsfield: a scene it has no photo for (QA 11-22 A4)", () => {
  const call = async (h: FakeHiggsfield, prompt: string) => {
    const r = await h.tools.find((t) => t.name === 'generate_image')!.call({ prompt })
    return { isError: !!r.isError, text: r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n'), images: r.content.filter((c) => c.type === 'image').length }
  }
  test('no matching photo: no picture, no job, nothing to save, and the prepared scenes named', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pics-'))
    fs.mkdirSync(path.join(dir, 'higgsfield'))
    for (const n of [HIGGSFIELD_PICTURE, ...Object.values(SCENE_PICTURES)]) fs.writeFileSync(path.join(dir, 'higgsfield', n), 'x')
    const state = new FakeState(fs.mkdtempSync(path.join(os.tmpdir(), 'pics-state-')))
    const h = new FakeHiggsfield(loadPictures(dir), state)
    for (const prompt of ['눈 내리는 밤 거리', 'a snowy mountain cabin at night']) {
      const r = await call(h, prompt)
      expect(r.isError, prompt).toBe(true)
      expect(r.images).toBe(0)
      expect(r.text).toBe(noPictureText(prompt, loadPictures(dir)))
      expect(r.text).toContain('Nothing was made')
      expect(r.text).toContain('Prepared scenes: yuzu ginger tea pouch iced glass frosted window; two glasses iced')
      expect(r.text).toContain('change_banner_text with scene')
      expect(r.text).not.toContain('mcp-file:')
    }
    expect(state.get().generations).toEqual([])
    // "눈 내리는 창가" shares "창가" (window) with the story photo, a frosted window: that photo, once; asked again, no
    // second copy (A4 got it twice and saved it twice)
    const first = await call(h, '눈 내리는 창가')
    expect([first.isError, first.images]).toEqual([false, 1])
    const again = await call(h, '눈 내리는 창가, 다른 느낌으로')
    expect([again.isError, again.images]).toEqual([true, 0])
    expect(again.text).toContain('Nothing new was made; do not save it again')
    expect(state.get().generations.length).toBe(1)
    // another scene is still there
    const cafe = await call(h, 'cafe table')
    expect([cafe.isError, cafe.images]).toEqual([false, 1])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('everything else is refused, before a lookup or a socket', () => {
  test('connections to an unknown service', async () => {
    await expect(serviceRequest('https://api.example.com/mcp', { method: 'POST', headers: [] }, { lookup: throwingLookup })).rejects.toBeInstanceOf(NetError)
    const r = await A.json('/api/admin/integrations', { method: 'POST', as: 'carol', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mcp', name: 'Elsewhere', url: 'https://mcp.elsewhere.example/mcp', auth: 'none', access: { everyone: true, groups: [], users: [] } }) })
    expect(r.body.status).not.toBe('connected')
    expect(reached).toEqual([])
  })

  test('web_fetch, downloads, Slack', async () => {
    await expect(webFetch('https://example.com/', { lookup: throwingLookup })).rejects.toThrow(DEMO_OFFLINE_TEXT)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-fakes-'))
    await expect(downloadToFile('https://example.com/a.png', path.join(dir, 'a.png'), { lookup: throwingLookup })).rejects.toThrow(DEMO_OFFLINE_TEXT)
    expect(fs.existsSync(path.join(dir, 'a.png'))).toBe(false)
    // an unknown generation on the fake's own host is not answered either
    await expect(downloadToFile(`https://${MEDIA_HOST}/nope.png`, path.join(dir, 'b.png'), { lookup: throwingLookup })).rejects.toThrow(DEMO_OFFLINE_TEXT)
    fs.rmSync(dir, { recursive: true, force: true })
    const slack = new SlackApi()
    await expect(slack.call('auth.test', 'xoxb-demo')).rejects.toBeInstanceOf(SlackApiError)
    expect(slack.socketUrlOk('wss://wss-primary.slack.com/link')).toBe(false)
    expect(slack.responseUrlOk('https://hooks.slack.com/actions/x')).toBe(false)
    expect(await slack.respond('https://hooks.slack.com/actions/x', {})).toBe(false)
    expect(reached).toEqual([])
  })

  test('fetch, WebSocket, DNS, sockets and http(s) from anywhere in the process', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow(DEMO_OFFLINE_TEXT)
    await expect(fetch(new Request('https://api.anthropic.com/v1/messages', { method: 'POST' }))).rejects.toThrow(DEMO_OFFLINE_TEXT)
    expect(() => new WebSocket('wss://example.com/socket')).toThrow(DEMO_OFFLINE_TEXT)
    await expect(dnsp.lookup('example.com')).rejects.toThrow(DEMO_OFFLINE_TEXT)
    await expect(dnsp.resolve4('example.com')).rejects.toThrow(DEMO_OFFLINE_TEXT)
    const cbErr = await new Promise<Error | null>((ok) => dns.lookup('example.com', (e) => ok(e)))
    expect(cbErr?.message).toContain(DEMO_OFFLINE_TEXT)
    const sockErr = await new Promise<Error>((ok) => net.connect(443, 'example.com').on('error', ok))
    expect(sockErr.message).toContain(DEMO_OFFLINE_TEXT)
    const tlsErr = await new Promise<Error>((ok) => tls.connect({ host: '93.184.215.14', port: 443 }).on('error', ok))
    expect(tlsErr.message).toContain(DEMO_OFFLINE_TEXT)
    expect(() => https.request('https://example.com/')).toThrow(DEMO_OFFLINE_TEXT)
    expect(() => http.get({ host: 'example.com', port: 80 })).toThrow(DEMO_OFFLINE_TEXT)
    expect(reached).toEqual([])
  })

  test('loopback still works (the model proxy, the gate and the app itself are on this computer)', async () => {
    const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('here') })
    try {
      expect(await (await fetch(`http://127.0.0.1:${s.port}/`)).text()).toBe('here')
      expect((await dnsp.lookup('localhost')).address).toBeTruthy()
    } finally { s.stop(true) }
  })
})

test('closing the server takes the fence away', async () => {
  expect(carolHiggsfield).toBeTruthy()
  await A.close()
  A = undefined as unknown as CApp
  expect(activeDemoFakes()).toBeNull()
  expect(demoOffline()).toBe(false)
  expect(globalThis.fetch).toBe(origFetch)
})
