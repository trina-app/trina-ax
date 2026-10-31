// AI reads of video and audio files (docs/DECISIONS.md "AI reads video and audio (feat/video-read)"), like a Claude
// Code user who runs ffmpeg for frames and whisper for the words: `read` of a video gives frames (pictures with their
// times) and a timed transcript of its sound; an audio file gives the transcript. files/service.ts readMedia drives a
// read; this module holds the converter runs, the limits, the time and frame arithmetic, the transcript cache and the
// media slot.
//
// - Linux servers (ffmpeg and ffprobe come from the distribution: an apt dependency, never bundled). A Mac server says
//   video and audio are not supported there yet (AVFoundation is phase 2).
// - Every ffmpeg / ffprobe run is a converter run (tools/isolate.ts: bwrap without network, read-only system, only the
//   read's own work folder; the converter cgroup on Linux) with allow-lists of protocols (file), demuxers and decoders
//   (decoder names, not codec names, checked on Debian 12's ffmpeg 5.1 and Debian 13's 7.1), `-threads 1`, a time and
//   a memory limit. Frames come on stdout as PNG and are drawn again by the Go normalizer (vision.ts normalizeForModel);
//   the WAV of a transcript piece is read back without following a link (readOutput).
// - Only the listed ffprobe fields are used: no title, comment or other tags, chapter names or subtitle text reach the
//   AI. Transcripts are file content (untrusted, like any text file): the read says so, and they stay out of step
//   labels, tool summaries and audit rows.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { TranscribeResult } from '@mycel/shared/api'
import { ToolError } from '../policy/errors'
import { readOutput, runIsolated } from '../tools/isolate'
import { OPENROUTER_MAX_BYTES } from '../jobs/openrouter-stt'

/** the largest video or audio file a read takes (founder: a fixed constant, not per plan) */
export const MEDIA_INPUT_MAX = 1024 ** 3
/** longer than this, the file's own length is more likely wrong (or hostile) than real */
export const MEDIA_MAX_SECONDS = 6 * 3600
const MEDIA_MAX_STREAMS = 32
/** frames of a larger picture are not made (8K is 33 MP) */
const MEDIA_MAX_SIDE = 8192
const MEDIA_MAX_PIXELS = 40_000_000
/** free disk the copy of a file must leave in the work folder's file system */
export const MEDIA_DISK_RESERVE = 2 * 1024 ** 3

/** frames of one read (PDF_PAGES_PER_READ), and the most without `frames` */
export const FRAMES_MAX = 20
export const FRAMES_DEFAULT_MAX = 12
/** the sound one read transcribes: 10 minutes next to frames, 30 minutes when no frames go (founder Q3: the token budget
 * decides; about 9,000 Korean tokens at 300 a minute) */
export const TRANSCRIPT_SPAN_WITH_FRAMES = 600
export const TRANSCRIPT_SPAN_ALONE = 1800
/** the characters of a read's text for the API engine, which cuts any tool result at 30,000 (engine/api-agent.ts
 * TOOL_OUTPUT_MAX): room left for the lines after the transcript */
export const API_ENGINE_TEXT_MAX = 28_000
/** transcripts are made and cached in fixed pieces from 0:00. OpenRouter: 10 minutes (one request, 19.2 MB of 16 kHz WAV
 * under its 25 MB). Local whisper.cpp: 30 seconds, whisper's own window (QA 2026-11-01: a 2 vCPU box needed 180-300 s
 * for a 2-minute piece and never finished one inside a read, so nothing was ever cached); every finished piece is kept,
 * and a piece shorter than the window costs about a whole one. On a hosted server (a plan) at most
 * HOSTED_LOCAL_NEW_SEC of new sound a read (founder Q8) */
export const TRANSCRIPT_PIECE_SEC = 600
export const LOCAL_PIECE_SEC = 30
export const HOSTED_LOCAL_NEW_SEC = 120
/** the clock of a read's time and of whisper.cpp's speed (tests move it on to stand for slow converters) */
let readClock = () => Date.now()
export const now = () => readClock()
export function setClockForTests(f: (() => number) | null) { readClock = f ?? (() => Date.now()) }
/** a whole read (Stop always ends it at once): a chat turn, and a call without one (the remote connector's clients
 * give up well before a few minutes) */
