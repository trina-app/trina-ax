// The launcher stops a turn's engine when the server's connection goes away before the turn ended (server crash,
// kill -9, restart). Before, it only stopped on {"op":"kill"} or the 3-hour backstop, so an engine of a crashed
// server kept running (and spending the subscription) for hours with nobody reading its answer.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { nativeBinDir } from '../../server/src/config'
import { WORK } from '../lib/env'
import { waitFor } from '../lib/wait'

const W = path.join(WORK, 'p1-launcher')
const AGENT = path.join(W, 'agent')
const ENGINE = path.join(W, 'engine.sh')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

let launcher: Bun.Subprocess<'ignore', 'pipe', 'inherit'>
let sock = ''

beforeAll(async () => {
  fs.rmSync(W, { recursive: true, force: true })
  fs.mkdirSync(AGENT, { recursive: true })
  // an "engine" that never ends on its own (plus a child, like an MCP bridge, that must go with it)
  fs.writeFileSync(ENGINE, '#!/bin/sh\nsleep 120 &\necho "child $!"\nexec sleep 120\n', { mode: 0o755 })
  sock = fs.mkdtempSync('/tmp/mycel-p1l-') + '/l.sock'
  launcher = Bun.spawn([path.join(nativeBinDir(), 'mycel-launcher'), '--listen', sock, '--agent-root', AGENT, '--bridge', '/nonexistent/bridge',
    '--tools-sock', path.join(W, 'tools.sock'), '--allow-cmd', ENGINE], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
  const r = launcher.stdout.getReader()
  const { value } = await r.read()
  expect(new TextDecoder().decode(value)).toContain('ready')
  r.releaseLock()
})
afterAll(() => { launcher?.kill(); fs.rmSync(path.dirname(sock), { recursive: true, force: true }) })

/** start a turn; resolves with the socket, the engine pid and its child's pid */
function start(chat: string): Promise<{ c: net.Socket; pid: number; child: number }> {
  return new Promise((res, rej) => {
    const c = net.createConnection(sock)
    let buf = ''
    let pid = 0
    c.setEncoding('utf8')
    c.on('connect', () => c.write(JSON.stringify({ op: 'run', turnId: 't-' + chat, chatDir: path.join(AGENT, chat), cmd: ENGINE, args: [], env: {}, token: 'x', systemPrompt: '', stdin: '', timeoutMs: 600_000 }) + '\n'))
    c.on('data', (d: string) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        if (ev.ev === 'started') pid = ev.pid
        else if (ev.ev === 'stdout') {
          const m = /child (\d+)/.exec(Buffer.from(ev.b64, 'base64').toString())
          if (m && pid) res({ c, pid, child: Number(m[1]) })
        } else if (ev.ev === 'error') rej(new Error(ev.message))
      }
    })
    c.on('error', rej)
  })
}

describe('mycel-launcher', () => {
  test('keeps the engine running while the server stays connected', async () => {
    const t = await start('chat-a')
    await Bun.sleep(400)
    expect(alive(t.pid)).toBe(true)
    t.c.write(JSON.stringify({ op: 'kill' }) + '\n')
    expect(await waitFor(() => !alive(t.pid) && !alive(t.child), { timeoutMs: 8000 })).toBe(true)
    t.c.destroy()
  })

  test('stops the engine and its process group when the server connection closes', async () => {
    const t = await start('chat-b')
    expect(alive(t.pid)).toBe(true)
    expect(alive(t.child)).toBe(true)
    t.c.destroy() // what a crashed server looks like from the launcher
    expect(await waitFor(() => !alive(t.pid) && !alive(t.child), { timeoutMs: 8000 })).toBe(true)
  })
})
