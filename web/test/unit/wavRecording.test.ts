// lib/wavRecording.ts: voice input as 16 kHz WAV for a server that decodes with macOS's own programs
// (Me.team.voiceInputWav).
import { afterEach, describe, expect, test } from 'bun:test'
import { recordingAsWav, wavFromSamples, WAV_RATE } from '../../src/lib/wavRecording'

const g = globalThis as { OfflineAudioContext?: unknown }
const saved = g.OfflineAudioContext
afterEach(() => { g.OfflineAudioContext = saved })

describe('the WAV the server gets', () => {
  test('a plain 16-bit PCM header at 16 kHz, mono', () => {
    const w = wavFromSamples(new Float32Array(WAV_RATE), WAV_RATE)
    const v = new DataView(w.buffer)
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...w.subarray(8, 12))).toBe('WAVE')
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(16_000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(32_000)
    expect(w.length).toBe(44 + 32_000)
  })
  test('samples are clipped to 16 bits, not wrapped', () => {
    const w = wavFromSamples(Float32Array.from([0, 1, -1, 2, -2, 0.5]), WAV_RATE)
    const v = new DataView(w.buffer)
    expect([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16383])
  })
})

describe('the recording', () => {
  test('a browser without OfflineAudioContext, or a WAV already, is sent as it is', async () => {
    g.OfflineAudioContext = undefined
    const f = new File([new Uint8Array([1, 2, 3])], 'voice-1.webm', { type: 'audio/webm' })
    expect(await recordingAsWav(f)).toBe(f)
    g.OfflineAudioContext = class {}
    const w = new File([new Uint8Array([1])], 'voice-1.wav', { type: 'audio/wav' })
    expect(await recordingAsWav(w)).toBe(w)
  })
  test('decoded, mixed to one channel at 16 kHz and named .wav; a recording the browser cannot decode goes as it is', async () => {
    const made: { channels: number; frames: number; rate: number }[] = []
    let fail = false
    g.OfflineAudioContext = class {
      destination = {}
      constructor(channels: number, frames: number, rate: number) { made.push({ channels, frames, rate }) }
      async decodeAudioData() { if (fail) throw new Error('EncodingError'); return { duration: 0.5 } }
      createBufferSource() { return { buffer: null, connect() {}, start() {} } }
      async startRendering() { return { getChannelData: () => new Float32Array(8000).fill(0.25) } }
    }
    const f = new File([new Uint8Array([1, 2, 3])], 'voice-202611161300.webm', { type: 'audio/webm' })
    const w = await recordingAsWav(f)
    expect(w.name).toBe('voice-202611161300.wav')
    expect(w.type).toBe('audio/wav')
    expect(w.size).toBe(44 + 16_000)
    expect(made[1]).toEqual({ channels: 1, frames: 8000, rate: 16_000 })
    fail = true
    expect(await recordingAsWav(f)).toBe(f)
  })
})
