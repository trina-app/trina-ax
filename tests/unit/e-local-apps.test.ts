// The desktop app's manager of apps on the person's computer (desktop/src/common/local-apps.ts,
// docs/decisions/20261118-local-app-connectors.md), with a real program: a small MCP server over stdio
// (tests/fixtures/local-apps/fake-mcp.ts). The person confirms a command once (again only when it changes), the
// program starts from an argument list and never through a shell, never as root, gets the setting values in its
// environment and never sends one back, is initialized once for every client, is answered when it pings, and stops on
// Stop and on a cancelled call. A plain CLI declared as tools (adapter b, ego lite's shape) gets each of the AI's
// values as one argument of its own or as stdin, never a command line.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOCAL_APP_PRESETS, type LocalAppSpec, type LocalCall } from '@mycel/shared/api'
import { t } from '../../desktop/src/common/i18n'
import { ASIDE_EXEC_SIGN_IN, ASIDE_PROFILE_ID_WORDS, ASIDE_PROFILES_DESCRIPTION, ASIDE_SIGNED_OUT, asideAccountList, asideProfilesIn, asideSessionId, asideToolsList, asideNotRunning, egoDown, EGO_BUNDLE_ID, isListedEgo, notOpenWords, withAsideSignedOut, asideAccountMismatch, asideAccountsWithProfiles, asideAccountLines, asideSuggestedAccount, isListedAside, CLI_OUTPUT_MAX, cliArgv, cliOutputText, cliTools, commandHash, defaultSearchPath, hideValues, HIDDEN_VALUE, LocalApps, resolveProgram, SlotError } from '../../desktop/src/common/local-apps'

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

