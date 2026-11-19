// Apps on the person's own computer as connectors (docs/decisions/20261118-local-app-connectors.md): the desktop app's
// side. The team server sends one JSON-RPC message at a time (local.call, shared/src/api/local-apps.ts) through the
// team page of the window that sent the turn; this manager runs it against the program on this computer and gives the
// program's answer back (local.result). No Electron here (main/local-apps.ts wires it to the app's dialog and its
// safeStorage), so tests run it with a fake program.
//
// Adapters:
//   'mcp'  the program is an MCP server over stdio (`aside mcp`): messages pass through as newline-delimited JSON. One
//          process per connection, started on the first call; the server's initialize is answered from the first one
//          (a stdio server takes one initialize per process).
//   'cli'  a plain CLI declared as tools (ego lite): this manager answers as an MCP server itself; each tools/call runs
//          the program once, with the AI's slot values as arguments of their own or as stdin (cliArgv).
//
// The rules kept (the owner's lean set, 2026-11-19): the program starts from an argument list, never through a shell;
// it never starts while this app runs as root; it runs only after the person's yes in the app's own window (once per
// command: `confirm`), asked again only when the command changes (localCommandKey); setting values come from this
// computer (`settings`) and are hidden in everything sent back; Stop and quitting end it.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localCommandKey, localCommandLines, type LocalAppSpec, type LocalCall, type LocalCliTool, type LocalFailure, type LocalResult } from '@mycel/shared/api'
import { insideAppDir, withoutAppImage } from './linux'

/** the most one answer may be, in bytes: it goes back as one WebSocket frame, and the server's frames end at 16 MB
 * (Bun's maxPayloadLength); a larger one would close the window's socket and leave the call waiting */
export const LOCAL_MAX_ANSWER = 15 * 1024 * 1024
/** what is kept of the program's error output for the reason a start failed */
const STDERR_KEEP = 4000
/** a CLI tool's output kept for the AI, stdout and stderr together, in characters (the server cuts again): even with
 * every character escaped in JSON it stays under LOCAL_MAX_ANSWER */
export const CLI_OUTPUT_MAX = 2 * 1024 * 1024
/** a program that does not stop on SIGTERM is killed after this long */
const KILL_AFTER_MS = 2000
/** a value shorter than this is not hidden (it would replace ordinary words) */
const HIDE_MIN = 4
export const HIDDEN_VALUE = '[hidden]'

export interface LocalAppsDeps {
  /** The app's own window: "Connect this program?" with the exact command. true only on the person's yes there. */
  confirm(o: { team: string; name: string; lines: string[]; program: string }): Promise<boolean>
  /** what the person confirmed for a connection (the hash of its command), and that they did */
  confirmed(team: string, id: string): string | null
  setConfirmed(team: string, id: string, hash: string): void
  /** the setting values typed on this computer, by name (never sent to the team server) */
  settings(team: string, id: string): Record<string, string>
  /** tests: another way to start programs (the same argument list, never a shell) */
  spawn?: typeof nodeSpawn
  /** tests: the app runs as root */
  isRoot?: () => boolean
  /** tests: where a program named without a path is looked for (default: PATH and the usual places) */
  searchPath?: () => string[]
  /** a program started or stopped (Settings shows "Running") */
  onChange?: (team: string, id: string, running: boolean) => void
  now?: () => number
}

export const commandHash = (spec: LocalAppSpec) => crypto.createHash('sha256').update(localCommandKey(spec)).digest('hex')

/** where a program named without a path is looked for: PATH, then the places tools install themselves to (an app
 * started from the Dock gets a short PATH on macOS) */
