// Start / talk to the native helpers (native/): gate (peer credentials) and launcher (runs engine turns).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import type { Subprocess } from 'bun'
import type { LaunchEvent, LaunchRequest } from '@mycel/shared'
import { connectUnix } from './system/sockets'

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
  // --exit-with-parent: stdin stays open (we never end it); when this process dies, even by kill -9, the pipe closes
  // and the helper exits instead of staying behind as an orphan
  const p = Bun.spawn([path.join(bin, 'mycel-gate'), '--listen', listen, '--upstream', upstream, '--mode', mode, '--exit-with-parent'],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env: {} })
  p.stdin.write(secret + '\n'); p.stdin.flush()
  await waitReady(p, 'gate')
  return p
}

/** macOS: run every engine turn under sandbox-exec with this profile (scripts/macos/engine.sb). localLogin opens the
 * account's own CLI login files and direct HTTPS (dev: the engine runs as the owner with the owner's login). */
export interface LauncherSandbox { profile: string; localLogin: boolean; proxyPort?: number }

/** Stage 1 convenience: start the launcher as the current user. Production: LaunchDaemon as _axagent (stage 3). */
export async function startLauncher(bin: string, o: { listen: string; agentRoot: string; toolsSock: string; allowCmds: string[]; sessionRoots?: string[]; sandbox?: LauncherSandbox; codexAuthDir?: string; proxyPort?: number }) {
  const args = [path.join(bin, 'mycel-launcher'), '--listen', o.listen, '--agent-root', o.agentRoot, '--bridge', path.join(bin, 'mycel-bridge'), '--tools-sock', o.toolsSock, '--exit-with-parent']
  for (const c of o.allowCmds) args.push('--allow-cmd', c)
  for (const s of o.sessionRoots ?? []) args.push('--session-root', s)
  if (o.sandbox) {
    args.push('--sandbox-profile', o.sandbox.profile, '--proxy-port', String(o.sandbox.proxyPort ?? o.proxyPort ?? 0))
    if (o.sandbox.localLogin) args.push('--local-login')
  } else if (o.proxyPort) args.push('--proxy-port', String(o.proxyPort))
  if (o.codexAuthDir) args.push('--codex-auth-dir', o.codexAuthDir)
  fs.mkdirSync(o.agentRoot, { recursive: true, mode: 0o700 })
  // stdin is a pipe we keep open (see startGate): the launcher stops its turns and exits when it closes. Engines get
  // only the environment of their launch request, never the launcher's.
  const p = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env: { HOME: os.homedir() } })
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
  /** Which engine process owns this loopback TCP connection? Asked of the launcher because only the engine
   * account can see its own processes (the server uid gets EPERM). */
  tcpPeer(clientPort: number, serverPort: number): Promise<{ pid: number; pgid: number; sid: number } | null> {
    return new Promise((res) => {
      // connectUnix: a failed connect must not become an uncaught exception (launcher daemon down, see system/sockets.ts)
      connectUnix(this.sock, (c) => {
        let b = ""
        c.setEncoding("utf8")
        c.on("connect", () => c.write(JSON.stringify({ op: "tcp-peer", clientPort, serverPort }) + "\n"))
        c.on("data", (d: string) => { b += d })
        c.on("close", () => { try { const j = JSON.parse(b.split("\n")[0]); res(j.ev === "peer" ? { pid: j.pid, pgid: j.pgid, sid: j.sid } : null) } catch { res(null) } })
        c.on("error", () => res(null))
      })
    })
  }
  launch(req: LaunchRequest): LaunchHandle {
    const queue: LaunchEvent[] = []
    let wake: (() => void) | null = null
    let ended = false
    let killed = false
    let buf = ''
    let c: net.Socket | null = null
    const end = () => { ended = true; wake?.() }
    const killLine = JSON.stringify({ op: 'kill' }) + '\n'
    // on the next macrotask: with the launcher daemon down, a connect started inside the request that sends a chat
    // message was an uncaught exception in Bun and ended the server (system/sockets.ts connectUnix)
    connectUnix(this.sock, (s) => {
      c = s
      s.setEncoding('utf8')
      s.on('data', (d: string) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) try { queue.push(JSON.parse(l)) } catch {} }
        wake?.()
      })
      s.on('close', end); s.on('error', (e) => { queue.push({ ev: 'error', message: 'launcher: ' + e.message }); end() })
      s.write(JSON.stringify(req) + '\n')
      if (killed) s.write(killLine)
    })
    return {
      kill: () => { if (!c) { killed = true; return } try { c.write(killLine) } catch {} },
      events: {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (queue.length) { const e = queue.shift()!; yield e; if (e.ev === 'exit' || e.ev === 'error') { (c as net.Socket | null)?.end(); return } continue }
            if (ended) return
            await new Promise<void>((r) => (wake = r)); wake = null
          }
        },
      },
    }
  }
}

