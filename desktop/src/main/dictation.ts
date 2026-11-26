// Voice input transcribed on this Mac (docs/decisions/20261119-mac-dictation.md): the helper desktop/native/dictation
// (Apple's SpeechTranscriber, macOS 26 on Apple silicon), next to the app's program in Contents/MacOS, one child
// process per check, model download or recording. The team page records as always and hands the 16 kHz samples over
// the bridge (shared/src/desktop-bridge.ts `dictation`); this writes them to the helper's stdin as 16-bit PCM and sends
// its words back as events. Nothing is sent anywhere, nothing is kept. Electron is not imported here (unit tests run
// this with a fake helper); main.ts wires the IPC.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesktopDictationCheck, DesktopDictationEvent } from '@mycel/shared/desktop-bridge'

/** an app language as the helper takes it */
export const DICTATION_LANGUAGE = /^[a-z]{2,3}$/
/** a check (probe) that takes longer than this counts as unavailable */
export const PROBE_TIMEOUT_MS = 10_000
/** Apple's model download (ko 20 s, en 11 s on this office's line): given up after this */
export const INSTALL_TIMEOUT_MS = 10 * 60_000
/** a helper that says nothing (no `ready`) for this long did not start: the page uses the team server */
export const READY_TIMEOUT_MS = 15_000
/** after stop(), the last words and `done` within this, else an error */
export const FINISH_TIMEOUT_MS = 20_000
/** the longest recording (the page caps at 5 minutes; this is the app's own end) */
export const LISTEN_MAX_MS = 6 * 60_000
/** at most this many samples in one push (1 s; the page sends ~85 ms) */
export const PUSH_MAX = 16_000

/** The helper's path: MYCEL_DICTATION_HELPER (tests, a dev build with desktop/native-build/dictation), else next to the
 * app's own program on a Mac with Apple silicon and macOS 26 (Darwin 25) or later. Null elsewhere (Windows, Intel,
 * older macOS, the Mac App Store build, which has no helper). */
export function dictationHelperPath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform = process.platform, arch = process.arch, release = os.release(), mas = process.mas === true): string | null {
  const own = env.MYCEL_DICTATION_HELPER
  if (own) return fs.existsSync(own) ? own : null
  if (platform !== 'darwin' || mas || arch !== 'arm64') return null
  const major = Number(release.split('.')[0])
  if (!Number.isFinite(major) || major < 25) return null
  const p = path.join(path.dirname(execPath), 'dictation')
  return fs.existsSync(p) ? p : null
}

type HelperLine = Record<string, unknown> & { event?: unknown }

/** stdout of a helper as JSON lines (a line that is not JSON is skipped) */
function lines(child: ChildProcess, on: (l: HelperLine) => void) {
  let buf = ''
  child.stdout?.on('data', (b: Buffer) => {
    buf = (buf + b.toString('utf8')).slice(-1_000_000)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const s = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      try {
        const o = JSON.parse(s)
        if (o && typeof o === 'object') on(o)
      } catch { /* not a line of ours */ }
    }
  })
}

/** this recording's own helper only (its PID), never by name; a helper stuck in Core Audio is killed after 3 s */
function stopChild(c: ChildProcess) {
  if (c.exitCode !== null || c.signalCode !== null) return
  c.kill('SIGTERM')
  setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') }, 3000).unref()
}

/** -1…1 float samples as 16-bit little-endian PCM */
export function pcm16(samples: Float32Array): Buffer {
  const b = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] || 0))
    b.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2)
  }
  return b
}

export interface DictationHostDeps {
  helper?: () => string | null
  /** events of a recording, to the page that started it */
  send(e: DesktopDictationEvent): void
  /** tests: READY_TIMEOUT_MS */
  readyTimeoutMs?: number
}

interface Listening { id: number; child: ChildProcess; ended: boolean; timers: NodeJS.Timeout[]; end(e: DesktopDictationEvent | null): void }

