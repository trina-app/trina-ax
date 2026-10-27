import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { startServer, type Running } from '../../server/src/server'
import { fakeTurn } from '../lib/run-turn'
import { waitFor } from '../lib/wait'
import { SocketLauncher as SocketLauncherCls, startLauncher, type SocketLauncher } from '../../server/src/native'
import { nativeBinDir } from '../../server/src/config'
type SocketLauncherT = SocketLauncherCls

let srv: Running
beforeAll(async () => { const e = makeEnv('unit-native'); e.db.close(); srv = await startServer(e.cfg, { launcher: { allowCmds: [process.execPath, '/bin/sh'] } }) })
afterAll(async () => { await srv.close() })

/** speak MCP directly to a socket: hello line, then initialize; returns the first reply */
function direct(sock: string, first: unknown): Promise<string> {
  return new Promise((res) => {
    const c = net.createConnection(sock)
    let b = ''
    c.on('connect', () => { c.write(JSON.stringify(first) + '\n'); c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { file_path: 'shared/glossary.md' } } }) + '\n') })
    c.on('data', (d) => { b += d; if (b.includes('\n')) { c.destroy(); res(b) } })
    c.on('close', () => res(b)); c.on('error', () => res(b))
    setTimeout(() => { c.destroy(); res(b) }, 5000)
  })
}

describe('tool gate', () => {
  test('a valid turn token used from outside the turn\'s engine process group is refused', async () => {
    let stolen = ''
    const orig = srv.turns.create.bind(srv.turns)
    ;(srv.turns as any).create = (...a: any[]) => { const r = (orig as any)(...a); stolen = r.token; return r }
    let reply = ''
    const r = await fakeTurn(srv, 'alice', { calls: [{ tool: 'read', args: { file_path: 'shared/glossary.md' } }], sleepMs: 2500 }, {
      // steal the token while the turn is certainly live: after the legit call returned, during the engine's sleep
      onLine: async (l) => { if (l.tool === 'read' && !reply) reply = await direct(srv.toolsSock, { hello: { token: stolen } }) },
    })
    ;(srv.turns as any).create = orig
    expect(r.results[0].isError).toBe(false) // the legit bridge (in the group) works
    expect(reply).toContain('not authorized')
    expect(reply).toContain("not part of this turn's engine")
    expect(reply).not.toContain('ARR')
    // and after the turn ended the token is dead even for a right-group process
    expect(srv.turns.get(r.turnId)).toBeUndefined()
  })
  test('connecting to the server\'s private socket without the gate is refused', async () => {
    const reply = await direct(path.join(srv.cfg.runDir, 'private', 'server.sock'), { gate: { secret: 'x'.repeat(64), pid: process.pid, uid: process.getuid!(), gid: 0, pgid: 1, sid: 1 } })
    expect(reply).toContain('did not come through the gate')
  })
  test('garbage / no token is refused', async () => {
    expect(await direct(srv.toolsSock, { hello: {} })).toContain('missing token')
    expect(await direct(srv.toolsSock, { hello: { token: 'a'.repeat(43) } })).toContain('unknown or expired token')
  })
  test('rejections are audited', () => {
    const n = (srv.db.query("SELECT COUNT(*) n FROM tool_events WHERE tool = '(connect)' AND ok = 0").get() as any).n
    expect(n).toBeGreaterThanOrEqual(3)
  })
})

