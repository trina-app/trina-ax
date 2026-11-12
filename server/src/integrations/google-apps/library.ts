// The Google Workspace MCP library (github.com/taylorwilsdon/google_workspace_mcp, pinned in scripts/system/packages.json
// "python") as a child process of this server: started while some Google app is set up, on 127.0.0.1 and a free port
// this server picked, stopped on close (docs/GOOGLE-APPS-RUNTIME.md). It keeps nothing: every call brings the person's
// Google access token (transport.ts), the library checks it with Google and calls the API. Linux servers only in this
// version; the Mac app has no venv ('unsupported').
//
// Like the meaning indexer's child (knowledge-graph/meaning/indexer.ts): a short environment with none of this
// server's secrets, ready when it answers, restarted with a growing pause when it ends or stops answering. Not below
// people's work (no backgroundPrefix): a person waits for each of its answers.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AppContext } from '../../context'
import type { Logger } from '../../log'

export type LibraryState = 'unsupported' | 'off' | 'starting' | 'ready' | 'down'
export interface WorkspaceLibrary {
  state(): LibraryState
  /** start it (with this Google OAuth client id, any configured one) while some Google app is set up; null stops it */
  want(clientId: string | null): void
  /** the MCP address while ready: http://127.0.0.1:<port>/mcp, else null */
  endpoint(): string | null
  /** resolves true once ready (or false after ms) */
  whenReady(ms: number): Promise<boolean>
  close(): Promise<void>
}

/** where packages.sh pk_python_install puts it (/opt/trina/python/<name>/current/bin/<program>) */
export const LIBRARY_BIN = '/opt/trina/python/workspace-mcp/current/bin/workspace-mcp'
/** the four apps, every tool of them, minus the two comment tools that need full Drive access (owner decision 7) */
export const LIBRARY_ARGS = ['--transport', 'streamable-http', '--tools', 'gmail', 'calendar', 'docs', 'sheets', '--tool-tier', 'complete',
  '--disabled-tools', 'manage_document_comment', 'manage_spreadsheet_comment'] as const
/** what it may see of this server's environment: no secret of the server's, only what reaching Google needs */
export const LIBRARY_CHILD_ENV = ['PATH', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const
/** tests and development: an address that stands for the library (a fake MCP server); only http://127.0.0.1:<port>/mcp */
export const URL_ENV = 'MYCEL_GOOGLE_APPS_LIBRARY_URL'
/** development: the program, when it is not at LIBRARY_BIN (a venv of one's own; any system) */
export const BIN_ENV = 'MYCEL_GOOGLE_APPS_LIBRARY_BIN'

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

export interface LibraryOptions {
  log: Logger
  /** this server's environment (the overrides, and what LIBRARY_CHILD_ENV passes on) */
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  /** tests: the command that stands for the program (a small bun script); LIBRARY_ARGS follow it */
  command?: string[]
  /** where the per-start private folders go (default: the system's temp folder) */
  tmpRoot?: string
  /** how long a start may take to answer (Python loads ~90 modules; slow disks) */
  readyMs?: number
  /** how often a ready library is asked whether it is well, and how many missed answers in a row make it down */
  healthMs?: number
  healthMisses?: number
  /** the pause before a restart: firstBackoffMs, doubled after each failure in a row, at most maxBackoffMs */
  firstBackoffMs?: number
  maxBackoffMs?: number
}

/** the address the override names, when it is a loopback MCP address; else null */
export function overrideEndpoint(v: string | undefined): string | null {
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !/^\d+$/.test(u.port) || u.pathname !== '/mcp' || u.search || u.hash || u.username || u.password) return null
    return `http://127.0.0.1:${u.port}/mcp`
  } catch { return null }
}

/** a port nothing listens on now, on 127.0.0.1 */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = net.createServer()
    s.unref()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = a && typeof a === 'object' ? a.port : 0
      s.close(() => (port ? ok(port) : fail(new Error('no free port'))))
    })
  })
}

