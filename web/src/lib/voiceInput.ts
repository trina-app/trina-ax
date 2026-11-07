// Voice input's moves for one message box, without React or the page (docs/DECISIONS.md "Voice input in rooms and hold
// Space"); lib/useVoiceInput.ts runs it with the microphone, the upload and the box.
//
// idle → waiting (Space held in the box, up to HOLD_MS) → starting (the microphone is asked for) → recording (hold:
// ends when Space or the finger is let go; toggle: ends with ✓; press: a finger on the mic for less than HOLD_MS so
// far) → transcribing (the upload and the job) → idle, the words at the end of the box. Never sent by itself.
//
// Hold Space (computers only, the caller says so): a plain Space in the box (no repeat, no IME, no modifier, no "/",
// "#" or "@" list open) waits. In an empty box the Space is held back; in a box with text it types as usual and later
// Spaces are held back. Another key, the Space let go or the window left before HOLD_MS end the wait: the Space is a
// Space (a held-back one is typed then), so typing is unchanged. At HOLD_MS the typed Space is taken back and the
// recording starts. Letting go of Space transcribes, Esc cancels (while transcribing too), the window losing focus or
// the tab being hidden transcribes, the cap (CAP_MS) transcribes what was recorded.
// The mic: a click toggles. A finger on it records at once: let go within HOLD_MS (a tap) and it goes on until ✓; hold
// on and letting go transcribes, sliding DRAG_CANCEL_PX away cancels. A finger let go while the browser still asks for
// the microphone leaves it recording until ✓ (the person had to let go to answer the question).

/** Space or a finger held this long starts a hold */
export const HOLD_MS = 400
/** the longest recording: what was recorded by then is transcribed */
export const CAP_MS = 5 * 60_000
/** the time left shows from here on */
export const WARN_MS = 30_000
/** a finger this far from where it pressed the mic cancels */
export const DRAG_CANCEL_PX = 64
/** a hold let go sooner after the recording started has nothing to say: dropped, no job */
export const MIN_HOLD_RECORDING_MS = 300

export type VoicePhase = 'idle' | 'waiting' | 'starting' | 'recording' | 'transcribing'
export type VoiceMode = 'hold' | 'toggle' | 'press'
export type VoiceVia = 'space' | 'touch' | 'click'
/** what the page's live region says */
export type VoiceLive = 'recording' | 'transcribing' | 'inserted' | null
export type VoiceNote = { kind: 'blocked' } | { kind: 'empty' } | { kind: 'error'; error: unknown }

/** the parts of a KeyboardEvent this reads */
export interface KeyLike {
  key: string
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  preventDefault(): void
  stopPropagation?(): void
}

export interface BoxState {
  value: string
  selectionStart: number
  selectionEnd: number
}

export interface VoiceDeps {
  /** turn the microphone on (rejects when it cannot: no permission, no recorder) */
  start(): Promise<void>
  /** turn it off and hand over what it recorded (null: nothing) */
  stop(): Promise<File | null>
  /** turn it off and drop what it recorded */
  cancel(): void
  /** the recording's words ('' when nothing was heard); the signal aborts it */
  transcribe(file: File, signal: AbortSignal): Promise<string>
  /** the words for the end of the box */
  append(said: string): void
  /** the Space held back in an empty box after all: one space at the caret */
  typeSpace(): void
  /** take back the Space typed at `at` */
  removeSpace(at: number): void
  /** focus the box once it is shown; the caret at `at` (null: the end) */
  focusBox(at: number | null): void
  /** a note under the box (null clears it) */
  note(n: VoiceNote | null): void
  /** this place does not take voice input (a confidential chat or room and an outside speech service) */
  blocked(): boolean
  /** the browser said the microphone is allowed, so no question shows */
  granted(): boolean
  /** a hold of Space recorded (the hint for click users stops) */
  holdUsed(): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  now(): number
  /** something shown changed */
  changed(): void
}

