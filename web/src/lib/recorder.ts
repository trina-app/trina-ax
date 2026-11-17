// Microphone recorder for voice input (ported from Saram web/src/lib/recorder.ts): elapsed time and a live input
// level for the meter. The recording goes to POST /api/transcribe (a job) and the text lands in the composer.
// Live (start's `onSamples`, lib/liveDictation.ts): no recording file; the sound goes out as 16 kHz samples while it is
// recorded, through a ScriptProcessor (deprecated, but in every browser and WebView; an AudioWorklet would need a
// module URL the page's script rules allow).
// A microphone that gives no sound (muted, switched off, the wrong input picked, another program holding it) records
// without an error and the wave stays a row of dots: after SILENT_AFTER_MS with nothing heard since the start,
// `silent` says so until the first sound (lib/useVoiceInput.ts shows "No sound yet…" in the bar), live or not. Someone
// who has not spoken yet looks the same from here, so the words say only that.
import { useEffect, useRef, useState } from 'react'
import { downsampler } from './liveDictation'

/** A recording format the browser supports (Chrome/Firefox: webm/opus, Safari: mp4/aac). */
function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return candidates.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? ''
}

/** The wave in the recording bar (components/VoiceBar.tsx): a bar is never shorter than a dot, never taller than this. */
export const WAVE_DOT_PX = 3
export const WAVE_MAX_PX = 32
/** A level at or under this draws every bar as a dot: nothing was heard (about -45 dBFS on the scale of inputLevel). */
export const HEARD_LEVEL = WAVE_DOT_PX / WAVE_MAX_PX
/** Nothing heard for this long since the recording started: the bar says so. */
export const SILENT_AFTER_MS = 3000

/** The level that draws the wave's tallest bars, and the one under which every bar is a dot (dBFS, RMS). Measured on a
 * MacBook's built-in microphone through the app's own settings (echo cancellation, noise suppression, the browser's
 * gain control): a quiet room about -52 (90% under -46), speech a little away from the Mac about -33, close speech
 * -22 to -16. A level linear in the RMS (the former four times the RMS) drew -33 dBFS as a row of dots: the wave
 * stood still while the words were transcribed. */
export const LEVEL_FLOOR_DB = -48
export const LEVEL_FULL_DB = -15

/** The input level, 0 to 1, of the analyser's samples (-1 to 1, getFloatTimeDomainData): their RMS in dBFS, from
 * LEVEL_FLOOR_DB (0) to LEVEL_FULL_DB (1). Float samples, because the 8-bit ones round quiet speech to no sound. */
export function inputLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! ** 2
  if (!sum) return 0
  const db = 10 * Math.log10(sum / samples.length)
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / (LEVEL_FULL_DB - LEVEL_FLOOR_DB)))
}

/** The height of the wave's bar `i` at this level: the bars differ, and their pattern moves on each second. */
export function waveBarPx(level: number, i: number, seconds: number): number {
  return Math.max(WAVE_DOT_PX, level * WAVE_MAX_PX * (0.4 + 0.6 * Math.abs(Math.sin((i + seconds) * 1.7))))
}

/** Whether the bar says that nothing is heard: only while the level is really being read (`running`: the browser's
 * audio runs), nothing was heard since the start, and the level was watched for SILENT_AFTER_MS (`elapsedMs`). */
export function nothingHeard(o: { heard: boolean; running: boolean; elapsedMs: number }): boolean {
  return !o.heard && o.running && o.elapsedMs >= SILENT_AFTER_MS
}

export type RecorderState = 'idle' | 'recording'
export class RecorderError extends Error {
  constructor(public code: 'unsupported' | 'denied') {
    super(code)
    this.name = 'RecorderError'
  }
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  /** nothing was heard since the recording started (nothingHeard above) */
  const [silent, setSilent] = useState(false)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const stream = useRef<MediaStream | null>(null)
  const raf = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const resolveStop = useRef<((f: File | null) => void) | null>(null)

  const cleanup = () => {
    cancelAnimationFrame(raf.current)
    if (timer.current) clearInterval(timer.current)
    stream.current?.getTracks().forEach((t) => t.stop())
    ctx.current?.close().catch(() => {})
    stream.current = null
    ctx.current = null
    setLevel(0)
    setSilent(false)
  }
  useEffect(() => cleanup, [])

