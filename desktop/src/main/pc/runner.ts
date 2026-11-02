/**
 * The PC runner (docs/DECISIONS.md "PC runner"): the AI on the team server calls a pc_* tool, the team page hands the call
 * to this class over the bridge, and the person decides in the app's own view (ui/pc.ts). A page served through the relay
 * can send a call, not answer for the person.
 *
 *  - one workspace folder per project, chosen by the person in the system's own dialog; the server never names a path
 *  - every tool runs in the macOS jail (common/pc-sandbox.ts), file tools too: this process never opens a file of the
 *    workspace, so a link that a command swapped in reaches nothing, and a search pattern cannot hang the app
 *  - asks for every call, until the person allows the chat. A login command and a secret file ask every time
 *  - closing the app, switching the team, the stop button or another person signing in ends every command
 *
 * Each team has its own runner, like its own browser pane.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { PC_APPROVAL_TIMEOUT_MS, type PcCall, type PcResult } from '@mycel/shared/api'
import { PC_OUTPUT_LIMIT, PC_SHELL_TIMEOUT_DEFAULT_SEC, PC_TEXT_LIMIT, parsePcToolInput, usesCredentials, type ParsedPcCall } from '@mycel/shared'
import { applyEdit, asPcDecision, callNeeds, callSummary, ChatAllowances, commandEnv, effectiveDecision, inGitFolder, looksBinary, numberedLines, scrubPaths, searchCommand, visibleText, workCwd, workPath, workspaceProblem, type CallNeeds, type PcDecision, type ScrubPaths } from '../../common/pc-run'
import type { PcGrants, PcSandboxPaths } from '../../common/pc-sandbox'
import { agentSocket, jailAvailable, JailedProgram, loginPath, realDirs, type JailResult } from './jail'
import { debug } from '../debug'

/** the system's tools, at their fixed places: the jail's file tools do not depend on the person's PATH */
const CAT = '/bin/cat'
const SH = '/bin/sh'
/** a file larger than this is not read for the AI, and an edit does not load it */
const READ_MAX = 16 << 20
const FILE_TOOL_MS = 30_000
const MAX_PROMPTS = 5
const MAX_BACKGROUND = 5
const MAX_LOG = 200
/** finished results kept for replays after a reconnect */
const KEEP_RESULTS = 100
/** how long a background program gets to fail at once: its exit code then goes to the AI */
const BACKGROUND_SETTLE_MS = 700

export interface PcWorkspace { path: string; pickedAt: string }
export type PcWorkspaces = Record<string, PcWorkspace>

export type PcPrompt =
  | { kind: 'folder'; id: string; project: string; problem: 'too-wide' | 'system' | null }
  | { kind: 'call'; id: string; project: string; folder: string; tool: ParsedPcCall['tool']; text: string; detail: string | null; cwd: string; grants: PcGrants; always: boolean }

export interface PcLogEntry {
  id: string
  at: number
  tool: ParsedPcCall['tool']
  text: string
  outcome: 'running' | 'ok' | 'failed' | 'denied' | 'stopped'
  note: string | null
}

export interface PcBackground { id: string; text: string; startedAt: number; port: number | null }

export interface PcState {
  prompts: PcPrompt[]
  /** tools running now */
  running: { id: string; tool: ParsedPcCall['tool']; text: string }[]
  background: PcBackground[]
  allowedChats: number
  log: PcLogEntry[]
  logOpen: boolean
}

export const IDLE_PC_STATE: PcState = { prompts: [], running: [], background: [], allowedChats: 0, log: [], logOpen: false }

/** The bar is shown only while there is something to say. */
export const pcBarVisible = (s: PcState) => s.prompts.length > 0 || s.running.length > 0 || s.background.length > 0 || s.allowedChats > 0 || s.logOpen

export interface PcRunnerHost {
  /** folder for this team's sandbox homes */
  dir: string
  loadWorkspaces(): PcWorkspaces
  saveWorkspaces(w: PcWorkspaces): void
  /** the system's folder dialog; null when the person cancelled */
  pickFolder(project: string): Promise<string | null>
  onState(s: PcState): void
  onWaiting(callId: string, waiting: boolean): void
}

