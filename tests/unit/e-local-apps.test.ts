// The desktop app's manager of apps on the person's computer (desktop/src/common/local-apps.ts,
// docs/decisions/20261118-local-app-connectors.md), with a real program: a small MCP server over stdio
// (tests/fixtures/local-apps/fake-mcp.ts). The person confirms a command once (again only when it changes), the
// program starts from an argument list and never through a shell, never as root, gets the setting values in its
// environment and never sends one back, is initialized once for every client, is answered when it pings, and stops on
// Stop and on a cancelled call.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { LocalAppSpec, LocalCall } from '@mycel/shared/api'
import { commandHash, defaultSearchPath, hideValues, HIDDEN_VALUE, LocalApps, resolveProgram } from '../../desktop/src/common/local-apps'

setDefaultTimeout(30_000)
const FAKE = path.join(import.meta.dir, '..', 'fixtures', 'local-apps', 'fake-mcp.ts')
const TEAM = 'team-1'
const SECRET = 'sk-local-0123456789'
const spec = (args: string[] = []): LocalAppSpec => ({ adapter: 'mcp', command: process.execPath, args: [FAKE, ...args], env: ['FAKE_TOKEN'] })

function harness(o: { yes?: boolean; root?: boolean } = {}) {
  const asked: { name: string; lines: string[]; program: string }[] = []
  const confirmed = new Map<string, string>()
  const spawned: { file: string; args: readonly string[]; shell: unknown }[] = []
  const apps = new LocalApps({
    confirm: async (c) => { asked.push(c); return o.yes ?? true },
    confirmed: (team, id) => confirmed.get(`${team}/${id}`) ?? null,
    setConfirmed: (team, id, h) => { confirmed.set(`${team}/${id}`, h) },
    settings: () => ({ FAKE_TOKEN: SECRET }),
    isRoot: () => o.root ?? false,
    spawn: ((file: string, args: readonly string[], opts: { shell?: unknown }) => { spawned.push({ file, args, shell: opts.shell }); return spawn(file, args, opts as never) }) as never,
  })
  let n = 0
  const call = (message: Record<string, unknown>, c: Partial<LocalCall> = {}) => apps.call(TEAM, {
    callId: `call-${++n}`, turnId: '019a0000-0000-7000-8000-000000000001', connectionId: 'conn-1', name: 'Fake', spec: spec(), message, deadline: Date.now() + 10_000, ...c,
  })
  const init = (id: string, c: Partial<LocalCall> = {}) => call({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, c)
  const tool = (name: string, args: Record<string, unknown> = {}, c: Partial<LocalCall> = {}) => call({ jsonrpc: '2.0', id: `t-${n + 1}`, method: 'tools/call', params: { name, arguments: args } }, c)
  const text = (r: Awaited<ReturnType<typeof call>>) => ((r.message?.result as { content?: { text: string }[] })?.content ?? [])[0]?.text
  return { apps, asked, confirmed, spawned, call, init, tool, text }
}
const all: LocalApps[] = []
afterAll(() => { for (const a of all) a.stopAll() })

describe('apps on this computer: the desktop manager', () => {
  test('asked once for a command, from an argument list without a shell; the program is initialized once for every client', async () => {
    const h = harness()
    all.push(h.apps)
    const a = await h.init('i1')
    expect(a).toMatchObject({ ok: true, message: { id: 'i1', result: { serverInfo: { name: 'fake' } } } })
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]).toMatchObject({ name: 'Fake', program: process.execPath })
    expect(h.asked[0]!.lines[0]).toContain('fake-mcp.ts')
    expect(h.confirmed.get(`${TEAM}/conn-1`)).toBe(commandHash(spec()))
    expect(await h.call({ jsonrpc: '2.0', method: 'notifications/initialized' })).toMatchObject({ ok: true, message: null })
    // a second client (another turn) initializes again: answered from the first, the program saw one
    expect(await h.init('i2')).toMatchObject({ ok: true, message: { id: 'i2', result: { serverInfo: { name: 'fake' } } } })
    expect(h.text(await h.tool('inits'))).toBe('1')
    expect(h.asked).toHaveLength(1)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]).toMatchObject({ file: process.execPath, shell: false })
    expect(h.apps.runningIds(TEAM)).toEqual(['conn-1'])
  })

  test('shell characters stay plain arguments; a setting reaches the program and never comes back', async () => {
    const h = harness()
    all.push(h.apps)
    const odd = ['$(touch /tmp/never)', '; rm -rf ~', '`id`', "it's \"quoted\""]
    await h.init('i1', { spec: spec(odd) })
    expect(JSON.parse(h.text(await h.tool('argv', {}, { spec: spec(odd) }))!)).toEqual(odd)
    const env = h.text(await h.tool('env', { name: 'FAKE_TOKEN' }, { spec: spec(odd) }))
    expect(env).toBe(`value: ${HIDDEN_VALUE}`)
    expect(env).not.toContain(SECRET)
  })

  test('a new command asks again and starts a new program; Cancel is kept for the turn, a check asks again', async () => {
    const h = harness()
    all.push(h.apps)
    await h.init('i1')
    const first = h.spawned.length
    await h.init('i2', { spec: spec(['--other']) })
    expect(h.asked).toHaveLength(2)
    expect(h.spawned.length).toBe(first + 1)
    const no = harness({ yes: false })
    all.push(no.apps)
    expect(await no.init('i1')).toMatchObject({ ok: false, failure: 'declined' })
    expect(await no.init('i2')).toMatchObject({ ok: false, failure: 'declined' })
    expect(no.asked).toHaveLength(1)
    expect(await no.init('i3', { turnId: null })).toMatchObject({ ok: false, failure: 'declined' })
    expect(no.asked).toHaveLength(2)
    expect(no.spawned).toHaveLength(0)
  })

  test('never as root; a program that is not there says so', async () => {
    const root = harness({ root: true })
    expect(await root.init('i1')).toMatchObject({ ok: false, failure: 'root' })
    expect(root.asked).toHaveLength(0)
    const h = harness()
    expect(await h.init('i1', { spec: { adapter: 'mcp', command: 'no-such-program-xyz', args: [], env: [] } })).toMatchObject({ ok: false, failure: 'start_failed', error: 'no-such-program-xyz was not found on this computer' })
    expect(resolveProgram('no-such-program-xyz', defaultSearchPath())).toBeNull()
    expect(resolveProgram('relative/prog', ['/usr/bin'])).toBeNull()
    expect(resolveProgram('sh', ['/bin'])).toBe('/bin/sh')
  })

  test('the program\'s ping is answered; Stop ends it and the next call starts it again; a cancelled call ends at once', async () => {
    const h = harness()
    all.push(h.apps)
    await h.init('i1')
    expect(h.text(await h.tool('ask_ping'))).toBe('pong ok')
    const pid = (await new Promise<number>((r) => setTimeout(() => r(h.spawned.length), 10)))
    h.apps.stop(TEAM, 'conn-1')
    for (let i = 0; i < 50 && h.apps.runningIds(TEAM).length; i++) await Bun.sleep(50)
    expect(h.apps.runningIds(TEAM)).toEqual([])
    await h.init('i2')
    expect(h.spawned.length).toBe(pid + 1)
    const slow = h.tool('slow', {}, { callId: 'slow-1' })
    await Bun.sleep(200)
    h.apps.cancel('slow-1')
    expect(await slow).toMatchObject({ ok: false, failure: 'failed', error: 'stopped' })
  })

  test('a program started again under a client that initialized the one before (Stop, new settings) is initialized first', async () => {
    const h = harness()
    all.push(h.apps)
    await h.init('i1')
    await h.call({ jsonrpc: '2.0', method: 'notifications/initialized' })
    h.apps.stop(TEAM, 'conn-1')
    for (let i = 0; i < 50 && h.apps.runningIds(TEAM).length; i++) await Bun.sleep(50)
    // the same client (a Settings check after new values) goes on without its own initialize
    expect(h.text(await h.tool('inits'))).toBe('1')
    expect(h.text(await h.tool('echo', { text: 'hi' }))).toBe('echo: hi')
    expect(h.spawned).toHaveLength(2)
  })

  test('hideValues: each value, longest first, also as JSON writes it; short ones are left', () => {
    expect(hideValues('a abcd-ef "x\\"y12"', ['abcd-ef', 'x"y12', 'ab'])).toBe(`a ${HIDDEN_VALUE} "${HIDDEN_VALUE}"`)
  })
})
