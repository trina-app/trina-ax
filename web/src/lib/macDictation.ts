// Voice input transcribed on this Mac, inside the desktop app (docs/decisions/20261119-mac-dictation.md): Apple's
// SpeechTranscriber behind the bridge (shared/src/desktop-bridge.ts `dictation`), without React. The page records as
// always (lib/recorder.ts, 16 kHz samples) and hands the samples over; the words come back while the person talks:
// a guess for the newest words, replaced as it firms up, after the final words so far. Nothing leaves the Mac, so it
// is used wherever the mic shows, confidential chats and Safe operations 1A included; the team's "voice input off"
// still hides the mic. lib/useVoiceInput.ts picks this when the app language is ready here, else the team server.
// Readiness per language (one store for every box): unknown until checked; ready; preparing while Apple's model for
// it comes down (first use, with how far it is); server where this Mac cannot (Intel, macOS before 26, a language it
// lacks, the helper failed).
// The iPhone app (1.0.10, dictation-v1) offers the same bridge (lib/mobile.ts phoneDictation): the same states, the
// phone's words for "this Mac" (onPhone). The Android app's (1.0.10) holds the microphone itself (ownMic) and is used
// only with a recognizer on the phone.
import type { DesktopDictationEvent } from '@mycel/shared'
import { desktop, type DesktopBridge } from './desktop'
import { phoneDictation, type PhoneDictationBridge } from './mobile'

export type MacDictationBridge = NonNullable<DesktopBridge['dictation']> | PhoneDictationBridge

/** the app opens the microphone itself (the Android app): the page records nothing, the wave follows the app's level */
export const ownMic = (b: MacDictationBridge): b is PhoneDictationBridge => 'ownMic' in b && b.ownMic === true

/** the bridge, inside a desktop app that offers it, else inside the iPhone app that does */
export const macDictationBridge = (b: DesktopBridge | null = desktop()): MacDictationBridge | null => (b ? (b.dictation && b.dictation.version >= 1 ? b.dictation : null) : phoneDictation())

/** voice input is written on the phone (the iPhone app), not on a Mac: the notes say "this phone" */
export const onPhone = (b: DesktopBridge | null = desktop()): boolean => !b && !!phoneDictation()

/** unknown: not asked yet; ready: this Mac transcribes it; model: it can once Apple's model is fetched (the next tap
 * starts that); preparing: the model comes down now, `percent` of it; server: the team server transcribes */
export type MacReadiness = { kind: 'unknown' | 'ready' | 'model' | 'server' } | { kind: 'preparing'; percent: number }

const UNKNOWN: MacReadiness = { kind: 'unknown' }
const states = new Map<string, MacReadiness>()
const checking = new Map<string, Promise<MacReadiness>>()
const watchers = new Set<() => void>()
const set = (language: string, s: MacReadiness) => {
  states.set(language, s)
  watchers.forEach((f) => f())
}

export const macReadiness = (language: string): MacReadiness => states.get(language) ?? UNKNOWN
export const watchMacReadiness = (f: () => void) => {
  watchers.add(f)
  return () => void watchers.delete(f)
}
/** tests */
export function resetMacReadiness() {
  states.clear()
  checking.clear()
  watchers.forEach((f) => f())
}

/** This Mac's answer for the app language, asked once per page. */
export function checkMac(language: string, bridge: MacDictationBridge | null = macDictationBridge()): Promise<MacReadiness> {
  if (!bridge) return Promise.resolve({ kind: 'server' })
  const now = states.get(language)
  if (now) return Promise.resolve(now)
  let c = checking.get(language)
  if (!c) {
    c = bridge.check(language).then(
      (r): MacReadiness => ({ kind: r.state === 'ready' ? 'ready' : r.state === 'needs-model' ? 'model' : 'server' }),
      (): MacReadiness => ({ kind: 'server' }),
    )
    checking.set(language, c)
    void c.then((r) => {
      checking.delete(language)
      if (!states.has(language)) set(language, r)
    })
  }
  return c
}

/** Apple's model for the language comes down now (the first tap of the mic): `preparing` with its progress, then
 * ready; a failed download goes back to `model`, so the next tap tries again. */