/** GET /health on 127.0.0.1 (node:http: no proxy of the environment); true when it says healthy */
export function healthy(port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((ok) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { if (body.length < 4096) body += c })
      res.on('end', () => {
        if (res.statusCode !== 200) return ok(false)
        try { ok((JSON.parse(body) as { status?: string }).status === 'healthy') } catch { ok(false) }
      })
      res.on('error', () => ok(false))
    })
    req.on('timeout', () => { req.destroy(); ok(false) })
    req.on('error', () => ok(false))
  })
}

/** a line of its output that may go to the log: no Google token, no bearer value */
export const redactLine = (s: string) => s.replace(/ya29\.[A-Za-z0-9._-]+/g, 'ya29.…').replace(/(bearer\s+)\S+/gi, '$1…').replace(/\s+/g, ' ').trim().slice(0, 300)

interface Child {
  proc: ReturnType<typeof Bun.spawn>
  port: number
  clientId: string
  dir: string
  tail: string
  /** set when this server stops it (not a failure) */
  stopping: boolean
}

class Library implements WorkspaceLibrary {
  private o: Required<Omit<LibraryOptions, 'command' | 'tmpRoot' | 'platform' | 'env'>> & { command: string[] | null; tmpRoot: string; platform: NodeJS.Platform; env: Record<string, string | undefined> }
  private override: string | null
  private wanted: string | null = null
  private child: Child | null = null
  private ready = false
  private failures = 0
  private lastFailure: string | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private health: ReturnType<typeof setInterval> | null = null
  private misses = 0
  private closed = false
  private waiters = new Set<() => void>()
  /** a start in progress (port, folders, spawn), so two want() calls never start two */
  private starting: Promise<void> | null = null
  private again = false

  constructor(o: LibraryOptions) {
    const env = o.env ?? process.env
    this.o = {
      readyMs: 120_000, healthMs: 15_000, healthMisses: 3, firstBackoffMs: 2_000, maxBackoffMs: 5 * 60_000,
      ...o, env, command: o.command ?? null, tmpRoot: o.tmpRoot ?? os.tmpdir(), platform: o.platform ?? process.platform,
    }
    this.override = overrideEndpoint(env[URL_ENV])
    if (env[URL_ENV] && !this.override) o.log.warn('google apps library: the address override is not http://127.0.0.1:<port>/mcp; ignored', { env: URL_ENV })
  }

  /** the program to run, or null when this system has none */
  private program(): string[] | null {
    if (this.o.command) return this.o.command
    const own = this.o.env[BIN_ENV]
    const bin = own || (this.o.platform === 'linux' ? LIBRARY_BIN : null)
    if (!bin) return null
    try { fs.accessSync(bin, fs.constants.X_OK) } catch { return null }
    return [bin]
  }

  state(): LibraryState {
    if (this.override) return 'ready'
    if (this.ready && this.child) return 'ready'
    if (!this.program()) return 'unsupported'
    if (!this.wanted || this.closed) return 'off'
    // starting after a failure, or waiting for the next try: down
    return this.failures || this.retry ? 'down' : 'starting'
  }

  endpoint(): string | null {
    if (this.override) return this.override
    return this.ready && this.child ? `http://127.0.0.1:${this.child.port}/mcp` : null
  }

  want(clientId: string | null) {
    if (this.closed || this.override) return
    if (clientId !== null && !CLIENT_ID.test(clientId)) {
      this.o.log.warn('google apps library: not a Google client id; not started')
      clientId = null
    }
    // the same id: nothing to do while it runs, starts or waits for its restart
    if (clientId === this.wanted && (!clientId || this.child || this.starting || this.retry)) return
    this.wanted = clientId
    this.failures = 0
    this.clearRetry()
    if (this.child && this.child.clientId !== clientId) void this.stopChild(this.child)
    if (clientId && !this.child && this.program()) this.start()
    this.notify()
  }

