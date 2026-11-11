// One answer's tool connection (mcp/socket.ts CallQueue): read-only tool calls run at the same time, at most
// MAX_PARALLEL_READS; every other message runs alone and in order. Each answer keeps its JSON-RPC id, its audit row
// (tool_events) and the turn's checks. Spoken over the server's private socket like the gate does (secret, peer
// credentials, turn token), with a fake turn tool set whose calls finish when the test says so.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { makeEnv } from '../lib/env'
import { waitFor } from '../lib/wait'
import { CallQueue, MAX_PARALLEL_READS, parallelCall, startMcpSocket, type McpSocketServer } from '../../server/src/mcp/socket'
import { makeHandler } from '../../server/src/mcp/protocol'
import { TurnRegistry, type Turn, type TurnToolSet } from '../../server/src/turns'
import { PARALLEL_READ_TOOLS, ROOM_READ_ONLY_TOOLS } from '../../server/src/rooms/ai-tools'
import { EXPLORE_TOOLS, PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { toolRegistry } from '../../server/src/tools/registry'

const env = makeEnv('unit-mcp-socket-parallel')
const turns = new TurnRegistry(env.db, process.getuid!())
// a short folder: a unix socket path has at most 104 bytes on macOS
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-par-'))
const PG = 424242
let srv: McpSocketServer
beforeAll(() => { srv = startMcpSocket(path.join(dir, 's.sock'), env.files, env.db, turns) })
afterAll(() => { srv.stop(); fs.rmSync(dir, { recursive: true, force: true }) })

type Outcome = { text?: string; isError?: boolean; throws?: string }
type Running = { name: string; n: number; finish: (o?: Outcome) => void }

/** A turn's tool set whose every call waits until the test finishes it. */
class SlowTools implements TurnToolSet {
  started: Running[] = []
  running = 0
  most = 0
  list() { return [] }
  has(name: string) {
    if (name === 'glob') throw new Error('the tool set failed')
    return true
  }
  call(name: string, args: unknown) {
    const n = Number((args as { n?: unknown } | null)?.n)
    this.running++
    this.most = Math.max(this.most, this.running)
    return new Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean; summary: string }>((resolve, reject) => {
      this.started.push({ name, n, finish: (o = {}) => {
        this.running--
        if (o.throws) return reject(new Error(o.throws))
        resolve({ content: [{ type: 'text', text: o.text ?? `${name} ${n} done` }], ...(o.isError ? { isError: true } : {}), summary: `${name} ${n} -> ${o.isError ? 'error' : 'ok'}` })
      } })
    })
  }
  get(n: number) { const r = this.started.find((s) => s.n === n); if (!r) throw new Error(`call ${n} has not started`); return r }
  names() { return this.started.map((s) => `${s.name} ${s.n}`) }
}

type Client = { lines: any[]; closed: boolean; send(m: unknown): void; call(id: number, name: string, args?: Record<string, unknown>): void; reply(id: number): Promise<any>; end(): void }

let chats = 0
/** A turn of alice with its engine bound, and a connection that passed the gate and the hello. */
async function open(tools?: TurnToolSet): Promise<{ turn: Turn; c: Client }> {
  const { turn, token } = turns.create('alice', `c_par_${++chats}`)
  turns.bind(turn.id, PG)
  if (tools) turn.tools = tools
  const sock = net.createConnection(srv.path)
  sock.setEncoding('utf8')
  await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej) })
  const c: Client = {
    lines: [], closed: false,
    send: (m) => { sock.write(JSON.stringify(m) + '\n') },
    call: (id, name, args = { n: id }) => c.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    reply: async (id) => { const r = await waitFor(() => c.lines.find((l) => l.id === id)); if (!r) throw new Error(`no reply ${id}`); return r },
    end: () => sock.destroy(),
  }
  let buf = ''
  sock.on('data', (d: string) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) c.lines.push(JSON.parse(l)) }
  })
  sock.on('close', () => { c.closed = true })
  c.send({ gate: { secret: srv.secret, pid: process.pid, uid: process.getuid!(), gid: 0, pgid: PG, sid: PG } })
  c.send({ hello: { token } })
  c.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })
  expect((await c.reply(0)).result.serverInfo.name).toBe('team')
  return { turn, c }
}
const close = (turn: Turn, c: Client) => { turns.revoke(turn.id); c.end() }
/** the turn's audit rows of tool calls (not the connection's own) */
const audit = (turnId: string) => env.db.query("SELECT tool, summary, ok FROM tool_events WHERE turn_id = ? AND tool != '(connect)' ORDER BY id").all(turnId) as { tool: string; summary: string; ok: number }[]
const rejected = (turnId: string) => env.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = '(connect)' AND ok = 0 ORDER BY id").all(turnId) as { summary: string }[]
/** nothing more happens for a while (to show that something waits) */
const settle = () => Bun.sleep(60)