export const READ_DEADLINE_MS = 5 * 60_000
export const CONNECTION_DEADLINE_MS = 60_000
const PROBE_TIMEOUT_MS = 15_000
const PROBE_RSS_MIB = 256
const SCAN_TIMEOUT_MS = 30_000
const FRAME_TIMEOUT_MS = 20_000
const FRAME_RSS_MIB = 1024
/** all frames of one read: past it the frames made so far go, and the rest are named */
export const FRAMES_TOTAL_MS = 90_000
/** the end of a read's time kept for putting the result together: the transcript (made after the frames) gives its
 * converters only the time before it */
export const RESULT_RESERVE_MS = 5_000
/** The time a new OpenRouter piece of `seconds` must still have to start: cutting its sound, the upload and the
 * transcription (at most its own 60 s). A piece cut off by the deadline is lost, and OpenRouter may bill it anyway. */
export function openRouterPieceNeedsMs(seconds: number): number {
  return Math.min(60_000, 10_000 + seconds * 50)
}

// ---------------- this server's speed (local whisper.cpp) ----------------
/** seconds of whisper.cpp work per second of sound before this server measured itself: on the slow side (the QA box
 * took 2-2.5 s with 1 thread), so a read does not start a piece it cannot finish */
export const LOCAL_SPEED_DEFAULT = 2.5
/** cutting a piece's sound and starting whisper.cpp (the model is read again for every piece) */
const LOCAL_PIECE_OVERHEAD_MS = 5_000
/** the margin on the estimate: a piece starts only when its estimate times this fits in the time left */
const LOCAL_SAFETY = 1.2
/** weight of each new piece in the moving average */
const SPEED_WEIGHT = 0.3
const SPEED_KEY = 'media.localSpeed'
export interface LocalSpeed { secPerSec: number; measured: boolean }
/** the local model as reads name it (the transcript's label, the cache key, the speed) */
export const localModelName = (model: string) => `whisper.cpp ${model}`
interface StoredSpeed { secPerSec: number; pieces: number; model: string; threads: number; at: string }
function storedSpeed(db: Database): StoredSpeed | null {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(SPEED_KEY) as { value: string } | null
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as StoredSpeed
    return Number.isFinite(v.secPerSec) && v.secPerSec > 0 && v.secPerSec < 1000 ? v : null
  } catch { return null }
}
/** This server's whisper.cpp speed for `model` with `threads` (another model or thread count starts from the default). */
export function localSpeed(db: Database, model: string, threads: number): LocalSpeed {
  const v = storedSpeed(db)
  return v && v.model === model && v.threads === threads ? { secPerSec: v.secPerSec, measured: true } : { secPerSec: LOCAL_SPEED_DEFAULT, measured: false }
}
/** A piece of `seconds` took `elapsedMs` of whisper.cpp: the moving average follows (the first measurement replaces the
 * default). `cutOff`: the run was stopped by its time limit, so it would have taken at least that long. */
export function recordLocalSpeed(db: Database, model: string, threads: number, elapsedMs: number, seconds: number, cutOff = false): LocalSpeed {
  const sample = Math.max(0.01, elapsedMs / 1000 / Math.max(seconds, LOCAL_PIECE_SEC))
  const v = storedSpeed(db)
  const same = v && v.model === model && v.threads === threads ? v : null
  let next = same ? same.secPerSec * (1 - SPEED_WEIGHT) + sample * SPEED_WEIGHT : sample
  if (cutOff) next = Math.max(next, sample, same?.secPerSec ?? 0)
  const stored: StoredSpeed = { secPerSec: Math.round(next * 1000) / 1000, pieces: (same?.pieces ?? 0) + 1, model, threads, at: new Date().toISOString() }
  db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SPEED_KEY, JSON.stringify(stored))
  return { secPerSec: stored.secPerSec, measured: true }
}
/** The time a new local piece of `seconds` must still have to start at `secPerSec` (a piece costs at least a window). */
export function localPieceNeedsMs(secPerSec: number, seconds: number): number {
  return LOCAL_PIECE_OVERHEAD_MS + Math.ceil(secPerSec * Math.max(seconds, LOCAL_PIECE_SEC) * 1000 * LOCAL_SAFETY)
}
/** How many new local pieces fit in `budgetMs` at `secPerSec` (the plan of a read; each piece is checked again with the
 * speed measured so far before it starts) */
export function localPiecesThatFit(budgetMs: number, secPerSec: number, pieceSec = LOCAL_PIECE_SEC): number {
  return Math.max(0, Math.floor(budgetMs / localPieceNeedsMs(secPerSec, pieceSec)))
}

