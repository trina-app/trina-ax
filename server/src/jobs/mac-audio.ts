// Sound from audio and video files on an Apple silicon Mac without ffmpeg (docs/decisions/20261116-mac-local-speech.md):
// macOS's own programs, signed by Apple and present on every Mac. afinfo says what a file holds and how long it is,
// afconvert decodes it to 16 kHz mono 16-bit WAV (what whisper.cpp and OpenRouter get), and avconvert (AVFoundation)
// takes the sound out of a video that afconvert cannot open (Opus in mp4, some phone videos) as m4a first. Each runs
// isolated like every converter (tools/isolate.ts: the macOS sandbox, no network, only its work folder), with a time
// limit and a cap on what it may write. The decoded sound is cut here, in the server, into the pieces the transcripts
// use (jobs/transcribe.ts LOCAL_PIECE_SEC windows via files/media.ts), each a plain 44-byte-header WAV with nothing
// of the file's tags (afconvert writes a WAVE_FORMAT_EXTENSIBLE header and a FLLR chunk; those never go on).
//
// Not here: browsers' webm/opus recordings (no macOS decoder opens webm; the web app sends voice input as WAV when the
// server has no ffmpeg, Me.team.voiceInputWav) and the pictures of a video (no frames on a Mac server).
import fs from 'node:fs'
import path from 'node:path'
import { ToolError } from '../policy/errors'
import { runIsolated } from '../tools/isolate'

export interface MacAudioTools { afinfo: string; afconvert: string; avconvert: string | null }

/** macOS's audio programs on an Apple silicon Mac, else null: Intel Macs and Linux keep what they had (ffmpeg, or the
 * note that a Mac server does not read video and audio). `platform`, `arch`, `exists`: tests. */
export function macAudioTools(platform: string = process.platform, arch: string = process.arch, exists: (p: string) => boolean = (p) => fs.existsSync(p)): MacAudioTools | null {
  if (platform !== 'darwin' || arch !== 'arm64') return null
  if (!exists('/usr/bin/afinfo') || !exists('/usr/bin/afconvert')) return null
  return { afinfo: '/usr/bin/afinfo', afconvert: '/usr/bin/afconvert', avconvert: exists('/usr/bin/avconvert') ? '/usr/bin/avconvert' : null }
}

/** extensions afconvert opens on macOS 13+ (checked on macOS 26: wav, aiff, caf, mp3, m4a/aac, flac, Ogg Opus, and
 * the sound of mp4 / mov / m4v / 3gp). webm, mkv, avi, wma, Ogg Vorbis and AMR are not among them. */
export const MAC_AUDIO_EXT: ReadonlySet<string> = new Set(['wav', 'aiff', 'aif', 'aifc', 'caf', 'mp3', 'm4a', 'aac', 'flac', 'opus', 'mp4', 'm4v', 'mov', '3gp'])
/** containers whose sound avconvert can take out when afconvert cannot */
const MAC_VIDEO_EXT: ReadonlySet<string> = new Set(['mp4', 'm4v', 'mov', '3gp'])
export const extOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase()

/** 16 kHz mono 16-bit PCM */
export const WAV_BYTES_PER_SEC = 32_000
const AFINFO_TIMEOUT_MS = 15_000
const AFINFO_RSS_MIB = 256
const DECODE_RSS_MIB = 512
const AVCONVERT_RSS_MIB = 1024

export interface MacSound {
  /** seconds (afinfo's estimate) */ durationSec: number
  /** "aac", "mp3", "opus", "lpcm" …: afinfo's data format */ codec: string
  channels: number | null
  sampleRate: number | null
  /** afinfo's file type ("m4af", "mp4f", "MooV", "WAVE" …) */ format: string
}

/** afinfo's answer -> the first track's sound, or null (no sound it could open). Only these fields are used: no tags,
 * no file name (afinfo prints the path it was given, and that is the work folder's in.<ext>). */
export function parseAfinfo(out: string): MacSound | null {
  if (/AudioFileOpenURL failed/.test(out)) return null
  const dur = /^estimated duration:\s*([\d.]+)\s*sec/m.exec(out)
  const fmt = /^Data format:\s*(\d+)\s*ch,\s*(\d+)\s*Hz,\s*'?([^\s(']+)/m.exec(out)
  const type = /^File type ID:\s*(\S+)/m.exec(out)
  const durationSec = dur ? Number(dur[1]) : NaN
  if (!fmt || !Number.isFinite(durationSec)) return null
  const channels = Number(fmt[1]), sampleRate = Number(fmt[2])
  return { durationSec, codec: fmt[3]!.replace(/^\./, ''), channels: channels > 0 ? channels : null, sampleRate: sampleRate > 0 ? sampleRate : null, format: type?.[1] ?? 'unknown' }
}


