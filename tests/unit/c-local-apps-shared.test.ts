// An app on the person's computer (docs/decisions/20261118-local-app-connectors.md, rule 3) in chats more than one
// person sees (owner 2026-11-20: after alice shared a chat, her own Aside stopped working for her from her desktop app;
// the turn's "desktop" flag was the in-app browser's, which is off in every shared chat). Each person's turn uses that
// person's own connections: alice's turn from her connected desktop window gets her Aside in a private chat, a chat
// shared with bob and a team project chat (where the shared chat's card asks her first); bob's turn, even from his own
// desktop window, never gets it and nothing reaches any desktop app; alice from the web is told the one known reason,
// never a guess.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import fs from 'node:fs'
import { ATTACH_HOW_LOCAL } from '../../server/src/integrations/connections/team-attach'
import path from 'node:path'
import { getChatRuntime } from '../../server/src/chat/runtime'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const DESK = 'win-lshared-desk1'
const WEB = 'win-lshared-web01'
const BOB_DESK = 'win-lshared-bobd1'
const SPEC = { adapter: 'mcp' as const, command: 'aside', args: ['mcp'], env: [] }
const TOOL = 'my_aside__echo'

let h: Harness
const sock: Record<string, TestSocket> = {}
const stops: (() => void)[] = []
/** what each fake desktop app was sent: its window, the method and the turn */
const seen: { window: string; method: string; turnId: string | null; args?: Record<string, unknown>; fetched?: { url: string; status: number; bytes: Buffer; type: string | null; again: number }[] }[] = []
let projectId: string

/** a fake desktop app: answers local.call as an MCP server (initialize, tools/list, tools/call echo) */
function serveLocal(s: TestSocket, window: string) {
  const done = new Set<string>()
  const timer = setInterval(() => {
    for (const f of s.frames as ServerFrame[]) {
      if (f.type !== 'local.call' || done.has(f.data.call.callId)) continue
      const call = f.data.call
      done.add(call.callId)
      s.send({ type: 'local.ack', callId: call.callId })
      const m = call.message as { id?: string; method: string; params?: { arguments?: { text?: string; code?: string } } }
      const entry: (typeof seen)[number] = { window, method: m.method, turnId: call.turnId, ...(m.params?.arguments ? { args: m.params.arguments } : {}) }
      seen.push(entry)
      // the app's code downloads each link it was given, as Aside's repl fetch does (local-file-links.ts), and says the
      // address back in its answer
      const urls = m.method === 'tools/call' ? [...(m.params?.arguments?.code ?? '').matchAll(/https?:\/\/[^"'`\s)]+/g)].map((x) => x[0]) : []
      if (urls.length) {
        void (async () => {
          entry.fetched = []
          for (const url of urls) {
            const r = await fetch(url)
            const bytes = Buffer.from(await r.arrayBuffer())
            entry.fetched.push({ url, status: r.status, bytes, type: r.headers.get('content-type'), again: (await fetch(url)).status })
          }
          s.send({ type: 'local.result', result: { callId: call.callId, ok: true, message: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `fetched ${entry.fetched.map((f) => `${f.status} ${f.bytes.length} B from ${f.url}`).join(', ')}` }] } } } })
        })()
        continue
      }
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Say it back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
          // a tool that acts (Aside's repl: code in the person's browser)
          { name: 'repl', description: 'Run code in the browser', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } }] }
        : m.method === 'tools/call' ? { content: [{ type: 'text', text: `echo: ${m.params?.arguments?.text ?? ''}` }] }
        : null
      s.send({ type: 'local.result', result: { callId: call.callId, ok: true, message: m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result } } })
    }
  }, 20)
  stops.push(() => clearInterval(timer))
}

