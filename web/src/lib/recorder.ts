// Microphone recorder for voice input (ported from Saram web/src/lib/recorder.ts): elapsed time and a live input
// level for the meter. The recording goes to POST /api/transcribe (a job) and the text lands in the composer.
// Live (start's `onSamples`, lib/liveDictation.ts): no recording file; the sound goes out as 16 kHz samples while it is
// recorded, through a ScriptProcessor (deprecated, but in every browser and WebView; an AudioWorklet would need a
// module URL the page's script rules allow).
import { useEffect, useRef, useState } from 'react'
import { downsampler } from './liveDictation'

/** A recording format the browser supports (Chrome/Firefox: webm/opus, Safari: mp4/aac). */
function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return candidates.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? ''
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
  }
  useEffect(() => cleanup, [])

  const start = async (o: { onSamples?: (samples: Float32Array) => void } = {}) => {
    const live = o.onSamples
    if (!navigator.mediaDevices?.getUserMedia || (live ? typeof AudioContext === 'undefined' : typeof MediaRecorder === 'undefined')) throw new RecorderError('unsupported')
    let s: MediaStream
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      throw new RecorderError('denied')
    }
    stream.current = s
    rec.current = null
    if (!live) startFile(s)

    const ac = new AudioContext()
    ctx.current = ac
    // (a context made after the question about the microphone may start suspended)
    void ac.resume?.().catch(() => {})
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
    const data = new Uint8Array(analyser.fftSize)
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (const v of data) sum += ((v - 128) / 128) ** 2
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4))
      raf.current = requestAnimationFrame(tick)
    }
    tick()

    setSeconds(0)
    const t0 = Date.now()
    timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 250)
    setState('recording')
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

  return { state, seconds, level, start, stop, cancel }
}