describe('launcher', () => {
  test('token file is gone once the bridge started; system prompt file gone after first output; .turn removed at the end', async () => {
    const chatId = 'c_files'
    const chatDir = path.join(srv.cfg.agentRoot, chatId)
    let during: string[] | null = null
    // Look at .turn when the engine reports its first tool result: by then the bridge has started (it reads and
    // deletes the token before connecting) and the engine has produced output (the launcher deletes system.md
    // before forwarding the first stdout chunk). The engine then sleeps, so .turn still exists.
    // (This used to be a fixed 1 s sleep after start, which failed when engine start-up was slow under load.)
    await fakeTurn(srv, 'alice', { calls: [{ tool: 'list', args: {} }], sleepMs: 1500 }, {
      chatId,
      onLine: (l) => { if (l.tool === 'list' && during === null) during = fs.existsSync(path.join(chatDir, '.turn')) ? fs.readdirSync(path.join(chatDir, '.turn')) : [] },
    })
    expect(during).not.toBeNull()
    expect(during!).toContain('mcp.json')
    expect(during!).not.toContain('token')
    expect(during!).not.toContain('system.md')
    expect(fs.existsSync(path.join(chatDir, '.turn'))).toBe(false)
  })
  test('the whole engine process group is killed at turn end', async () => {
    const script = path.join(srv.cfg.dataDir, 'bg.sh')
    fs.writeFileSync(script, 'sleep 300 &\necho BGPID=$!\n')
    const r = await fakeTurn(srv, 'alice', { calls: [], attack: script })
    const pid = +(/BGPID=(\d+)/.exec(JSON.stringify(r.lines))?.[1] ?? 0)
    expect(pid).toBeGreaterThan(0)
    // the kill is immediate, but the orphan is reaped by launchd/init asynchronously; poll instead of a fixed sleep
    const isAlive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(await waitFor(() => !isAlive(), { timeoutMs: 5000 })).toBe(true)
  })
  test('only allowed engine binaries run; chat folder must sit directly under the agent root', async () => {
    const h = srv.launcher!.launch({ op: 'run', turnId: 'tx', chatDir: path.join(srv.cfg.agentRoot, 'c_x'), cmd: '/usr/bin/id', args: [], env: {}, token: 't', systemPrompt: '', stdin: '', timeoutMs: 1000 })
    const evs = []; for await (const e of h.events) evs.push(e)
    expect(JSON.stringify(evs)).toContain('not allowed')
    const h2 = srv.launcher!.launch({ op: 'run', turnId: 'tx', chatDir: '/tmp/elsewhere', cmd: '/bin/sh', args: [], env: {}, token: 't', systemPrompt: '', stdin: '', timeoutMs: 1000 })
    const evs2 = []; for await (const e of h2.events) evs2.push(e)
    expect(JSON.stringify(evs2)).toContain('agent root')
  })
  test('--dedicated-account (kill -1 / reaper) is refused for a person\'s uid', () => {
    const p = Bun.spawnSync([path.join(srv.cfg.nativeBin, 'mycel-launcher'), '--dedicated-account', '--listen', path.join(srv.cfg.dataDir, 'x.sock'), '--agent-root', srv.cfg.agentRoot,
      '--bridge', 'b', '--tools-sock', 't', '--allow-cmd', '/bin/sh', '--server-uid', '0'])
    expect(p.exitCode).toBe(2)
    expect(p.stderr.toString()).toContain('refused')
  })
  test('TCP peer lookup (for the model proxy) is answered by the launcher', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const child = Bun.spawn([process.execPath, '-e', `const s=require('net').createConnection(${server.port},'127.0.0.1',()=>console.log('P'+s.localPort));setInterval(()=>{},1000)`], { stdout: 'pipe' })
    const reader = (child.stdout as ReadableStream).getReader(); const { value } = await reader.read()
    const clientPort = +new TextDecoder().decode(value).trim().slice(1)
    const peer = await (srv.launcher as SocketLauncher).tcpPeer(clientPort, server.port)
    child.kill(); server.stop(true)
    expect(peer?.pid).toBe(child.pid)
  })
})