describe('Aside with an account no Aside Browser profile uses', () => {
  /** the listed Aside (`aside mcp`) as a program named aside: the fake MCP server, with these accounts */
  function asideHarness(env: Record<string, string>, spec: LocalAppSpec = { adapter: 'mcp', command: 'aside', args: ['mcp'], env: [] }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-acct-'))
    fs.writeFileSync(path.join(dir, 'aside'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 })
    const spawned: string[][] = []
    const asked: string[][] = []
    const confirmed = new Map<string, string>()
    const apps = new LocalApps({
      confirm: async (c) => { asked.push(c.lines); return true },
      confirmed: (team, id) => confirmed.get(`${team}/${id}`) ?? null, setConfirmed: (team, id, h) => { confirmed.set(`${team}/${id}`, h) },
      settings: () => env, isRoot: () => false, searchPath: () => [dir],
      spawn: ((file: string, args: readonly string[], opts: unknown) => { spawned.push([...args]); return spawn(file, args, opts as never) }) as never,
    })
    all.push(apps)
    let n = 0
    const call = (message: Record<string, unknown>) => apps.call(TEAM, { callId: `a-${++n}`, turnId: null, connectionId: 'aside-1', name: 'Aside', spec, message, deadline: Date.now() + 10_000 })
    const tool = (name: string) => call({ jsonrpc: '2.0', id: `t-${n + 1}`, method: 'tools/call', params: { name, arguments: {} } })
    const texts = (r: Awaited<ReturnType<typeof call>>) => ((r.message?.result as { content?: { text: string }[] })?.content ?? []).map((c) => c.text)
    const init = () => call({ jsonrpc: '2.0', id: 'i1', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    const mcpRuns = () => spawned.filter((a) => a[0] === 'mcp')
    const done = () => { apps.stopAll(); fs.rmSync(dir, { recursive: true, force: true }) }
    return { apps, spawned, asked, call, tool, texts, init, mcpRuns, done }
  }

  test('Aside names the account to use: it starts again with that account and the call works, asked once on the computer', async () => {
    const h = asideHarness({ FAKE_ASIDE_GOOD: 'u2' })
    try {
      await h.init()
      expect(h.texts(await h.tool('repl'))).toEqual(['ok as u2'])
      expect(h.mcpRuns()).toEqual([['mcp'], ['mcp', '--account', 'u2']])
      // the same program and confirmed command: no second confirm
      expect(h.asked).toHaveLength(1)
      // and it stays on that account
      expect(JSON.parse(h.texts(await h.tool('browser_profiles'))[0]!).profiles).toHaveLength(1)
      expect(h.mcpRuns()).toHaveLength(2)
      expect(h.apps.runningIds(TEAM)).toEqual(['aside-1'])
    } finally { h.done() }
  })

  test('an empty profile list: the account comes from Aside\'s account list (one with profiles, signed in first)', async () => {
    const accounts = { accounts: [{ id: 1, hasSession: false, profileBindings: [] }, { id: 3, hasSession: false, profileBindings: [{}] }, { id: 2, hasSession: true, profileBindings: [{}] }] }
    const h = asideHarness({ FAKE_ASIDE_GOOD: 'u2', FAKE_ASIDE_ACCOUNTS: JSON.stringify(accounts) })
    try {
      await h.init()
      const r = h.texts(await h.tool('browser_profiles'))
      expect(JSON.parse(r[0]!).profiles).toHaveLength(1)
      expect(r).not.toContain(ASIDE_SIGNED_OUT)
      expect(h.spawned).toContainEqual(['account', 'list', '--json'])
      expect(h.mcpRuns().at(-1)).toEqual(['mcp', '--account', 'u2'])
    } finally { h.done() }
  })

  test('no account has a profile: plain words for the person, no terminal steps; the next call starts Aside fresh', async () => {
    const h = asideHarness({})
    try {
      await h.init()
      const r = h.texts(await h.tool('browser_profiles'))
      expect(r.at(-1)).toBe(ASIDE_SIGNED_OUT)
      expect(ASIDE_SIGNED_OUT).toContain("Aside Browser isn't signed in. Open Aside and sign in, then ask again.")
      expect(ASIDE_SIGNED_OUT).not.toContain('aside account')
      expect(h.mcpRuns()).toEqual([['mcp']])
      await h.tool('repl')
      expect(h.mcpRuns()).toEqual([['mcp'], ['mcp']])
    } finally { h.done() }
  })

  test('a command the person typed is never changed, even when it is Aside', async () => {
    const h = asideHarness({ FAKE_ASIDE_GOOD: 'u2' }, { adapter: 'mcp', command: 'aside', args: ['mcp', '--incognito'], env: [] })
    try {
      await h.init()
      const r = h.texts(await h.tool('repl'))
      expect(r).toHaveLength(1)
      expect(r[0]).toContain('none of its profiles use account u1')
      expect(h.mcpRuns()).toEqual([['mcp', '--incognito']])
      expect(h.spawned.some((a) => a[0] === 'account')).toBe(false)
    } finally { h.done() }
  })

  test('reading Aside\'s answers and account list', () => {
    const err = { result: { content: [{ type: 'text', text: 'none of its profiles use account u1. Rerun with --account u2' }], isError: true } }
    expect(asideAccountMismatch('repl', err)).toBe(true)
    expect(asideSuggestedAccount(err)).toBe('u2')
    expect(asideAccountMismatch('repl', { error: { code: -1, message: 'Aside: none of its profiles use account u3' } })).toBe(true)
    expect(asideAccountMismatch('browser_profiles', { result: { content: [{ type: 'text', text: '{"profiles":[]}' }] } })).toBe(true)
    expect(asideAccountMismatch('browser_profiles', { result: { content: [{ type: 'text', text: '{"profiles":[{"id":"p"}]}' }] } })).toBe(false)
    expect(asideAccountMismatch('repl', { result: { content: [{ type: 'text', text: '{"profiles":[]}' }] } })).toBe(false)
    expect(asideAccountsWithProfiles('{"accounts":[{"id":0,"profileBindings":[{}]},{"id":4,"hasSession":true,"profileBindings":[{}]}]}', 'u0')).toEqual(['u4'])
    expect(asideAccountsWithProfiles('not json')).toEqual([])
    expect(isListedAside({ adapter: 'mcp', command: 'aside', args: ['mcp'], env: [] })).toBe(true)
    expect(isListedAside({ adapter: 'mcp', command: 'aside', args: ['mcp', '--account', 'u1'], env: [] })).toBe(false)
    expect(isListedAside({ adapter: 'mcp', command: '/usr/local/bin/aside', args: ['mcp'], env: [] })).toBe(false)
  })
})

describe('Aside with several accounts, each with its own profiles', () => {
  // like a Mac where Aside has accounts u0 (current, two profiles), u1 and u2 (one each): Claude Code reaches all four
  const PROFILES = {
    u0: [{ profileId: 'prof-a', label: 'Work' }, { profileId: 'prof-b', label: 'Personal' }],
    u1: [{ profileId: 'prof-c', label: 'Shop' }],
    u2: [{ profileId: 'prof-d', label: 'Video' }],
  }
  function multi(extra: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-multi-'))
    fs.writeFileSync(path.join(dir, 'aside'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 })
    const spawned: string[][] = []
    const confirmed = new Map<string, string>()
    let asked = 0
    const env = { FAKE_ASIDE_PROFILES: JSON.stringify(PROFILES), FAKE_ASIDE_CURRENT: 'u0', ...extra }
    const apps = new LocalApps({
      confirm: async () => { asked++; return true },
      confirmed: (team, id) => confirmed.get(`${team}/${id}`) ?? null, setConfirmed: (team, id, h) => { confirmed.set(`${team}/${id}`, h) },
      settings: () => env, isRoot: () => false, searchPath: () => [dir],
      spawn: ((file: string, args: readonly string[], opts: unknown) => { spawned.push([...args]); return spawn(file, args, opts as never) }) as never,
    })
    all.push(apps)
    let n = 0
    const call = (message: Record<string, unknown>) => apps.call(TEAM, { callId: `m-${++n}`, turnId: null, connectionId: 'aside-1', name: 'Aside', spec: LOCAL_APP_PRESETS.find((p) => p.id === 'aside')!.spec, message, deadline: Date.now() + 10_000 })
    const tool = (name: string, args: Record<string, unknown> = {}) => call({ jsonrpc: '2.0', id: `t-${n + 1}`, method: 'tools/call', params: { name, arguments: args } })
    const texts = (r: Awaited<ReturnType<typeof call>>) => ((r.message?.result as { content?: { text: string }[] })?.content ?? []).map((c) => c.text)
    const init = () => call({ jsonrpc: '2.0', id: 'i1', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    const mcpRuns = () => spawned.filter((a) => a[0] === 'mcp')
    const done = () => { apps.stopAll(); fs.rmSync(dir, { recursive: true, force: true }) }
    return { apps, env, spawned, asked: () => asked, call, tool, texts, init, mcpRuns, done }
  }

  test('Aside\'s current account switched while the main aside mcp runs: that process keeps its own account', async () => {
    // a plain `aside mcp` takes Aside's current account at its first call and keeps it (review finding 1 on #149)
    const h = multi()
    try {
      await h.init()
      await h.tool('browser_profiles')
      // `aside account use u1` on this Mac (Claude Code, the Aside app): the main process still runs as u0
      ;(h.env as Record<string, string>).FAKE_ASIDE_CURRENT = 'u1'
      const profiles = JSON.parse(h.texts(await h.tool('browser_profiles'))[0]!).profiles as { profileId: string; account: string }[]
      expect(profiles.map((p) => [p.profileId, p.account])).toEqual([['prof-a', 'u0'], ['prof-b', 'u0'], ['prof-c', 'u1'], ['prof-d', 'u2']])
      expect(h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'prof-a' }))).toEqual(['ok as u0 in prof-a'])
      expect(h.texts(await h.tool('repl', { title: 't', code: '2', profile_id: 'prof-c' }))).toEqual(['ok as u1 in prof-c'])
      // u0's own profile went to the main process: no `aside mcp --account u0` beside it
      expect(h.mcpRuns()).toEqual([['mcp'], ['mcp', '--account', 'u1']])
      const mine = JSON.parse(h.texts(await h.tool('exec', { prompt: 'x' }))[0]!) as { session_id: string }
      expect(mine.session_id).toStartWith('s-u0-')
      expect(h.texts(await h.tool('exec', { prompt: 'y', session_id: mine.session_id }))).toEqual([`continued ${mine.session_id} as u0`])
    } finally { h.done() }
  })

  test('an older Aside CLI without `account list --json`, its current account without profiles: every account\'s profiles, not "signed out"', async () => {
    // like a Mac with Aside CLI 1.26.1023 (2026-11-21): `account list --json` fails ("unknown option '--json'"), Aside's
    // current account u1 has no profile, and the others have theirs (signed-in Google ones and signed-out local ones)
    const accounts = {
      u1: [],
      u2: [{ profileId: 'prof-w', label: 'Profile 1' }],
      u4: [{ profileId: 'prof-x', label: 'Profile 3' }],
      u5: [{ profileId: 'prof-y', label: 'Profile 7' }, { profileId: 'prof-z', label: 'Profile 8' }],
    }
    const h = multi({ FAKE_ASIDE_PROFILES: JSON.stringify(accounts), FAKE_ASIDE_CURRENT: 'u1', FAKE_ASIDE_NO_LIST_JSON: '1', FAKE_ASIDE_SIGNED_IN: 'u2,u5' })
    try {
      await h.init()
      const r = h.texts(await h.tool('browser_profiles'))
      expect(r).not.toContain(ASIDE_SIGNED_OUT)
      const profiles = JSON.parse(r[0]!).profiles as { profileId: string; account: string }[]
      expect(profiles.map((p) => [p.profileId, p.account])).toEqual([['prof-w', 'u2'], ['prof-x', 'u4'], ['prof-y', 'u5'], ['prof-z', 'u5']])
      // the --json list failed, so the plain lines were read; the main process went to a signed-in account with profiles
      expect(h.spawned).toContainEqual(['account', 'list', '--json'])
      expect(h.spawned).toContainEqual(['account', 'list'])
      expect(h.mcpRuns()).toEqual([['mcp'], ['mcp', '--account', 'u2']])
      // a signed-out local account's profile works in its own aside mcp
      expect(h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'prof-x' }))).toEqual(['ok as u4 in prof-x'])
    } finally { h.done() }
  })

  test('reading the plain lines of `aside account list` (an Aside CLI without --json)', () => {
    const lines = '* u1  Local Account  signed out  profiles: none\n  u2  someone@example.com  signed in  profiles: Profile 1, Profile 2\n  provider: google\n  u4  Local Account  signed out  profiles: Profile 3\n'
    expect(asideAccountList(lines)).toEqual({ current: 'u1', accounts: [
      { id: 'u1', signedIn: false, profileIds: [], hasProfiles: false },
      { id: 'u2', signedIn: true, profileIds: [], hasProfiles: true },
      { id: 'u4', signedIn: false, profileIds: [], hasProfiles: true },
    ] })
    expect(asideAccountsWithProfiles(lines)).toEqual(['u2', 'u4'])
    expect(asideAccountsWithProfiles(lines, 'u2')).toEqual(['u4'])
    expect(asideAccountLines("error: unknown option '--json'")).toBeNull()
    expect(asideAccountsWithProfiles('')).toEqual([])
  })

  test('a profile id no account has is not looked for again on every call', async () => {
    const h = multi()
    try {
      await h.init()
      const lists = () => h.spawned.filter((a) => a[0] === 'account').length
      expect(h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'nope' }))[0]).toContain('is not available for account u0')
      const after = lists()
      expect(h.texts(await h.tool('repl', { title: 't', code: '2', profile_id: 'nope' }))[0]).toContain('is not available for account u0')
      expect(lists()).toBe(after)
    } finally { h.done() }
  })

  test('browser_profiles lists every account\'s profiles, each with its account; tools/list says so', async () => {
    const h = multi()
    try {
      await h.init()
      const list = await h.call({ jsonrpc: '2.0', id: 'l1', method: 'tools/list' })
      const bp = (list.message?.result as { tools: { name: string; description: string }[] }).tools.find((t) => t.name === 'browser_profiles')!
      expect(bp.description).toBe(ASIDE_PROFILES_DESCRIPTION)
      expect(bp.description).not.toContain("this MCP server's")
      const profiles = JSON.parse(h.texts(await h.tool('browser_profiles'))[0]!).profiles as { profileId: string; label: string; account: string; connected: boolean }[]
      expect(profiles.map((p) => [p.profileId, p.label, p.account])).toEqual([['prof-a', 'Work', 'u0'], ['prof-b', 'Personal', 'u0'], ['prof-c', 'Shop', 'u1'], ['prof-d', 'Video', 'u2']])
      expect(profiles.every((p) => p.connected === true)).toBe(true)
      // listing starts no other `aside mcp`: one-shot `host profiles` for the other accounts only
      expect(h.mcpRuns()).toEqual([['mcp']])
      expect(h.spawned.filter((a) => a[0] === 'host').sort()).toEqual([['host', 'profiles', '--account', 'u1', '--json'], ['host', 'profiles', '--account', 'u2', '--json']])
      expect(h.asked()).toBe(1)
    } finally { h.done() }
  })

  test('repl and exec in a profile of another account run in that account\'s own aside mcp; the default account\'s stay in the main one', async () => {
    const h = multi()
    try {
      await h.init()
      await h.tool('browser_profiles')
      expect(h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'prof-c' }))).toEqual(['ok as u1 in prof-c'])
      expect(h.mcpRuns()).toEqual([['mcp'], ['mcp', '--account', 'u1']])
      // the repl goes on in that profile without profile_id, in the same process
      expect(h.texts(await h.tool('repl', { title: 't', code: '2' }))).toEqual(['ok as u1'])
      // the default account's profile: the main process, and the repl goes on there
      expect(h.texts(await h.tool('repl', { title: 't', code: '3', profile_id: 'prof-b' }))).toEqual(['ok as u0 in prof-b'])
      expect(h.texts(await h.tool('repl', { title: 't', code: '4' }))).toEqual(['ok as u0'])
      // exec in u2's profile, then continued by its session id there
      const started = JSON.parse(h.texts(await h.tool('exec', { prompt: 'https://example.com', profile_id: 'prof-d' }))[0]!) as { session_id: string }
      expect(started.session_id).toStartWith('s-u2-')
      expect(h.texts(await h.tool('exec', { prompt: 'go on', session_id: started.session_id }))).toEqual([`continued ${started.session_id} as u2`])
      // a main-account exec session stays on the main process
      const mine = JSON.parse(h.texts(await h.tool('exec', { prompt: 'x' }))[0]!) as { session_id: string }
      expect(h.texts(await h.tool('exec', { prompt: 'y', session_id: mine.session_id }))).toEqual([`continued ${mine.session_id} as u0`])
      expect(h.mcpRuns()).toEqual([['mcp'], ['mcp', '--account', 'u1'], ['mcp', '--account', 'u2']])
      // each new process was initialized before its first call; one confirm for all; Stop ends them all
      expect(h.asked()).toBe(1)
      expect(h.apps.runningIds(TEAM)).toEqual(['aside-1'])
      h.apps.stop(TEAM, 'aside-1')
      for (let i = 0; i < 50 && h.apps.runningIds(TEAM).length; i++) await Bun.sleep(50)
      expect(h.apps.runningIds(TEAM)).toEqual([])
    } finally { h.done() }
  })

  test('a profile id the AI did not get from browser_profiles in this run is still found (Aside\'s account list read then)', async () => {
    const h = multi()
    try {
      await h.init()
      expect(h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'prof-d' }))).toEqual(['ok as u2 in prof-d'])
      // an id no account has: the main process answers with Aside's own words
      const r = h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'nope' }))
      expect(r[0]).toContain('is not available for account u0')
    } finally { h.done() }
  })

  test('an older Aside without host profiles --json: the other accounts\' profile ids from its account list', async () => {
    const h = multi({ FAKE_ASIDE_OLD_CLI: '1' })
    try {
      await h.init()
      const profiles = JSON.parse(h.texts(await h.tool('browser_profiles'))[0]!).profiles as { profileId: string; label: string | null; account: string }[]
      expect(profiles.map((p) => [p.profileId, p.account])).toEqual([['prof-a', 'u0'], ['prof-b', 'u0'], ['prof-c', 'u1'], ['prof-d', 'u2']])
      expect(profiles[2]!.label).toBeNull()
      expect(h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'prof-c' }))).toEqual(['ok as u1 in prof-c'])
    } finally { h.done() }
  })

  test('one account only: Aside\'s own list, no other program started', async () => {
    const h = multi({ FAKE_ASIDE_PROFILES: JSON.stringify({ u0: PROFILES.u0 }) })
    try {
      await h.init()
      const profiles = JSON.parse(h.texts(await h.tool('browser_profiles'))[0]!).profiles as { profileId: string; account?: string }[]
      expect(profiles.map((p) => p.profileId)).toEqual(['prof-a', 'prof-b'])
      // Aside's answer as it is (review finding 2 on #149): nothing added
      expect(profiles.some((p) => 'account' in p)).toBe(false)
      expect(h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'prof-b' }))).toEqual(['ok as u0 in prof-b'])
      expect(h.mcpRuns()).toEqual([['mcp']])
      expect(h.spawned.some((a) => a[0] === 'host')).toBe(false)
    } finally { h.done() }
  })

  test('Aside\'s own guide (`aside guide`) is its instructions, after the line that maps it to the tools; read once per process', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aside-guide-')), 'guide.md')
    fs.writeFileSync(file, '# Aside\nIn MCP, call browser_profiles, then pass its profileId as profile_id.')
    const h = multi({ FAKE_ASIDE_GUIDE_FILE: file })
    try {
      const first = await h.init()
      const ins = (first.message?.result as { instructions?: string }).instructions!
      const note = LOCAL_APP_PRESETS.find((p) => p.id === 'aside')!.guide!.note
      expect(ins.startsWith(note)).toBe(true)
      expect(ins).toContain('pass its profileId as profile_id')
      const again = await h.init()
      expect((again.message?.result as { instructions?: string }).instructions).toBe(ins)
      expect(h.spawned.filter((a) => a[0] === 'guide' || a[0] === '--help')).toEqual([['--help'], ['guide']])
    } finally { h.done(); fs.rmSync(path.dirname(file), { recursive: true, force: true }) }
  })

  test('an Aside CLI without `guide`: its help is read, `guide` is never run, initialize as Aside gave it', async () => {
    const h = multi()
    try {
      const r = await h.init()
      expect(r.ok).toBe(true)
      expect((r.message?.result as { instructions?: string }).instructions).toBeUndefined()
      expect(h.spawned.some((a) => a[0] === 'guide')).toBe(false)
      // not asked again for every client of the same process (tried again only after a while)
      await h.init()
      expect(h.spawned.filter((a) => a[0] === '--help')).toHaveLength(1)
    } finally { h.done() }
  })

  test('repl and exec: profile_id says to choose it for the request\'s account, after Aside\'s own words', async () => {
    const h = multi()
    try {
      await h.init()
      const list = await h.call({ jsonrpc: '2.0', id: 'l1', method: 'tools/list' })
      const tools = (list.message?.result as { tools: { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[] }).tools
      for (const name of ['repl', 'exec']) {
        const d = tools.find((t) => t.name === name)!.inputSchema.properties.profile_id!.description!
        expect(d.startsWith('Browser profile ID from browser_profiles.')).toBe(true)
        expect(d.endsWith(ASIDE_PROFILE_ID_WORDS)).toBe(true)
      }
      // a tool without profile_id is as Aside gave it
      expect(tools.find((t) => t.name === 'echo')!.inputSchema.properties.profile_id).toBeUndefined()
    } finally { h.done() }
  })

  test('exec in a profile whose Aside account is not signed in: nothing ran, the AI is told to use repl there; profiles say which accounts are signed in', async () => {
    const h = multi({ FAKE_ASIDE_EXEC_SIGN_IN: '1' })
    try {
      await h.init()
      const profiles = JSON.parse(h.texts(await h.tool('browser_profiles'))[0]!).profiles as { profileId: string; accountSignedIn?: boolean }[]
      expect(profiles.map((p) => [p.profileId, p.accountSignedIn])).toEqual([['prof-a', true], ['prof-b', true], ['prof-c', false], ['prof-d', false]])
      const r = h.texts(await h.tool('exec', { prompt: 'open the mail', profile_id: 'prof-c' }))
      expect(r[0]).toBe('Sign in again before using built-in Aside models.')
      expect(r).toContain(ASIDE_EXEC_SIGN_IN)
      // repl in the same profile works
      expect(h.texts(await h.tool('repl', { title: 't', code: '1', profile_id: 'prof-c' }))).toEqual(['ok as u1 in prof-c'])
      // exec in a signed-in account's profile: as it was
      expect(h.texts(await h.tool('exec', { prompt: 'x', profile_id: 'prof-a' }))[0]).toStartWith('{"session_id":"s-u0-')
    } finally { h.done() }
  })

  test('one account that is not signed in: each profile says so (accountSignedIn false); signed in, Aside\'s list as it is', async () => {
    const h = multi({ FAKE_ASIDE_PROFILES: JSON.stringify({ u0: PROFILES.u0 }), FAKE_ASIDE_SIGNED_IN: 'none', FAKE_ASIDE_EXEC_SIGN_IN: '1' })
    try {
      await h.init()
      const profiles = JSON.parse(h.texts(await h.tool('browser_profiles'))[0]!).profiles as { profileId: string; accountSignedIn?: boolean; account?: string }[]
      expect(profiles.map((p) => [p.profileId, p.accountSignedIn])).toEqual([['prof-a', false], ['prof-b', false]])
      expect(profiles.some((p) => 'account' in p)).toBe(false)
      expect(h.texts(await h.tool('exec', { prompt: 'x' }))).toContain(ASIDE_EXEC_SIGN_IN)
    } finally { h.done() }
  })

  test('reading Aside\'s account list, profile lists and exec answers', () => {
    expect(asideAccountList('{"currentAccountId":2,"accounts":[{"id":0,"hasSession":true,"profileBindings":[{"profileId":"a"},{"profileId":"b"}]},{"id":2,"profileBindings":[]},{"id":"x"}]}')).toEqual({ current: 'u2', accounts: [{ id: 'u0', signedIn: true, profileIds: ['a', 'b'], hasProfiles: true }, { id: 'u2', signedIn: false, profileIds: [], hasProfiles: false }] })
    expect(asideAccountList('nope')).toEqual({ current: null, accounts: [] })
    expect(asideProfilesIn('{"host":"local","profiles":[{"profileId":"a","label":"Work","connected":true},{"id":"old"}]}')).toEqual([{ profileId: 'a', label: 'Work', connected: true }])
    expect(asideProfilesIn('{"profiles":"x"}')).toBeNull()
    expect(asideProfilesIn('Browser profile "x" is not available')).toBeNull()
    expect(asideSessionId({ result: { content: [{ type: 'text', text: '{"session_id":"abc-123","status":"done"}' }] } })).toBe('abc-123')
    expect(asideSessionId({ result: { content: [{ type: 'text', text: 'Session: none' }] } })).toBeNull()
    const tl = asideToolsList({ result: { tools: [{ name: 'repl', description: 'r' }, { name: 'browser_profiles', description: 'old' }] } })
    expect((tl.result as { tools: { description: string }[] }).tools.map((t) => t.description)).toEqual(['r', ASIDE_PROFILES_DESCRIPTION])
  })
})

