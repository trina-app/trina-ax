// Meeting notes behind the bridge (shared/src/desktop-bridge.ts `meeting`, plan 20261116-1903-live-meeting-notes):
// - start(): the app's own dialog every time (not drawn or answered by the page; Cancel is the default button), then one
//   MeetingRun (./meeting.ts) for the open team. One meeting at a time.
// - while listening, a menu bar item drawn by the app ("● 12:03") shows it and stops it: a page cannot hide it.
// - "can't hear the call": a call app runs, the microphone hears speech for 20 s, the call's sound stays silent (a
//   refused macOS permission gives silence, not an error).
// The page gets state and lines (bridge:meeting-state / bridge:meeting-lines), never sound.
import { dialog, Menu, nativeImage, shell, Tray, type BaseWindow, type Session } from 'electron'
import { PRODUCT, type DesktopMeetingLine, type DesktopMeetingState } from '@mycel/shared'
import { t, type UiLocale } from '../common/i18n'
import { meetingHelperPath, MeetingRun } from './meeting'

/** the Settings page where macOS lists "System Audio Recording" (macOS 14.4: Screen Recording) */
export const MAC_SOUND_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
/** speech on the microphone with a silent call track for this long, while a call app runs: say so */
export const NO_CALL_SOUND_MS = 20_000
/** a frame this loud has someone talking in it (the chunker's start threshold) */
const SPEAKING_RMS = 0.004

export interface MeetingControlDeps {
  win(): BaseWindow | null
  locale(): UiLocale
  /** the open team's origin and the team page's session, or null (no team open, signed out) */
  team(): { origin: string; session: Session } | null
  state(s: DesktopMeetingState): void
  lines(l: DesktopMeetingLine[]): void
  /** tests: no dialog, no tray */
  ask?(): Promise<boolean>
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

  constructor(private readonly d: MeetingControlDeps) {}

  /** the bridge version this app offers: 0 where there is no helper (Windows, store build, older macOS) */
  version(): number { return (this.d.helper ?? meetingHelperPath)() ? 1 : 0 }
  running(): boolean { return this.run !== null }
  state(): DesktopMeetingState { return this.s }
  lines(): DesktopMeetingLine[] { return this.run ? this.run.lines() : this.lastLines }

  async start(): Promise<'started' | 'cancelled' | 'busy' | 'unavailable'> {
    if (this.run || this.asking) return 'busy'
    const helper = (this.d.helper ?? meetingHelperPath)()
    if (!helper || !this.d.team()) return 'unavailable'
    this.asking = true
    let yes = false
    try { yes = await (this.d.ask ?? (() => this.askDialog()))() } finally { this.asking = false }
    // the team may have changed or signed out while the dialog was open
    const team = this.d.team()
    if (!yes) return 'cancelled'
    if (!team || this.run) return team ? 'busy' : 'unavailable'
    this.lastLines = []
    this.heard = { me: 0, others: 0, since: Date.now() }
    const run = new MeetingRun({
      helper, origin: team.origin, session: team.session,
      events: {
        onLines: (l) => this.d.lines(l),
        onState: (st) => this.set({ microphone: st.microphone, callSound: st.callSound, callApps: st.callApps }),
        onBacklog: (n) => this.set({ waiting: n }),
        onStop: (message) => { void this.end(message === null ? 'helper' : 'stopped', message ?? undefined) },
        onLevel: (track, rms) => this.level(track, rms),
      },
    })
    this.run = run
    this.set({ state: 'listening', startedAt: Date.now(), problem: undefined, message: undefined, waiting: 0 })
    run.start()
    this.showTray()
    return 'started'
  }

  /** Stop: the last pieces get their words (at most a minute), then every line. */
  async stop(): Promise<DesktopMeetingLine[]> {
    return this.end()
  }

  private async end(problem?: 'stopped' | 'helper', message?: string): Promise<DesktopMeetingLine[]> {
    const run = this.run
    if (!run) return this.lastLines
    this.run = null
    this.hideTray()
    this.set({ state: 'saving', ...(problem ? { problem, message } : {}) })
    const lines = await run.stop()
    this.lastLines = lines
    this.set({ state: 'idle', waiting: 0 })
    return lines
  }

  private level(track: 'me' | 'others', rms: number) {
    if (rms < SPEAKING_RMS) return
    const now = Date.now()
    this.heard[track] = now
    // speech on the microphone for a while, never any on the call track, a call app running: likely refused in macOS
    if (track === 'me' && !this.s.problem && this.s.callApps?.length && !this.heard.others && now - this.heard.since > NO_CALL_SOUND_MS) {
      this.set({ problem: 'no_call_sound' })
    }
    if (track === 'others' && this.s.problem === 'no_call_sound') this.set({ problem: undefined })
  }

  openSoundSettings() { void shell.openExternal(MAC_SOUND_SETTINGS) }

  private set(p: Partial<DesktopMeetingState>) {
    this.s = { ...this.s, ...p }
    for (const k of Object.keys(this.s) as (keyof DesktopMeetingState)[]) if (this.s[k] === undefined) delete this.s[k]
    this.d.state(this.s)
  }

  private async askDialog(): Promise<boolean> {
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
    const L = this.d.locale()
    this.tray = new Tray(nativeImage.createEmpty())
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