/** A transcription job's own words while it runs and how far it is (the first recording on a server that downloads its
 * speech model: "음성 인식 모델 내려받는 중 (488 MB, 처음 한 번만) · 23%"); null when it has none. */
export function jobLabel(job: { message: string | null; progress: number | null } | null | undefined): string | null {
  if (!job?.message) return null
  return job.progress === null || job.progress === undefined ? job.message : `${job.message} · ${Math.round(job.progress * 100)}%`
}

/** A Space that may start a hold: pressed now (not repeating), not an IME's (Korean, Japanese), no modifier. */
export function plainSpace(e: KeyLike): boolean {
  return e.key === ' ' && !e.repeat && !e.isComposing && e.keyCode !== 229 && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
}

export class VoiceInput {
  phase: VoicePhase = 'idle'
  mode: VoiceMode | null = null
  via: VoiceVia | null = null
  live: VoiceLive = null
  private wait: { swallowed: boolean; at: number; timer: unknown } | null = null
  /** Space was held into a recording (or a refusal): its repeats are held back until it is let go */
  private holdingSpace = false
  /** asked while the microphone was still starting: what happens once it is on */
  private after: 'stop' | 'cancel' | null = null
  private grantedAtStart = false
  private recordingSince = 0
  private press: { x: number; y: number } | null = null
  private pressTimer: unknown = null
  private cap: unknown = null
  private abort: AbortController | null = null
  /** where the caret goes back to when a hold is cancelled */
  private caret: number | null = null
  /** each recording's number: a late answer of an earlier one does nothing */
  private run = 0

  constructor(private d: VoiceDeps) {}

  /** recording, or its words on their way: the box waits (read-only), nothing is sent */
  get busy() {
    return this.phase === 'starting' || this.phase === 'recording' || this.phase === 'transcribing'
  }

  /** A key in the message box, after its lists had their turn. `hold`: Space may start a hold here (a computer, the
   * mic shown and usable). true: the key was taken. */
  boxKeyDown(e: KeyLike, box: BoxState, o: { hold: boolean; menuOpen: boolean }): boolean {
    if (this.phase !== 'idle' || !o.hold || o.menuOpen || !plainSpace(e)) return false
    // a selection: the Space replaces it, as typing does
    if (box.selectionStart !== box.selectionEnd) return false
    const swallowed = box.value.length === 0
    if (swallowed) e.preventDefault()
    this.wait = { swallowed, at: box.selectionStart, timer: this.d.setTimeout(() => this.held(), HOLD_MS) }
    this.set('waiting')
    return swallowed
  }

  /** Any key going down in the window (capture: before the box's own handler). `onControl`: it is aimed at a button or
   * field of the page (where Space does what it does there). `ours`: it is aimed at this box, its bar or the page itself
   * (not another box, a menu, a list or a dialog, where Esc closes that); Esc cancels only then, or during a Space hold. */
  windowKeyDown(e: KeyLike, at: { onControl?: boolean; ours?: boolean } = {}) {
    const onControl = at.onControl ?? false
    const escape = e.key === 'Escape' && (at.ours !== false || this.holdingSpace)
    switch (this.phase) {
      case 'waiting':
        // its repeats are held back; any other key ends the wait first (a held-back Space goes in before it)
        if (e.key === ' ') e.preventDefault()
        else this.endWait()
        return
      case 'starting':
      case 'recording':
        if (escape) return this.escape(e)
        // a held Space never types or scrolls the page; in a toggle recording it still works on a button
        if (e.key === ' ' && (this.holdingSpace || this.mode !== 'toggle' || !onControl)) e.preventDefault()
        return
      case 'transcribing':
        if (escape) return this.escape(e)
        if (e.key === ' ' && this.holdingSpace) e.preventDefault()
        return
      case 'idle':
        if (e.key === ' ' && this.holdingSpace) e.preventDefault()
    }
  }