describe('the confirm on the computer, answered late', () => {
  test('the call stops waiting just before its deadline (unconfirmed); a Connect pressed later is kept and told, and the next call runs without asking', async () => {
    let press: (yes: boolean) => void = () => {}
    const confirmed = new Map<string, string>()
    const told: string[] = []
    let asks = 0
    const apps = new LocalApps({
      confirm: () => { asks++; return new Promise<boolean>((r) => { press = r }) },
      confirmed: (team, id) => confirmed.get(`${team}/${id}`) ?? null, setConfirmed: (team, id, h) => { confirmed.set(`${team}/${id}`, h) },
      settings: () => ({}), isRoot: () => false,
      onConfirmed: (team, id) => told.push(`${team}/${id}`),
    })
    all.push(apps)
    const init = (deadline: number, id = 'i1') => apps.call(TEAM, { callId: `late-${id}`, turnId: null, connectionId: 'conn-late', name: 'Fake', spec: spec(), message: { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, deadline })
    const started = Date.now()
    const r = await init(Date.now() + 2600)
    expect(r).toMatchObject({ ok: false, failure: 'unconfirmed' })
    // about 2 s before the deadline (CONFIRM_EARLY_MS), so the server hears why
    expect(Date.now() - started).toBeLessThan(2000)
    expect(told).toEqual([])
    press(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(told).toEqual([`${TEAM}/conn-late`])
    expect(confirmed.get(`${TEAM}/conn-late`)).toBe(commandHash(spec()))
    expect(await init(Date.now() + 10_000, 'i2')).toMatchObject({ ok: true })
    expect(asks).toBe(1)
  })

  test('Connect pressed in time: the call runs, and nothing is told (no second check)', async () => {
    const told: string[] = []
    const confirmed = new Map<string, string>()
    const apps = new LocalApps({
      confirm: () => new Promise<boolean>((r) => setTimeout(() => r(true), 50)),
      confirmed: (team, id) => confirmed.get(`${team}/${id}`) ?? null, setConfirmed: (team, id, h) => { confirmed.set(`${team}/${id}`, h) },
      settings: () => ({}), isRoot: () => false, onConfirmed: (team, id) => told.push(`${team}/${id}`),
    })
    all.push(apps)
    const r = await apps.call(TEAM, { callId: 'ok-1', turnId: null, connectionId: 'conn-ok', name: 'Fake', spec: spec(), message: { jsonrpc: '2.0', id: 'i1', method: 'initialize', params: {} }, deadline: Date.now() + 10_000 })
    expect(r).toMatchObject({ ok: true })
    expect(told).toEqual([])
  })
})

describe('ego lite not open', () => {
  const EGO = LOCAL_APP_PRESETS.find((p) => p.id === 'ego-lite')!.spec
  const BOOTSTRAP = 'Failed to connect to ego_cli bootstrap\nAgent note: ego-browser cannot connect to the ego_cli bootstrap from the default agent sandbox. Retry with Full Access or run ego-browser outside the agent sandbox. If it still fails, launch ego lite.app manually.'
  /** the listed ego lite as a program named ego-browser: the fake CLI while the "app" is up (a marker file), else
   * ego-browser's own bootstrap failure (exit 5), or `missing` words when set */
  function egoHarness(o: { running?: boolean; installed?: boolean; comesUp?: boolean; platform?: string; spec?: LocalAppSpec; missingWords?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-down-'))
    const up = path.join(dir, 'up')
    const fail = o.missingWords ? 'Failed to start ego lite: cannot find the app for com.citrolabs.ego.lite. Reinstall ego lite or launch it manually.' : BOOTSTRAP
    fs.writeFileSync(path.join(dir, 'ego-browser'), `#!/bin/sh\nif [ -f "${up}" ]; then exec "${process.execPath}" "${path.join(import.meta.dir, '..', 'fixtures', 'local-apps', 'fake-cli.ts')}" "$@"; fi\nprintf '%s\\n' "${fail.replace(/"/g, '\\"')}" >&2\nexit 5\n`, { mode: 0o755 })
    if (o.running && o.comesUp) fs.writeFileSync(up, '')
    let isRunning = !!o.running
    const opened: { id: string; args: string[] }[] = []
    const slept: number[] = []
    const apps = new LocalApps({
      confirm: async () => true, confirmed: () => commandHash(o.spec ?? EGO), setConfirmed: () => {}, settings: () => ({}), isRoot: () => false,
      searchPath: () => [dir], platform: o.platform ?? 'darwin', locale: () => 'en',
      appRunning: async () => isRunning,
      openApp: async (id, args) => { opened.push({ id, args }); if (o.installed === false) return false; isRunning = true; if (o.comesUp !== false) fs.writeFileSync(up, ''); return true },
      sleep: async (ms) => { slept.push(ms) },
    })
    all.push(apps)
    const run = (script = 'console.log(1)') => apps.call(TEAM, { callId: `ego-${Math.random()}`, turnId: null, connectionId: 'ego-1', name: 'ego lite', spec: o.spec ?? EGO, message: { jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'run_script', arguments: { script } } }, deadline: Date.now() + 20_000 })
    const texts = (r: Awaited<ReturnType<typeof run>>) => ((r.message?.result as { content?: { text: string }[] })?.content ?? []).map((c) => c.text)
    const done = () => fs.rmSync(dir, { recursive: true, force: true })
    return { run, texts, opened, slept, done }
  }

  test('not running: opened once in the background by its bundle id (as ego-browser starts it), waited for, and the call tried once more', async () => {
    const h = egoHarness()
    try {
      const r = await h.run()
      expect(r.ok).toBe(true)
      const out = h.texts(r)
      expect(out).toHaveLength(1)
      expect(out[0]).toContain('ran 14 chars')
      expect(h.opened).toEqual([{ id: EGO_BUNDLE_ID, args: ['--startup-ego-browser-service'] }])
      expect((r.message?.result as { isError?: boolean }).isError).toBe(false)
    } finally { h.done() }
  })

  test('not installed: plain words, no retry', async () => {
    const h = egoHarness({ installed: false })
    try {
      const out = h.texts(await h.run())
      expect(out.at(-1)).toBe(notOpenWords(t('en', 'localApp.egoNotInstalled')))
      expect(out.at(-1)).toContain("ego lite isn't installed on this computer. Install it from lite.ego.app, then ask again.")
      expect(h.opened).toHaveLength(1)
    } finally { h.done() }
    // ego-browser's own "cannot find the app": not opened at all
    const m = egoHarness({ missingWords: true })
    try {
      expect(m.texts(await m.run()).at(-1)).toContain("isn't installed")
      expect(m.opened).toHaveLength(0)
    } finally { m.done() }
  })

  test('it does not come up in time: "ego lite isn\'t open. Open ego lite, then ask again."', async () => {
    const h = egoHarness({ comesUp: false })
    try {
      // running, but its service never answers: tried once more, then the words for an app that does not answer
      const out = h.texts(await h.run())
      expect(out.at(-1)).toContain("ego lite is open but isn't answering")
    } finally { h.done() }
    // Linux: no way to open it here, only the words (Windows: e-local-apps-windows.test.ts)
    const w = egoHarness({ platform: 'linux' })
    try {
      const out = w.texts(await w.run())
      expect(out.at(-1)).toBe(notOpenWords("ego lite isn't open. Open ego lite, then ask again."))
      expect(w.opened).toHaveLength(0)
    } finally { w.done() }
  })

  test('already running (someone opened it): never opened again, only waited for and tried once more', async () => {
    const h = egoHarness({ running: true, comesUp: false })
    try {
      const out = h.texts(await h.run())
      expect(h.opened).toHaveLength(0)
      expect(h.slept.length).toBeGreaterThan(0)
      expect(out.at(-1)).toContain("ego lite is open but isn't answering")
    } finally { h.done() }
  })

  test('a command the person typed is never opened or retried, even when it is ego-browser', async () => {
    expect(isListedEgo({ ...EGO, command: '/opt/ego/ego-browser' } as LocalAppSpec)).toBe(false)
    const h = egoHarness({ spec: { ...EGO, command: '/opt/ego/ego-browser' } as LocalAppSpec })
    try {
      await h.run()
      expect(h.opened).toHaveLength(0)
    } finally { h.done() }
  })

  test('reading ego-browser\'s and Aside\'s words', () => {
    expect(isListedEgo(EGO)).toBe(true)
    expect(egoDown({ stdout: '', stderr: BOOTSTRAP, code: 5 })).toBe('down')
    expect(egoDown({ stdout: '', stderr: 'Failed to start ego lite.\nAgent note: …', code: 5 })).toBe('down')
    expect(egoDown({ stdout: '', stderr: 'Failed to start ego lite: cannot find the app for x. Reinstall ego lite or launch it manually.', code: 5 })).toBe('missing')
    expect(egoDown({ stdout: '', stderr: 'TypeError: x is undefined', code: 1 })).toBe(null)
    expect(egoDown({ stdout: '', stderr: BOOTSTRAP, code: 0 })).toBe(null)
    const down = { result: { content: [{ type: 'text', text: "Aside isn't running on this machine. Ask the user to open Aside, then retry the same command." }], isError: true } }
    expect(asideNotRunning(down)).toBe(true)
    expect(asideNotRunning({ error: { code: -1, message: 'Start Aside Browser to use the local host.' } })).toBe(true)
    expect(asideNotRunning({ result: { content: [{ type: 'text', text: 'ok' }] } })).toBe(false)
    const words = notOpenWords(t('en', 'localApp.asideNotOpen'))
    expect(words).toContain("Aside isn't open. Open Aside, then ask again.")
    expect((withAsideSignedOut(down, words).result as { content: { text: string }[] }).content.at(-1)!.text).toBe(words)
  })
})