  whenReady(ms: number): Promise<boolean> {
    if (this.endpoint()) return Promise.resolve(true)
    if (this.closed || this.state() === 'unsupported') return Promise.resolve(false)
    return new Promise((ok) => {
      const end = () => { clearTimeout(t); this.waiters.delete(check); ok(!!this.endpoint()) }
      // told of every change: ends when ready, or when it will not become ready (closed, stopped)
      const check = () => { if (this.endpoint() || this.closed || !this.wanted) end() }
      const t = setTimeout(end, Math.max(0, ms))
      this.waiters.add(check)
    })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.wanted = null
    this.clearRetry()
    this.notify()
    if (this.starting) await this.starting.catch(() => {})
    if (this.child) await this.stopChild(this.child)
  }

  private notify() { for (const w of [...this.waiters]) w() }
  private clearRetry() { if (this.retry) { clearTimeout(this.retry); this.retry = null } }

  private start() {
    if (this.closed || !this.wanted) return
    // a start for another id still runs: this one follows it
    if (this.starting) { this.again = true; return }
    const clientId = this.wanted
    this.starting = this.spawn(clientId).catch((e) => this.failed(null, `could not start: ${String((e as Error)?.message ?? e).slice(0, 200)}`)).finally(() => {
      this.starting = null
      if (this.again) { this.again = false; if (!this.child && !this.retry) this.start() }
    })
  }