/** afinfo of `name` in the work folder `work`: its sound, or null when it holds none afinfo can open. */
export async function macProbe(tools: MacAudioTools, work: string, name: string, signal?: AbortSignal, timeoutMs = AFINFO_TIMEOUT_MS): Promise<MacSound | null> {
  const r = await runIsolated({ cmd: tools.afinfo, args: [name], workDir: work, signal, timeoutMs: Math.max(1, Math.min(AFINFO_TIMEOUT_MS, timeoutMs)), maxRssMiB: AFINFO_RSS_MIB, maxStdout: 1024 * 1024, maxWorkBytes: folderBytes(work) + 16 * 1024 ** 2 })
  signal?.throwIfAborted()
  if (r.killed === 'workdir') throw new ToolError('the work folder was replaced', 'media_damaged')
  if (r.killed) throw new ToolError(`afinfo stopped (${r.killed})`, 'media_heavy')
  if (r.code !== 0) return null
  const s = parseAfinfo(r.stdout.toString('utf8'))
  // a length afinfo could not tell (an mp4 with Opus inside says 0): the sound is taken out with avconvert instead
  return s && s.durationSec > 0 ? s : null
}

/** Bytes in the work folder now (its files, one level: what runIsolated's maxWorkBytes counts against) */
function folderBytes(work: string): number {
  let n = 0
  try { for (const f of fs.readdirSync(work)) { try { const st = fs.lstatSync(path.join(work, f)); if (st.isFile()) n += st.size } catch { /* gone */ } } } catch { /* none */ }
  return n
}
const ranOut = (r: { killed: string | null }, what: string, signal?: AbortSignal) => {
  signal?.throwIfAborted()
  if (r.killed === 'workdir') throw new ToolError('the work folder was replaced', 'media_damaged')
  if (r.killed) throw new ToolError(`${what} stopped (${r.killed})`, 'media_heavy')
}

/** What macSound found: the file afconvert decodes (`name` itself, or the m4a avconvert took out of a video) and its sound. */
export interface MacSource { src: string; sound: MacSound }

/**
 * The sound of `name` (in `work`): afinfo; a video afinfo cannot open goes through avconvert (its sound as m4a, kept in
 * the work folder for macDecode). Throws ToolError media_mac_format (not a format this Mac opens), media_mac_no_sound
 * (a video with no sound this Mac can open), media_too_long, media_heavy (a time or memory limit), media_damaged (a
 * replaced work folder).
 */
export async function macSound(tools: MacAudioTools, work: string, name: string, o: { signal?: AbortSignal; timeoutMs: number; maxSeconds: number }): Promise<MacSource> {
  const x = extOf(name)
  if (!MAC_AUDIO_EXT.has(x)) throw new ToolError(`.${x || '?'} is not a format this Mac opens`, 'media_mac_format')
  const until = Date.now() + o.timeoutMs
  const left = () => Math.max(1, until - Date.now())
  let src = name
  let sound = await macProbe(tools, work, src, o.signal, left())
  if (!sound && MAC_VIDEO_EXT.has(x) && tools.avconvert) {
    src = MAC_SOUND_M4A
    const r = await runIsolated({ cmd: tools.avconvert, workDir: work, signal: o.signal, timeoutMs: left(), maxRssMiB: AVCONVERT_RSS_MIB, maxStdout: 1024 * 1024,
      // the m4a is at most the size of the video (the sound is part of it) plus a margin
      maxWorkBytes: folderBytes(work) * 2 + 64 * 1024 ** 2,
      args: ['--source', name, '--preset', 'PresetAppleM4A', '--output', src, '--replace'] })
    ranOut(r, 'avconvert', o.signal)
    sound = r.code === 0 ? await macProbe(tools, work, src, o.signal, left()) : null
  }
  if (!sound) throw new ToolError('no sound this Mac opens', MAC_VIDEO_EXT.has(x) ? 'media_mac_no_sound' : 'media_mac_format')
  if (sound.durationSec > o.maxSeconds) throw new ToolError('longer than the limit', 'media_too_long')
  return { src, sound }
}
/** the m4a avconvert takes out of a video */
export const MAC_SOUND_M4A = 'mac-sound.m4a'

/** afconvert: the sound of `from` (macSound's src, in `work`) as `out`, 16 kHz mono 16-bit WAV (afconvert's own header;
 * cut with macWavPiece). Throws ToolError media_heavy / media_damaged. */