beforeAll(async () => {
  h = await startHarness({ name: 'c-local-apps-shared', askUserTimeoutMs: 5000, stallTimeoutMs: 60_000 })
  sock.desk = await h.ws('alice', { windowId: DESK, client: 'desktop' }); await sock.desk.next('hello')
  sock.web = await h.ws('alice', { windowId: WEB }); await sock.web.next('hello')
  sock.bob = await h.ws('bob', { windowId: BOB_DESK, client: 'desktop' }); await sock.bob.next('hello')
  serveLocal(sock.desk, DESK)
  serveLocal(sock.bob, BOB_DESK)
  const made = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.createLocalIntegration, { body: { name: 'Aside', spec: SPEC } })
  expect(made).toMatchObject({ kind: 'local', status: 'connected' })
  // a team project alice writes and bob (finance) reads; its chats are shared with everyone who sees the project
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of stops) s(); for (const s of Object.values(sock)) s.close(); await h?.close() })

const from = {
  desk: { user: 'alice', window: DESK, client: 'desktop' as const, sock: () => sock.desk! },
  web: { user: 'alice', window: WEB, client: 'web' as const, sock: () => sock.web! },
  bob: { user: 'bob', window: BOB_DESK, client: 'desktop' as const, sock: () => sock.bob! },
}
type From = (typeof from)[keyof typeof from]

/** a turn whose cards are answered "Allow once" (the shared chat's card to the asker) until it ends */
async function ask(f: From, chatId: string, content: string, pick: RegExp | null = /once/i) {
  const started = await h.api(f.user, { window: f.window, client: f.client }).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const answered = new Set<string>()
  const cards: { question: string }[] = []
  const timer = setInterval(() => {
    for (const fr of f.sock().frames) {
      if (fr.type !== 'turn.request') continue
      const d = (fr as { data: { turnId: string; request: { requestId: string; question: string; options: { label: string; value: string }[] } } }).data
      if (d.turnId !== started.turnId || answered.has(d.request.requestId)) continue
      answered.add(d.request.requestId)
      cards.push(d.request)
      if (!pick) continue
      const once = d.request.options.find((o) => pick.test(o.label) || pick.test(o.value)) ?? d.request.options[0]!
      void h.api(f.user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: d.request.requestId, answer: once.value } }).catch(() => {})
    }
  }, 20)
  try {
    const done = await f.sock().next('message.done', (fr) => fr.data.messageId === started.assistantMessage.id, 40_000)
    await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
    return { started, cards, content: done.data.message.content as string }
  } finally { clearInterval(timer) }
}
const PROBE = fake({ echo: 'tools' }, { say: ' | ' }, { tool: TOOL, args: { text: 'hi' }, sayResult: true }, { say: ' | ' }, { echo: 'system' })
const parts = (s: string) => { const [tools, result, ...system] = s.split(' | '); return { tools: tools!.split(','), result: result ?? '', system: system.join(' | ') } }
const callsOf = (turnId: string) => seen.filter((s) => s.turnId === turnId)

async function sharedWithBob() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const put = (confirmKey?: string) => h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects: [{ subjectType: 'user', subjectId: 'bob' }], ...(confirmKey ? { confirmKey } : {}) } })
  let r = await put()
  if (r.status === 'confirm') r = await put(r.confirmKey)
  expect(r.status).toBe('saved')
  return c.id
}
const projectChat = async () => (await h.api('alice').call(API.createChat, { body: { projectId } })).id
const privateChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id

/** alice from her desktop gets her Aside; the call goes to her desktop window only, for that turn */
async function aliceGetsIt(chatId: string, shared: boolean, seen = false) {
  const r = await ask(from.desk, chatId, PROBE)
  const p = parts(r.content)
  expect(p.tools).toContain(TOOL)
  expect(p.result).toContain('echo: hi')
  const mine = callsOf(r.started.turnId)
  expect(mine.some((s) => s.method === 'tools/call')).toBe(true)
  expect(mine.every((s) => s.window === DESK)).toBe(true)
  // a shared chat: the asker sees the one notice first, the first time there (docs/decisions/20261123-shared-connector-
  // warning-once.md); a private chat, or the same place again, asks nothing
  if (shared && !seen) expect(r.cards.some((c) => c.question.includes('Aside'))).toBe(true)
  else expect(r.cards).toEqual([])
}
/** bob's turn in the same chat, from his own connected desktop window: alice's Aside is never his */
async function bobNever(chatId: string) {
  const r = await ask(from.bob, chatId, PROBE)
  const p = parts(r.content)
  expect(p.tools).not.toContain(TOOL)
  expect(p.result).not.toContain('echo: hi')
  // his own connections section (the chat's history after it holds alice's earlier answers, which name Aside)
  const own = p.system.slice(p.system.indexOf('## Connected services'))
  const section = own.slice(0, own.indexOf('\n## ', 5) > 0 ? own.indexOf('\n## ', 5) : undefined)
  expect(section).toContain('this user has no app connection')
  expect(section).not.toContain('Aside')
  expect(callsOf(r.started.turnId)).toEqual([])
  expect(seen.some((s) => s.window === BOB_DESK)).toBe(false)
  expect(r.cards).toEqual([])
}

