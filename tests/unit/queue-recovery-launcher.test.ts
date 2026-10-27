import { afterEach, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { codexDeviceLogin, launcherStatus } from '../../server/src/native'
import { ChatRuntime } from '../../server/src/chat/runtime'
import { QueueStore } from '../../server/src/chat/queue-store'
import { TurnExec } from '../../server/src/chat/turn'
import { testConfig } from './a-lib'
import { waitFor } from '../lib/wait'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f() })
function shortDir() {
  const dir = fs.mkdtempSync('/tmp/qrec-')
  cleanups.push(() => fs.rmSync(dir, { force: true, recursive: true }))
  return dir
}
async function fakeLauncher(sock: string, state: { live: number | undefined; hang?: boolean }) {
  let calls = 0, maxConnections = 0
  const connections = new Set<net.Socket>()
  const server = net.createServer(c => {
    connections.add(c); maxConnections = Math.max(maxConnections, connections.size)
    c.on('close', () => connections.delete(c)); c.on('error', () => {})
    let buffer = ''
    c.on('data', data => {
      buffer += data
      if (!buffer.includes('\n')) return
      calls++
      expect(JSON.parse(buffer.split('\n')[0]!).op).toBe('status')
      if (!state.hang) c.end(JSON.stringify({ ev: 'status', os: 'linux', sandbox: 'bwrap', ...(state.live === undefined ? {} : { liveTurns: state.live }) }) + '\n')
    })
  }).listen(sock)
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanups.push(async () => { for (const c of connections) c.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { calls: () => calls, connected: () => connections.size, maxConnections: () => maxConnections }
}
function fixture(name: string, sock: string) {
  const cfg = testConfig(`qrecover-${name}`, { mode: 'prod', engine: { authMode: 'local-login', launcherSock: sock } })
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  for (const u of ['a', 'b']) db.query("INSERT INTO users(id,username,name,role) VALUES(?,?,?,'member')").run(u, u, u)
  db.query("INSERT INTO settings(key,value) VALUES('concurrency','1')").run()
  const ctx = createContext({ config: cfg, db, log: silentLogger })
  const starts: TurnExec[] = []
  const run = spyOn(TurnExec.prototype, 'run').mockImplementation(async function(this: TurnExec) { starts.push(this) })
  const rt = new ChatRuntime(ctx, { recoveryPollMs: 20 })
  const store = new QueueStore(db)
  const add = (id: string, user: string) => db.transaction(() => {
    db.query('INSERT INTO chats(id,user_id) VALUES(?,?)').run(id, user)
    const u = rt.store.insertMessage({ chatId: id, parentId: null, role: 'user', authorId: user, content: 'synthetic', status: 'done' })
    const a = rt.store.insertMessage({ chatId: id, parentId: u, role: 'assistant', authorId: null, content: '', status: 'streaming', turnId: id })
    const seq = store.admit(user)
    db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,message_id,user_message_id,queue_seq) VALUES(?,?,?,'claude-code','queued',?,?,?)").run(id,id,user,a,u,seq)
  })()
  const finish = (e: TurnExec) => {
    db.query("UPDATE turns SET status='done' WHERE id=?").run(e.id)
    rt.turnFinished(e); (e as any).resolveDone()
  }
  cleanups.push(async () => { void rt.drain(0); for (const e of starts) finish(e); await ctx.close(); db.close(); run.mockRestore() })
  return { db, ctx, rt, store, starts, add, finish }
}

test('missing launcher status and legacy login from HTTP microtasks return failure without uncaught errors', async () => {
  const sock = path.join(shortDir(), 'missing.sock'), uncaught: unknown[] = []
  const caught = (e: unknown) => uncaught.push(e)
  process.on('uncaughtException', caught); cleanups.push(() => { process.off('uncaughtException', caught) })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    await Promise.resolve()
    const job = new URL(req.url).pathname === '/status' ? launcherStatus(sock, 100)
      : codexDeviceLogin(sock, { cmd: '/synthetic/not-executed', proxy: 'http://127.0.0.1:1' }, {})
    return Response.json(await Promise.race([job, Bun.sleep(500).then(() => 'timed out')]))
  } })
  cleanups.push(() => server.stop(true))
  expect(await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()).toBeNull()
  expect(await (await fetch(`http://127.0.0.1:${server.port}/login`)).json()).toMatchObject({ code: null })
  expect(uncaught).toEqual([])
})

test('prod recovery keeps admission closed while missing/busy/unknown, then dispatches durable FIFO once at idle', async () => {
  const sock = path.join(shortDir(), 'launcher.sock'), f = fixture('resume', sock)
  f.add('a1', 'a'); f.add('a2', 'a'); f.add('b1', 'b')
  f.store.claim('a1', 'a', 2700000)
  const tickets = [...f.store.tickets()]
  await Promise.all([f.rt.recover(), f.rt.recover()])
  expect(f.rt.queueDiagnostics().recovery).toBe('launcher_unreachable')
  expect(f.db.query("SELECT status FROM turns WHERE id='a1'").get()).toEqual({ status: 'interrupted' })
  expect(f.rt.queuedCount()).toBe(2); expect(f.starts).toHaveLength(0)
  expect(() => f.rt.checkQueueRoom('a', 'en')).toThrow('unavailable')
  const repair = spyOn(f.rt.queueStore, 'repair')
  cleanups.push(() => repair.mockRestore())
  const state = { live: 1 as number | undefined }, server = await fakeLauncher(sock, state)
  await waitFor(() => f.rt.queueDiagnostics().recovery === 'launcher_busy', { timeoutMs: 1500 })
  expect(f.rt.queueDiagnostics().recovery).toBe('launcher_busy')
  await Promise.all([f.rt.recover(), f.rt.recover()]); f.rt.resume()
  state.live = undefined
  await waitFor(() => f.rt.queueDiagnostics().recovery === 'launcher_unknown', { timeoutMs: 1500 })
  expect(f.rt.queueDiagnostics().recovery).toBe('launcher_unknown')
  expect(f.starts).toHaveLength(0); expect([...f.store.tickets()]).toEqual(tickets)
  expect(repair).not.toHaveBeenCalled()
  state.live = 0
  await waitFor(() => f.starts.length === 1, { timeoutMs: 1500 })
  expect(f.starts.map(e => e.id)).toEqual(['b1'])
  expect(f.rt.acceptingTurns).toBe(true)
  expect(f.rt.queueDiagnostics().recovery).toBe('ready')
  f.finish(f.starts[0]!)
  expect(f.starts.map(e => e.id)).toEqual(['b1', 'a2'])
  const calls = server.calls(); await Bun.sleep(70)
  expect(server.calls()).toBe(calls)
  expect(server.maxConnections()).toBe(1)
})

test('shutdown cancels an in-flight recovery probe and cannot restart queued work', async () => {
  const sock = path.join(shortDir(), 'launcher.sock'), state = { live: 0, hang: true }
  const server = await fakeLauncher(sock, state), f = fixture('shutdown', sock)
  f.add('a1', 'a')
  const recovery = f.rt.recover()
  await waitFor(() => server.calls() === 1, { timeoutMs: 1500 })
  await f.rt.shutdown(); await recovery
  await waitFor(() => server.connected() === 0, { timeoutMs: 200 })
  expect(server.connected()).toBe(0)
  state.hang = false
  await Bun.sleep(70)
  expect(server.calls()).toBe(1); expect(f.starts).toHaveLength(0)
  expect(f.db.query("SELECT status FROM turns WHERE id='a1'").get()).toEqual({ status: 'queued' })
  expect(f.rt.acceptingTurns).toBe(false)
})
