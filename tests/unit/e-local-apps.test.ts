// The desktop app's manager of apps on the person's computer (desktop/src/common/local-apps.ts,
// docs/decisions/20261118-local-app-connectors.md), with a real program: a small MCP server over stdio
// (tests/fixtures/local-apps/fake-mcp.ts). The person confirms a command once (again only when it changes), the
// program starts from an argument list and never through a shell, never as root, gets the setting values in its
// environment and never sends one back, is initialized once for every client, is answered when it pings, and stops on
// Stop and on a cancelled call. A plain CLI declared as tools (adapter b, ego lite's shape) gets each of the AI's
// values as one argument of its own or as stdin, never a command line.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { LocalAppSpec, LocalCall } from '@mycel/shared/api'
import { CLI_OUTPUT_MAX, cliArgv, cliOutputText, cliTools, commandHash, defaultSearchPath, hideValues, HIDDEN_VALUE, LocalApps, resolveProgram, SlotError } from '../../desktop/src/common/local-apps'

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

// ---------------- adapter (b): a plain CLI declared as tools (ego lite's shape, a fake CLI here) ----------------
const FAKE_CLI = path.join(import.meta.dir, '..', 'fixtures', 'local-apps', 'fake-cli.ts')
const cliSpec = (): LocalAppSpec => ({
  adapter: 'cli', command: process.execPath, env: ['FAKE_TOKEN'], tools: [
    { name: 'read_guide', title: 'Read the guide', description: 'The guide', args: [FAKE_CLI, 'skill'], slots: [], readOnly: true },
    { name: 'run_script', description: 'Run a script', args: [FAKE_CLI, 'nodejs'], stdin: 'script', slots: [{ name: 'script', description: 'The script', type: 'string', required: true }], readOnly: false },
    { name: 'args', description: 'Arguments', args: [FAKE_CLI, 'args', '--url', { slot: 'url' }, { slot: 'n' }, { slot: 'flag' }], slots: [{ name: 'url', description: '', type: 'string', required: true }, { name: 'n', description: '', type: 'number', required: false }, { name: 'flag', description: '', type: 'boolean', required: false }], readOnly: true },
  ],
})

