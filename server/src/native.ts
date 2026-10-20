// Start / talk to the native helpers (native/): gate (peer credentials) and launcher (runs engine turns).
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import type { Subprocess } from 'bun'
import type { LaunchEvent, LaunchRequest } from '@mycel/shared'

async function waitReady(p: Subprocess<any, 'pipe', any>, what: string, ms = 5000) {
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader()
  const t = setTimeout(() => p.kill(), ms)
  let s = ''
  while (!s.includes('ready')) {
    const { value, done } = await reader.read()
    if (done) { clearTimeout(t); throw new Error(`${what} did not start: exit ${await p.exited}`) }
    s += new TextDecoder().decode(value)
  }
  clearTimeout(t)
  reader.releaseLock()
}

export async function startGate(bin: string, listen: string, upstream: string, secret: string, mode = '0600') {
  const p = Bun.spawn([path.join(bin, 'mycel-gate'), '--listen', listen, '--upstream', upstream, '--mode', mode],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env: {} })
  p.stdin.write(secret + '\n'); p.stdin.flush()
  await waitReady(p, 'gate')
  return p
}

/** Stage 1 convenience: start the launcher as the current user. Production: LaunchDaemon as _axagent (stage 3). */
export async function startLauncher(bin: string, o: { listen: string; agentRoot: string; toolsSock: string; allowCmds: string[]; sessionRoots?: string[] }) {
  const args = [path.join(bin, 'mycel-launcher'), '--listen', o.listen, '--agent-root', o.agentRoot, '--bridge', path.join(bin, 'mycel-bridge'), '--tools-sock', o.toolsSock]
  for (const c of o.allowCmds) args.push('--allow-cmd', c)
  for (const s of o.sessionRoots ?? []) args.push('--session-root', s)
  fs.mkdirSync(o.agentRoot, { recursive: true, mode: 0o700 })
  const p = Bun.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env: {} })
  await waitReady(p, 'launcher')
  return p
}

/** The boundary between the server and whatever runs engines as the engine account. */
export interface Launcher {
  launch(req: LaunchRequest): LaunchHandle
}
export interface LaunchHandle {
  events: AsyncIterable<LaunchEvent>
  kill(): void
}

export class SocketLauncher implements Launcher {
  constructor(private sock: string) {}
  launch(req: LaunchRequest): LaunchHandle {
    const c = net.createConnection(this.sock)
    c.write(JSON.stringify(req) + '\n')
    const queue: LaunchEvent[] = []
    let wake: (() => void) | null = null
    let ended = false
    let buf = ''
    c.setEncoding('utf8')
    c.on('data', (d: string) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) try { queue.push(JSON.parse(l)) } catch {} }
      wake?.()
    })
    const end = () => { ended = true; wake?.() }
    c.on('close', end); c.on('error', (e) => { queue.push({ ev: 'error', message: 'launcher: ' + e.message }); end() })
    return {
      kill: () => { try { c.write(JSON.stringify({ op: 'kill' }) + '\n') } catch {} },
      events: {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (queue.length) { const e = queue.shift()!; yield e; if (e.ev === 'exit' || e.ev === 'error') { c.end(); return } continue }
            if (ended) return
            await new Promise<void>((r) => (wake = r)); wake = null
          }
        },
      },
    }
  }
}

export const randomSecret = () => crypto.randomBytes(32).toString('hex')