// ---------------- silence (16 kHz mono 16-bit WAV) ----------------
/** 100 ms frames: a frame is sound when its RMS is above -50 dBFS (room tone and digital silence are below; quiet
 * speech peaks well above) */
const VOICE_FRAME_SEC = 0.1
const VOICE_RMS = 32768 * 10 ** (-50 / 20)
/** less sound than this in a piece: it is silence, and whisper.cpp is not run on it (it invents lines over silence and
 * names a language for them, QA L2) */
export const MIN_VOICED_SEC = 0.3
/** a piece with less sound than this gets the team's language as a hint: whisper's own guess on a few seconds is often
 * wrong ("la" for 5 s of Korean, QA) */
export const SHORT_SPEECH_SEC = 8
export interface Voice { /** seconds with sound */ voiced: number; /** per 100 ms frame from the start of the WAV */ frames: boolean[] }
/** Where a server-made WAV has sound (its data chunk; any other chunk, such as ffmpeg's LIST, is skipped). */
export function voiceOf(wav: Uint8Array): Voice {
  const b = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength)
  let pos = 12, data: Buffer | null = null
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') {
    while (pos + 8 <= b.length) {
      const id = b.toString('latin1', pos, pos + 4), size = b.readUInt32LE(pos + 4)
      if (id === 'data') { data = b.subarray(pos + 8, Math.min(b.length, pos + 8 + size)); break }
      pos += 8 + size + (size & 1)
    }
  }
  if (!data) return { voiced: Infinity, frames: [] }
  const per = Math.round(16_000 * VOICE_FRAME_SEC)
  const frames: boolean[] = []
  for (let f = 0; (f + 1) * per * 2 <= data.length; f++) {
    let sum = 0
    for (let i = 0; i < per; i++) { const x = data.readInt16LE((f * per + i) * 2); sum += x * x }
    frames.push(Math.sqrt(sum / per) > VOICE_RMS)
  }
  return { voiced: frames.filter(Boolean).length * VOICE_FRAME_SEC, frames }
}
/** Whether there is sound near [start, end] seconds of a piece (whisper's times are off by up to about half a second). */
export function soundNear(v: Voice, start: number, end: number): boolean {
  if (!v.frames.length) return true
  const a = Math.max(0, Math.floor((start - 0.5) / VOICE_FRAME_SEC)), z = Math.min(v.frames.length - 1, Math.ceil((end + 0.5) / VOICE_FRAME_SEC))
  for (let i = a; i <= z; i++) if (v.frames[i]) return true
  return false
}
const AUDIO_TIMEOUT_MS = 90_000
const AUDIO_RSS_MIB = 512
/** a frame PNG (1568 px rgb24 is 7.4 MB before compression) */
const FRAME_PNG_MAX = 16 * 1024 ** 2

// ---------------- allow-lists (ffmpeg's own names) ----------------
/** demuxers: the format list refuses an HLS playlist or an ffconcat file named .mp4 (they open other files) */
const FORMATS = ['mov', 'matroska', 'avi', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'amr', 'aiff', 'caf', 'asf']
/** decoders, by decoder name (ffmpeg checks those: an MP3 is decoded by mp3float, AV1 by libdav1d, MP2 by mp2) */
const VIDEO_DECODERS = ['h264', 'hevc', 'vp8', 'vp9', 'libdav1d', 'mpeg4', 'mpeg1video', 'mpeg2video', 'mjpeg', 'prores', 'h263', 'png']
const PCM = ['pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be', 'pcm_s32le', 'pcm_s32be', 'pcm_f32le', 'pcm_f32be', 'pcm_f64le', 'pcm_f64be', 'pcm_u8', 'pcm_s8', 'pcm_mulaw', 'pcm_alaw']
const AUDIO_DECODERS = ['aac', 'mp3float', 'mp3', 'mp2float', 'mp2', 'ac3', 'eac3', 'opus', 'vorbis', 'flac', 'alac', 'amrnb', 'amrwb', 'wmav1', 'wmav2', ...PCM]
/** text subtitles: ffprobe opens a decoder for every stream and refuses the whole file when one is not on the list
 * (a downloaded .mkv with subtitles); never decoded for a read */