describe('adapter (b): a declared CLI', () => {
  test('cliArgv: each slot is one argument of its own or stdin; types and names are checked', () => {
    const t = cliSpec().adapter === 'cli' ? (cliSpec() as Extract<LocalAppSpec, { adapter: 'cli' }>).tools : []
    expect(cliArgv(t[2]!, { url: 'https://a.example/?q=1&x=$(id)', n: 3, flag: true })).toEqual({ args: [FAKE_CLI, 'args', '--url', 'https://a.example/?q=1&x=$(id)', '3', 'true'], stdin: null })
    expect(cliArgv(t[2]!, { url: '; rm -rf ~' }).args).toEqual([FAKE_CLI, 'args', '--url', '; rm -rf ~'])
    expect(cliArgv(t[1]!, { script: 'console.log(1)' })).toEqual({ args: [FAKE_CLI, 'nodejs'], stdin: 'console.log(1)' })
    expect(() => cliArgv(t[1]!, {})).toThrow(SlotError)
    expect(() => cliArgv(t[2]!, { url: 'x', n: '3' })).toThrow('n must be a number')
    expect(() => cliArgv(t[2]!, { url: 'x', extra: 'y' })).toThrow('has no input named extra')
    expect(() => cliArgv(t[2]!, { url: 'a\0b' })).toThrow('NUL')
    expect(cliTools(t)[2]).toMatchObject({ name: 'args', inputSchema: { type: 'object', required: ['url'], additionalProperties: false, properties: { n: { type: 'number' } } }, annotations: { readOnlyHint: true } })
  })

  test('the manager answers as an MCP server: the list from the slots, the guide, a script on stdin, a failure as an error answer, the setting hidden', async () => {
    const h = harness()
    all.push(h.apps)
    const c = { spec: cliSpec() }
    expect(await h.init('i1', c)).toMatchObject({ ok: true, message: { result: { capabilities: { tools: {} } } } })
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]!.lines).toEqual([`${process.execPath} ${FAKE_CLI} skill`, `${process.execPath} ${FAKE_CLI} nodejs < script`, `${process.execPath} ${FAKE_CLI} args --url <url> <n> <flag>`])
    const list = await h.call({ jsonrpc: '2.0', id: 'l1', method: 'tools/list', params: {} }, c)
    expect(((list.message!.result as { tools: { name: string }[] }).tools).map((t) => t.name)).toEqual(['read_guide', 'run_script', 'args'])
    expect(h.text(await h.tool('read_guide', {}, c))).toContain('# fake guide')
    const odd = 'const a = "$(id)"; `whoami`; console.log(a) // ECHO_TOKEN'
    const ran = h.text(await h.tool('run_script', { script: odd }, c))!
    expect(ran).toContain(`ran ${odd.length} chars`)
    expect(ran).toContain(`token: ${HIDDEN_VALUE}`)
    expect(ran).not.toContain(SECRET)
    // ego lite's ego-browser prints the script's output on stderr and exits 0: the AI still gets all of it, also past
    // the short tail kept for start failures
    const onStderr = await h.tool('run_script', { script: 'STDERR_OUT ECHO_TOKEN' }, c)
    expect(onStderr.message!.result).toMatchObject({ isError: false })
    expect(h.text(onStderr)).toContain('printed on stderr')
    expect(h.text(onStderr)).toContain(`token: ${HIDDEN_VALUE}`)
    expect(h.text(onStderr)).not.toContain(SECRET)
    expect(h.text(onStderr)).toContain('line 499 of the long result')
    const failed = await h.tool('run_script', { script: 'FAIL' }, c)
    expect(failed.message!.result).toMatchObject({ isError: true })
    expect(h.text(failed)).toContain('script failed on purpose')
    expect(JSON.parse(h.text(await h.tool('args', { url: 'https://example.com/?a=1;b', n: 2 }, c))!)).toEqual(['--url', 'https://example.com/?a=1;b', '2'])
    const missing = await h.tool('run_script', {}, c)
    expect(missing.message!.result).toMatchObject({ isError: true, content: [{ text: 'run_script needs script' }] })
    expect(h.spawned.every((s) => s.shell === false)).toBe(true)
    expect(h.asked).toHaveLength(1)
    // nothing keeps running between calls
    expect(h.apps.runningIds(TEAM)).toEqual([])
  })

  test('cliOutputText: stdout and stderr share one size cap, stderr cut to what stdout leaves, each cut said', () => {
    expect(cliOutputText({ stdout: 'out', stderr: 'err', outChars: 3, errChars: 3 }, 10)).toBe('out\nerr')
    expect(cliOutputText({ stdout: '', stderr: '', outChars: 0, errChars: 0 }, 10)).toBe('(no output)')
    // stdout fits, stderr gets the rest of the budget
    const a = cliOutputText({ stdout: 'oooooo', stderr: 'eeeeee', outChars: 6, errChars: 6 }, 10)
    expect(a).toBe('oooooo\neeee\n[error output (stderr) cut: the program wrote 6 characters there, only the first 4 are shown]')
    // stdout alone fills it: no stderr at all, both cuts said
    const b = cliOutputText({ stdout: 'o'.repeat(12), stderr: 'eee', outChars: 20, errChars: 3 }, 10)
    expect(b).toBe(`${'o'.repeat(10)}\n[output cut: the program wrote 20 characters, only the first 10 are shown]\n[error output (stderr) cut: the program wrote 3 characters there, only the first 0 are shown]`)
    // only stderr (ego lite): all of the budget is its
    expect(cliOutputText({ stdout: '', stderr: 'e'.repeat(15), outChars: 0, errChars: 15 }, 10)).toStartWith(`${'e'.repeat(10)}\n[error output (stderr) cut: the program wrote 15 characters there, only the first 10 are shown]`)
  })

  test('a large stdout and a large stderr together stay within one cap (one WebSocket frame), with the cut said', async () => {
    const h = harness()
    all.push(h.apps)
    const c = { spec: cliSpec() }
    expect(await h.init('i1', c)).toMatchObject({ ok: true })
    const both = await h.tool('run_script', { script: `BIG ${CLI_OUTPUT_MAX - 1000} ${CLI_OUTPUT_MAX}` }, c)
    expect(both.ok).toBe(true)
    const text = h.text(both)!
    expect(text.length).toBeLessThan(CLI_OUTPUT_MAX + 300)
    expect(text.startsWith('o'.repeat(CLI_OUTPUT_MAX - 1000) + '\n' + 'e'.repeat(999))).toBe(true)
    expect(text).toContain(`[error output (stderr) cut: the program wrote ${CLI_OUTPUT_MAX} characters there, only the first 1000 are shown]`)
    expect(text).not.toContain('[output cut')
    // both far past the cap: stdout cut, stderr has no room left
    const over = h.text(await h.tool('run_script', { script: `BIG ${CLI_OUTPUT_MAX + 500_000} ${CLI_OUTPUT_MAX + 500_000}` }, c))!
    expect(over.length).toBeLessThan(CLI_OUTPUT_MAX + 300)
    expect(over).toContain(`[output cut: the program wrote ${CLI_OUTPUT_MAX + 500_000} characters, only the first ${CLI_OUTPUT_MAX} are shown]`)
    expect(over).toContain(`only the first 0 are shown]`)
    expect(over).not.toContain('e'.repeat(10))
    expect(h.apps.runningIds(TEAM)).toEqual([])
  })
})