export async function macToWavFile(tools: MacAudioTools, work: string, from: MacSource, out: string, o: { signal?: AbortSignal; timeoutMs: number }): Promise<void> {
  const r = await runIsolated({ cmd: tools.afconvert, workDir: work, signal: o.signal, timeoutMs: Math.max(1, o.timeoutMs), maxRssMiB: DECODE_RSS_MIB, maxStdout: 1024 * 1024,
    maxWorkBytes: folderBytes(work) + Math.ceil((from.sound.durationSec + 10) * WAV_BYTES_PER_SEC) + 16 * 1024 ** 2,
    args: ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', from.src, out] })
  ranOut(r, 'afconvert', o.signal)
  if (r.code !== 0) throw new ToolError(`afconvert exit ${r.code}`, 'media_damaged')
}

/** macSound then macToWavFile: the whole sound of `name` as `out` (voice input jobs, tests). */
export async function macDecode(tools: MacAudioTools, work: string, name: string, out: string,
  o: { signal?: AbortSignal; timeoutMs: number; maxSeconds: number }): Promise<MacSource> {
  const until = Date.now() + o.timeoutMs
  const from = await macSound(tools, work, name, o)
  await macToWavFile(tools, work, from, out, { signal: o.signal, timeoutMs: until - Date.now() })
  if (from.src !== name) fs.rmSync(path.join(work, from.src), { force: true })
  return from
}

/** A plain 16 kHz mono 16-bit PCM WAV (44-byte header) around `pcm`. */
export function pcmWav(pcm: Uint8Array): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1')
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16_000, 24); h.writeUInt32LE(WAV_BYTES_PER_SEC, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** Where the samples of a 16 kHz mono 16-bit WAV start and how many bytes they have, from its first bytes (the
 * header, any chunks before data). null: not such a WAV. */
export function wavLayout(head: Uint8Array, fileSize: number): { offset: number; bytes: number } | null {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength)
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null
  let fmtOk = false
  for (let pos = 12; pos + 8 <= b.length;) {
    const id = b.toString('latin1', pos, pos + 4), size = b.readUInt32LE(pos + 4)
    if (id === 'fmt ' && pos + 8 + 16 <= b.length) {
      const tag = b.readUInt16LE(pos + 8), ch = b.readUInt16LE(pos + 10), rate = b.readUInt32LE(pos + 12), bits = b.readUInt16LE(pos + 22)
      // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (afconvert's), whose sub-format is PCM for LEI16
      fmtOk = (tag === 1 || tag === 0xfffe) && ch === 1 && rate === 16_000 && bits === 16
    }
    if (id === 'data') {
      if (!fmtOk) return null
      const offset = pos + 8
      // afconvert may leave the data size open (0 or 0xFFFFFFFF) while it writes; the file's end decides then
      const bytes = Math.max(0, Math.min(size === 0 || size === 0xffffffff ? Infinity : size, fileSize - offset))
      return { offset, bytes: bytes - (bytes % 2) }
    }
    pos += 8 + size + (size & 1)
  }
  return null
}

/** The server-made WAV `name` in `work` opened without following a link (O_NOFOLLOW, a regular file with one name, like
 * tools/isolate.ts readOutput) and where its samples are; null: not such a file, or not a 16 kHz mono 16-bit WAV. The
 * caller closes `fd`. */
function openWav(work: string, name: string): { fd: number; offset: number; bytes: number } | null {
  if (!name || name.includes('/') || name === '.' || name === '..') throw new Error('a plain file name')
  let fd: number
  try { fd = fs.openSync(path.join(work, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const st = fs.fstatSync(fd)
    const head = Buffer.alloc(Math.min(st.size, 64 * 1024))
    if (st.isFile() && st.nlink === 1) fs.readSync(fd, head, 0, head.length, 0)
    const lay = st.isFile() && st.nlink === 1 ? wavLayout(head, st.size) : null
    if (lay) return { fd, ...lay }
  } catch { /* not readable */ }
  fs.closeSync(fd)
  return null
}

/** The sound from `start` for `seconds` of the server-made WAV `name` in `work` (macDecode), as a plain WAV of its own;
 * only the bytes of that part are read (a 6-hour file's WAV is 690 MB). null: not such a file. */
export function macWavPiece(work: string, name: string, start: number, seconds: number): Buffer | null {
  const w = openWav(work, name)
  if (!w) return null
  try {
    const from = Math.min(w.bytes, Math.max(0, Math.round(start * 16_000)) * 2)
    const to = Math.min(w.bytes, from + Math.max(0, Math.round(seconds * 16_000)) * 2)
    const pcm = Buffer.alloc(to - from)
    let off = 0
    while (off < pcm.length) { const n = fs.readSync(w.fd, pcm, off, pcm.length - off, w.offset + from + off); if (n <= 0) break; off += n }
    return pcmWav(pcm.subarray(0, off))
  } finally { fs.closeSync(w.fd) }
}

/** Seconds of sound in a server-made WAV (macDecode's); 0 when it is not one. */
export function macWavSeconds(work: string, name: string): number {
  const w = openWav(work, name)
  if (!w) return 0
  fs.closeSync(w.fd)
  return w.bytes / WAV_BYTES_PER_SEC
}