const SUBTITLE_DECODERS = ['srt', 'subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']
export const MEDIA_DECODERS: readonly string[] = [...VIDEO_DECODERS, ...AUDIO_DECODERS, ...SUBTITLE_DECODERS]
/** ffprobe's codec_name of the streams a read uses (AV1 shows as av1, AMR as amr_nb / amr_wb) */
const VIDEO_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg1video', 'mpeg2video', 'mjpeg', 'prores', 'h263', 'png'])
const AUDIO_CODECS = new Set(['aac', 'mp3', 'mp2', 'ac3', 'eac3', 'opus', 'vorbis', 'flac', 'alac', 'amr_nb', 'amr_wb', 'wmav1', 'wmav2', ...PCM])
/** before every -i: the file protocol only, the demuxers and decoders above */
const INPUT_GUARD = ['-protocol_whitelist', 'file', '-format_whitelist', FORMATS.join(','), '-codec_whitelist', MEDIA_DECODERS.join(',')]
/** what a probe, scan or frame run may leave in the work folder besides the input (they write nothing there; a
 * converter taken over by a hostile file must not fill the disk until its time limit) */
const WORK_SLACK = 64 * 1024 ** 2
const workCap = (work: string, name: string) => { try { return fs.statSync(path.join(work, name)).size + WORK_SLACK } catch { return WORK_SLACK } }

export interface MediaTools { ffmpeg: string; ffprobe: string }

/** What a read uses of ffprobe's answer (nothing else of it is kept). */
export interface MediaInfo {
  /** seconds; null when neither the container nor a stream says (a browser recording): scanDuration */
  durationSec: number | null
  /** the demuxer ("mov", "matroska", "mp3" …) */
  format: string
  /** the picture: the first decodable video stream that is not a cover (the default one first); width and height as shown
   * (a 90° rotation applied) */
  video: { index: number; codec: string; width: number; height: number; fps: number | null } | null
  /** the sound: the first decodable audio stream (the default one first) */
  audio: { index: number; codec: string; channels: number | null; sampleRate: number | null } | null
  /** a cover picture (attached_pic) and no other picture: an audio file */
  cover: boolean
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** ffprobe's JSON -> MediaInfo (exported for tests). Throws ToolError media_unsupported for an odd file. */
export function parseProbe(json: string): MediaInfo {
  let j: { format?: { duration?: unknown; format_name?: unknown }; streams?: unknown }
  try { j = JSON.parse(json) } catch { throw new ToolError('ffprobe gave no answer', 'media_damaged') }
  const streams = Array.isArray(j.streams) ? j.streams as Record<string, any>[] : []
  if (streams.length > MEDIA_MAX_STREAMS) throw new ToolError('too many streams', 'media_unsupported')
  const first = <T>(list: T[], dflt: (x: T) => boolean) => list.find(dflt) ?? list[0] ?? null
  const isDefault = (s: Record<string, any>) => s.disposition?.default === 1
  const videos = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1 && VIDEO_CODECS.has(String(s.codec_name)))
  const covers = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1)
  const audios = streams.filter((s) => s.codec_type === 'audio' && AUDIO_CODECS.has(String(s.codec_name)))
  const v = first(videos, isDefault)
  const a = first(audios, isDefault)
  let video: MediaInfo['video'] = null
  if (v) {
    let w = Math.trunc(num(v.width) ?? 0), h = Math.trunc(num(v.height) ?? 0)
    const rot = (Array.isArray(v.side_data_list) ? v.side_data_list as { rotation?: unknown }[] : []).map((d) => num(d.rotation)).find((r) => r !== null) ?? 0
    if (Math.abs(Math.round(rot)) % 180 === 90) [w, h] = [h, w]
    const [fn, fd] = String(v.avg_frame_rate ?? '').split('/').map(Number)
    const fps = fn && fd ? Math.round((fn / fd) * 100) / 100 : null
    if (w > 0 && h > 0) video = { index: Number(v.index), codec: String(v.codec_name), width: w, height: h, fps: fps && fps < 1000 ? fps : null }
  }
  const durs = [num(j.format?.duration), ...streams.map((s) => num(s.duration))].filter((d): d is number => d !== null && d > 0)
  return {
    durationSec: num(j.format?.duration) ?? (durs.length ? Math.max(...durs) : null),
    format: String(j.format?.format_name ?? '').split(',')[0] || 'unknown',
    video,
    audio: a ? { index: Number(a.index), codec: String(a.codec_name), channels: num(a.channels), sampleRate: num(a.sample_rate) } : null,
    cover: !video && covers.length > 0,
  }
}