  /** `live` in the answer: the samples go out (false: asked for, but the browser keeps the sound paused, so the whole
   * recording is kept as a file instead) */
  const start = async (o: { onSamples?: (samples: Float32Array) => void } = {}): Promise<{ live: boolean }> => {
    let live = o.onSamples
    if (!navigator.mediaDevices?.getUserMedia || (live ? typeof AudioContext === 'undefined' : typeof MediaRecorder === 'undefined')) throw new RecorderError('unsupported')
    let s: MediaStream
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      throw new RecorderError('denied')
    }
    stream.current = s
    rec.current = null

    const ac = new AudioContext()
    ctx.current = ac
    // a context made after the question about the microphone (outside the tap) may start paused; live words need it
    // running, else the recording is kept whole as before. The level needs it running too: while it is paused the wave
    // would stay 0 with the recording going on (the frames below ask again, for a browser that starts it later).
    if (ac.state !== 'running') {
      try {
        await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 1000))])
      } catch { /* still paused: below */ }
      if ((ac.state as AudioContextState) !== 'running') live = undefined
    }
    if (!live) startFile(s)
    const analyser = ac.createAnalyser()
    analyser.fftSize = 512
    const source = ac.createMediaStreamSource(s)
    source.connect(analyser)
    if (live) {
      const proc = ac.createScriptProcessor(4096, 1, 1)
      const down = downsampler(ac.sampleRate)
      proc.onaudioprocess = (e) => {
        const out = down(e.inputBuffer.getChannelData(0))
        if (out.length) live(out)
      }
      // it only runs while connected to the output; nothing is written to it, so nothing is heard
      source.connect(proc)
      proc.connect(ac.destination)
    }
    const data = new Float32Array(analyser.fftSize)
    const t0 = Date.now()
    let heard = false
    let said = false
    // the time the level was watched: frames only (a tab in the background draws none, and what was said meanwhile was
    // not seen), and only while the browser's audio runs
    let watched = 0
    let last = t0
    // still paused after the wait above: asked again once a second (a browser that starts the sound only at a later
    // tap or key), so the level comes back; nothing is said about the microphone meanwhile
    let asked = t0
    const tick = () => {
      if (ac.state === 'suspended' && Date.now() - asked >= 1000) {
        asked = Date.now()
        void ac.resume().catch(() => {})
      }
      analyser.getFloatTimeDomainData(data)
      const lv = inputLevel(data)
      setLevel(lv)
      if (!heard) {
        const at = Date.now()
        if (ac.state === 'running') watched += Math.min(100, at - last)
        last = at
        if (lv > HEARD_LEVEL) {
          heard = true
          if (said) setSilent(false)
        } else if (!said && nothingHeard({ heard, running: ac.state === 'running', elapsedMs: watched })) {
          said = true
          setSilent(true)
        }
      }
      raf.current = requestAnimationFrame(tick)
    }
    tick()

    setSeconds(0)
    timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 250)
    setState('recording')
    return { live: !!live }
  }

  /** the whole recording as one file (MediaRecorder): stop() hands it over */
  const startFile = (s: MediaStream) => {
    const mime = pickMime()
    const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined)
    chunks.current = []
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data) }
    r.onstop = () => {
      const type = r.mimeType || mime || 'audio/webm'
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const blob = new Blob(chunks.current, { type })
      resolveStop.current?.(blob.size ? new File([blob], `voice-${stamp}.${ext}`, { type }) : null)
      resolveStop.current = null
    }
    r.start(1000)
    rec.current = r
  }

  /** Stop and return the recording (null if nothing was captured, and always when live: the samples went out already). */
  const stop = () =>
    new Promise<File | null>((resolve) => {
      const r = rec.current
      if (!r || r.state === 'inactive') {
        cleanup()
        setState('idle')
        return resolve(null)
      }
      resolveStop.current = resolve
      r.stop()
      cleanup()
      setState('idle')
    })

  const cancel = () => {
    resolveStop.current = null
    if (rec.current && rec.current.state !== 'inactive') {
      rec.current.onstop = null
      rec.current.stop()
    }
    cleanup()
    setState('idle')
  }

  return { state, seconds, level, silent, start, stop, cancel }
}