  private async spawn(clientId: string) {
    const program = this.program()
    if (!program) { this.o.log.info('google apps library: not on this system (no venv); Gmail, Calendar, Docs and Sheets stay off'); return }
    const port = await freePort()
    if (this.closed || this.wanted !== clientId) return
    // a private folder per start: its HOME (the library writes there) and the folder attachments would go to (empty;
    // nothing saves there with stateless mode). Removed when the process ends.
    const dir = fs.mkdtempSync(path.join(this.o.tmpRoot, 'trina-google-apps-'))
    fs.chmodSync(dir, 0o700)
    for (const d of ['home', 'attachments']) fs.mkdirSync(path.join(dir, d), { mode: 0o700 })
    const env = libraryEnv({ parent: this.o.env, port, clientId, dir })
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([...program, ...LIBRARY_ARGS], { cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw e
    }
    const c: Child = { proc, port, clientId, dir, tail: '', stopping: false }
    this.child = c
    this.ready = false
    if (this.closed || this.wanted !== clientId) { await this.stopChild(c); return }
    const t0 = Date.now()
    for (const s of [proc.stdout, proc.stderr]) {
      void (async () => {
        const dec = new TextDecoder()
        try { for await (const chunk of s as ReadableStream<Uint8Array>) c.tail = (c.tail + dec.decode(chunk, { stream: true })).slice(-4000) } catch { /* ended */ }
      })()
    }
    void proc.exited.then((code) => this.ended(c, code))
    // ready when /health answers
    while (!c.stopping && this.child === c && this.wanted === clientId && proc.exitCode === null && Date.now() - t0 < this.o.readyMs) {
      if (await healthy(port, 1_000)) {
        if (c.stopping || this.child !== c) return
        this.ready = true
        this.failures = 0
        this.misses = 0
        this.o.log.info('google apps library ready', { port, ms: Date.now() - t0, after: this.lastFailure ?? undefined })
        this.lastFailure = null
        this.watch(c)
        this.notify()
        return
      }
      await Bun.sleep(250)
    }
    if (!c.stopping && this.child === c && proc.exitCode === null) {
      void this.stopChild(c)
      this.failed(c, `no answer in ${Math.round(this.o.readyMs / 1000)} s`)
    }
  }

  /** while ready: /health every healthMs; healthMisses missed answers in a row make it down (restarted) */
  private watch(c: Child) {
    if (this.health) clearInterval(this.health)
    this.health = setInterval(() => {
      if (this.child !== c || c.stopping) return
      void healthy(c.port).then((ok) => {
        if (this.child !== c || c.stopping) return
        if (ok) { this.misses = 0; return }
        if (++this.misses < this.o.healthMisses) return
        void this.stopChild(c)
        this.failed(c, `${this.misses} health checks missed`)
      })
    }, this.o.healthMs)
    ;(this.health as { unref?: () => void }).unref?.()
  }

  private ended(c: Child, code: number | null) {
    fs.rmSync(c.dir, { recursive: true, force: true })
    if (this.child === c) {
      this.child = null
      this.ready = false
      if (this.health) { clearInterval(this.health); this.health = null }
    }
    if (!c.stopping) this.failed(c, `ended (${code === null ? 'killed' : `exit ${code}`})`)
    this.notify()
  }

  /** a failure: logged with its last line of output, and a restart after a pause that grows with each one in a row */
  private failed(c: Child | null, why: string) {
    if (c && this.child === c) { this.child = null; this.ready = false }
    if (this.closed || !this.wanted || (c && c.clientId !== this.wanted)) return
    this.failures++
    const last = c?.tail.trim().split('\n').filter(Boolean).pop()
    const pause = Math.min(this.o.maxBackoffMs, this.o.firstBackoffMs * 2 ** Math.min(this.failures - 1, 20))
    this.lastFailure = why
    this.o.log.warn('google apps library down; starting it again', { why, last: last ? redactLine(last) : undefined, failures: this.failures, retryInMs: pause })
    this.clearRetry()
    this.retry = setTimeout(() => { this.retry = null; if (!this.child) this.start() }, pause)
    ;(this.retry as { unref?: () => void }).unref?.()
    this.notify()
  }

  private async stopChild(c: Child) {
    c.stopping = true
    if (this.child === c) {
      this.child = null
      this.ready = false
      if (this.health) { clearInterval(this.health); this.health = null }
    }
    if (c.proc.exitCode === null && c.proc.signalCode === null) {
      try { c.proc.kill('SIGTERM') } catch { /* gone */ }
      const t = setTimeout(() => { try { c.proc.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
      ;(t as { unref?: () => void }).unref?.()
      await c.proc.exited.catch(() => {})
      clearTimeout(t)
    }
    fs.rmSync(c.dir, { recursive: true, force: true })
  }
}

/** The library's environment: the allowed few of this server's, and its own settings. No token cache (a revoked Google
 * sign-in stops working at once), no telemetry, no client secret: Google tokens come from this server on each call. */
export function libraryEnv(o: { parent: Record<string, string | undefined>; port: number; clientId: string; dir: string }): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of LIBRARY_CHILD_ENV) if (o.parent[k]) env[k] = o.parent[k]!
  env.PATH ||= '/usr/bin:/bin'
  env.LANG ||= 'C.UTF-8'
  return {
    ...env,
    HOME: path.join(o.dir, 'home'),
    TMPDIR: path.join(o.dir, 'home'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    NO_COLOR: '1',
    WORKSPACE_MCP_HOST: '127.0.0.1',
    PORT: String(o.port),
    WORKSPACE_MCP_BASE_URI: 'http://127.0.0.1',
    MCP_ENABLE_OAUTH21: 'true',
    EXTERNAL_OAUTH21_PROVIDER: 'true',
    WORKSPACE_MCP_STATELESS_MODE: 'true',
    WORKSPACE_MCP_DISABLE_LOCAL_FILES: 'true',
    WORKSPACE_ATTACHMENT_DIR: path.join(o.dir, 'attachments'),
    WORKSPACE_MCP_TOKEN_VALIDATION_WORKERS: '8',
    WORKSPACE_MCP_LOG_LEVEL: 'WARNING',
    GOOGLE_OAUTH_CLIENT_ID: o.clientId,
    // with no client secret the library signs its own (unused) proxy tokens with this; a new one per start
    FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY: crypto.randomBytes(32).toString('base64url'),
  }
}

/** A library for tests and other hosts (the server uses workspaceLibraryOf). */
export function createWorkspaceLibrary(o: LibraryOptions): WorkspaceLibrary {
  return new Library(o)
}

const instances = new WeakMap<AppContext, WorkspaceLibrary>()
/** This server's library: one per context, stopped when the server closes. */
export function workspaceLibraryOf(ctx: AppContext): WorkspaceLibrary {
  let lib = instances.get(ctx)
  if (!lib) {
    lib = createWorkspaceLibrary({ log: ctx.log.child({ part: 'google-apps-library' }) })
    instances.set(ctx, lib)
    const l = lib
    ctx.onClose(() => l.close())
  }
  return lib
}