interface CallCtx {
  callId: string
  abort: AbortController
  /** why it was stopped, for the AI */
  stopReason: string | null
  program?: JailedProgram
  waiting: number
}

interface OpenPrompt { prompt: PcPrompt; callId: string; settle(answer: string | null): void }

type ToolOutcome = { ok: boolean; text: string; run?: PcResult['run'] }

const decode = (b: Buffer) => b.toString('utf8')
const secs = (ms: number) => (ms / 1000).toFixed(1)
const clipText = (s: string, max: number) => (Buffer.byteLength(s) > max ? `${Buffer.from(s).subarray(0, max).toString('utf8')}\n(cut)` : s)

export class PcRunner {
  private workspaces: PcWorkspaces
  private allowances = new ChatAllowances()
  private prompts: OpenPrompt[] = []
  private calls = new Map<string, { ctx: CallCtx; result: Promise<PcResult> }>()
  private finished = new Map<string, PcResult>()
  private running = new Map<string, { tool: ParsedPcCall['tool']; text: string }>()
  private background = new Map<string, PcBackground & { program: JailedProgram }>()
  private log: PcLogEntry[] = []
  private logOpen = false
  private disposed = false

  constructor(private host: PcRunnerHost) {
    this.workspaces = host.loadWorkspaces()
  }

  // -------------------------------------------------------------- the view

  state(): PcState {
    return {
      prompts: this.prompts.slice(0, 1).map((p) => p.prompt),
      running: [...this.running].map(([id, r]) => ({ id, ...r })),
      background: [...this.background.values()].map(({ id, text, startedAt, port }) => ({ id, text, startedAt, port })),
      allowedChats: this.allowances.size,
      log: this.log,
      logOpen: this.logOpen,
    }
  }

  private emit() {
    if (!this.disposed) this.host.onState(this.state())
  }

  toggleLog(open = !this.logOpen) {
    this.logOpen = open
    this.emit()
  }

  answer(id: string, value: unknown) {
    this.prompts.find((p) => p.prompt.id === id)?.settle(asPcDecision(value) === 'deny' ? null : String(value))
  }

  /** The stop button: every command ends, every question is a no, and "this chat" is taken back. */
  stop() {
    for (const c of [...this.calls.values()]) this.stopCall(c.ctx, 'The person pressed stop in the desktop app. Do not try again; ask them what to do.')
    for (const b of [...this.background.values()]) b.program.stop()
    this.allowances.clear()
    this.emit()
  }

  revokeChats() {
    this.allowances.clear()
    this.emit()
  }

  /** The port of a background dev server, which only a click of the person opens (app-window.ts). */
  previewPort(id: string): number | null {
    return this.background.get(id)?.port ?? null
  }

  private stopCall(ctx: CallCtx, reason: string) {
    ctx.stopReason ??= reason
    ctx.abort.abort()
    ctx.program?.stop()
    for (const p of [...this.prompts]) if (p.callId === ctx.callId) p.settle(null)
  }

  /** pc.cancel from the server: the turn stopped. */
  cancel(callId: string) {
    const c = this.calls.get(callId)
    if (c) this.stopCall(c.ctx, 'The turn was stopped.')
  }

  /** Another person signed in to this team, or the person signed out: nothing of theirs stays. */
  resetForNewPerson() {
    this.stop()
    this.workspaces = {}
    this.host.saveWorkspaces({})
    this.log = []
    this.finished.clear()
    this.emit()
  }

  /** Closing the window, switching the team, quitting: every command ends now. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const p of [...this.prompts]) p.settle(null)
    for (const c of this.calls.values()) {
      c.ctx.stopReason ??= 'The desktop app closed.'
      c.ctx.abort.abort()
      c.ctx.program?.kill()
    }
    for (const b of this.background.values()) b.program.kill()
    this.background.clear()
  }

  // ------------------------------------------------------------- questions

  /** The call waits for the person from here until release: the server pauses the turn's time limit meanwhile. */
  private hold(ctx: CallCtx) {
    if (ctx.waiting++ === 0) this.host.onWaiting(ctx.callId, true)
  }

