// Voice input transcribed on the iPhone itself (dictation-v1, docs/decisions/20261119-iphone-dictation.md): the
// page's recording and its words, between the bridge (src/bridge.ts MobileReceiver) and the app's Dictation module
// (modules/dictation/ios). Pure: no native imports, so the tests run it without Expo.
//
// One recording at a time, owned by the document that started it (its nonce and generation). Its words go back only
// to that document (dictationEventScript), and a fence (navigation, a session reset, a team change) cancels it: no
// words of one page reach the next.
import { dictationEventBody, dictationInstall, dictationState, type DictationEvent, type DictationEventBody, type DictationInstall, type DictationState } from './protocol'

/** The app's Dictation module (modules/dictation/ios/DictationModule.swift), numbers for the recordings. */
export interface DictationNative {
  check(language: string): Promise<{ state?: unknown; micInApp?: unknown; onDevice?: unknown }>
  install(n: number, language: string): Promise<unknown>
  start(n: number, language: string): Promise<boolean>
  push(n: number, b64: string): void
  stop(n: number): void
  cancel(n: number): void
  addListener(event: 'onDictation', cb: (e: Record<string, unknown>) => void): { remove(): void }
}

export interface DictationOwner { id: string; nonce: string; generation: number }

interface Run { n: number; owner: DictationOwner; seq: number; kind: 'record' | 'install' }

export class PhoneDictation {
  private next = 1
  private runs = new Map<number, Run>()
  private recording: Run | null = null
  private sub: { remove(): void } | null = null

  constructor(private native: DictationNative, private deliver: (e: DictationEvent) => void) {}

  private listen() {
    if (this.sub) return
    this.sub = this.native.addListener('onDictation', e => this.on(e))
  }

  private on(raw: Record<string, unknown>) {
    const n = typeof raw.id === 'number' ? raw.id : -1
    const run = this.runs.get(n)
    const body = dictationEventBody(raw)
    if (!run || !body) return
    // a model download says only how far it is; a recording only its words
    if ((run.kind === 'install') !== (body.event === 'progress')) return
    if (body.event === 'done' || body.event === 'error') this.end(run)
    this.send(run, body)
  }

  private send(run: Run, body: DictationEventBody) {
    this.deliver({ v: 1, type: 'mobile-dictation', id: run.owner.id, nonce: run.owner.nonce, generation: run.owner.generation, ...body })
  }

  private end(run: Run) {
    this.runs.delete(run.n)
    if (this.recording === run) this.recording = null
  }

  private find(owner: DictationOwner): Run | null {
    const r = this.recording
    return r && r.owner.id === owner.id && r.owner.nonce === owner.nonce && r.owner.generation === owner.generation ? r : null
  }

  async check(language: string): Promise<DictationState> {
    return (await this.checkDetail(language)).state
  }

  /** the state, and on Android (1.0.10) that the app holds the microphone (`micInApp`) and whether the recognizer is
   * on the phone */
  async checkDetail(language: string, page?: { nonce: string; appMic: boolean }): Promise<{ state: DictationState; micInApp?: true; onDevice?: boolean }> {
    const r = await this.native.check(language).catch(() => null) as { state?: unknown; micInApp?: unknown; onDevice?: unknown } | null
    const state = dictationState(r?.state) ? r.state : 'unsupported'
    if (r?.micInApp === true) {
      this.micInApp = true
      // a page that knows only the iPhone's way would record too and treat any recognizer as on the phone
      if (!page?.appMic) return { state: 'unsupported' }
      if (this.appMicPages.size > 50) this.appMicPages.clear()
      this.appMicPages.add(page.nonce)
    }
    if (state === 'unsupported' || r?.micInApp !== true) return { state }
    return { state, micInApp: true, onDevice: r.onDevice !== false }
  }

  async install(owner: DictationOwner, language: string): Promise<DictationInstall> {
    this.listen()
    const run: Run = { n: this.next++, owner, seq: 0, kind: 'install' }
    this.runs.set(run.n, run)
    try {
      const r = await this.native.install(run.n, language).catch(() => 'failed')
      return dictationInstall(r) ? r : 'failed'
    } finally { this.runs.delete(run.n) }
  }

  /** the module holds the microphone (Android): only a page that said it can take that (appMic) may use it */
  private micInApp = false
  /** the pages (nonces) whose check said appMic */
  private appMicPages = new Set<string>()

  /** true once the phone listens; a recording before this one ends (one at a time) */
  async start(owner: DictationOwner, language: string): Promise<boolean> {
    if (this.micInApp && !this.appMicPages.has(owner.nonce)) return false
    this.listen()
    if (this.recording) this.cancelRun(this.recording)
    const run: Run = { n: this.next++, owner, seq: 0, kind: 'record' }
    this.runs.set(run.n, run)
    this.recording = run
    const ok = await this.native.start(run.n, language).catch(() => false)
    // fenced or replaced while the recognizer got ready: it was cancelled then, and the module gives way itself
    if (this.recording !== run) { this.runs.delete(run.n); return false }
    if (!ok) { this.end(run); return false }
    return true
  }

  /** the recording's sound, in order; anything else (another document, a gap, a repeat) is dropped */
  push(owner: DictationOwner, seq: number, b64: string): void {
    const r = this.find(owner)
    if (!r || seq !== r.seq) return
    r.seq++
    this.native.push(r.n, b64)
  }

  /** the sound ended: the last words, then done, still go to this document */
  stop(owner: DictationOwner): void {
    const r = this.find(owner)
    if (!r) return
    this.recording = null
    this.native.stop(r.n)
  }

  cancel(owner: DictationOwner): void {
    const r = this.find(owner)
    if (r) this.cancelRun(r)
  }

  private cancelRun(r: Run) {
    this.end(r)
    this.native.cancel(r.n)
  }

  /** The fence: every recording and download goes, nothing more is delivered to any page. */
  clear(): void {
    for (const r of [...this.runs.values()]) {
      this.runs.delete(r.n)
      if (r.kind === 'record') this.native.cancel(r.n)
    }
    this.recording = null
  }
}
