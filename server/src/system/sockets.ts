// Unix sockets the engine core needs, checked before they are used (component G).
//
// A Unix socket address holds at most 104 bytes on macOS (sockaddr_un.sun_path, 108 on Linux) including the final
// NUL, so a path of 104 bytes or more cannot be bound or connected to. A data folder with a long path (or one deep
// under /private/tmp) used to fail only inside the native gate ("bind: invalid argument", "gate did not start: exit
// 1") and every chat ended with "The AI engine stopped unexpectedly". The server now says which socket is too long,
// at start, in Diagnostics and when a chat tries to start the engine.
//
// probeSocket() is how Diagnostics asks whether the launcher answers. It never throws. Bun 1.3.12 has a trap here:
// a node:net connect to a Unix socket that fails (no file, or a file left by a process that ended) while still in
// the microtask chain of a Bun.serve request handler is thrown as an uncaught exception instead of being emitted
// as 'error' on the socket (the listener never runs). That ended the production server whenever Diagnostics was
// opened while the launcher daemon was down (install-guide check, 2026-10-21). From a fresh macrotask
// (setImmediate) the same failure is an ordinary 'error' event, so every Unix-socket client connect of the server
// starts there (see connectUnix; native.ts SocketLauncher does the same).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/** sun_path size including the final NUL: 104 on macOS (and the BSDs), 108 on Linux. */
export function sunPathSize(platform: NodeJS.Platform = process.platform): number {
  return platform === 'linux' ? 108 : 104
}
/** The longest socket path in bytes that still fits (one byte goes to the NUL). */
export const maxSocketPathBytes = (platform: NodeJS.Platform = process.platform) => sunPathSize(platform) - 1

export interface SocketPath { name: 'tools' | 'server' | 'launcher'; path: string }
export interface SocketPathProblem extends SocketPath { bytes: number; max: number }

/** The sockets the engine core binds or connects to, for a run folder and (production) the launcher socket. */
export function engineSockets(runDir: string, launcherSock?: string | null): SocketPath[] {
  return [
    { name: 'tools', path: path.join(runDir, 'tools.sock') },
    { name: 'server', path: path.join(runDir, 'private', 'server.sock') },
    { name: 'launcher', path: launcherSock ?? path.join(runDir, 'private', 'launcher.sock') },
  ]
}

/** Socket paths that do not fit in a Unix socket address on this platform. */
export function tooLongSockets(socks: SocketPath[], platform: NodeJS.Platform = process.platform): SocketPathProblem[] {
  const max = maxSocketPathBytes(platform)
  return socks.map((s) => ({ ...s, bytes: Buffer.byteLength(s.path), max })).filter((s) => s.bytes > max)
}

/** One line for logs and errors: which socket, how long, what to do. */
export function socketPathMessage(p: SocketPathProblem[], dev: boolean): string {
  const first = p[0]!
  const list = p.map((x) => `${x.path} (${x.bytes} bytes)`).join(', ')
  const fix = dev
    ? 'Move the data folder to a shorter path, e.g. the default ~/.team-ax-dev (TEAM_AX_DEV_DIR / MYCEL_DATA_DIR)'
    : 'Move the installation\'s run folder to a shorter path (engine.runDir / engine.launcherSock in config/server.json)'
  return `socket path too long: ${list}; a Unix socket path can be at most ${first.max} bytes on this system, so the AI engine cannot start. ${fix}.`
}

/**
 * Is `p` under a temporary folder the macOS engine sandbox refuses (scripts/macos/engine.sb denies /tmp,
 * /private/tmp, /var/tmp, /private/var/tmp and /private/var/folders)? Engine turns there fail even when the
 * socket paths fit.
 */
export function underSandboxDeniedTmp(p: string): boolean {
  const abs = path.resolve(p)
  return ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/private/var/folders', '/var/folders'].some((d) => abs === d || abs.startsWith(d + '/'))
}

export type SocketProbe = 'ok' | 'missing' | 'refused' | 'denied' | 'too_long' | 'not_socket' | 'timeout' | 'error'

/**
 * net.createConnection(path) on the next macrotask, with its 'error' listener attached before it can fire (see the
 * header: a failed connect inside a request handler's microtasks is otherwise an uncaught exception in Bun).
 */
export function connectUnix(p: string, setup: (c: net.Socket) => void): void {
  setImmediate(() => {
    const c = net.createConnection(p)
    setup(c)
  })
}

/**
 * Does something accept connections on this Unix socket? Never throws. 'missing' when there is no socket file (the
 * daemon that makes it is not running), 'refused' when the file is left over from a daemon that ended.
 */
export function probeSocket(p: string, timeoutMs = 2000): Promise<SocketProbe> {
  if (Buffer.byteLength(p) > maxSocketPathBytes()) return Promise.resolve('too_long')
  try {
    const st = fs.statSync(p)
    if (!st.isSocket()) return Promise.resolve('not_socket')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return Promise.resolve(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'error')
  }
  return new Promise((resolve) => {
    let done = false
    let c: net.Socket | null = null
    const finish = (r: SocketProbe) => {
      if (done) return
      done = true
      clearTimeout(t)
      try { c?.destroy() } catch {}
      resolve(r)
    }
    const t = setTimeout(() => finish('timeout'), timeoutMs)
    try {
      connectUnix(p, (sock) => {
        c = sock
        // the file was there a moment ago: ENOENT / ECONNREFUSED now mean nobody listens on it (Bun reports a
        // refused Unix-socket connect as ENOENT)
        sock.on('error', (e: NodeJS.ErrnoException) => finish(
          e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? (fs.existsSync(p) ? 'refused' : 'missing') : e.code === 'EACCES' || e.code === 'EPERM' ? 'denied' : 'error',
        ))
        sock.once('connect', () => finish('ok'))
        if (done) sock.destroy()
      })
    } catch {
      finish('error')
    }
  })
}