export class DictationHost {
  private seq = 0
  private run: Listening | null = null
  /** per language: a check's answer (dropped when a model was installed or a recording failed) */
  private checks = new Map<string, Promise<DesktopDictationCheck>>()
  private installs = new Map<string, { done: Promise<'installed' | 'failed' | 'unsupported'>; watchers: Set<(p: number) => void>; percent: number }>()
  /** the helper failed at a recording: the server transcribes until the app starts again */
  private broken = false

  constructor(private readonly d: DictationHostDeps) {}

  private helper(): string | null { return this.broken ? null : (this.d.helper ?? dictationHelperPath)() }
  /** the bridge version this app offers: 0 without a helper */
  version(): number { return (this.d.helper ?? dictationHelperPath)() ? 1 : 0 }

  check(language: string): Promise<DesktopDictationCheck> {
    const helper = this.helper()
    if (!helper || !DICTATION_LANGUAGE.test(language)) return Promise.resolve({ state: 'unavailable' })
    let c = this.checks.get(language)
    if (!c) {
      c = this.probe(helper, language)
      this.checks.set(language, c)
      // an unavailable answer (a helper that failed once) is asked again next time
      void c.then((r) => { if (r.state === 'unavailable' && this.checks.get(language) === c) this.checks.delete(language) })
    }
    return c
  }

