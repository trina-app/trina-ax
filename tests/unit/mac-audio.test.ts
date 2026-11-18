// jobs/mac-audio.ts: what afinfo says, the WAV afconvert writes, and cutting the decoded sound into the transcript's
// pieces (30 s windows, files/media.ts LOCAL_PIECE_SEC) without following a link. The parts that run macOS's programs
// are in mac-local-speech.test.ts (Apple silicon only); everything here runs on any machine.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { extOf, MAC_AUDIO_EXT, macAudioTools, macWavPiece, macWavSeconds, parseAfinfo, pcmWav, wavLayout, WAV_BYTES_PER_SEC } from '../../server/src/jobs/mac-audio'
import { localSpeechReady, missingLocalTools, wantsWavRecordings } from '../../server/src/jobs/transcribe'
import { LOCAL_PIECE_SEC } from '../../server/src/files/media'
import { wavData } from '../../server/src/jobs/openrouter-stt'
import { WORK } from '../lib/env'

const dir = path.join(WORK, 'mac-audio')
beforeAll(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** afinfo's answers on macOS 26 (the path line is the work folder's in.<ext>) */
const AFINFO_M4A = `File:           in.m4a
File type ID:   m4af
Num Tracks:     1
----
Data format:     1 ch,  22050 Hz, aac  (0x00000000) 0 bits/channel, 0 bytes/packet, 1024 frames/packet, 0 bytes/frame
                no channel layout.
estimated duration: 9.015238 sec
audio bytes: 37778
`
const AFINFO_MOV = `File:           in.mov
File type ID:   MooV
Num Tracks:     1
----
Data format:     2 ch,  48000 Hz, aac  (0x00000000) 0 bits/channel, 0 bytes/packet, 1024 frames/packet, 0 bytes/frame
estimated duration: 61.5 sec
`
const AFINFO_WAV = `File:           in.wav
File type ID:   WAVE
Data format:     1 ch,  16000 Hz, Int16
estimated duration: 9.015250 sec
`
const AFINFO_MP3 = `File type ID:   MPG3
Data format:     1 ch,  22050 Hz, .mp3 (0x00000000) 0 bits/channel, 0 bytes/packet, 576 frames/packet, 0 bytes/frame
estimated duration: 9.090612 sec
`

describe('afinfo', () => {
  test('the sound of an m4a, a mov, a wav and an mp3', () => {
    expect(parseAfinfo(AFINFO_M4A)).toEqual({ durationSec: 9.015238, codec: 'aac', channels: 1, sampleRate: 22050, format: 'm4af' })
    expect(parseAfinfo(AFINFO_MOV)).toEqual({ durationSec: 61.5, codec: 'aac', channels: 2, sampleRate: 48000, format: 'MooV' })
    expect(parseAfinfo(AFINFO_WAV)).toMatchObject({ codec: 'Int16', sampleRate: 16000 })
    expect(parseAfinfo(AFINFO_MP3)).toMatchObject({ codec: 'mp3', durationSec: 9.090612 })
  })
  test('no sound it could open: null (a webm, a video without sound)', () => {
    expect(parseAfinfo('Fail: AudioFileOpenURL failed\nFile:           in.webm\n')).toBeNull()
    expect(parseAfinfo('')).toBeNull()
    expect(parseAfinfo('File type ID:   mp4f\n')).toBeNull()
  })
  test('the formats a Mac opens, by extension', () => {
    for (const x of ['m4a', 'mp3', 'wav', 'aiff', 'flac', 'mp4', 'mov', 'm4v', 'caf', 'opus']) expect(MAC_AUDIO_EXT.has(x)).toBe(true)
    for (const x of ['webm', 'mkv', 'avi', 'wma', 'ogg', 'amr', 'weba']) expect(MAC_AUDIO_EXT.has(x)).toBe(false)
    expect(extOf('in.M4A')).toBe('m4a')
    expect(extOf('noext')).toBe('')
  })
})

describe('which servers use it', () => {
  const yes = () => true
  test('only an Apple silicon Mac with afinfo and afconvert', () => {
    expect(macAudioTools('darwin', 'arm64', yes)).toEqual({ afinfo: '/usr/bin/afinfo', afconvert: '/usr/bin/afconvert', avconvert: '/usr/bin/avconvert' })
    expect(macAudioTools('darwin', 'arm64', (p) => p !== '/usr/bin/avconvert')).toMatchObject({ avconvert: null })
    expect(macAudioTools('darwin', 'x64', yes)).toBeNull()
    expect(macAudioTools('linux', 'arm64', yes)).toBeNull()
    expect(macAudioTools('darwin', 'arm64', (p) => p !== '/usr/bin/afconvert')).toBeNull()
  })
  test('with it ffmpeg is not missing, recordings come as WAV, and local is ready once whisper-cli is there', () => {
    const mac = macAudioTools('darwin', 'arm64', yes)
    expect(missingLocalTools({ whisperBin: '/w', ffmpegBin: null, mac })).toEqual([])
    expect(missingLocalTools({ whisperBin: null, ffmpegBin: null, mac })).toEqual(['whisper.cpp'])
    expect(missingLocalTools({ whisperBin: '/w', ffmpegBin: null, mac: null })).toEqual(['ffmpeg'])
    expect(wantsWavRecordings({ ffmpegBin: null, mac })).toBe(true)
    // ffmpeg there (Homebrew): the browser's own recording, as before
    expect(wantsWavRecordings({ ffmpegBin: '/opt/homebrew/bin/ffmpeg', mac })).toBe(false)
    expect(wantsWavRecordings({ ffmpegBin: null, mac: null })).toBe(false)
    expect(localSpeechReady({ whisperBin: '/w', ffmpegBin: null, mac })).toBe(true)
    expect(localSpeechReady({ whisperBin: null, ffmpegBin: null, mac })).toBe(false)
    // Linux (the kit, the Docker image) with whisper-cli and ffmpeg reads 'local' by itself only with 4 cores and 8 GB
    // (the owner, 2026-11-19); a smaller one, or one without ffmpeg, does not
    expect(localSpeechReady({ whisperBin: '/w', ffmpegBin: '/f', mac: null })).toBe(false)
    expect(localSpeechReady({ whisperBin: '/w', ffmpegBin: '/f', mac: null }, true)).toBe(true)
    expect(localSpeechReady({ whisperBin: '/w', ffmpegBin: null, mac: null }, true)).toBe(false)
    expect(localSpeechReady({ whisperBin: null, ffmpegBin: '/f', mac: null }, true)).toBe(false)
  })
})