export function defaultSearchPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform: string = process.platform): string[] {
  // Homebrew's own folder only on the Mac (Apple silicon); Linux also: Ubuntu's snap programs
  const extra = platform === 'win32' ? [] : [path.join(home, '.local', 'bin'), ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin', '/usr/bin', '/bin', ...(platform === 'linux' ? ['/snap/bin'] : [])]
  // never the AppImage's own mount (Linux): its programs are the app's, not the person's
  return [...new Set([...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extra])].filter((d) => !insideAppDir(d, env.APPDIR))
}

/** Setting values may be sealed: the system keeps a key for this app. On Linux without a Secret Service (GNOME Keyring,
 * KWallet) Electron falls back to `basic_text`, a key built into every Chromium: that is not sealed, so it counts as
 * unavailable (so does any backend that is not a known keyring) (the page says the settings were not kept). */
/** the Secret Service backends Electron reports on Linux (never basic_text or unknown) */
const LINUX_KEYRINGS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
export function sealable(platform: string, available: () => boolean, backend: () => string): boolean {
  if (!available()) return false
  if (platform !== 'linux') return true
  try { return LINUX_KEYRINGS.has(backend()) } catch { return false }
}

/** The program to start: a full path as it is (`~/` is the home folder), a bare name found in `dirs`. null: not found. */
export function resolveProgram(command: string, dirs: string[], home = os.homedir()): string | null {
  const c = command.startsWith('~/') ? path.join(home, command.slice(2)) : command
  const runnable = (p: string) => { try { const st = fs.statSync(p); return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0) } catch { return false } }
  if (c.includes('/') || c.includes('\\')) return path.isAbsolute(c) && runnable(c) ? c : null
  for (const d of dirs) {
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const p = path.join(d, c + ext)
      if (runnable(p)) return p
    }
  }
  return null
}

export class SlotError extends Error { name = 'SlotError' }

/** A CLI tool's argument list and stdin from the AI's values: each slot's value is one argument of its own (or stdin),
 * never joined into a command line and never read by a shell. A value that starts with "-" goes as it is: it is one
 * argument, and the person declared where it goes. Refused: a missing required slot, a value of the wrong type, a slot
 * the tool does not have, a NUL character. */
export function cliArgv(tool: LocalCliTool, input: unknown): { args: string[]; stdin: string | null } {
  const values = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  for (const k of Object.keys(values)) if (!tool.slots.some((s) => s.name === k)) throw new SlotError(`${tool.name} has no input named ${k}`)
  const text = (name: string): string | null => {
    const s = tool.slots.find((x) => x.name === name)!
    const v = values[name]
    if (v === undefined || v === null) { if (s.required) throw new SlotError(`${tool.name} needs ${name}`); return null }
    if (s.type === 'string' && typeof v !== 'string') throw new SlotError(`${name} must be text`)
    if (s.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) throw new SlotError(`${name} must be a number`)
    if (s.type === 'boolean' && typeof v !== 'boolean') throw new SlotError(`${name} must be true or false`)
    const out = String(v)
    if (out.includes('\0')) throw new SlotError(`${name} has a NUL character`)
    return out
  }
  const args: string[] = []
  for (const a of tool.args) {
    if (typeof a === 'string') { args.push(a); continue }
    const v = text(a.slot)
    if (v !== null) args.push(v)
  }
  return { args, stdin: tool.stdin ? text(tool.stdin) : null }
}

/** A declared CLI tool's run: what was kept of each stream, how many characters each wrote in all, its exit code. */
export interface CliRun { stdout: string; stderr: string; outChars: number; errChars: number; code: number }

/**
 * What the AI gets from a CLI run: stdout, then stderr, also on success (some CLIs print their whole result on stderr:
 * ego lite's `ego-browser nodejs` writes the script's console.log there and exits 0). Both together are at most `max`
 * characters, so the answer stays one WebSocket frame (LOCAL_MAX_ANSWER): stdout first, stderr cut to what stdout
 * leaves. A cut stream ends with a note that says so and how much is missing.
 */
export function cliOutputText(r: Pick<CliRun, 'stdout' | 'stderr' | 'outChars' | 'errChars'>, max = CLI_OUTPUT_MAX): string {
  const out = r.stdout.slice(0, max)
  const outAll = Math.max(r.outChars, r.stdout.length)
  const parts: string[] = []
  if (out) parts.push(out)
  if (outAll > out.length) parts.push(`[output cut: the program wrote ${outAll} characters, only the first ${out.length} are shown]`)
  const err = r.stderr.slice(0, Math.max(0, max - out.length))
  const errAll = Math.max(r.errChars, r.stderr.length)
  if (err) parts.push(err)
  if (errAll > err.length) parts.push(`[error output (stderr) cut: the program wrote ${errAll} characters there, only the first ${err.length} are shown]`)
  return parts.join('\n').trim() || '(no output)'
}