// subscription mode: the per-turn model proxy token reaches the engine on an inherited pipe (fd 3), never through the
// environment or argv (other processes of the engine account can read those); credential variables in a request's
// environment are dropped by the launcher
describe('launcher: model proxy token', () => {
  const run = async (o: { env?: Record<string, string>; modelToken?: { kind: string; value: string } }) => {
    const chatDir = path.join(srv.cfg.agentRoot, 'mt' + Math.random().toString(36).slice(2, 8))
    const h = srv.launcher!.launch({ op: 'run', turnId: 'mt' + Math.random().toString(36).slice(2, 8), chatDir, cmd: '/bin/sh',
      args: ['-c', 'echo "oauth=${CLAUDE_CODE_OAUTH_TOKEN-} key=${ANTHROPIC_API_KEY-} fdvar=${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR-}${CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR-} base=${ANTHROPIC_BASE_URL-}"; cat <&3 2>/dev/null || echo "no fd 3"'],
      env: o.env ?? {}, token: 't', systemPrompt: '', stdin: '', timeoutMs: 10_000, ...(o.modelToken ? { modelToken: o.modelToken } : {}) } as any)
    let out = '', err: string | null = null
    for await (const ev of h.events) { if (ev.ev === 'stdout') out += Buffer.from(ev.b64, 'base64').toString(); if (ev.ev === 'error') err = ev.message }
    return { out: out.trim(), err }
  }
  test('token on fd 3 with the variable naming it; credential variables from the request are dropped', async () => {
    const r = await run({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'leak-1', ANTHROPIC_API_KEY: 'leak-2', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, modelToken: { kind: 'oauth', value: 'mpx_turn_token' } })
    expect(r.err).toBeNull()
    expect(r.out).toBe('oauth= key= fdvar=3 base=http://127.0.0.1:9\nmpx_turn_token')
    const k = await run({ modelToken: { kind: 'api-key', value: 'mpx_key' } })
    expect(k.out).toBe('oauth= key= fdvar=3 base=\nmpx_key')
  })
  test('without a model token there is no fd 3; a bad token kind or a token with a newline is refused', async () => {
    expect((await run({})).out).toBe('oauth= key= fdvar= base=\nno fd 3')
    expect((await run({ modelToken: { kind: 'other', value: 'x' } })).err).toContain('bad model token')
    expect((await run({ modelToken: { kind: 'oauth', value: 'a\nb' } })).err).toContain('bad model token')
  })
})