  private release(ctx: CallCtx) {
    if (--ctx.waiting === 0) this.host.onWaiting(ctx.callId, false)
  }

  private ask(prompt: PcPrompt, ctx: CallCtx): Promise<string | null> {
    if (this.disposed || ctx.abort.signal.aborted) return Promise.resolve(null)
    if (this.prompts.length >= MAX_PROMPTS) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.hold(ctx)
      const settle = (answer: string | null) => {
        const i = this.prompts.findIndex((p) => p.prompt.id === prompt.id)
        if (i < 0) return
        this.prompts.splice(i, 1)
        clearTimeout(timer)
        this.release(ctx)
        this.emit()
        resolve(answer)
      }
      const timer = setTimeout(() => settle(null), PC_APPROVAL_TIMEOUT_MS)
      this.prompts.push({ prompt, callId: ctx.callId, settle })
      this.emit()
    })
  }

  // ------------------------------------------------------------- workspace

  /** The project's workspace folder: asked for the first time, and again when it moved or no longer qualifies. */
  private async workspace(call: PcCall, ctx: CallCtx): Promise<string | null> {
    const home = realpathSync(homedir())
    const saved = this.workspaces[call.project.id]
    if (saved) {
      try {
        const real = realpathSync(saved.path)
        if (!workspaceProblem(real, home)) return real
      } catch {
        // moved or deleted: ask again
      }
    }
    // the card and the system's dialog are one wait for the person
    this.hold(ctx)
    try {
      let problem: 'too-wide' | 'system' | null = null
      for (;;) {
        const answer = await this.ask({ kind: 'folder', id: crypto.randomUUID(), project: call.project.name, problem }, ctx)
        if (!answer) return null
        const picked = await this.host.pickFolder(call.project.name)
        if (!picked || ctx.abort.signal.aborted || this.disposed) return null
        let real: string
        try {
          real = realpathSync(picked)
        } catch {
          return null
        }
        problem = workspaceProblem(real, home)
        if (problem) continue
        this.workspaces = { ...this.workspaces, [call.project.id]: { path: real, pickedAt: new Date().toISOString() } }
        this.host.saveWorkspaces(this.workspaces)
        return real
      }
    } finally {
      this.release(ctx)
    }
  }

  /** HOME of the workspace's commands, in the app's own folder: caches, temp files, logs, a git identity. */
  private async sandboxHome(projectId: string): Promise<string> {
    const dir = join(this.host.dir, createHash('sha256').update(projectId).digest('hex').slice(0, 24))
    if (!existsSync(join(dir, 'logs'))) {
      mkdirSync(join(dir, 'tmp'), { recursive: true, mode: 0o700 })
      mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 })
      // a file here, not environment variables: a repository's own user.name must keep winning
      const id = await gitIdentity()
      if (id) writeFileSync(join(dir, '.gitconfig'), id, { mode: 0o600 })
    }
    return realpathSync(dir)
  }

  // ------------------------------------------------------------------- run

  /** Run one pc.call. Same callId twice returns the first result: a reconnect replays calls. */
  run(call: PcCall): Promise<PcResult> {
    const done = this.finished.get(call.callId)
    if (done) return Promise.resolve(done)
    const open = this.calls.get(call.callId)
    if (open) return open.result
    const ctx: CallCtx = { callId: call.callId, abort: new AbortController(), stopReason: null, waiting: 0 }
    const result = this.execute(call, ctx).finally(() => {
      this.calls.delete(call.callId)
    })
    void result.then((r) => {
      this.finished.set(call.callId, r)
      while (this.finished.size > KEEP_RESULTS) this.finished.delete(this.finished.keys().next().value as string)
    })
    this.calls.set(call.callId, { ctx, result })
    return result
  }

  private async execute(call: PcCall, ctx: CallCtx): Promise<PcResult> {
    const fail = (text: string, approval: PcResult['approval'] = 'none'): PcResult => ({ callId: call.callId, ok: false, content: [{ type: 'text', text }], error: text.slice(0, 4000), approval })
    if (this.disposed) return fail('The desktop app closed.')
    if (!jailAvailable()) return fail('The PC runner works only in the desktop app for macOS for now, and not in the App Store version. Tell the person.')
    const parsed = parsePcToolInput(call.tool, call.args)
    if (!parsed.ok) return fail(parsed.error)
    const refused = refusedPath(parsed.call)
    if (refused) return fail(refused)

    const entry = this.logEntry(call, parsed.call)
    const close = (outcome: PcLogEntry['outcome'], note: string | null = null) => {
      entry.outcome = outcome
      entry.note = note
      this.running.delete(call.callId)
      this.emit()
    }
    const denied = () => {
      close(ctx.stopReason ? 'stopped' : 'denied')
      return fail(ctx.stopReason ?? 'The person did not allow this. Do not try it again in this answer; ask them what they want.', 'denied')
    }

    const work = await this.workspace(call, ctx)
    if (!work) return denied()
    const needs = callNeeds(parsed.call)
    let approval: 'once' | 'chat'
    if (!needs.always && this.allowances.has(call.project.id, call.chatId)) approval = 'chat'
    else {
      const d = await this.approve(call, parsed.call, needs, work, ctx)
      if (d === 'deny') return denied()
      if (d === 'chat') {
        this.allowances.add(call.project.id, call.chatId)
        this.emit()
      }
      approval = d === 'chat' ? 'chat' : 'once'
    }
    if (ctx.abort.signal.aborted) return denied()

    this.running.set(call.callId, { tool: parsed.call.tool, text: entry.text })
    this.emit()
    const grants = needs.grants
    const home = realpathSync(homedir())
    const user = userInfo().username
    const scrub: ScrubPaths = { work, sandboxHome: '', home, user }
    try {
      const sandboxHome = await this.sandboxHome(call.project.id)
      scrub.sandboxHome = sandboxHome
      const path = await loginPath()
      const jail: JailBase = { paths: { work, sandboxHome, home, pathDirs: realDirs(path), sshAgentSocket: agentSocket() }, env: commandEnv({ path, home, sandboxHome, user, lang: process.env.LANG, sshAgentSocket: agentSocket() }, grants), grants }
      const out = await this.runTool(parsed.call, jail, ctx)
      const stopped = !!ctx.stopReason
      close(stopped ? 'stopped' : out.ok ? 'ok' : 'failed', out.run ? (out.run.signal ?? String(out.run.code)) : null)
      const text = scrubPaths(ctx.stopReason ? `${ctx.stopReason}\n${out.text}` : out.text, scrub)
      return { callId: call.callId, ok: out.ok && !stopped, content: [{ type: 'text', text: clipText(text, 1_500_000) }], ...(out.ok && !stopped ? {} : { error: text.slice(0, 400) }), approval, grants, ...(out.run ? { run: out.run } : {}) }
    } catch (e) {
      debug('pc tool failed', e instanceof Error ? e.message : String(e))
      close('failed')
      const m = `The tool could not run: ${e instanceof Error ? e.message : String(e)}`
      return fail(scrubPaths(m, scrub), approval)
    }
  }

  private async approve(call: PcCall, c: ParsedPcCall, needs: CallNeeds, folder: string, ctx: CallCtx): Promise<PcDecision> {
    const answer = await this.ask({
      kind: 'call', id: crypto.randomUUID(), project: call.project.name, folder, tool: c.tool, text: visibleText(callSummary(c)), detail: callDetail(c),
      cwd: c.tool === 'pc_shell' ? (workCwd(c.input.cwd) ?? '') : '', grants: needs.grants, always: needs.always,
    }, ctx)
    return effectiveDecision(answer, needs.always)
  }

  private logEntry(call: PcCall, c: ParsedPcCall): PcLogEntry {
    const entry: PcLogEntry = { id: call.callId, at: Date.now(), tool: c.tool, text: callSummary(c).slice(0, 400), outcome: 'running', note: null }
    this.log = [entry, ...this.log].slice(0, MAX_LOG)
    return entry
  }

  private jailed(j: JailBase, ctx: CallCtx, o: { file: string; args: string[]; cwd?: string; stdin?: string; timeoutMs: number; limit: number; stopAtLimit?: boolean; grants?: PcGrants }): Promise<JailResult> {
    const program = new JailedProgram({ paths: j.paths, grants: o.grants ?? j.grants, env: j.env, file: o.file, args: o.args, cwd: o.cwd ?? j.paths.work, stdin: o.stdin, timeoutMs: o.timeoutMs, limit: o.limit, stopAtLimit: o.stopAtLimit })
    ctx.program = program
    return program.done
  }

  private async runTool(c: ParsedPcCall, j: JailBase, ctx: CallCtx): Promise<ToolOutcome> {
    switch (c.tool) {
      case 'pc_read': return this.read(c.input, j, ctx)
      case 'pc_write': return this.write(workPath(c.input.file_path)!, c.input.content, j, ctx, `Saved ${c.input.file_path} (${Buffer.byteLength(c.input.content)} bytes).`)
      case 'pc_edit': return this.edit(c.input, j, ctx)
      case 'pc_search': return this.search(c.input, j, ctx)
      case 'pc_shell': return c.input.background ? this.startBackground(c.input, j, ctx) : this.shell(c.input, j, ctx)
    }
  }

  private async loadFile(rel: string, j: JailBase, ctx: CallCtx): Promise<{ ok: true; bytes: Buffer } | { ok: false; text: string }> {
    const r = await this.jailed(j, ctx, { file: CAT, args: ['--', `./${rel}`], timeoutMs: FILE_TOOL_MS, limit: READ_MAX, stopAtLimit: true })
    if (r.truncated) return { ok: false, text: `The file is larger than ${READ_MAX >> 20} MiB: read parts of it with pc_shell (sed -n, head, tail).` }
    if (r.code !== 0) return { ok: false, text: fileError(rel, decode(r.stderr)) }
    return { ok: true, bytes: r.stdout }
  }

  private async read(i: ParsedPcReadInput, j: JailBase, ctx: CallCtx): Promise<ToolOutcome> {
    const rel = workPath(i.file_path)!
    const f = await this.loadFile(rel, j, ctx)
    if (!f.ok) return { ok: false, text: f.text }
    if (looksBinary(f.bytes)) return { ok: true, text: `${i.file_path} is a binary file (${f.bytes.length} bytes): not shown.` }
    const n = numberedLines(decode(f.bytes), i.offset, i.limit)
    const first = i.offset ?? 1
    const tail = n.more ? `\n(lines ${first}-${first + n.text.split('\n').length - 1} of ${n.total}: use offset for the rest)` : ''
    return { ok: true, text: clipText(n.text, PC_TEXT_LIMIT) + tail }
  }

  private async write(rel: string, content: string, j: JailBase, ctx: CallCtx, done: string): Promise<ToolOutcome> {
    const r = await this.jailed(j, ctx, { file: SH, args: ['-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', `./${rel}`], stdin: content, timeoutMs: FILE_TOOL_MS, limit: PC_OUTPUT_LIMIT })
    if (r.code !== 0) return { ok: false, text: fileError(rel, decode(r.stderr)) }
    return { ok: true, text: done }
  }

  private async edit(i: ParsedPcEditInput, j: JailBase, ctx: CallCtx): Promise<ToolOutcome> {
    const rel = workPath(i.file_path)!
    const f = await this.loadFile(rel, j, ctx)
    if (!f.ok) return { ok: false, text: f.text }
    if (looksBinary(f.bytes)) return { ok: false, text: `${i.file_path} is a binary file.` }
    const e = applyEdit(decode(f.bytes), i.old_string, i.new_string, i.replace_all === true)
    if (!e.ok) return { ok: false, text: e.error }
    return this.write(rel, e.text, j, ctx, `Edited ${i.file_path} (${e.count} ${e.count === 1 ? 'place' : 'places'}).`)
  }

  private async search(i: ParsedPcSearchInput, j: JailBase, ctx: CallCtx): Promise<ToolOutcome> {
    const { file, args } = searchCommand({ pattern: i.pattern, glob: i.glob, path: workPath(i.path ?? '')!, ignoreCase: i['-i'] })
    const r = await this.jailed(j, ctx, { file, args, timeoutMs: FILE_TOOL_MS, limit: PC_TEXT_LIMIT, stopAtLimit: true })
    if (r.timedOut) return { ok: false, text: `The search did not finish in ${FILE_TOOL_MS / 1000} s. Search a smaller folder or use a simpler pattern.` }
    const lines = decode(r.stdout).split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''))
    const head = i.head_limit ?? 200
    if (!lines.length) return r.code !== 0 && r.code !== 1 && !i.glob ? { ok: false, text: 'The search failed: check the pattern (extended regular expression).' } : { ok: true, text: 'No matches.' }
    return { ok: true, text: lines.slice(0, head).join('\n') + (lines.length > head || r.truncated ? `\n(cut at ${Math.min(head, lines.length)} lines)` : '') }
  }

  private async shell(i: ParsedPcShellInput, j: JailBase, ctx: CallCtx): Promise<ToolOutcome> {
    const cwd = join(j.paths.work, workCwd(i.cwd)!)
    const timeoutMs = (i.timeout_sec ?? PC_SHELL_TIMEOUT_DEFAULT_SEC) * 1000
    const r = await this.jailed(j, ctx, { file: '/bin/bash', args: ['-c', i.command], cwd, timeoutMs, limit: PC_OUTPUT_LIMIT })
    const stdout = decode(r.stdout)
    const stderr = decode(r.stderr)
    const signal = r.timedOut ? 'timeout' : r.stopped ? 'stopped' : r.signal
    const head = r.timedOut ? `Stopped: the time limit (${timeoutMs / 1000} s) was reached.` : r.stopped ? 'Stopped.' : `Exit code ${r.code}.`
    const parts = [`${head} (${secs(r.ms)} s)`, stdout ? `--- stdout ---\n${stdout}` : '--- stdout: empty ---']
    if (stderr) parts.push(`--- stderr ---\n${stderr}`)
    if (r.truncated) parts.push('(output cut)')
    const ok = r.code === 0 && !r.timedOut && !r.stopped
    if (!ok) {
      const hint = jailHint(`${stdout}\n${stderr}`, j.grants, i.command)
      if (hint) parts.push(hint)
    }
    return { ok, text: parts.join('\n'), run: { code: r.code, signal, ms: r.ms } }
  }

  private async startBackground(i: ParsedPcShellInput, j: JailBase, ctx: CallCtx): Promise<ToolOutcome> {
    if (this.background.size >= MAX_BACKGROUND) return { ok: false, text: `${MAX_BACKGROUND} background commands already run. The person can stop them in the app.` }
    const name = i.log_name ?? 'background'
    const logFile = join(j.paths.sandboxHome, 'logs', `${name}.log`)
    const program = new JailedProgram({ paths: j.paths, grants: j.grants, env: j.env, file: '/bin/bash', args: ['-c', i.command], cwd: join(j.paths.work, workCwd(i.cwd)!), timeoutMs: 0, limit: 0, logFile })
    const id = crypto.randomUUID()
    const entry = { id, text: i.command.slice(0, 200), startedAt: Date.now(), port: i.preview_port ?? null, program }
    this.background.set(id, entry)
    this.emit()
    let ended: JailResult | null = null
    void program.done.then((r) => {
      ended = r
      this.background.delete(id)
      this.emit()
    })
    await Promise.race([program.done, new Promise((r) => setTimeout(r, BACKGROUND_SETTLE_MS))])
    if (ended) {
      const r = ended as JailResult
      return { ok: false, text: `The command ended at once (exit code ${r.code}). Log: $HOME/logs/${name}.log`, run: { code: r.code, signal: r.signal, ms: r.ms } }
    }
    return { ok: true, text: `Started in the background (log: $HOME/logs/${name}.log; read it with pc_shell: tail -n 20 "$HOME/logs/${name}.log"). It ends when the app closes.${i.preview_port ? ` The person has a button that opens port ${i.preview_port} in their own browser.` : ''}` }
  }
}