describe("an app on alice's computer in each kind of chat", () => {
  test('a private chat (unchanged): from her desktop it runs with no card', async () => {
    await aliceGetsIt(await privateChat(), false)
  })

  test('a chat shared with bob: her turn from her desktop gets it (her card first); bob\'s turn never does', async () => {
    const chat = await sharedWithBob()
    await aliceGetsIt(chat, true)
    await bobNever(chat)
    // and alice again after bob's turn: still hers (the notice was seen in this chat)
    await aliceGetsIt(chat, true, true)
  })

  test('a team project chat (shared by default): the same both ways', async () => {
    const chat = await projectChat()
    await aliceGetsIt(chat, true)
    await bobNever(chat)
  })

  test('a shared chat, no press on her notice: nothing reaches her desktop app for that turn', async () => {
    const chat = await sharedWithBob()
    const r = await ask(from.desk, chat, fake({ tool: TOOL, args: { text: 'no' }, sayResult: true }), null)
    expect(r.cards.some((c) => c.question.includes('Aside'))).toBe(true)
    expect(r.content).not.toContain('echo: no')
    expect(callsOf(r.started.turnId)).toEqual([])
  })

  test('from the web in a shared chat: not offered, and the AI is told the one known reason with no guessing', async () => {
    const chat = await sharedWithBob()
    const r = await ask(from.web, chat, PROBE)
    const p = parts(r.content)
    expect(p.tools).not.toContain(TOOL)
    expect(callsOf(r.started.turnId)).toEqual([])
    expect(p.system).toContain('Aside (an app on the user\'s own computer, personal connection): not usable in this answer')
    expect(p.system).toContain('this message was sent from the web page')
    expect(p.system).toContain('Do not guess at other causes')
  })
})

