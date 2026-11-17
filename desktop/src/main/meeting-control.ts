// Meeting notes behind the bridge (shared/src/desktop-bridge.ts `meeting`, plan 20261116-1903-live-meeting-notes):
// - start(): the app's own dialog every time (not drawn or answered by the page; Cancel is the default button), then one
//   MeetingRun (./meeting.ts) for the open team. One meeting at a time.
// - while listening, a menu bar item drawn by the app ("● 12:03") shows it and stops it: a page cannot hide it.
// - "can't hear the call": a call app runs, the microphone hears speech for 20 s, the call's sound stays silent (a
//   refused macOS permission gives silence, not an error).
// The page gets state and lines (bridge:meeting-state / bridge:meeting-lines), never sound.
import fs from 'node:fs'
import path from 'node:path'
// Electron's dialog, menu bar item and shell are required when used (the unit tests run this file without Electron;
// the bundle keeps electron external, so this is the same require the other main files make)
import type { BaseWindow, Session, Tray } from 'electron'
const electron = (): typeof import('electron') => require('electron')
import { PRODUCT, type DesktopMeetingLine, type DesktopMeetingState } from '@mycel/shared'
import { t, type UiLocale } from '../common/i18n'
import { meetingHelperPath, MeetingRun } from './meeting'

/** the Settings page where macOS lists "System Audio Recording" (macOS 14.4: Screen Recording) */
export const MAC_SOUND_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
/** speech on the microphone with a silent call track for this long, while a call app runs: say so */
export const NO_CALL_SOUND_MS = 20_000
/** a frame this loud has someone talking in it (the chunker's start threshold) */
const SPEAKING_RMS = 0.004
/** nobody spoke on either track for this long: the meeting stops by itself */
export const MEETING_SILENCE_MS = 10 * 60_000
/** the longest meeting */
export const MEETING_MAX_MS = 4 * 60 * 60_000
/** start() only right after the person's own key or click on the team page (a page script alone cannot ask) */
export const MEETING_INPUT_MS = 3000
/** after a Cancel, the dialog is not shown again this soon */
export const MEETING_CANCEL_PAUSE_MS = 3000
/** call apps whose sound is only a call (browsers and Slack also play other things, so they don't prove a call) */
const CALL_ONLY_APPS = new Set(['us.zoom.xos', 'com.microsoft.teams2', 'com.microsoft.teams', 'com.cisco.webexmeetingsapp', 'Cisco-Systems.Spark', 'com.apple.FaceTime'])
/** the last meeting's lines, kept until the page says its note is saved */
const UNSAVED_FILE = 'meeting-unsaved.json'