describe('which calls run side by side', () => {
  test('only calls of the read-only file tools; everything else, unknown tools included, runs alone', () => {
    const call = (name: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
    for (const t of ['read', 'list', 'glob', 'grep']) expect(parallelCall(call(t))).toBe(true)
    // search and knowledge_explore: removed tools (search by meaning, the knowledge graph); a call by such a name now runs
    // alone like any unknown tool
    for (const t of ['search', 'knowledge_explore', 'write', 'edit', 'edit_files', 'make_file', 'share_file', 'remember', 'ask_user', 'artifact', 'web_fetch', 'room_file', 'room_thread',
      'skill', 'hwp_render', 'mcp__other__read', 'Read', 'unknown_tool', '', undefined, 42])
      expect(parallelCall(call(t))).toBe(false)
    for (const m of [{ jsonrpc: '2.0', id: 1, method: 'initialize' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 3, method: 'ping', params: { name: 'read' } }, null, 'read', [call('read')]])
      expect(parallelCall(m)).toBe(false)
  })
  test('the list is read-only tools only, and none of them patches its step (TurnExec.patchToolStep is FIFO per tool)', () => {
    expect([...PARALLEL_READ_TOOLS].sort()).toEqual(['glob', 'grep', 'list', 'read'])
    for (const t of PARALLEL_READ_TOOLS) {
      expect(ROOM_READ_ONLY_TOOLS.has(t)).toBe(true)
      expect(EXPLORE_TOOLS.has(t)).toBe(true)
      expect(PARENT_ONLY_TOOLS.has(t)).toBe(false)
    }
  })
  test('CallQueue: a job that throws does not stop the ones after it', async () => {
    const q = new CallQueue(2)
    const done: string[] = []
    q.push(false, async () => { throw new Error('x') })
    q.push(true, async () => { done.push('a') })
    q.push(false, async () => { done.push('b') })
    expect(await waitFor(() => done.length === 2)).toBe(true)
    expect(done).toEqual(['a', 'b'])
  })
})

describe('one connection, several calls', () => {
  test('reads run at the same time; each answer keeps its id and goes out when its call finishes; one audit row each', async () => {
    const tools = new SlowTools()
    const { turn, c } = await open(tools)
    c.call(1, 'read'); c.call(2, 'grep'); c.call(3, 'list')
    // all three started before any of them finished
    expect(await waitFor(() => tools.started.length === 3)).toBe(true)
    expect(tools.names()).toEqual(['read 1', 'grep 2', 'list 3'])
    tools.get(3).finish(); await c.reply(3)
    tools.get(2).finish(); await c.reply(2)
    tools.get(1).finish(); await c.reply(1)
    expect(c.lines.slice(1).map((l) => l.id)).toEqual([3, 2, 1])
    for (const [id, name] of [[1, 'read'], [2, 'grep'], [3, 'list']] as const) {
      const r = c.lines.find((l) => l.id === id)
      expect(r.jsonrpc).toBe('2.0')
      expect(r.result.content[0].text).toBe(`${name} ${id} done`)
      expect(r.result.isError).toBeUndefined()
    }
    expect(audit(turn.id)).toEqual([
      { tool: 'list', summary: 'list 3 -> ok', ok: 1 },
      { tool: 'grep', summary: 'grep 2 -> ok', ok: 1 },
      { tool: 'read', summary: 'read 1 -> ok', ok: 1 },
    ])
    close(turn, c)
  })

  test('a write waits for every read before it, and the reads after it wait for the write', async () => {
    const tools = new SlowTools()
    const { turn, c } = await open(tools)
    c.call(1, 'read'); c.call(2, 'list'); c.call(3, 'write'); c.call(4, 'read'); c.call(5, 'grep')
    expect(await waitFor(() => tools.started.length === 2)).toBe(true)
    await settle()
    expect(tools.names()).toEqual(['read 1', 'list 2'])
    tools.get(2).finish(); await c.reply(2)
    await settle()
    // read 1 still runs: the write has not started
    expect(tools.names()).toEqual(['read 1', 'list 2'])
    tools.get(1).finish(); await c.reply(1)
    expect(await waitFor(() => tools.started.length === 3)).toBe(true)
    expect(tools.started[2]!.name).toBe('write')
    await settle()
    // the write runs alone: the reads after it wait
    expect(tools.started.length).toBe(3)
    expect(tools.running).toBe(1)
    tools.get(3).finish(); await c.reply(3)
    // then both reads after it start together
    expect(await waitFor(() => tools.started.length === 5)).toBe(true)
    expect(tools.running).toBe(2)
    tools.get(5).finish(); tools.get(4).finish()
    await c.reply(4); await c.reply(5)
    expect(c.lines.slice(1, 4).map((l) => l.id)).toEqual([2, 1, 3])
    expect(audit(turn.id).map((r) => r.summary)).toEqual(['list 2 -> ok', 'read 1 -> ok', 'write 3 -> ok', 'grep 5 -> ok', 'read 4 -> ok'])
    close(turn, c)
  })

  test('tools that are not read-only, unknown ones too, run one at a time in order', async () => {
    const tools = new SlowTools()
    const { turn, c } = await open(tools)
    c.call(1, 'share_file'); c.call(2, 'ask_user'); c.call(3, 'some_new_tool'); c.call(4, 'read')
    for (const n of [1, 2, 3]) {
      expect(await waitFor(() => tools.started.length === n)).toBe(true)
      await settle()
      expect(tools.started.length).toBe(n)
      tools.get(n).finish(); await c.reply(n)
    }
    expect(await waitFor(() => tools.started.length === 4)).toBe(true)
    tools.get(4).finish(); await c.reply(4)
    expect(c.lines.slice(1).map((l) => l.id)).toEqual([1, 2, 3, 4])
    expect(tools.most).toBe(1)
    close(turn, c)
  })

  test('other messages keep their order: tools/list and ping wait for the reads before them', async () => {
    const tools = new SlowTools()
    const { turn, c } = await open(tools)
    c.call(1, 'read')
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    c.send({ jsonrpc: '2.0', id: 3, method: 'ping' })
    c.call(4, 'read')
    expect(await waitFor(() => tools.started.length === 1)).toBe(true)
    await settle()
    expect(c.lines.length).toBe(1)
    expect(tools.started.length).toBe(1)
    tools.get(1).finish()
    expect(await waitFor(() => tools.started.length === 2)).toBe(true)
    tools.get(4).finish(); await c.reply(4)
    expect(c.lines.slice(1).map((l) => l.id)).toEqual([1, 2, 3, 4])
    expect(c.lines[2].result.tools).toEqual(expect.any(Array))
    close(turn, c)
  })

  test(`at most ${MAX_PARALLEL_READS} reads at once, started in the order they came`, async () => {
    const tools = new SlowTools()
    const { turn, c } = await open(tools)
    for (let n = 1; n <= 7; n++) c.call(n, n % 2 ? 'read' : 'grep')
    expect(await waitFor(() => tools.started.length === MAX_PARALLEL_READS)).toBe(true)
    await settle()
    expect(tools.started.map((s) => s.n)).toEqual([1, 2, 3, 4])
    tools.get(2).finish(); await c.reply(2)
    expect(await waitFor(() => tools.started.length === 5)).toBe(true)
    expect(tools.started[4]!.n).toBe(5)
    await settle()
    expect(tools.running).toBe(MAX_PARALLEL_READS)
    for (const n of [1, 3, 4, 5, 6, 7]) { await waitFor(() => tools.started.some((s) => s.n === n)); tools.get(n).finish(); await c.reply(n) }
    expect(tools.most).toBe(MAX_PARALLEL_READS)
    expect(audit(turn.id).length).toBe(7)
    close(turn, c)
  })

  test('an error in one call does not touch the others; errors map to the result or a JSON-RPC error as before', async () => {
    const tools = new SlowTools()
    const { turn, c } = await open(tools)
    c.call(1, 'read'); c.call(2, 'glob'); c.call(3, 'read'); c.call(4, 'list')
    // glob: the tool set itself fails before the call runs -> a JSON-RPC internal error with its own id
    const r2 = await c.reply(2)
    expect(r2.error).toEqual({ code: -32603, message: 'the tool set failed' })
    expect(await waitFor(() => tools.started.length === 3)).toBe(true)
    tools.get(1).finish({ throws: 'disk on fire' })
    tools.get(4).finish({ isError: true, text: 'Nothing found' })
    tools.get(3).finish()
    const [r1, r3, r4] = [await c.reply(1), await c.reply(3), await c.reply(4)]
    expect(r1.result).toEqual({ content: [{ type: 'text', text: 'Error: internal error' }], isError: true })
    expect(r3.result).toEqual({ content: [{ type: 'text', text: 'read 3 done' }] })
    expect(r4.result).toEqual({ content: [{ type: 'text', text: 'Nothing found' }], isError: true })
    const rows = audit(turn.id)
    expect(rows.find((r) => r.summary.startsWith('read -> internal'))).toEqual({ tool: 'read', summary: 'read -> internal: disk on fire', ok: 0 })
    expect(rows.find((r) => r.tool === 'list')!.ok).toBe(0)
    expect(rows.find((r) => r.summary === 'read 3 -> ok')!.ok).toBe(1)
    expect(rows.length).toBe(3)
    expect(c.closed).toBe(false)
    // the connection goes on
    c.call(5, 'read'); expect(await waitFor(() => tools.started.length === 4)).toBe(true)
    tools.get(5).finish(); expect((await c.reply(5)).result.content[0].text).toBe('read 5 done')
    close(turn, c)
  })

  test('a turn stopped while reads run: no answers go out, the connection closes, and nothing after them runs', async () => {
    const tools = new SlowTools()
    const { turn, c } = await open(tools)
    c.call(1, 'read'); c.call(2, 'read'); c.call(3, 'write'); c.call(4, 'read')
    expect(await waitFor(() => tools.started.length === 2)).toBe(true)
    turns.invalidate(turn.id, 'stopped')
    expect(await waitFor(() => c.closed)).toBe(true)
    tools.get(2).finish(); tools.get(1).finish()
    expect(await waitFor(() => rejected(turn.id).length === 4)).toBe(true)
    await settle()
    expect(c.lines.map((l) => l.id)).toEqual([0])
    // the write and the read after it never ran
    expect(tools.names()).toEqual(['read 1', 'read 2'])
    expect(rejected(turn.id).every((r) => r.summary.startsWith('rejected: turn ended'))).toBe(true)
    // the two reads that ran keep their audit rows
    expect(audit(turn.id).map((r) => r.summary)).toEqual(['read 2 -> ok', 'read 1 -> ok'])
    turns.revoke(turn.id, 'stopped'); c.end()
  })

  test('the real file tools side by side: every read joins the read scope and the sources', async () => {
    // no turn tool set: the six file tools, as a stage-1 turn
    const { turn, c } = await open()
    c.call(1, 'read', { file_path: 'shared/glossary.md' })
    c.call(2, 'read', { file_path: 'shared/policies/remote-work-v2.md' })
    c.call(3, 'grep', { pattern: 'Decisions', path: 'shared/meetings', output_mode: 'content', head_limit: 3 })
    c.call(4, 'list', { path: 'shared' })
    c.call(5, 'glob', { pattern: '**/*.md', path: 'projects' })
    c.call(6, 'read', { file_path: 'groups/finance/budget.md' })
    const r = await Promise.all([1, 2, 3, 4, 5, 6].map((id) => c.reply(id)))
    expect(r[0].result.content[0].text).toContain('ARR')
    expect(r[1].result.content[0].text).toContain('코어타임')
    expect(r[2].result.content[0].text).toContain('Decisions')
    expect(r[3].result.content[0].text).toContain('glossary.md')
    expect(r[4].result.isError).toBeUndefined()
    // alice may not read finance: denied, nothing of it recorded
    expect(r[5].result.isError).toBe(true)
    expect(r[5].result.content[0].text).not.toContain('CANARY')
    const read = turn.files.readPaths
    expect(read.has('shared/glossary.md')).toBe(true)
    expect(read.has('shared/policies/remote-work-v2.md')).toBe(true)
    expect([...read].some((p) => p.startsWith('shared/meetings/'))).toBe(true)
    expect([...read].some((p) => p.startsWith('groups/finance'))).toBe(false)
    expect(turn.files.namePaths.has('shared')).toBe(true)
    expect(turn.files.readHashes.has('shared/glossary.md')).toBe(true)
    expect(audit(turn.id).length).toBe(6)
    close(turn, c)
  })
})

describe('the handler (mcp/protocol.ts)', () => {
  test('each call keeps the person as loaded at its start, while another call of the same answer starts', async () => {
    let open_: () => void = () => {}
    const gate = new Promise<void>((r) => { open_ = r })
    let started = false
    toolRegistry(env.files).register({
      name: 'probe_person', description: 'test', input: z.object({}),
      async run(_a, ctx) {
        const before = ctx.user
        started = true
        await gate
        return { text: ctx.user === before ? 'same' : 'changed', summary: 'probe_person' }
      },
    })
    const h = makeHandler(env.files, env.db, env.ctx('alice', null))
    const a = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'probe_person', arguments: {} } })
    expect(await waitFor(() => started)).toBe(true)
    // another call of the same answer loads the person again
    const b = await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list', arguments: { path: 'shared' } } })
    expect(b.result.isError).toBeUndefined()
    open_()
    expect((await a).result.content[0].text).toBe('same')
  })
})