// docs/decisions/20261128-local-app-team-file-links.md: the owner asked for a vendor reply with a team quote PDF through
// their Daum mail in Aside (earlier: "Aside cannot attach", 20261126-shared-chat-own-tools.md). An app on the computer
// takes code or a task: a handle in quotes there becomes a one-time download link after the card, the app downloads the
// checked bytes once, and the AI sees the handle again in the answer, never the link
describe('a team file handed to an app on the computer', () => {
  const REL = 'shared/handbook.pdf'
  const code = (handle = `team-file:${REL}`) => `const r = await fetch("${handle}"); await page.locator('e5').setInputFiles([{ name: 'handbook.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await r.arrayBuffer()) }])`
  const evOf = (turnId: string) => (h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'my_aside__repl'").get(turnId) as { summary: string }).summary
  for (const kind of ['private', 'shared'] as const) {
    test(`${kind} chat: the code gets a one-time link to the checked file; the AI sees only the handle`, async () => {
      const chat = kind === 'private' ? await privateChat() : await projectChat()
      const r = await ask(from.desk, chat, fake({ tool: 'my_aside__repl', args: { code: code() }, sayResult: true }))
      // the card named the file (the repl changes something: its card is the consent for the file leaving the team)
      expect(r.cards.some((c) => c.question.includes('Aside'))).toBe(true)
      const call = callsOf(r.started.turnId).find((x) => x.method === 'tools/call')!
      const sent = String(call.args?.code)
      expect(sent).not.toContain('team-file:')
      const url = /"(https?:\/\/[^"]+)"/.exec(sent)![1]!
      expect(url.startsWith(`${h.url.replace(/\/$/, '')}/team-file-links/`)).toBe(true)
      expect(sent).toBe(code(url))
      await waitFor(() => !!call.fetched?.length)
      const got = call.fetched![0]!
      expect(got.status).toBe(200)
      expect(got.type).toBe('application/pdf')
      expect(got.bytes.equals(fs.readFileSync(path.join(h.team, REL)))).toBe(true)
      // one download only
      expect(got.again).toBe(404)
      // the answer as the AI sees it: the handle, never the link
      expect(r.content).toContain(`200 ${got.bytes.length} B from team-file:${REL}`)
      expect(r.content).not.toContain('/team-file-links/')
      expect(evOf(r.started.turnId)).toContain(`team file attached: ${REL}`)
      expect(JSON.stringify(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'local_app.file_link' ORDER BY id DESC").get())).toContain(REL)
    })
  }
  test('the instructions say how (only where the app is offered), never that it cannot', async () => {
    const r = await ask(from.desk, await privateChat(), PROBE)
    expect(parts(r.content).system).toContain(ATTACH_HOW_LOCAL)
    expect(parts(r.content).system).not.toContain('cannot attach one')
    const web = await ask(from.web, await privateChat(), PROBE)
    expect(parts(web.content).system).not.toContain(ATTACH_HOW_LOCAL)
  })
  test('a handle without quotes in the middle of the code: refused with how to write it, nothing reaches the app', async () => {
    const chat = await privateChat()
    const r = await ask(from.desk, chat, fake({ tool: 'my_aside__repl', args: { code: `fetch(team-file:${REL})` }, sayResult: true }))
    expect(r.content).toContain('in quotes')
    expect(callsOf(r.started.turnId).some((s) => s.method === 'tools/call')).toBe(false)
    expect(evOf(r.started.turnId)).toContain('refused (attachment: handle without quotes)')
  })
  test('a file the user cannot read: refused as not there, nothing reaches the app', async () => {
    const chat = await privateChat()
    const r = await ask(from.desk, chat, fake({ tool: 'my_aside__repl', args: { code: code('team-file:groups/finance/budget.md') }, sayResult: true }))
    expect(r.content).toContain('there is no team file')
    expect(callsOf(r.started.turnId).some((s) => s.method === 'tools/call')).toBe(false)
  })
  test('a path out of the team folder: refused as not there, nothing reaches the app', async () => {
    const chat = await privateChat()
    for (const p of ['../../etc/passwd', '/etc/passwd', 'shared/../../outside.txt']) {
      const r = await ask(from.desk, chat, fake({ tool: 'my_aside__repl', args: { code: code(`team-file:${p}`) }, sayResult: true }))
      expect(r.content).toContain('there is no team file')
      expect(callsOf(r.started.turnId).some((s) => s.method === 'tools/call')).toBe(false)
    }
  })
  test('a link the app did not use is gone when the turn ends (a turn that finished normally)', async () => {
    const links = getChatRuntime(h.ctx).localRelay.links
    const chat = await privateChat()
    // a whole value of another argument gets a link too; this fake app downloads only what its code names
    const r = await ask(from.desk, chat, fake({ tool: 'my_aside__repl', args: { code: 'void 0', url: `team-file:${REL}` }, sayResult: true }))
    const call = callsOf(r.started.turnId).find((x) => x.method === 'tools/call')!
    expect(String(call.args?.url)).toContain('/team-file-links/')
    await waitFor(() => links.pendingBytes === 0)
    const token = String(call.args?.url).split('/').pop()
    expect((await fetch(`${h.url.replace(/\/$/, '')}/team-file-links/${token}`)).status).toBe(404)
  })
  test('a link nobody was given, or a made-up one: the same 404', async () => {
    for (const t of ['x'.repeat(43), 'short']) expect((await fetch(`${h.url.replace(/\/$/, '')}/team-file-links/${t}`)).status).toBe(404)
  })
})
