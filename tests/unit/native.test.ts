import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { startServer, type Running } from '../../server/src/server'
import { fakeTurn } from '../lib/run-turn'
import type { SocketLauncher } from '../../server/src/native'

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
      onStarted: async () => { await Bun.sleep(800); reply = await direct(srv.toolsSock, { hello: { token: stolen } }) },
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
    let during: string[] = []
    await fakeTurn(srv, 'alice', { calls: [{ tool: 'list', args: {} }], sleepMs: 1500 }, { chatId, onStarted: async () => { await Bun.sleep(1000); during = fs.existsSync(path.join(chatDir, '.turn')) ? fs.readdirSync(path.join(chatDir, '.turn')) : [] } })
    expect(during).toContain('mcp.json')
    expect(during).not.toContain('token')
    expect(during).not.toContain('system.md')
    expect(fs.existsSync(path.join(chatDir, '.turn'))).toBe(false)
  })
  test('the whole engine process group is killed at turn end', async () => {
    const script = path.join(srv.cfg.dataDir, 'bg.sh')
    fs.writeFileSync(script, 'sleep 300 &\necho BGPID=$!\n')
    const r = await fakeTurn(srv, 'alice', { calls: [], attack: script })
    const pid = +(/BGPID=(\d+)/.exec(JSON.stringify(r.lines))?.[1] ?? 0)
    expect(pid).toBeGreaterThan(0)
    await Bun.sleep(200)
    let alive = true; try { process.kill(pid, 0) } catch { alive = false }
    expect(alive).toBe(false)
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