export function prepareMac(language: string, bridge: MacDictationBridge | null = macDictationBridge()) {
  if (!bridge || macReadiness(language).kind !== 'model') return
  set(language, { kind: 'preparing', percent: 0 })
  const still = () => macReadiness(language).kind === 'preparing'
  bridge
    .install(language, (percent) => {
      if (still()) set(language, { kind: 'preparing', percent: Math.max(0, Math.min(100, Math.floor(percent))) })
    })
    .then(
      (r) => { if (still()) set(language, { kind: r === 'installed' ? 'ready' : r === 'unsupported' ? 'server' : 'model' }) },
      () => { if (still()) set(language, { kind: 'model' }) },
    )
}

/** the helper failed in a recording: the server for the rest of this page's life */
export function macFailed(language: string) {
  set(language, { kind: 'server' })
}

/** the app language as the Mac takes it (two or three letters), else null */
export const macLanguage = (locale: string): string | null => (/^[a-z]{2,3}$/.test(locale) ? locale : null)

/** languages written without spaces between words: their pieces join as they are */
const NO_SPACES = new Set(['ja', 'zh'])

/** The final words so far and the newest guess, as the box shows them. */
export function shownText(finals: readonly string[], guess: string, language: string): string {
  const sep = NO_SPACES.has(language) ? '' : ' '
  let s = ''
  for (const part of [...finals, guess]) {
    const p = part.trim()
    if (!p) continue
    s = s ? s + sep + p : p
  }
  return s.replace(/[ \t]{2,}/g, ' ')
}

export interface OnDeviceDeps {
  bridge: MacDictationBridge
  language: string
  /** the whole text heard so far (final words, then the newest guess), each time it changes */
  onText(text: string): void
  /** it stopped before Stop: the helper failed or stopped answering (the words so far stay) */
  onFail(code: string): void
}

/** One recording transcribed on this Mac: start() (false: it could not, use the team server), push() while recording,
 * finish() after Stop (the last words, every one final), cancel() for Esc / ✕. */
export class OnDeviceRun {
  private id: number | null = null
  private finals: string[] = []
  private guess = ''
  private off: (() => void) | null = null
  private ended = false
  private settled: ((r: { text: string; ok: boolean }) => void) | null = null
  private result: { text: string; ok: boolean } | null = null
  /** words were shown */
  heard = false

  constructor(private readonly d: OnDeviceDeps) {}

  text(): string {
    return shownText(this.finals, this.guess, this.d.language)
  }

  async start(): Promise<boolean> {
    this.off = this.d.bridge.onEvent((e) => this.on(e))
    let id: number | null = null
    try {
      id = await this.d.bridge.start(this.d.language)
    } catch {
      id = null
    }
    if (this.ended) {
      if (typeof id === 'number') this.d.bridge.cancel(id)
      return false
    }
    if (typeof id !== 'number') {
      this.close()
      return false
    }
    this.id = id
    return true
  }

  push(samples: Float32Array) {
    if (this.id !== null && !this.ended && samples.length) this.d.bridge.push(this.id, samples)
  }

  /** Stop: resolves with the whole text once the Mac has made every word final (ok false: it failed on the way; the
   * words so far are the text then) */
  finish(): Promise<{ text: string; ok: boolean }> {
    if (this.result) return Promise.resolve(this.result)
    if (this.id === null || this.ended) return Promise.resolve(this.end(false))
    return new Promise((resolve) => {
      this.settled = resolve
      this.d.bridge.stop(this.id!)
    })
  }

  cancel() {
    if (this.id !== null && !this.ended) this.d.bridge.cancel(this.id)
    this.ended = true
    this.close()
  }

  private on(e: DesktopDictationEvent) {
    if (this.ended || this.id === null || e.id !== this.id) return
    if (e.event === 'text') {
      if (e.final) {
        this.finals.push(e.text)
        this.guess = ''
      } else this.guess = e.text
      const t = this.text()
      if (t) this.heard = true
      this.d.onText(t)
    } else if (e.event === 'done') {
      this.end(true)
    } else if (e.event === 'error') {
      const waiting = this.settled !== null
      this.end(false)
      if (!waiting) this.d.onFail(e.code)
    }
  }

  private end(ok: boolean) {
    // a guess never made final (the helper failed) is still what the person said: it stays
    const r = { text: this.text(), ok }
    this.result = r
    this.ended = true
    this.close()
    const s = this.settled
    this.settled = null
    s?.(r)
    return r
  }

  private close() {
    this.off?.()
    this.off = null
  }
}