  windowKeyUp(e: KeyLike) {
    if (e.key !== ' ') return
    const held = this.holdingSpace
    this.holdingSpace = false
    if (this.phase === 'waiting') return this.endWait()
    if (!held || this.via !== 'space') return
    if (this.phase === 'starting' && this.mode === 'hold') this.letGo()
    else if (this.phase === 'recording' && this.mode === 'hold') void this.finish()
  }

  /** The window lost the focus or the tab was hidden: a hold never stays on (a recording started with a click does). */
  away() {
    if (this.phase === 'waiting') return this.endWait()
    if (this.press) return this.pressEnd()
    const held = this.holdingSpace
    this.holdingSpace = false
    if (!held || this.via !== 'space' || this.mode !== 'hold') return
    if (this.phase === 'starting') this.letGo()
    else if (this.phase === 'recording') void this.finish()
  }

  /** The mic clicked (a mouse, a pen, the keyboard): starts a recording that ends with ✓. */
  click() {
    if (this.phase === 'idle') this.begin('toggle', 'click')
  }

  /** A finger on the mic. false: nothing started (busy, or this place says no). */
  pressStart(x: number, y: number): boolean {
    if (this.phase !== 'idle') return false
    this.begin('press', 'touch')
    // (begin changed the phase, or left it idle when this place says no)
    if ((this.phase as VoicePhase) !== 'starting') return false
    this.press = { x, y }
    this.pressTimer = this.d.setTimeout(() => {
      this.pressTimer = null
      if (this.mode !== 'press' || !this.press) return
      this.mode = 'hold'
      this.d.changed()
    }, HOLD_MS)
    return true
  }

  pressMove(x: number, y: number) {
    const p = this.press
    if (!p || Math.hypot(x - p.x, y - p.y) <= DRAG_CANCEL_PX) return
    this.clearPress()
    this.cancel()
  }

  /** The finger let go (or the system took the touch). */
  pressEnd() {
    if (!this.press) return
    this.clearPress()
    // a tap, or a finger let go to answer the browser's question: on until ✓
    if (this.phase === 'starting' || this.mode === 'press') {
      this.mode = 'toggle'
      return this.d.changed()
    }
    if (this.phase === 'recording' && this.mode === 'hold') void this.finish()
  }

  /** ✓, letting go of a hold, the cap: the recording's words go to the box. */
  async finish() {
    if (this.phase === 'starting') {
      this.after = 'stop'
      return
    }
    if (this.phase !== 'recording') return
    // a hold let go at once (Space held just past HOLD_MS): nothing was said, no job for it
    if (this.mode === 'hold' && this.d.now() - this.recordingSince < MIN_HOLD_RECORDING_MS) return this.cancel()
    this.clearRecording()
    const run = this.run
    const abort = new AbortController()
    this.abort = abort
    const via = this.via
    this.set('transcribing')
    if (via !== 'touch') this.d.focusBox(null)
    let file: File | null = null
    try {
      file = await this.d.stop()
    } catch {
      file = null
    }
    if (abort.signal.aborted || run !== this.run) return
    if (!file) return this.reset()
    try {
      const said = (await this.d.transcribe(file, abort.signal)).trim()
      if (abort.signal.aborted || run !== this.run) return
      this.reset()
      if (said) {
        this.d.append(said)
        this.live = 'inserted'
        this.d.focusBox(null)
      } else this.d.note({ kind: 'empty' })
    } catch (e) {
      if (abort.signal.aborted || run !== this.run) return
      this.reset()
      this.d.note({ kind: 'error', error: e })
    }
    this.d.changed()
  }

  /** ✕, Esc, a finger slid away: nothing goes to the box. */
  cancel() {
    switch (this.phase) {
      case 'waiting':
        return this.endWait()
      case 'starting':
        this.after = 'cancel'
        return
      case 'recording': {
        const via = this.via
        this.clearRecording()
        this.d.cancel()
        this.run++
        this.reset()
        if (via !== 'touch') this.d.focusBox(this.caret)
        return
      }
      case 'transcribing':
        this.abort?.abort()
        this.run++
        this.reset()
    }
  }