// managed Codex turns (docs/DECISIONS.md "AI 연결" D9, security T1 / S-3): the launcher writes the placeholder login the
// server sends into a fresh <chat>/.codex, refuses anything that could be a real ChatGPT login or key, sets the refresh
// address to the proxy itself, refuses provider addresses other than the proxy, and removes the folders at the end.
describe('launcher: managed Codex placeholder login (S-3)', () => {
  const R = fs.mkdtempSync('/tmp/mycel-nm-')
  const sock = path.join(R, 'l.sock')
  const agent = path.join(R, 'agent')
  let proc: Awaited<ReturnType<typeof startLauncher>>
  let l: SocketLauncherT
  beforeAll(async () => {
    proc = await startLauncher(nativeBinDir(), { listen: sock, agentRoot: agent, toolsSock: path.join(R, 't.sock'), allowCmds: ['/bin/sh'], proxyPort: 45678 })
    l = new SocketLauncherCls(sock)
  })
  afterAll(() => { proc?.kill(); fs.rmSync(R, { recursive: true, force: true }) })
  const tokenOk = 'mpx_' + 'a'.repeat(43)
  const jwt = (o: unknown) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(o)).toString('base64url')}.c2ln`
  const chatgpt = (over: Record<string, unknown> = {}, apiKey: string | null = null) => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: apiKey, tokens: { id_token: jwt({ a: 1 }), access_token: tokenOk, refresh_token: 'teamax-no-refresh', account_id: 'teamax-0123456789ab', ...over }, last_refresh: new Date().toISOString() })
  const run = async (authJson: string | null, o: { args?: string[]; env?: Record<string, string>; chat?: string } = {}) => {
    const chat = o.chat ?? 'c' + Math.random().toString(36).slice(2, 8)
    const chatDir = path.join(agent, chat)
    const h = l.launch({ op: 'run', turnId: 't' + Math.random().toString(36).slice(2, 8), chatDir, cmd: '/bin/sh',
      args: o.args ?? ['-c', 'cat .codex/auth.json; echo; ls -A .home | wc -l; echo "REF=$CODEX_REFRESH_TOKEN_URL_OVERRIDE KEY=${OPENAI_API_KEY-}${CODEX_API_KEY-}${CODEX_ACCESS_TOKEN-}"'],
      env: o.env ?? {}, token: 't'.repeat(30), systemPrompt: '', stdin: '', timeoutMs: 10_000, ...(authJson !== null ? { codexHome: { authJson } } : {}) } as any)
    let out = '', err: string | null = null
    for await (const ev of h.events) { if (ev.ev === 'stdout') out += Buffer.from(ev.b64, 'base64').toString(); if (ev.ev === 'error') err = ev.message }
    return { out: out.trim(), err, chatDir }
  }
  test('a placeholder login is written (0600), the refresh address is the proxy, key variables are dropped, nothing stays', async () => {
    const auth = chatgpt()
    const r = await run(auth, { env: { OPENAI_API_KEY: 'sk-leak', CODEX_API_KEY: 'sk-leak2', CODEX_ACCESS_TOKEN: 'at-leak', CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://evil.example/token' } })
    expect(r.err).toBeNull()
    const [json, homeCount, env] = r.out.split('\n')
    expect(JSON.parse(json!)).toEqual(JSON.parse(auth))
    expect(homeCount!.trim()).toBe('0')
    expect(env).toBe('REF=http://127.0.0.1:45678/codex/oauth/token KEY=')
    expect(fs.existsSync(path.join(r.chatDir, '.codex'))).toBe(false)
    expect(fs.existsSync(path.join(r.chatDir, '.home'))).toBe(false)
    const k = await run(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: tokenOk }))
    expect(k.err).toBeNull()
  })
  test('anything that looks like a real login or key is refused before the engine starts', async () => {
    const bad: [string, string][] = [
      ['a real access token', chatgpt({ access_token: 'eyJhbGciOi.real.token' })],
      ['a real refresh token', chatgpt({ refresh_token: 'rt-REAL' })],
      ['a real account id', chatgpt({ account_id: 'acc-1234' })],
      ['an API key next to the tokens', chatgpt({}, 'sk-proj-real')],
      ['an id_token that is not a JWT', chatgpt({ id_token: 'x' })],
      ['a real API key', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-proj-' + 'r'.repeat(40) })],
      ['tokens in API key mode', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: tokenOk, tokens: { access_token: 'x' } })],
      ['another mode', JSON.stringify({ auth_mode: 'chatgptAuthTokens', tokens: {} })],
      ['not JSON', '{'],
      ['too big', chatgpt({ pad: 'x'.repeat(20_000) })],
    ]
    for (const [label, auth] of bad) {
      const r = await run(auth, { args: ['-c', 'echo RAN'] })
      expect(r.err, label).toMatch(/managed Codex login/)
      expect(r.out, label).toBe('')
      expect(fs.existsSync(path.join(r.chatDir, '.codex', 'auth.json')), label).toBe(false)
    }
  })
  test('a provider or ChatGPT address other than the proxy is refused; the proxy\'s is fine', async () => {
    const bad = await run(chatgpt(), { args: ['-c', 'model_providers.teamax.base_url="https://chatgpt.com/backend-api/codex"', '-c', 'echo RAN'] })
    expect(bad.err).toMatch(/not the model proxy/)
    const bad2 = await run(chatgpt(), { args: ['-c', 'chatgpt_base_url="http://127.0.0.1:1/"', '-c', 'echo RAN'] })
    expect(bad2.err).toMatch(/not the model proxy/)
    const ok = await run(chatgpt(), { args: ['-c', 'echo ok', 'x', '-c', 'model_providers.teamax.base_url="http://127.0.0.1:45678/codex/chatgpt"'] })
    expect(ok.err).toBeNull()
  })
  test('a hidden folder (the sign-in folders) is never a chat folder; a managed turn needs --proxy-port', async () => {
    const r = await run(chatgpt(), { chat: '.codex-login' })
    expect(r.err).toMatch(/hidden folder/)
    const h = srv.launcher!.launch({ op: 'run', turnId: 'np', chatDir: path.join(srv.cfg.agentRoot, 'np1'), cmd: '/bin/sh', args: ['-c', 'echo RAN'], env: {}, token: 't'.repeat(30), systemPrompt: '', stdin: '', timeoutMs: 5000, codexHome: { authJson: chatgpt() } } as any)
    let err = ''
    for await (const e of h.events) if (e.ev === 'error') err = e.message
    expect(err).toMatch(/needs the model proxy/)
  })
  test('a left-over .codex of a crashed turn is removed before any other turn starts in that chat', async () => {
    const chatDir = path.join(agent, 'leftover')
    fs.mkdirSync(path.join(chatDir, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(chatDir, '.codex', 'auth.json'), '{"tokens":{"refresh_token":"rt-REAL"}}')
    const r = await run(null, { chat: 'leftover', args: ['-c', 'test -e .codex && echo THERE || echo GONE'] })
    expect(r.out).toBe('GONE')
  })
})