type JailBase = { paths: PcSandboxPaths; env: Record<string, string>; grants: PcGrants }
type InputOf<T extends ParsedPcCall['tool']> = Extract<ParsedPcCall, { tool: T }>['input']
type ParsedPcReadInput = InputOf<'pc_read'>
type ParsedPcEditInput = InputOf<'pc_edit'>
type ParsedPcSearchInput = InputOf<'pc_search'>
type ParsedPcShellInput = InputOf<'pc_shell'>

/** What the person reads on the card besides the path: the text that will be written. */
function callDetail(c: ParsedPcCall): string | null {
  const part = (s: string, n: number) => visibleText(s.slice(0, n)) + (s.length > n ? `\n[... ${s.length - n} more characters]` : '')
  if (c.tool === 'pc_write') return part(c.input.content, 4000)
  if (c.tool === 'pc_edit') return `- ${part(c.input.old_string, 1500)}\n+ ${part(c.input.new_string, 1500)}`
  return null
}

/** A call that leaves the folder is refused before the person is asked; the jail would close it anyway. */
function refusedPath(c: ParsedPcCall): string | null {
  const bad = (p: string) => `Refused: ${p.slice(0, 200)} is not a path inside the workspace. Paths are relative to it, with no "..".`
  switch (c.tool) {
    case 'pc_read': return workPath(c.input.file_path) ? null : bad(c.input.file_path)
    case 'pc_write': case 'pc_edit': {
      const p = workPath(c.input.file_path)
      if (!p) return bad(c.input.file_path)
      return inGitFolder(p) ? 'Refused: pc_write and pc_edit stay out of .git. Use git commands.' : null
    }
    case 'pc_search': return c.input.path !== undefined && workPath(c.input.path) === null ? bad(c.input.path) : null
    case 'pc_shell': return workCwd(c.input.cwd) === null ? bad(c.input.cwd ?? '') : null
  }
}

