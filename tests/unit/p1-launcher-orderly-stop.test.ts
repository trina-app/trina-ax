// QA TC-338: an orderly stop of mycel-launcher (an update's prepare-stop, SIGTERM from systemd / launchd) ends the
// running turns with a confirmed exit that says why ("update" / "shutdown"), instead of a socket the restart cut (read
// as an engine crash, the turn slot quarantined). A turn that the stop did not end keeps its own exit.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { nativeBinDir } from '../../server/src/config'
import { WORK } from '../lib/env'
import { waitFor } from '../lib/wait'

const W = path.join(WORK, 'p1-launcher-stop')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const cleanups: (() => void)[] = []
afterEach(() => { for (const f of cleanups.splice(0)) f() })

async function startLauncher() {
  fs.rmSync(W, { recursive: true, force: true })
  const agent = path.join(W, 'agent')
  fs.mkdirSync(agent, { recursive: true })
  const engine = path.join(W, 'engine.sh')
  // never ends on its own (with a child, like the MCP bridge); "quick" in its stdin: ends at once
  fs.writeFileSync(engine, '#!/bin/sh\nread line\n[ "$line" = quick ] && exit 0\nsleep 120 &\necho "child $!"\nexec sleep 120\n', { mode: 0o755 })
  const dir = fs.mkdtempSync('/tmp/mycel-p1s-')
  const sock = dir + '/l.sock'
  const launcher = Bun.spawn([path.join(nativeBinDir(), 'mycel-launcher'), '--listen', sock, '--agent-root', agent, '--bridge', '/nonexistent/bridge',
    '--tools-sock', path.join(W, 'tools.sock'), '--allow-cmd', engine], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
  cleanups.push(() => { launcher.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }) })
  const r = launcher.stdout.getReader()
  const { value } = await r.read()
  expect(new TextDecoder().decode(value)).toContain('ready')
  r.releaseLock()
  return { launcher, sock, agent, engine }
}

type Turn = { pid: number; child: number; exit: Promise<any>; exitAt: () => number }
/** start a turn; resolves once its engine runs, with the exit event to come */
function startTurn(l: { sock: string; agent: string; engine: string }, chat: string, stdin = 'run\n'): Promise<Turn> {
  return new Promise((res, rej) => {
    const c = net.createConnection(l.sock)
    let buf = '', pid = 0, resolveExit!: (e: any) => void, at = 0
    const exit = new Promise<any>((r) => (resolveExit = r))
    c.setEncoding('utf8')
    c.on('connect', () => c.write(JSON.stringify({ op: 'run', turnId: 't-' + chat, chatDir: path.join(l.agent, chat), cmd: l.engine, args: [], env: {}, token: 'x', systemPrompt: '', stdin, timeoutMs: 600_000 }) + '\n'))
    c.on('data', (d: string) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        const t = { exit, exitAt: () => at }
        if (ev.ev === 'started') { pid = ev.pid; if (stdin === 'quick\n') res({ pid, child: 0, ...t }) }
        else if (ev.ev === 'stdout') {
          const m = /child (\d+)/.exec(Buffer.from(ev.b64, 'base64').toString())
          if (m && pid) res({ pid, child: Number(m[1]), ...t })
        } else if (ev.ev === 'exit' || ev.ev === 'error') { at = performance.now(); resolveExit(ev); c.end(); if (!pid) res({ pid: 0, child: 0, ...t }) }
      }
    })
    c.on('error', rej)
    c.on('close', () => resolveExit(null))
  })
}
function ask(sock: string, req: object): Promise<any> {
  return new Promise((res, rej) => {
    const c = net.createConnection(sock)
    let buf = ''
    c.setEncoding('utf8')
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'))
    c.on('data', (d: string) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { res(JSON.parse(buf.slice(0, i))); c.end() } })
    c.on('error', rej)
  })
}

test('prepare-stop "update": the running turns end with a confirmed exit saying so, new ones are refused until the restart', async () => {
  const l = await startLauncher()
  const a = await startTurn(l, 'chat-a'), b = await startTurn(l, 'chat-b')
  const answer = await ask(l.sock, { op: 'prepare-stop', reason: 'update' })
  const answeredAt = performance.now()
  expect(answer).toEqual({ ev: 'prepared', ended: 2 })
  // each exit was sent before the answer: the server reads a confirmed end
  expect(await a.exit).toMatchObject({ ev: 'exit', signal: 'update' })
  expect(await b.exit).toMatchObject({ ev: 'exit', signal: 'update' })
  expect(a.exitAt()).toBeLessThan(answeredAt)
  expect(b.exitAt()).toBeLessThan(answeredAt)
  expect(await waitFor(() => !alive(a.pid) && !alive(a.child) && !alive(b.pid) && !alive(b.child), { timeoutMs: 8000 })).toBe(true)
  // until the restart, a new turn is refused before anything of it starts, and the status says why
  const c = await startTurn(l, 'chat-c')
  expect(c.pid).toBe(0)
  expect(await c.exit).toEqual({ ev: 'error', message: 'launcher_stopping: update' })
  expect(await ask(l.sock, { op: 'status' })).toMatchObject({ ev: 'status', liveTurns: 0, stopping: 'update' })
  expect(await ask(l.sock, { op: 'prepare-stop', reason: 'nonsense' })).toMatchObject({ ev: 'error' })
}, 30_000)

test('SIGTERM: every running turn ends with "shutdown" (or the prepared "update") before the launcher exits', async () => {
  const l = await startLauncher()
  const a = await startTurn(l, 'chat-a')
  l.launcher.kill('SIGTERM')
  expect(await a.exit).toMatchObject({ ev: 'exit', signal: 'shutdown' })
  expect(await Promise.race([l.launcher.exited, Bun.sleep(10_000).then(() => 'still running')])).toBe(0)
  expect(alive(a.pid) || alive(a.child)).toBe(false)

  // an update said so first: the stop after it exits at once with nothing left to end
  const m = await startLauncher()
  const b = await startTurn(m, 'chat-b')
  await ask(m.sock, { op: 'prepare-stop', reason: 'update' })
  expect(await b.exit).toMatchObject({ ev: 'exit', signal: 'update' })
  m.launcher.kill('SIGTERM')
  expect(await Promise.race([m.launcher.exited, Bun.sleep(10_000).then(() => 'still running')])).toBe(0)
}, 40_000)

test('a turn whose engine ended on its own is reported as it ended', async () => {
  const l = await startLauncher()
  const q = await startTurn(l, 'chat-q', 'quick\n')
  const ev = await q.exit
  expect(ev).toMatchObject({ ev: 'exit', code: 0 })
  expect(ev.signal).toBeUndefined()
}, 20_000)