/** The tools/list a CLI's declared tools make: one input property per slot. */
export function cliTools(tools: LocalCliTool[]) {
  return tools.map((t) => ({
    name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(t.slots.map((s) => [s.name, { type: s.type, description: s.description }])),
      required: t.slots.filter((s) => s.required).map((s) => s.name),
      additionalProperties: false,
    },
    annotations: { readOnlyHint: t.readOnly },
  }))
}

/** Every setting value in `text` replaced (longest first), so none leaves the computer in an answer. */
export function hideValues(text: string, values: string[]): string {
  const vs = [...new Set(values.filter((v) => v.length >= HIDE_MIN))].sort((a, b) => b.length - a.length)
  let out = text
  for (const v of vs) {
    out = out.split(v).join(HIDDEN_VALUE)
    // the same value as JSON writes it inside a string (quotes, backslashes, line breaks escaped)
    const j = JSON.stringify(v).slice(1, -1)
    if (j !== v) out = out.split(j).join(HIDDEN_VALUE)
  }
  return out
}

/** The environment a program gets: this app's, without what belongs to Electron or to the AppImage the app runs from
 * (its variables, its mount in LD_LIBRARY_PATH and PATH: ./linux.ts), a PATH that finds the usual places, and the
 * person's setting values. */
export function envFor(values: Record<string, string>, dirs: string[], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(withoutAppImage(base))) if (!/^(ELECTRON_|MYCEL_DESKTOP_)/.test(k)) env[k] = v
  env.PATH = dirs.filter((d) => !insideAppDir(d, base.APPDIR)).join(path.delimiter)
  return { ...env, ...values }
}

interface Running {
  key: string
  child: ChildProcessWithoutNullStreams
  waiting: Map<string, (m: Record<string, unknown>) => void>
  /** the first initialize's answer, given to every later one */
  init: Record<string, unknown> | null
  initializing: Promise<Record<string, unknown>> | null
  initialized: boolean
  stderr: string
  exited: boolean
  onExit: Set<(why: string) => void>
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
/** what a program answered (null: nothing to answer, a notification), or why there is no answer */
type Answer = { message: Record<string, unknown> | null } | { failure: LocalFailure; error: string }

export class LocalApps {
  private running = new Map<string, Running>()
  private asking = new Map<string, Promise<boolean>>()
  /** a Cancel in a turn: the same command is not asked again in a turn (a check from Settings asks again) */
  private declined = new Set<string>()
  private calls = new Map<string, AbortController>()
  /** a connection's last initialize params: a program started again (Stop, new settings) under a client that already
   * initialized it is initialized with them before that client's next request */
  private initParams = new Map<string, unknown>()
  private spawn: typeof nodeSpawn
  constructor(private d: LocalAppsDeps) { this.spawn = d.spawn ?? nodeSpawn }

  private k(team: string, id: string) { return `${team}\u0000${id}` }

  /** Run one call. Never throws: a failure is a result the server puts into words. */
  async call(team: string, call: LocalCall): Promise<LocalResult> {
    const fail = (failure: LocalFailure, error: string): LocalResult => ({ callId: call.callId, ok: false, failure, error: this.hide(team, call.connectionId, error).slice(0, 4000) })
    const isRoot = this.d.isRoot ?? (() => typeof process.getuid === 'function' && process.getuid() === 0)
    if (isRoot()) return fail('root', 'the app runs as root')
    const ac = new AbortController()
    this.calls.set(call.callId, ac)
    try {
      const key = commandHash(call.spec)
      const ck = this.k(team, call.connectionId)
      if (this.d.confirmed(team, call.connectionId) !== key) {
        if (call.turnId && this.declined.has(`${ck}\u0000${key}`)) return fail('declined', 'Cancel was chosen on this computer')
        const yes = await this.ask(team, call, key)
        if (!yes) { this.declined.add(`${ck}\u0000${key}`); return fail('declined', 'Cancel was chosen on this computer') }
        this.declined.delete(`${ck}\u0000${key}`)
      }
      const answer = call.spec.adapter === 'mcp' ? await this.passMcp(team, call, key, ac.signal) : await this.answerCli(team, call, ac.signal)
      if ('failure' in answer) return fail(answer.failure, answer.error)
      if (answer.message === null) return { callId: call.callId, ok: true, message: null }
      const text = this.hide(team, call.connectionId, JSON.stringify(answer.message))
      if (Buffer.byteLength(text) > LOCAL_MAX_ANSWER) return fail('failed', 'the answer is too large')
      return { callId: call.callId, ok: true, message: JSON.parse(text) }
    } catch (e) {
      return fail('failed', e instanceof Error ? e.message : String(e))
    } finally { this.calls.delete(call.callId) }
  }