  private probe(helper: string, language: string): Promise<DesktopDictationCheck> {
    return new Promise((resolve) => {
      let answer: DesktopDictationCheck = { state: 'unavailable' }
      let child: ChildProcess
      try {
        child = spawn(helper, ['probe', '--language', language], { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return resolve(answer)
      }
      const timer = setTimeout(() => stopChild(child), PROBE_TIMEOUT_MS)
      lines(child, (l) => {
        if (l.event !== 'probe') return
        if (l.available !== true) answer = { state: 'unavailable' }
        else if (l.supported !== true || typeof l.locale !== 'string') answer = { state: 'unsupported' }
        else answer = { state: l.installed === true ? 'ready' : 'needs-model', locale: String(l.locale).slice(0, 35) }
      })
      child.on('error', () => { clearTimeout(timer); resolve({ state: 'unavailable' }) })
      // 'close', not 'exit': stdout is read to its end first (the answer is its last line)
      child.on('close', () => { clearTimeout(timer); resolve(answer) })
    })
  }

  /** Apple's model for this language, once (a second call while it runs joins it) */
  install(language: string, onProgress?: (percent: number) => void): Promise<'installed' | 'failed' | 'unsupported'> {
    const helper = this.helper()
    if (!helper || !DICTATION_LANGUAGE.test(language)) return Promise.resolve('failed')
    const now = this.installs.get(language)
    if (now) {
      if (onProgress) { now.watchers.add(onProgress); onProgress(now.percent) }
      return now.done
    }
    const watchers = new Set<(p: number) => void>(onProgress ? [onProgress] : [])
    const entry = { watchers, percent: 0, done: null as unknown as Promise<'installed' | 'failed' | 'unsupported'> }
    entry.done = new Promise((resolve) => {
      let result: 'installed' | 'failed' | 'unsupported' = 'failed'
      let child: ChildProcess
      try {
        child = spawn(helper, ['install', '--language', language], { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return resolve('failed')
      }
      const timer = setTimeout(() => stopChild(child), INSTALL_TIMEOUT_MS)
      lines(child, (l) => {
        if (l.event === 'progress' && typeof l.percent === 'number' && Number.isFinite(l.percent)) {
          entry.percent = Math.max(entry.percent, Math.min(100, Math.max(0, Math.floor(l.percent))))
          for (const w of watchers) w(entry.percent)
        } else if (l.event === 'installed') result = 'installed'
        else if (l.event === 'error') result = l.code === 'unsupported' ? 'unsupported' : 'failed'
      })
      const end = () => {
        clearTimeout(timer)
        this.installs.delete(language)
        this.checks.delete(language)
        resolve(result)
      }
      child.on('error', end)
      child.on('close', end)
    })
    this.installs.set(language, entry)
    return entry.done
  }

  /** A recording: its id, or null when the helper is not there (the page uses the team server). The helper says
   * `ready` before the sound is taken; an earlier recording still on goes. */
  start(language: string): Promise<number | null> {
    const helper = this.helper()
    if (!helper || !DICTATION_LANGUAGE.test(language)) return Promise.resolve(null)
    if (this.run) this.cancel(this.run.id)
    const id = ++this.seq
    let child: ChildProcess
    try {
      child = spawn(helper, ['listen', '--language', language], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return Promise.resolve(null)
    }
    let ready = false
    let resolveStart: (id: number | null) => void = () => {}
    const timers: NodeJS.Timeout[] = []
    const run: Listening = {
      id,
      child,
      ended: false,
      timers,
      // once: the timers go, the helper goes, a start still waiting gets null, `e` goes to the page
      end: (e) => {
        if (run.ended) return
        run.ended = true
        for (const t of timers) clearTimeout(t)
        if (this.run === run) this.run = null
        child.stdin?.end()
        stopChild(child)
        if (!ready) return resolveStart(null)
        if (e) this.d.send(e)
      },
    }
    this.run = run
    // ending stdin of a helper that is gone already gives EPIPE
    child.stdin?.on('error', () => {})
    const started = new Promise<number | null>((resolve) => { resolveStart = resolve })
    // a helper stuck before `ready` (the Speech framework not answering) did not start
    timers.push(setTimeout(() => run.end(null), this.d.readyTimeoutMs ?? READY_TIMEOUT_MS))
    lines(child, (l) => {
      if (run.ended) return
      if (l.event === 'ready') {
        ready = true
        clearTimeout(timers[0])
        timers.push(setTimeout(() => run.end({ id, event: 'error', code: 'too_long' }), LISTEN_MAX_MS))
        resolveStart(id)
      } else if (l.event === 'text' && typeof l.text === 'string') {
        this.d.send({ id, event: 'text', final: l.final === true, text: l.text.slice(0, 20_000) })
      } else if (l.event === 'done') {
        run.end({ id, event: 'done' })
      } else if (l.event === 'error') {
        // a model that went missing is fetched again by the next check
        this.checks.delete(language)
        run.end({ id, event: 'error', code: typeof l.code === 'string' ? l.code.slice(0, 40) : 'helper' })
      }
    })
    child.on('error', () => { if (!run.ended && ready) this.broken = true; run.end({ id, event: 'error', code: 'helper' }) })
    // 'close', not 'exit': every line it wrote (the last words, done) is read first
    child.on('close', () => {
      // gone without done: it crashed (the server transcribes the next recordings)
      if (!run.ended && ready) this.broken = true
      run.end({ id, event: 'error', code: 'helper' })
    })
    return started
  }

  push(id: number, samples: Float32Array) {
    const r = this.run
    if (!r || r.id !== id || r.ended || !(samples instanceof Float32Array) || !samples.length) return
    const s = samples.length > PUSH_MAX ? samples.subarray(0, PUSH_MAX) : samples
    r.child.stdin?.write(pcm16(s))
  }

  /** the sound ended: the helper writes its last words and `done` (else an error after FINISH_TIMEOUT_MS) */
  stop(id: number) {
    const r = this.run
    if (!r || r.id !== id || r.ended) return
    r.child.stdin?.end()
    r.timers.push(setTimeout(() => r.end({ id, event: 'error', code: 'timeout' }), FINISH_TIMEOUT_MS))
  }

  /** nothing more comes from this recording (a start still waiting answers null) */
  cancel(id: number) {
    const r = this.run
    if (r && r.id === id) r.end(null)
  }

  /** the page went (reload, another team, the window closed): its recording goes too */
  stopAll() {
    if (this.run) this.cancel(this.run.id)
  }
}
