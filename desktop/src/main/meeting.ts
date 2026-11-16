// Meeting notes in the main process (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md): one meeting at a time. It
// starts the sound helper (desktop/native/meeting-audio, next to the app's program in Contents/MacOS), reads its frames
// into a MeetingSession (common/meeting/session.ts) and sends each piece to the open team (POST /api/meetings/piece)
// with the team page's own sign-in (its session's fetch, the CSRF header). The helper is this meeting's own child
// process: stopping it stops only that PID. The bridge and the app's start dialog (slice 3) call start / stop.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session } from 'electron'
import { CSRF_HEADER } from '@mycel/shared/api'
import { FrameReader, MeetingSession, type MeetingLine, type PieceAnswer } from '../common/meeting/session'

export const MEETING_PIECE_PATH = '/api/meetings/piece'
const PIECE_TIMEOUT_MS = 75_000

/** The helper's path: next to the app's own program on a Mac (a packaged app), or MYCEL_MEETING_HELPER (tests, a dev
 * build with desktop/native-build/meeting-audio). Null where there is none (Windows until P3, the store build). */
export function meetingHelperPath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform = process.platform, release = os.release()): string | null {
  const own = env.MYCEL_MEETING_HELPER
  if (own) return fs.existsSync(own) ? own : null
  if (platform !== 'darwin') return null
  // macOS 14.4 (Darwin 23.4) and later: the plan's floor for process taps
  const [maj = 0, min = 0] = release.split('.').map(Number)
  if (maj < 23 || (maj === 23 && min < 4)) return null
  const p = path.join(path.dirname(execPath), 'meeting-audio')
  return fs.existsSync(p) ? p : null
}

/** A refusal of the team server as the session reads it: the reason and Retry-After decide whether to send again. */
export async function pieceAnswerOf(res: Response): Promise<PieceAnswer> {
  let body: any = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (res.ok) {
    const lines = Array.isArray(body?.lines) ? body.lines.filter((l: any) => l && typeof l.text === 'string' && Number.isFinite(l.start) && Number.isFinite(l.end)) : []
    return { ok: true, lines: lines.map((l: any) => ({ start: Number(l.start), end: Number(l.end), text: String(l.text).slice(0, 4000) })) }
  }
  const retry = Number(res.headers.get('retry-after'))
  const reason = typeof body?.error?.params?.reason === 'string' ? body.error.params.reason : undefined
  const message = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${res.status}`
  return { ok: false, status: res.status, ...(reason ? { reason } : {}), ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSec: retry } : {}), message }
}

export interface MeetingEvents {
  onLines(lines: MeetingLine[]): void
  onStop(message: string | null): void
  onState(s: { microphone: boolean; callSound: boolean; callApps: string[] }): void
  onBacklog?(waiting: number): void
}

export class MeetingRun {
  private child: ChildProcess | null = null
  private readonly session: MeetingSession
  private readonly reader = new FrameReader()
  private ended = false

  constructor(private readonly o: { helper: string; origin: string; session: Pick<Session, 'fetch'>; events: MeetingEvents }) {
    this.session = new MeetingSession({
      send: (wav) => this.send(wav),
      onLines: (l) => o.events.onLines(l),
      onStop: (m) => { void this.stop(); o.events.onStop(m) },
      onBacklog: o.events.onBacklog,
    })
  }

  start() {
    const child = spawn(this.o.helper, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    const end = () => { if (this.ended) return; this.ended = true; void this.session.finish().then(() => this.o.events.onStop(null)) }
    // a helper that cannot start (missing, not allowed to run) is an 'error' event, not a throw
    child.on('error', () => { this.child = null; end() })
    // ending stdin of a helper that is gone already gives EPIPE
    child.stdin!.on('error', () => {})
    const onData = (b: Buffer) => {
      if (this.ended) return
      try { for (const f of this.reader.push(b)) this.session.push(f) } catch {
        // a broken stream: stop once (later chunks would fail on the same bytes)
        child.stdout!.off('data', onData)
        void this.stop()
        this.o.events.onStop(null)
      }
    }
    child.stdout!.on('data', onData)
    let err = ''
    child.stderr!.on('data', (b: Buffer) => {
      err = (err + b.toString('utf8')).slice(-8192)
      let nl: number
      while ((nl = err.indexOf('\n')) >= 0) {
        const line = err.slice(0, nl); err = err.slice(nl + 1)
        try {
          const e = JSON.parse(line)
          if (e?.event === 'started') this.o.events.onState({ microphone: e.microphone === true, callSound: e.callSound === true, callApps: Array.isArray(e.callApps) ? e.callApps.map(String) : [] })
        } catch { /* not an event line */ }
      }
    })
    child.on('exit', () => { this.child = null; end() })
  }

  /** Stop listening; resolves with every line once the last pieces have their answers. */
  async stop(): Promise<MeetingLine[]> {
    this.ended = true
    const c = this.child
    this.child = null
    // this meeting's own helper only (its PID), never by name
    if (c && c.exitCode === null && c.signalCode === null) {
      c.stdin?.end()
      c.kill('SIGTERM')
      // a helper stuck in Core Audio must not keep the meeting "on"
      setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') }, 3000).unref()
    }
    return this.session.finish()
  }

  lines(): MeetingLine[] { return this.session.all() }

  private async send(wav: Uint8Array): Promise<PieceAnswer> {
    const fd = new FormData()
    fd.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'piece.wav')
    const res = await this.o.session.fetch(this.o.origin + MEETING_PIECE_PATH, { method: 'POST', body: fd, headers: { [CSRF_HEADER]: '1' }, signal: AbortSignal.timeout(PIECE_TIMEOUT_MS) })
    return pieceAnswerOf(res)
  }
}
