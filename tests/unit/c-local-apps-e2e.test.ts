// Apps on the person's computer end to end (docs/decisions/20261118-local-app-connectors.md): the team server's
// McpClient → the local relay → the desktop window's WebSocket → the page's relay (web/src/lib/localRelay.ts) → the
// desktop app's manager (desktop/src/common/local-apps.ts) → a real MCP server over stdio
// (tests/fixtures/local-apps/fake-mcp.ts) and back. Added from the desktop window, it is confirmed once on the
// computer, its tools are saved, a chat turn calls one, the setting value never leaves the computer, and Stop on the
// computer ends the program (the next call starts it again).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { API, type LocalAppSpec, type LocalCall, type ServerFrame } from '@mycel/shared/api'
import type { DesktopBridge } from '@mycel/shared'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { LocalApps } from '../../desktop/src/common/local-apps'
import { LocalRelay } from '../../web/src/lib/localRelay'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const DESK = 'win-local-e2e01'
const FAKE = path.join(import.meta.dir, '..', 'fixtures', 'local-apps', 'fake-mcp.ts')
const SECRET = 'sk-e2e-local-9876543210'
const SPEC: LocalAppSpec = { adapter: 'mcp', command: process.execPath, args: [FAKE], env: ['FAKE_TOKEN'] }

let h: Harness
let desk: TestSocket
let apps: LocalApps
let pump: ReturnType<typeof setInterval>
const asked: string[] = []
const confirmed = new Map<string, string>()
let spawns = 0
beforeAll(async () => {
  h = await startHarness({ name: 'c-local-apps-e2e', relay: { windowGoneMs: 600, sweepMs: 100 } })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop' })
  await desk.next('hello')
  apps = new LocalApps({
    confirm: async (c) => { asked.push(c.lines.join('\n')); return true },
    confirmed: (team, id) => confirmed.get(`${team}/${id}`) ?? null,
    setConfirmed: (team, id, hash) => { confirmed.set(`${team}/${id}`, hash) },
    settings: () => ({ FAKE_TOKEN: SECRET }),
    spawn: ((f: string, a: string[], o: object) => { spawns++; return spawn(f, a, o) }) as never,
  })
  // what the desktop app's preload gives the page (only the part this uses)
  const bridge = { bridgeVersion: 1, localApps: { version: 1, run: (call: LocalCall) => apps.call('team-e2e', call), cancel: (id: string) => apps.cancel(id) } } as unknown as DesktopBridge
  const relay = new LocalRelay((f) => desk.send(f), () => bridge)
  const seen = new Set<string>()
  pump = setInterval(() => {
    for (const f of desk.frames as ServerFrame[]) {
      if (f.type !== 'local.call' || seen.has(f.data.call.callId)) continue
      seen.add(f.data.call.callId)
      relay.handleCall(f.data.call)
    }
  }, 10)
})
afterAll(async () => { clearInterval(pump); apps?.stopAll(); desk?.close(); await h?.close() })