/** afconvert's WAV: WAVE_FORMAT_EXTENSIBLE fmt (40 bytes) and a FLLR padding chunk before data */
function afconvertWav(samples: Int16Array): Buffer {
  const fmt = Buffer.alloc(8 + 40)
  fmt.write('fmt ', 0, 'latin1'); fmt.writeUInt32LE(40, 4)
  fmt.writeUInt16LE(0xfffe, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22)
  const fllr = Buffer.alloc(8 + 4044); fllr.write('FLLR', 0, 'latin1'); fllr.writeUInt32LE(4044, 4)
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  const data = Buffer.alloc(8); data.write('data', 0, 'latin1'); data.writeUInt32LE(pcm.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, fllr, data, pcm])
  const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}
/** `seconds` of 16 kHz samples whose value is the second they are in (0, 1, 2 …), to see where a piece was cut */
function counting(seconds: number): Int16Array {
  const s = new Int16Array(seconds * 16_000)
  for (let i = 0; i < s.length; i++) s[i] = Math.floor(i / 16_000)
  return s
}

describe('the decoded sound in 30 s pieces', () => {
  test('a plain 44-byte header: 16 kHz, mono, 16-bit PCM', () => {
    const w = pcmWav(Buffer.alloc(320))
    expect(w.length).toBe(364)
    expect(wavLayout(w, w.length)).toEqual({ offset: 44, bytes: 320 })
    expect(w.readUInt16LE(20)).toBe(1) // PCM, not EXTENSIBLE
    expect(wavData(w)!.length).toBe(320)
  })
  test('afconvert\'s header is read; another rate, more channels or not a WAV is not', () => {
    const w = afconvertWav(counting(1))
    expect(wavLayout(w, w.length)).toEqual({ offset: w.length - 32_000, bytes: 32_000 })
    const stereo = Buffer.from(w); stereo.writeUInt16LE(2, 22)
    expect(wavLayout(stereo, stereo.length)).toBeNull()
    const rate = Buffer.from(w); rate.writeUInt32LE(44100, 24)
    expect(wavLayout(rate, rate.length)).toBeNull()
    expect(wavLayout(Buffer.from('not a wav at all'), 16)).toBeNull()
  })
  test('a 65 s recording gives pieces of 30, 30 and 5 s, each from its own place, with nothing of the file\'s chunks', () => {
    fs.writeFileSync(path.join(dir, 'full.wav'), afconvertWav(counting(65)))
    expect(macWavSeconds(dir, 'full.wav')).toBe(65)
    const pieces: Buffer[] = []
    for (let k = 0; k * LOCAL_PIECE_SEC < 65; k++) pieces.push(macWavPiece(dir, 'full.wav', k * LOCAL_PIECE_SEC, Math.min(LOCAL_PIECE_SEC, 65 - k * LOCAL_PIECE_SEC))!)
    expect(pieces.map((p) => (p.length - 44) / WAV_BYTES_PER_SEC)).toEqual([30, 30, 5])
    for (const [k, p] of pieces.entries()) {
      expect(p.subarray(0, 4).toString('latin1')).toBe('RIFF')
      expect(p.includes(Buffer.from('FLLR'))).toBe(false)
      // the first sample of piece k is second 30·k, its last one second 30·k + length − 1
      expect(p.readInt16LE(44)).toBe(k * 30)
      expect(p.readInt16LE(p.length - 2)).toBe(Math.min(65, (k + 1) * 30) - 1)
    }
    // a part past the end stops at the end; the whole of it in one
    expect((macWavPiece(dir, 'full.wav', 60, 30)!.length - 44) / WAV_BYTES_PER_SEC).toBe(5)
    expect((macWavPiece(dir, 'full.wav', 0, Infinity)!.length - 44) / WAV_BYTES_PER_SEC).toBe(65)
    expect(macWavPiece(dir, 'full.wav', 70, 30)!.length).toBe(44)
  })
  test('a link or a second name in the work folder\'s place is not read', () => {
    fs.writeFileSync(path.join(dir, 'secret.wav'), afconvertWav(counting(2)))
    fs.symlinkSync(path.join(dir, 'secret.wav'), path.join(dir, 'link.wav'))
    expect(macWavPiece(dir, 'link.wav', 0, 1)).toBeNull()
    expect(macWavSeconds(dir, 'link.wav')).toBe(0)
    fs.linkSync(path.join(dir, 'secret.wav'), path.join(dir, 'hard.wav'))
    expect(macWavPiece(dir, 'hard.wav', 0, 1)).toBeNull()
    expect(macWavPiece(dir, 'missing.wav', 0, 1)).toBeNull()
    expect(() => macWavPiece(dir, '../x.wav', 0, 1)).toThrow()
  })
})