  /** local.cancel: the turn stopped. A running CLI tool is stopped; an MCP server is told (notifications/cancelled
   * comes from the server as its own message). */
  cancel(callId: string) { this.calls.get(callId)?.abort() }

  private hide(team: string, id: string, text: string) {
    try { return hideValues(text, Object.values(this.d.settings(team, id))) } catch { return text }
  }

  /** One confirm at a time per connection (a turn's calls wait for the same answer). */
  private ask(team: string, call: LocalCall, key: string): Promise<boolean> {
    const k = `${this.k(team, call.connectionId)}\u0000${key}`
    let p = this.asking.get(k)
    if (!p) {
      const dirs = (this.d.searchPath ?? defaultSearchPath)()
      const program = resolveProgram(call.spec.command, dirs) ?? call.spec.command
      p = this.d.confirm({ team, name: call.name, lines: localCommandLines(call.spec), program }).then((yes) => {
        if (yes) this.d.setConfirmed(team, call.connectionId, key)
        return yes
      }, () => false).finally(() => this.asking.delete(k))
      this.asking.set(k, p)
    }
    return p
  }

  // ---------------- adapter 'mcp': an MCP server over stdio ----------------
  private start(team: string, call: LocalCall, key: string): Running | { failure: LocalFailure; error: string } {
    const ck = this.k(team, call.connectionId)
    const cur = this.running.get(ck)
    if (cur && !cur.exited && cur.key === key) return cur
    if (cur) this.kill(cur)
    const spec = call.spec as Extract<LocalAppSpec, { adapter: 'mcp' }>
    const dirs = (this.d.searchPath ?? defaultSearchPath)()
    const program = resolveProgram(spec.command, dirs)
    if (!program) return { failure: 'start_failed', error: `${spec.command} was not found on this computer` }
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawn(program, spec.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: envFor(this.d.settings(team, call.connectionId), dirs), cwd: os.homedir(), detached: process.platform !== 'win32', windowsHide: true }) as ChildProcessWithoutNullStreams
    } catch (e) { return { failure: 'start_failed', error: e instanceof Error ? e.message : String(e) } }
    const r: Running = { key, child, waiting: new Map(), init: null, initializing: null, initialized: false, stderr: '', exited: false, onExit: new Set() }
    this.running.set(ck, r)
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > LOCAL_MAX_ANSWER * 2) { this.kill(r); return }
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) this.fromProgram(r, line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { r.stderr = (r.stderr + chunk).slice(-STDERR_KEEP) })
    const gone = (why: string) => {
      if (r.exited) return
      r.exited = true
      if (this.running.get(ck) === r) this.running.delete(ck)
      for (const f of r.onExit) f(why)
      this.d.onChange?.(team, call.connectionId, false)
    }
    child.on('error', (e) => gone(e.message))
    child.on('exit', (code, signal) => gone(`the program stopped (${signal ?? `exit ${code}`})${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`))
    child.stdin.on('error', () => {})
    this.d.onChange?.(team, call.connectionId, true)
    return r
  }

  /** A line from the program: an answer to a waiting request, or the program's own request (answered here: ping, and
   * "not offered" for anything else, such as sampling), or a notification (ignored). */
  private fromProgram(r: Running, line: string) {
    let m: Record<string, unknown>
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m !== 'object') return
    const id = m.id
    if (typeof m.method === 'string') {
      if (id === undefined || id === null) return
      const answer = m.method === 'ping' ? { jsonrpc: '2.0', id, result: {} } : m.method === 'roots/list' ? { jsonrpc: '2.0', id, result: { roots: [] } } : rpcError(id, -32601, 'not offered by this client')
      this.write(r, answer)
      return
    }
    if (typeof id === 'string' || typeof id === 'number') r.waiting.get(String(id))?.(m)
  }

  private write(r: Running, m: unknown) { if (!r.exited) r.child.stdin.write(JSON.stringify(m) + '\n') }

  private request(r: Running, m: Record<string, unknown>, deadline: number, signal: AbortSignal): Promise<Answer> {
    const id = String(m.id)
    return new Promise((resolve) => {
      const done = (v: Answer) => { clearTimeout(timer); r.waiting.delete(id); r.onExit.delete(onExit); signal.removeEventListener('abort', onAbort); resolve(v) }
      const onExit = (why: string) => done({ failure: 'failed', error: why })
      const onAbort = () => done({ failure: 'failed', error: 'stopped' })
      const timer = setTimeout(() => done({ failure: 'failed', error: 'the program did not answer in time' }), Math.max(1000, deadline - (this.d.now ?? Date.now)()))
      r.waiting.set(id, (answer) => done({ message: answer }))
      r.onExit.add(onExit)
      signal.addEventListener('abort', onAbort, { once: true })
      this.write(r, m)
    })
  }

  private async passMcp(team: string, call: LocalCall, key: string, signal: AbortSignal): Promise<Answer> {
    const m = call.message
    const started = this.start(team, call, key)
    if ('failure' in started) return started
    const r = started
    const method = typeof m.method === 'string' ? m.method : ''
    const isRequest = m.id !== undefined && m.id !== null
    const ck = this.k(team, call.connectionId)
    // one initialize per process: a later client gets the first answer under its own id
    const init = async (params: unknown): Promise<Answer | null> => {
      if (r.init) return null
      r.initializing ??= this.request(r, { jsonrpc: '2.0', id: `init-${crypto.randomUUID()}`, method: 'initialize', params }, call.deadline, signal).then((a) => {
        if ('failure' in a) throw new Error(a.error)
        const result = a.message?.result
        if (result && typeof result === 'object') r.init = result as Record<string, unknown>
        else throw new Error(JSON.stringify(a.message?.error ?? 'no answer'))
        return r.init
      }).finally(() => { r.initializing = null })
      try { await r.initializing; return null } catch (e) { return { failure: 'failed', error: e instanceof Error ? e.message : String(e) } }
    }
    if (method === 'initialize' && isRequest) {
      this.initParams.set(ck, m.params ?? {})
      const failed = await init(m.params ?? {})
      return failed ?? { message: { jsonrpc: '2.0', id: m.id, result: r.init } }
    }
    if (method === 'notifications/initialized') {
      if (!r.initialized) { r.initialized = true; this.write(r, m) }
      return { message: null }
    }
    if (!isRequest) { this.write(r, m); return { message: null } }
    // a program started again under a client that initialized the one before (Stop, new settings): initialized here
    // first, as a stdio server takes no other request before it
    if (!r.init) {
      const failed = await init(this.initParams.get(ck) ?? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'team-integrations', version: '1.0' } })
      if (failed) return failed
    }
    if (!r.initialized) { r.initialized = true; this.write(r, { jsonrpc: '2.0', method: 'notifications/initialized' }) }
    return this.request(r, m, call.deadline, signal)
  }

  // ---------------- adapter 'cli': declared tools, this manager is the MCP server ----------------
  private async answerCli(team: string, call: LocalCall, signal: AbortSignal): Promise<Answer> {
    const spec = call.spec as Extract<LocalAppSpec, { adapter: 'cli' }>
    const m = call.message
    const id = m.id
    if (id === undefined || id === null) return { message: null }
    const ok = (result: unknown) => ({ message: { jsonrpc: '2.0', id, result } as Record<string, unknown> })
    switch (m.method) {
      case 'initialize': return ok({ protocolVersion: typeof (m.params as { protocolVersion?: unknown })?.protocolVersion === 'string' ? (m.params as { protocolVersion: string }).protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: spec.command, version: '1' } })
      case 'ping': return ok({})
      case 'tools/list': return ok({ tools: cliTools(spec.tools) })
      case 'tools/call': {
        const p = (m.params ?? {}) as { name?: unknown; arguments?: unknown }
        const tool = spec.tools.find((t) => t.name === p.name)
        if (!tool) return { message: rpcError(id, -32602, `no tool named ${String(p.name).slice(0, 100)}`) }
        let argv: { args: string[]; stdin: string | null }
        try { argv = cliArgv(tool, p.arguments) } catch (e) { return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }) }
        const run = await this.runCli(team, call, spec, argv, signal)
        if ('failure' in run) return run
        return ok({ content: [{ type: 'text', text: cliOutputText(run) }], isError: run.code !== 0 })
      }
      default: return { message: rpcError(id, -32601, 'not offered') }
    }
  }

  private runCli(team: string, call: LocalCall, spec: Extract<LocalAppSpec, { adapter: 'cli' }>, argv: { args: string[]; stdin: string | null }, signal: AbortSignal): Promise<CliRun | { failure: LocalFailure; error: string }> {
    const dirs = (this.d.searchPath ?? defaultSearchPath)()
    const program = resolveProgram(spec.command, dirs)
    if (!program) return Promise.resolve({ failure: 'start_failed', error: `${spec.command} was not found on this computer` })
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawn(program, argv.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: envFor(this.d.settings(team, call.connectionId), dirs), cwd: os.homedir(), detached: process.platform !== 'win32', windowsHide: true }) as ChildProcessWithoutNullStreams
      } catch (e) { resolve({ failure: 'start_failed', error: e instanceof Error ? e.message : String(e) }); return }
      const ck = this.k(team, call.connectionId)
      const r: Running = { key: 'cli', child, waiting: new Map(), init: null, initializing: null, initialized: true, stderr: '', exited: false, onExit: new Set() }
      // a CLI run counts as the connection running, so Stop ends it too
      const prev = this.running.get(ck)
      this.running.set(`${ck}\u0000${call.callId}`, r)
      this.d.onChange?.(team, call.connectionId, true)
      let stdout = '', stderr = '', outChars = 0, errChars = 0, settled = false
      const finish = (v: CliRun | { failure: LocalFailure; error: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        r.exited = true
        this.running.delete(`${ck}\u0000${call.callId}`)
        if (!prev && ![...this.running.keys()].some((k) => k === ck || k.startsWith(ck + '\u0000'))) this.d.onChange?.(team, call.connectionId, false)
        resolve(v)
      }
      const onAbort = () => { this.kill(r); finish({ failure: 'failed', error: 'stopped' }) }
      const timer = setTimeout(() => { this.kill(r); finish({ failure: 'failed', error: 'the program did not finish in time' }) }, Math.max(1000, call.deadline - (this.d.now ?? Date.now)()))
      signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      // each stream kept up to the whole budget (cliOutputText shares it out), and counted past it for the note
      child.stdout.on('data', (c: string) => { outChars += c.length; if (stdout.length < CLI_OUTPUT_MAX) stdout += c })
      // kept like stdout (the AI reads it: a CLI may print its result there), not only a short tail for errors
      child.stderr.on('data', (c: string) => { errChars += c.length; if (stderr.length < CLI_OUTPUT_MAX) stderr += c })
      child.on('error', (e) => finish({ failure: 'start_failed', error: e.message }))
      child.on('exit', (code) => finish({ stdout, stderr, outChars, errChars, code: code ?? 1 }))
      child.stdin.on('error', () => {})
      if (argv.stdin !== null) child.stdin.write(argv.stdin)
      child.stdin.end()
    })
  }

  // ---------------- Stop ----------------
  /** `hard`: at once with SIGKILL (the app is quitting: no timer of its own runs after that) */
  private kill(r: Running, hard = false) {
    if (r.exited) return
    const pid = r.child.pid
    const sig = (s: NodeJS.Signals) => {
      // the program's own children too (it was started in a group of its own)
      try { if (pid && process.platform !== 'win32') process.kill(-pid, s); else r.child.kill(s) } catch { try { r.child.kill(s) } catch {} }
    }
    if (hard) return sig('SIGKILL')
    sig('SIGTERM')
    setTimeout(() => { if (!r.exited) sig('SIGKILL') }, KILL_AFTER_MS).unref?.()
  }

  /** Stop the connection's program (Settings' Stop, a removed connection). */
  stop(team: string, id: string) {
    const ck = this.k(team, id)
    for (const [k, r] of [...this.running]) if (k === ck || k.startsWith(ck + '\u0000')) this.kill(r)
  }

  /** Quitting, or another team opened in the window: every program of `team` (all teams when left out) stops. */
  stopAll(team?: string, hard = false) {
    for (const [k, r] of [...this.running]) if (!team || k.startsWith(team + '\u0000')) this.kill(r, hard)
  }

  /** The connections of `team` with a program running now. */
  runningIds(team: string): string[] {
    const ids = new Set<string>()
    for (const [k, r] of this.running) if (!r.exited && k.startsWith(team + '\u0000')) ids.add(k.split('\u0000')[1]!)
    return [...ids]
  }
}