export interface MeetingControlDeps {
  win(): BaseWindow | null
  locale(): UiLocale
  /** the open team's origin and the team page's session, or null (no team open, signed out) */
  team(): { id: string; userId: string | null; origin: string; session: Session } | null
  state(s: DesktopMeetingState): void
  lines(l: DesktopMeetingLine[]): void
  /** when the person last pressed a key or clicked on the team page (Electron's input events) */
  lastInput(): number
  /** where the unsaved lines are kept (the app's data folder) */
  dataDir: string
  /** tests: no dialog, no tray */
  ask?(): Promise<boolean>
  now?(): number
  tray?: boolean
  helper?(): string | null
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(r).padStart(2, '0')}`
}

export class MeetingControl {
  private run: MeetingRun | null = null
  private s: DesktopMeetingState = { state: 'idle' }
  private asking = false
  private tray: Tray | null = null
  private tick?: NodeJS.Timeout
  private heard = { me: 0, others: 0, since: 0 }
  private lastLines: DesktopMeetingLine[] = []
  private teamOrigin: string | null = null
  private teamIdNow: string | null = null
  private userNow: string | null = null
  private cancelledAt = 0
  private watchdog?: NodeJS.Timeout
  private lastSpeech = 0

  constructor(private readonly d: MeetingControlDeps) {}

  /** the bridge version this app offers: 0 where there is no helper (Windows, store build, older macOS) */
  version(): number { return (this.d.helper ?? meetingHelperPath)() ? 1 : 0 }
  running(): boolean { return this.run !== null }
  /** the team origin of the meeting under way, else null */
  origin(): string | null { return this.run ? this.teamOrigin : null }
  /** the team of the meeting under way (by id: on an office network its origin is the direct address) */
  teamId(): string | null { return this.run ? this.teamIdNow : null }
  private clock(): number { return this.d.now?.() ?? Date.now() }
  state(): DesktopMeetingState { return this.s }
  lines(): DesktopMeetingLine[] { return this.run ? this.run.lines() : this.lastLines }

  async start(): Promise<'started' | 'cancelled' | 'busy' | 'unavailable'> {
    if (this.run || this.asking) return 'busy'
    const helper = (this.d.helper ?? meetingHelperPath)()
    const before = this.d.team()
    if (!helper || !before) return 'unavailable'
    const now = this.clock()
    // only right after the person's own key or click, and not again at once after a Cancel
    if (now - this.d.lastInput() > MEETING_INPUT_MS || now - this.cancelledAt < MEETING_CANCEL_PAUSE_MS) return 'cancelled'
    this.asking = true
    let yes = false
    try { yes = await (this.d.ask ?? (() => this.askDialog()))() } finally { this.asking = false }
    if (!yes) { this.cancelledAt = this.clock(); return 'cancelled' }
    // the team changed or signed out while the dialog was open: not this meeting
    const team = this.d.team()
    if (!team || team.origin !== before.origin || team.session !== before.session) return 'cancelled'
    if (this.run) return 'busy'
    this.lastLines = []
    this.teamOrigin = team.origin
    this.teamIdNow = team.id
    this.userNow = team.userId
    this.heard = { me: 0, others: 0, since: this.clock() }
    this.lastSpeech = this.clock()
    const run = new MeetingRun({
      helper, origin: team.origin, session: team.session,
      events: {
        onLines: (l) => { this.d.lines(l); this.keep() },
        onState: (st) => this.set({ microphone: st.microphone, callSound: st.callSound, callApps: st.callApps }),
        onBacklog: (n) => this.set({ waiting: n }),
        onStop: (message) => { void this.end(message === null ? 'helper' : 'stopped', message ?? undefined) },
        onLevel: (track, rms) => this.level(track, rms),
      },
    })
    this.run = run
    this.set({ state: 'listening', startedAt: this.clock(), problem: undefined, message: undefined, waiting: 0 })
    run.start()
    this.showTray()
    // stops by itself after 10 minutes with nobody speaking, and at 4 hours
    this.watchdog = setInterval(() => {
      const t = this.clock()
      if (t - this.lastSpeech > MEETING_SILENCE_MS) void this.end('silence')
      else if (this.s.startedAt && t - this.s.startedAt > MEETING_MAX_MS) void this.end('too_long')
    }, 15_000)
    return 'started'
  }

  /** Stop: the last pieces get their words (at most a minute), then every line. */
  async stop(): Promise<DesktopMeetingLine[]> {
    return this.end()
  }

  private async end(problem?: 'stopped' | 'helper' | 'silence' | 'too_long', message?: string): Promise<DesktopMeetingLine[]> {
    const run = this.run
    if (!run) return this.lastLines
    this.run = null
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = undefined
    this.hideTray()
    this.set({ state: 'saving', ...(problem ? { problem, message } : {}) })
    const lines = await run.stop()
    this.lastLines = lines
    this.keep(lines)
    this.set({ state: 'idle', waiting: 0 })
    return lines
  }

  /** The meeting's lines on this computer until the page says its note is saved (the window may close, the app quit). */
  private keep(lines?: DesktopMeetingLine[]) {
    const startedAt = this.s.startedAt
    if (!startedAt) return
    const all = lines ?? this.run?.lines() ?? this.lastLines
    // whose they are: only that team's page, signed in as that person, is offered them
    try { fs.writeFileSync(path.join(this.d.dataDir, UNSAVED_FILE), JSON.stringify({ startedAt, teamId: this.teamIdNow, userId: this.userNow, lines: all }), { mode: 0o600 }) } catch { /* kept in memory only */ }
  }

  /** the last meeting's lines when the page has not said they are saved (none while a meeting runs) */
  unsaved(): { startedAt: number; lines: DesktopMeetingLine[] } | null {
    if (this.run) return null
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.d.dataDir, UNSAVED_FILE), 'utf8'))
      if (typeof v?.startedAt !== 'number' || !Array.isArray(v.lines) || !v.lines.length) return null
      const team = this.d.team()
      if (!team || v.teamId !== team.id || !v.userId || v.userId !== team.userId) return null
      const lines = (v.lines as unknown[]).filter((l: any) => l && (l.track === 'me' || l.track === 'others') && typeof l.text === 'string' && Number.isFinite(l.startMs) && Number.isFinite(l.endMs)).slice(0, 20_000) as DesktopMeetingLine[]
      return lines.length ? { startedAt: v.startedAt, lines } : null
    } catch { return null }
  }

  /** the page saved the note of the meeting that started at `startedAt`: forget its lines */
  saved(startedAt: number) {
    const u = this.unsaved()
    if (u && u.startedAt === startedAt) { try { fs.rmSync(path.join(this.d.dataDir, UNSAVED_FILE), { force: true }) } catch { /* gone */ } }
  }

  private level(track: 'me' | 'others', rms: number) {
    if (rms < SPEAKING_RMS) return
    const now = this.clock()
    this.heard[track] = now
    this.lastSpeech = now
    // speech on the microphone for a while, never any on the call track while a call-only app runs and its tap is up:
    // likely refused in macOS (a browser or Slack being open proves no call)
    const inCall = this.s.callSound === true && (this.s.callApps ?? []).some((a) => CALL_ONLY_APPS.has(a))
    if (track === 'me' && !this.s.problem && inCall && !this.heard.others && now - this.heard.since > NO_CALL_SOUND_MS) {
      this.set({ problem: 'no_call_sound' })
    }
    if (track === 'others' && this.s.problem === 'no_call_sound') this.set({ problem: undefined })
  }

  openSoundSettings() { void electron().shell.openExternal(MAC_SOUND_SETTINGS) }

  private set(p: Partial<DesktopMeetingState>) {
    this.s = { ...this.s, ...p }
    for (const k of Object.keys(this.s) as (keyof DesktopMeetingState)[]) if (this.s[k] === undefined) delete this.s[k]
    this.d.state(this.s)
  }

  private async askDialog(): Promise<boolean> {
    const { dialog } = electron()
    const L = this.d.locale()
    const w = this.d.win()
    const opts = {
      type: 'question' as const,
      message: t(L, 'meeting.askTitle'),
      detail: t(L, 'meeting.askDetail', { app: PRODUCT.displayName }),
      buttons: [t(L, 'meeting.cancel'), t(L, 'meeting.start')],
      // Cancel is the default: Enter or Escape from someone typing in the page answers no
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
    return r.response === 1
  }

  private showTray() {
    if (this.d.tray === false || this.tray) return
    this.drawTray(electron())
  }

  private drawTray({ Menu, nativeImage, Tray: TrayClass }: typeof import('electron')) {
    if (this.tray || !this.run) return
    const L = this.d.locale()
    this.tray = new TrayClass(nativeImage.createEmpty())
    this.tray.setToolTip(t(L, 'meeting.tray'))
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: t(L, 'meeting.tray'), enabled: false },
      { label: t(L, 'meeting.trayStop'), click: () => { void this.stop() } },
    ]))
    const draw = () => { if (this.tray && this.s.startedAt) this.tray.setTitle(`● ${fmt(Date.now() - this.s.startedAt)}`) }
    draw()
    this.tick = setInterval(draw, 1000)
  }

  private hideTray() {
    if (this.tick) clearInterval(this.tick)
    this.tick = undefined
    this.tray?.destroy()
    this.tray = null
  }
}