function fileError(rel: string, stderr: string): string {
  if (/no such file/i.test(stderr)) return `${rel} does not exist.`
  if (/not permitted/i.test(stderr)) return `Refused: ${rel} is outside the workspace or a secret file (the jail closed it).`
  if (/is a directory/i.test(stderr)) return `${rel} is a folder. Use pc_search with a glob to list it.`
  return `${rel}: ${stderr.trim().slice(0, 300)}`
}

function jailHint(output: string, g: PcGrants, command: string): string | null {
  const noLogin = !g.login && (usesCredentials(command) || /\bgit\b/.test(command))
  if (!/Operation not permitted|EPERM|Permission denied \(publickey\)|could not read/i.test(output) && !(noLogin && usesCredentials(command))) return null
  const lines = ['The jail may have closed this: a command reaches only the workspace folder.']
  if (!g.secretFiles) lines.push('If it needs the secret files of the project (.env, key files; some tools read .env by themselves), run it again with secret_files: true.')
  if (noLogin) lines.push('A command that uses a login or changes git settings gets the login only when it is alone in the call, starts the line and names no program or settings file: "git push origin main", with cwd for its folder, not "cd x && git push", not through a script. If it cannot be written that way, ask the person to run it themselves.')
  return lines.join(' ')
}

async function gitIdentity(): Promise<string | null> {
  const value = (key: string) => new Promise<string>((resolve) => {
    execFile('/usr/bin/git', ['config', '--global', key], { timeout: 3000, encoding: 'utf8' }, (_e, out) => resolve(String(out ?? '').trim()))
  })
  const [name, email] = await Promise.all([value('user.name'), value('user.email')])
  const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
  return name && email ? `[user]\n\tname = ${quote(name)}\n\temail = ${quote(email)}\n` : null
}
