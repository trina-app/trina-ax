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
})