/** A converter's end as the error a read maps to a note (never its stderr). */
function refused(r: { killed: string | null; code: number | null; stderr: string }, signal?: AbortSignal): ToolError {
  signal?.throwIfAborted()
  // the run replaced its work folder (tools/isolate.ts runIsolated): the file is damaged or cannot be read, as for the
  // other converters (the HWP renderer), not "too heavy"; the read stops there (assertWork)
  if (r.killed === 'workdir') return new ToolError('the work folder was replaced', 'media_damaged')
  if (r.killed) return new ToolError(`stopped (${r.killed})`, 'media_heavy')
  if (/not on whitelist/.test(r.stderr)) return new ToolError('a format or codec outside the allow-list', 'media_unsupported')
  return new ToolError(`exit ${r.code}`, 'media_damaged')
}

/** ffprobe of `name` in the work folder `work`. Throws ToolError media_* (never converter text). */
export async function probeMedia(tools: MediaTools, work: string, name: string, signal?: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS): Promise<MediaInfo> {
  const r = await runIsolated({
    cmd: tools.ffprobe, workDir: work, signal, timeoutMs: Math.min(PROBE_TIMEOUT_MS, timeoutMs), maxRssMiB: PROBE_RSS_MIB, maxStdout: 1024 * 1024, maxWorkBytes: workCap(work, name),
    args: ['-v', 'error', '-threads', '1', ...INPUT_GUARD,
      // stream_disposition and stream_side_data as sections: "stream=…,disposition" prints no disposition at all
      '-show_entries', 'format=duration,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels,duration:stream_disposition=default,attached_pic:stream_side_data=rotation',
      '-of', 'json', name],
  })
  if (r.killed || r.code !== 0) throw refused(r, signal)
  const info = parseProbe(r.stdout.toString('utf8'))
  if (info.durationSec !== null && info.durationSec > MEDIA_MAX_SECONDS) throw new ToolError('longer than the limit', 'media_too_long')
  return info
}

/** The length of a file that does not say (a browser's MediaRecorder webm): its packets read through without decoding. */
export async function scanDuration(tools: MediaTools, work: string, name: string, signal?: AbortSignal, timeoutMs = SCAN_TIMEOUT_MS): Promise<number | null> {
  const r = await runIsolated({
    cmd: tools.ffmpeg, workDir: work, signal, timeoutMs: Math.min(SCAN_TIMEOUT_MS, timeoutMs), maxRssMiB: PROBE_RSS_MIB, maxStdout: 4 * 1024 * 1024, maxWorkBytes: workCap(work, name),
    args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', ...INPUT_GUARD, '-i', name, '-map', '0', '-c', 'copy', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'],
  })
  signal?.throwIfAborted()
  // a run that ends otherwise gives no length; one that replaced its work folder ends the read
  if (r.killed === 'workdir') throw refused(r, signal)
  const all = [...r.stdout.toString('utf8').matchAll(/^out_time_us=(\d+)$/gm)]
  const us = all.length ? Number(all[all.length - 1]![1]) : NaN
  return Number.isFinite(us) && us > 0 ? us / 1e6 : null
}

/** Whether frames of this picture size are made at all. */
export const frameable = (v: NonNullable<MediaInfo['video']>) => v.width <= MEDIA_MAX_SIDE && v.height <= MEDIA_MAX_SIDE && v.width * v.height <= MEDIA_MAX_PIXELS

/** One frame at `t` seconds as a PNG (longest side at most `px`, square pixels, 8-bit RGB), on stdout. */
export async function framePng(tools: MediaTools, work: string, name: string, stream: number, t: number, px: number, signal?: AbortSignal, timeoutMs = FRAME_TIMEOUT_MS): Promise<Buffer> {
  const r = await runIsolated({
    cmd: tools.ffmpeg, workDir: work, signal, timeoutMs: Math.min(FRAME_TIMEOUT_MS, timeoutMs), maxRssMiB: FRAME_RSS_MIB, maxStdout: FRAME_PNG_MAX, maxWorkBytes: workCap(work, name),
    args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', ...INPUT_GUARD, '-ss', t.toFixed(3), '-i', name,
      '-map', `0:${stream}`, '-frames:v', '1', '-an', '-sn', '-dn',
      // non-square pixels (some cameras) to square ones first, at most 8192 wide; rotation is applied by ffmpeg itself
      '-vf', `scale='trunc(min(iw*sar,${MEDIA_MAX_SIDE})/2)*2':ih,setsar=1,scale='min(${px},iw)':'min(${px},ih)':force_original_aspect_ratio=decrease,format=rgb24`,
      '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'],
  })
  if (r.killed || r.code !== 0) throw refused(r, signal)
  const png = r.stdout
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new ToolError('no frame at that time', 'media_no_frame')
  return png
}