// ---------------- the engine account's Codex login (launcher codex-status / codex-logout / codex-login) ----------------
export interface CodexLoginState { loggedIn: boolean; accountId?: string; lastRefresh?: string; problem?: string }

/** One request, the reply lines until the connection closes (or `until` says stop). */
function exchange(sock: string, req: unknown, onEvent: (e: any) => boolean | void, timeoutMs = 15_000): Promise<{ events: any[] }> {
  return new Promise((res) => {
    const c = net.createConnection(sock)
    const events: any[] = []
    let b = ''
    const t = setTimeout(() => c.destroy(), timeoutMs)
    c.setEncoding('utf8')
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'))
    c.on('data', (d: string) => {
      b += d
      let i
      while ((i = b.indexOf('\n')) >= 0) {
        const l = b.slice(0, i); b = b.slice(i + 1)
        try { const e = JSON.parse(l); events.push(e); if (onEvent(e) === true) c.end() } catch {}
      }
    })
    c.on('close', () => { clearTimeout(t); res({ events }) })
    c.on('error', () => {})
  })
}

/** Ask the launcher about the engine account's Codex login (never returns a token). null = launcher unreachable
 * or no Codex login folder configured. */
export async function codexLoginState(sock: string): Promise<CodexLoginState | null> {
  const { events } = await exchange(sock, { op: 'codex-status' }, (e) => e.ev === 'codex_state' || e.ev === 'error')
  const e = events.find((x) => x.ev === 'codex_state')
  return e ? { loggedIn: !!e.loggedIn, ...(e.accountId ? { accountId: String(e.accountId) } : {}), ...(e.lastRefresh ? { lastRefresh: String(e.lastRefresh) } : {}), ...(e.problem ? { problem: String(e.problem) } : {}) } : null
}

export async function codexLogout(sock: string): Promise<{ ok: boolean; message?: string }> {
  const { events } = await exchange(sock, { op: 'codex-logout' }, (e) => e.ev === 'logout_done' || e.ev === 'error')
  const e = events.find((x) => x.ev === 'logout_done' || x.ev === 'error')
  return e?.ev === 'logout_done' ? { ok: !!e.ok, ...(e.message ? { message: e.message } : {}) } : { ok: false, message: e?.message ?? 'launcher unreachable' }
}

/** `codex login --device-auth` as the engine account. Events: started{pid} (bind the proxy token to it now),
 * stdout/stderr text, then exit{code} or error{message}. */
export function codexDeviceLogin(sock: string, o: { cmd: string; proxy: string; timeoutMs?: number }, on: { started?(pid: number): void; output?(text: string): void }): Promise<{ code: number | null; message?: string }> {
  return new Promise((res) => {
    const c = net.createConnection(sock)
    let b = ''
    let result: { code: number | null; message?: string } | null = null
    c.setEncoding('utf8')
    c.on('connect', () => c.write(JSON.stringify({ op: 'codex-login', cmd: o.cmd, proxy: o.proxy, timeoutMs: o.timeoutMs ?? 0 }) + '\n'))
    c.on('data', (d: string) => {
      b += d
      let i
      while ((i = b.indexOf('\n')) >= 0) {
        const l = b.slice(0, i); b = b.slice(i + 1)
        let e: any
        try { e = JSON.parse(l) } catch { continue }
        if (e.ev === 'started') on.started?.(e.pid)
        else if (e.ev === 'stdout' || e.ev === 'stderr') on.output?.(Buffer.from(e.b64, 'base64').toString('utf8'))
        else if (e.ev === 'exit') { result = { code: e.code, ...(e.signal ? { message: e.signal } : {}) }; c.end() }
        else if (e.ev === 'error') { result = { code: null, message: e.message }; c.end() }
      }
    })
    c.on('close', () => res(result ?? { code: null, message: 'launcher closed the connection' }))
    c.on('error', (e) => { result ??= { code: null, message: 'launcher: ' + e.message } })
  })
}

export const randomSecret = () => crypto.randomBytes(32).toString('hex')
