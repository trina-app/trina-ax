// Voice input as WAV for a server that decodes with macOS's own programs (an Apple silicon Mac without ffmpeg,
// Me.team.voiceInputWav; server/src/jobs/mac-audio.ts): those do not open the webm/opus Chrome and the desktop app
// record. The browser decodes its own recording (decodeAudioData reads what its MediaRecorder wrote), mixes it to one
// channel at 16 kHz (what whisper.cpp uses) and wraps it as 16-bit PCM WAV: 32 KB a second, 9.6 MB for the 5-minute cap.

/** 16-bit PCM WAV (44-byte header) of mono float samples at `rate` */
export function wavFromSamples(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)) }
  ascii(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  ascii(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!))
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true)
  }
  return out
}

export const WAV_RATE = 16_000

/** The recording as a 16 kHz mono WAV file of the same name (".wav"); the recording itself when the browser cannot
 * decode it (the server then says which formats it reads). */
export async function recordingAsWav(file: File): Promise<File> {
  if (typeof OfflineAudioContext === 'undefined' || /\.wav$/i.test(file.name)) return file
  try {
    const bytes = await file.arrayBuffer()
    // decodeAudioData needs a context; an OfflineAudioContext at the target rate is one, and it does not open the
    // speakers (an AudioContext would, on some phones)
    const probe = new OfflineAudioContext(1, 1, WAV_RATE)
    const decoded = await probe.decodeAudioData(bytes)
    const frames = Math.max(1, Math.ceil(decoded.duration * WAV_RATE))
    const mix = new OfflineAudioContext(1, frames, WAV_RATE)
    const src = mix.createBufferSource()
    src.buffer = decoded
    // one output channel: the context mixes every input channel down (speakers' rules: equal parts)
    src.connect(mix.destination)
    src.start()
    const rendered = await mix.startRendering()
    const wav = wavFromSamples(rendered.getChannelData(0), WAV_RATE)
    return new File([wav as BlobPart], file.name.replace(/\.[a-z0-9]{1,8}$/i, '') + '.wav', { type: 'audio/wav' })
  } catch {
    return file
  }
}