/** The sound from `start` for `seconds` as 16 kHz mono 16-bit WAV (at most OPENROUTER_MAX_BYTES), written to `out` in
 * the work folder and read back without following a link; the file stays for whisper.cpp, the caller removes it. */
export async function audioWav(tools: MediaTools, work: string, name: string, stream: number, start: number, seconds: number, out: string,
  o: { signal?: AbortSignal; timeoutMs?: number; inputBytes: number }): Promise<Buffer> {
  const r = await runIsolated({
    cmd: tools.ffmpeg, workDir: work, signal: o.signal, timeoutMs: Math.min(AUDIO_TIMEOUT_MS, o.timeoutMs ?? AUDIO_TIMEOUT_MS), maxRssMiB: AUDIO_RSS_MIB,
    maxStdout: 1024 * 1024, maxWorkBytes: o.inputBytes + OPENROUTER_MAX_BYTES + 16 * 1024 ** 2,
    args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', ...INPUT_GUARD, '-ss', start.toFixed(3), '-t', seconds.toFixed(3), '-i', name,
      '-map', `0:${stream}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', out],
  })
  if (r.killed || r.code !== 0) throw refused(r, o.signal)
  const got = readOutput(work, out, OPENROUTER_MAX_BYTES)
  if (!got.ok) throw new ToolError(`no sound (${got.why})`, got.why === 'too_large' ? 'media_heavy' : 'media_damaged')
  return got.bytes
}

// ---------------- times ----------------
/** "1:02:03.5" / "2:30" / "90.5" -> seconds, or NaN */
function seconds(s: string): number {
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(s)) return NaN
  const parts = s.split(':').map(Number)
  if (parts.slice(1).some((p) => p >= 60)) return NaN
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/**
 * The `time` value: "1:00-2:30", "90-150" (seconds), "1:00-" (to the end) or "0:05" (one moment). An end past the end of
 * the file stops there, like a range of PDF pages. Errors say what to send (the AI reads them).
 */
export function parseTime(spec: string, duration: number): { start: number; end: number; moment: boolean } {
  const s = spec.replace(/\s+/g, '')
  const m = /^([^-]+)(-([^-]*))?$/.exec(s)
  const bad = () => new ToolError(`time must look like "1:00-2:30", "90-150" (seconds), "1:00-" (to the end) or "0:05" (one moment); got "${spec.slice(0, 40)}"`, 'bad_time')
  if (!m) throw bad()
  const start = seconds(m[1]!)
  if (!Number.isFinite(start)) throw bad()
  if (start >= duration) throw new ToolError(`time ${clock(start)} is past the end: this file is ${clock(duration)} long`, 'bad_time')
  if (m[2] === undefined) return { start, end: start, moment: true }
  const end = m[3] ? seconds(m[3]) : duration
  if (!Number.isFinite(end)) throw bad()
  if (end <= start) throw new ToolError(`time "${spec.slice(0, 40)}" ends before it starts`, 'bad_time')
  return { start, end: Math.min(end, duration), moment: false }
}

/** "0:05.3", "12:03.0", "1:02:03" (one decimal under an hour) */
export function clock(sec: number): string {
  const t = Math.max(0, sec)
  if (t >= 3600) {
    const s = Math.floor(t)
    return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }
  const d = Math.round(t * 10) / 10
  return `${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, '0')}`
}
/** a `time` value to send: whole seconds ("10:00", "1:00:00") */
export function timeArg(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** frames without `frames`: one every 1.5 s, 1 to 12 */
export const defaultFrames = (len: number) => Math.min(FRAMES_DEFAULT_MAX, Math.max(1, Math.round(len / 1.5)))
/** longest side of a frame: fewer frames, bigger pictures (small text on a screen recording needs 1568 px) */
export const framePx = (n: number) => (n <= 4 ? 1568 : n <= 12 ? 1024 : 768)
/** `n` frames evenly over [start, end): the middle of each of n equal parts (never the black first frame of a fade) */
export function frameTimes(start: number, end: number, n: number): number[] {
  if (n <= 0) return []
  if (end <= start) return [start]
  const step = (end - start) / n
  return Array.from({ length: n }, (_, i) => start + (i + 0.5) * step)
}

// ---------------- the media slot ----------------
/** one media read at a time on this server (ffmpeg on a 4 GB box, and the transcription of reads: its own slot, so a
 * person's mic dictation never waits behind a video); each person may have a few waiting, so parallel sub-agents queue
 * instead of failing "busy" */
export const MEDIA_PARALLEL = 1
export const MEDIA_QUEUE_MAX = 8
export const MEDIA_PER_PERSON = 4
export const MEDIA_WAIT_MS = 5 * 60_000
let running = 0
const owners = new Map<string, number>()
const waiting: { owner: string; go: () => void }[] = []

/** Run `f` in the media slot for `owner`. Throws ToolError media_busy (queue full, or the wait passed `waitMs`). */
export async function mediaSlot<T>(owner: string, f: () => Promise<T>, signal?: AbortSignal, waitMs = MEDIA_WAIT_MS): Promise<T> {
  signal?.throwIfAborted()
  if ((owners.get(owner) ?? 0) >= MEDIA_PER_PERSON) throw new ToolError('too many media reads of this person', 'media_busy')
  if (running >= MEDIA_PARALLEL && waiting.length >= MEDIA_QUEUE_MAX) throw new ToolError('too many media reads', 'media_busy')
  owners.set(owner, (owners.get(owner) ?? 0) + 1)
  try {
    if (running >= MEDIA_PARALLEL) {
      await new Promise<void>((resolve, reject) => {
        const w = { owner, go: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve() } }
        const drop = () => { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1) }
        const onAbort = () => { clearTimeout(timer); drop(); reject(signal!.reason) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); drop(); reject(new ToolError('waited too long for the media slot', 'media_busy')) }, waitMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        waiting.push(w)
      })
    } else running++
    try { return await f() } finally {
      const next = waiting.shift()
      if (next) next.go()
      else running--
    }
  } finally {
    const n = (owners.get(owner) ?? 1) - 1
    if (n > 0) owners.set(owner, n)
    else owners.delete(owner)
  }
}
/** media reads running and waiting (tests, diagnostics) */
export const mediaStats = () => ({ running, waiting: waiting.length })

// ---------------- work folders ----------------
/** the work folders of the reads running in this process, with the dev:ino each was made with */
const active = new Map<string, string>()
/** dev:ino of a plain folder (never through a link), or null */
function folderId(p: string): string | null {
  try { const st = fs.lstatSync(p); return st.isDirectory() ? `${st.dev}:${st.ino}` : null } catch { return null }
}
/** A fresh work folder `<base>/vid-<uuid>` (0700) for one read; drop it with dropWork. */
export function mediaWork(base: string): string {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const dir = path.join(base, `vid-${crypto.randomUUID()}`)
  fs.mkdirSync(dir, { mode: 0o700 })
  const real = fs.realpathSync(dir)
  active.set(real, folderId(real)!)
  return real
}
/** Whether `dir` is still the plain folder mediaWork made. A converter that replaced it (runIsolated 'workdir'; the
 * macOS sandbox allows that) leaves a link or another folder in its place: nothing more is run, read or removed in it. */
export function workIntact(dir: string): boolean {
  const id = active.get(dir)
  return id !== undefined && folderId(dir) === id
}
/** After a converter run failed: a read whose work folder was replaced ends as a damaged file (media_damaged). */
export function assertWork(dir: string) {
  if (!workIntact(dir)) throw new ToolError('the work folder was replaced', 'media_damaged')
}
/** Removes the folder (a link left in its place: the link, never what it points at). */
export function dropWork(dir: string) { active.delete(dir); fs.rmSync(dir, { recursive: true, force: true }) }
/** At start: no media read survives a restart, so every vid-* folder left in the work folder goes now (a crash could
 * leave a 1 GB copy there for the 24 h scratch sweep). Folders of reads running in this process are kept. */
export function cleanMediaWork(base: string): number {
  let n = 0
  let names: string[] = []
  try { names = fs.readdirSync(base) } catch { return 0 }
  for (const f of names) {
    if (!f.startsWith('vid-')) continue
    const p = path.join(base, f)
    if (active.has(p)) continue
    try { fs.rmSync(p, { recursive: true, force: true }); n++ } catch { /* gone */ }
  }
  return n
}

// ---------------- the transcript cache ----------------
export interface Segment { start: number; end: number; text: string }
export interface Piece { segments: Segment[]; language: string | null }

/**
 * Transcripts by content: `<data>/mediacache/<key>.json` (0700 folder, 0600 files), the key a sha256 of the file's
 * sha256, the provider and model and the piece. A piece is opened only by a read that was allowed to read a file with
 * those bytes; it never leaves the server again (a confidential chat may use one: nothing new goes out). Not in
 * backups (the data folder holds it, not the team folder). At most 200 MB and 30 days; least recently used go first.
 */
export class TranscriptCache {
  constructor(readonly dir: string, readonly maxBytes = 200 * 1024 ** 2, readonly maxAgeMs = 30 * 86_400_000) {}
  static key(p: { file: string; provider: string; model: string; piece: number; pieceSec: number }): string {
    return crypto.createHash('sha256').update(JSON.stringify(['transcript-v1', p.file, p.provider, p.model, p.pieceSec, p.piece])).digest('hex')
  }
  private file(key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('bad cache key')
    return path.join(this.dir, `${key}.json`)
  }
  get(key: string): Piece | null {
    const got = readOutput(this.dir, path.basename(this.file(key)), 16 * 1024 ** 2)
    if (!got.ok) return null
    try {
      const j = JSON.parse(got.bytes.toString('utf8')) as Piece
      if (!Array.isArray(j.segments)) return null
      const now = new Date()
      try { fs.utimesSync(this.file(key), now, now) } catch { /* fine */ }
      return { language: typeof j.language === 'string' ? j.language : null, segments: j.segments.filter((s) => typeof s?.start === 'number' && typeof s?.end === 'number' && typeof s?.text === 'string') }
    } catch { return null }
  }
  set(key: string, piece: Piece) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const tmp = path.join(this.dir, `.${key}.${crypto.randomBytes(6).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(piece), { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, this.file(key))
    this.prune()
  }
  /** older than 30 days, then the least recently used while over the size cap */
  prune(now = Date.now()): number {
    let names: string[] = []
    try { names = fs.readdirSync(this.dir) } catch { return 0 }
    const files: { p: string; size: number; at: number }[] = []
    let n = 0
    for (const f of names) {
      const p = path.join(this.dir, f)
      let st: fs.Stats
      try { st = fs.lstatSync(p) } catch { continue }
      if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs || (f.endsWith('.tmp') && now - st.mtimeMs > 3600_000)) { fs.rmSync(p, { force: true, recursive: true }); n++; continue }
      files.push({ p, size: st.size, at: st.mtimeMs })
    }
    let total = files.reduce((a, f) => a + f.size, 0)
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= this.maxBytes) break
      fs.rmSync(f.p, { force: true }); total -= f.size; n++
    }
    return n
  }
}