describe('server → relay → page → desktop manager → stdio MCP server', () => {
  let id = ''
  test('added from the desktop window: confirmed once on the computer, connected, its tools saved', async () => {
    const made = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.createLocalIntegration, { body: { name: 'Fake', slug: 'fake', spec: SPEC } })
    id = made.id
    expect(made).toMatchObject({ kind: 'local', status: 'connected' })
    expect(made.tools.map((t) => t.name)).toEqual(['echo', 'argv', 'env', 'inits', 'slow', 'ask_ping'])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('fake-mcp.ts')
  })

  test('a chat turn from that window calls a tool; the setting value is hidden before it leaves the computer', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, desk, 'alice', chat.id, fake(
      { tool: 'my_fake__echo', args: { text: 'hello' }, sayResult: true }, { say: ' | ' },
      { tool: 'my_fake__env', args: { name: 'FAKE_TOKEN' }, sayResult: true }, { say: ' | ' },
      { tool: 'my_fake__inits', args: {}, sayResult: true },
    ), { window: DESK, client: 'desktop', ms: 40_000 })
    const [echo, env, inits] = r.done.content.split(' | ')
    expect(echo).toContain('echo: hello')
    expect(env).toContain('value: [hidden]')
    expect(r.done.content).not.toContain(SECRET)
    // the check and the turn each initialized their client: the program saw one initialize
    expect(inits).toContain('1')
    expect(asked).toHaveLength(1)
    expect(spawns).toBe(1)
  })

  test('Stop on the computer ends the program; the next call starts it again without asking', async () => {
    apps.stop('team-e2e', id)
    for (let i = 0; i < 50 && apps.runningIds('team-e2e').length; i++) await Bun.sleep(50)
    expect(apps.runningIds('team-e2e')).toEqual([])
    const again = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.refreshIntegration, { params: { id }, body: {} })
    expect(again.status).toBe('connected')
    expect(spawns).toBe(2)
    expect(asked).toHaveLength(1)
  })

  test('a declared CLI (adapter b, ego lite\'s shape with a fake CLI): its tools come from the slots, a turn reads the guide and runs a script on stdin', async () => {
    const FAKE_CLI = path.join(import.meta.dir, '..', 'fixtures', 'local-apps', 'fake-cli.ts')
    const cli: LocalAppSpec = { adapter: 'cli', command: process.execPath, env: [], tools: [
      { name: 'read_guide', title: 'Read the guide', description: 'The guide', args: [FAKE_CLI, 'skill'], slots: [], readOnly: true },
      { name: 'run_script', title: 'Run a browser script', description: 'Run a script', args: [FAKE_CLI, 'nodejs'], stdin: 'script', slots: [{ name: 'script', description: 'The script', type: 'string', required: true }], readOnly: true },
    ] }
    const made = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.createLocalIntegration, { body: { name: 'Ego', slug: 'ego', spec: cli } })
    expect(made).toMatchObject({ kind: 'local', status: 'connected', local: { adapter: 'cli' } })
    expect(made.tools.map((t) => [t.name, t.title, t.readOnly])).toEqual([['read_guide', 'Read the guide', true], ['run_script', 'Run a browser script', true]])
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, desk, 'alice', chat.id, fake(
      { tool: 'my_ego__read_guide', args: {}, sayResult: true }, { say: ' | ' },
      { tool: 'my_ego__run_script', args: { script: 'await page.goto("https://example.com") // $(id)' }, sayResult: true },
    ), { window: DESK, client: 'desktop', ms: 40_000 })
    const [guide, ran] = r.done.content.split(' | ')
    expect(guide).toContain('# fake guide')
    expect(ran).toContain('ran 47 chars: "await page.goto(\\"https://example.com\\") // $(id)"')
    // the script is code: never on the step (people are not developers), only the address it opens
    // (docs/decisions/20261124-step-key-input.md)
    expect(r.done.steps.map((s: { label: string }) => s.label)).toEqual(['Ego · Read the guide', 'Ego · Run a browser script · example.com'])
  })

  test('a script that changes something asks first: the card shows it as a code block, byte for byte, and the answer says what the program printed on stderr', async () => {
    const FAKE_CLI = path.join(import.meta.dir, '..', 'fixtures', 'local-apps', 'fake-cli.ts')
    const cli: LocalAppSpec = { adapter: 'cli', command: process.execPath, env: [], tools: [
      { name: 'run_script', title: 'Run a browser script', description: 'Run a script', args: [FAKE_CLI, 'nodejs'], stdin: 'script', slots: [{ name: 'script', description: 'The script', type: 'string', required: true }], readOnly: false },
    ] }
    await h.api('alice', { window: DESK, client: 'desktop' }).call(API.createLocalIntegration, { body: { name: 'Ego two', slug: 'egotwo', spec: cli } })
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    // indented, with a run of spaces and quotes: ODD_SPACE would refuse lines for it (the JSON open, escaped)
    const script = 'const p = await page()\nif (p) {\n  await p.goto("https://en.wikipedia.org/wiki/Mycelium")  // STDERR_OUT\n}\n'
    const started = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'my_egotwo__run_script', args: { script }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const card = await desk.next('turn.request', (f) => f.data.turnId === started.turnId, 30_000)
    const q = card.data.request as { kind: string; requestId: string; options?: { value: string }[]; details?: { fields?: { name: string; value: string; code?: true }[]; exact?: true }[] }
    expect(q.details?.[0]?.exact).toBe(true)
    expect(q.details?.[0]?.fields).toEqual([{ name: 'Script', value: script, code: true }])
    await h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: q.requestId, answer: q.options![0]!.value } })
    const done = await desk.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 40_000)
    // ego lite prints the result on stderr and exits 0: it reaches the AI
    expect(done.data.message.content).toContain('printed on stderr')
    expect(done.data.message.content).toContain('line 499 of the long result')
  })
})