  /** The box goes away (another chat or room): nothing goes on in the background. */
  dispose() {
    if (this.wait) this.d.clearTimeout(this.wait.timer)
    this.wait = null
    this.holdingSpace = false
    this.clearPress()
    this.clearRecording()
    if (this.phase === 'recording') this.d.cancel()
    this.abort?.abort()
    // a microphone still starting is turned off when it is on (start's answer sees the new run)
    this.run++
    this.after = null
    this.phase = 'idle'
    this.mode = null
    this.via = null
    this.live = null
  }

  private escape(e: KeyLike) {
    e.preventDefault()
    e.stopPropagation?.()
    this.cancel()
  }

  /** The wait ends before HOLD_MS: the Space is a Space. */
  private endWait() {
    const w = this.wait
    if (!w) return
    this.d.clearTimeout(w.timer)
    this.wait = null
    if (w.swallowed) this.d.typeSpace()
    this.set('idle')
  }

  /** Space held for HOLD_MS. */
  private held() {
    const w = this.wait
    if (!w || this.phase !== 'waiting') return
    this.wait = null
    if (!w.swallowed) this.d.removeSpace(w.at)
    this.caret = w.at
    this.holdingSpace = true
    this.phase = 'idle'
    this.begin('hold', 'space')
  }

  /** Space let go while the microphone is still starting: when the browser asks for it, the person let go to answer
   * (it goes on until ✓); when it was already allowed, the recording ends as soon as it is on. */
  private letGo() {
    if (this.grantedAtStart) this.after = 'stop'
    else this.mode = 'toggle'
    this.d.changed()
  }

  private begin(mode: VoiceMode, via: VoiceVia) {
    this.d.note(null)
    if (this.d.blocked()) {
      this.d.note({ kind: 'blocked' })
      this.d.changed()
      return
    }
    if (via !== 'space') this.caret = null
    const run = ++this.run
    this.mode = mode
    this.via = via
    this.after = null
    this.grantedAtStart = this.d.granted()
    this.set('starting')
    this.d.start().then(
      () => {
        if (run !== this.run) return this.d.cancel()
        const after = this.after
        this.after = null
        if (after === 'cancel') {
          this.d.cancel()
          this.run++
          this.reset()
          if (via !== 'touch') this.d.focusBox(this.caret)
          return
        }
        if (via === 'space') this.d.holdUsed()
        this.recordingSince = this.d.now()
        this.cap = this.d.setTimeout(() => void this.finish(), CAP_MS)
        this.set('recording')
        if (after === 'stop') void this.finish()
      },
      (e) => {
        if (run !== this.run) return
        // cancelled while the browser asked: no note; and a microphone half on (a recorder that failed after it) goes off
        const cancelled = this.after === 'cancel'
        this.clearPress()
        this.d.cancel()
        this.reset()
        if (!cancelled) this.d.note({ kind: 'error', error: e })
        if (via !== 'touch') this.d.focusBox(this.caret)
      },
    )
  }

  private clearPress() {
    this.press = null
    if (this.pressTimer !== null) this.d.clearTimeout(this.pressTimer)
    this.pressTimer = null
  }

  private clearRecording() {
    if (this.cap !== null) this.d.clearTimeout(this.cap)
    this.cap = null
    this.clearPress()
  }

  private reset() {
    this.abort = null
    this.after = null
    this.mode = null
    this.via = null
    this.set('idle')
  }

  private set(phase: VoicePhase) {
    this.phase = phase
    if (phase === 'recording') this.live = 'recording'
    else if (phase === 'transcribing') this.live = 'transcribing'
    else if (phase === 'idle' || phase === 'starting') this.live = null
    this.d.changed()
  }
}