/** A provider's answer for one piece -> the piece's segments in file time (whisper's music / blank markers dropped, and
 * lines whose time holds no sound at all: whisper invents them over silence). The language only when a line is left. */
export function pieceOf(r: TranscribeResult, offset: number, length: number, voice?: Voice): Piece {
  const raw = r.segments?.length ? r.segments : r.text ? [{ start: 0, end: length, text: r.text }] : []
  const segments = raw
    .filter((s) => !voice || soundNear(voice, Math.max(0, s.start), Math.min(Math.max(s.end, s.start), length)))
    .map((s) => ({ start: offset + Math.max(0, s.start), end: offset + Math.min(Math.max(s.end, s.start), length), text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text && !/^\[(BLANK_AUDIO|MUSIC|음악|music|silence)\]$/i.test(s.text))
  return { segments, language: segments.length ? r.language : null }
}
/** a piece of silence: nothing sent, nothing said */
export const SILENT_PIECE: Piece = { segments: [], language: null }

/** The languages of a transcript, most spoken first (by the length of their lines; pieces of silence name none), so
 * one piece's guess never labels the whole transcript. */
export function transcriptLanguages(pieces: Piece[]): string[] {
  const time = new Map<string, number>()
  for (const p of pieces) {
    if (!p.language || !p.segments.length) continue
    time.set(p.language, (time.get(p.language) ?? 0) + p.segments.reduce((n, s) => n + Math.max(0.1, s.end - s.start), 0))
  }
  return [...time.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)
}
