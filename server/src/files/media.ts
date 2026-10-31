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
/** transcripts are made and cached in fixed pieces from 0:00 (10 minutes: one OpenRouter request, 19.2 MB of 16 kHz WAV
 * under its 25 MB). Local whisper.cpp: 2-minute pieces everywhere, so a slow server (a 2 vCPU box gives whisper 1
 * thread, and the converter rlimit counts CPU seconds of all its threads) keeps every piece it finished instead of losing
 * a 10-minute one to the read's deadline; on a hosted server (a plan) at most one new piece a read (founder Q8) */
export const TRANSCRIPT_PIECE_SEC = 600
export const LOCAL_PIECE_SEC = 120
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
/** the share of the read's time kept for each planned frame (at most FRAMES_TOTAL_MS): the transcript, made first,
 * starts no new piece into it, so slow local transcription does not leave a video read without its frames */
export const FRAME_RESERVE_MS = 5_000
/** The time a new transcript piece of `seconds` must still have to start: cutting its sound and the provider's answer
 * (OpenRouter: upload and transcription, at most its own 60 s; whisper.cpp: about 4x real time on a small server). A
 * piece cut off by the deadline is lost, and OpenRouter may bill it anyway. */
export function pieceNeedsMs(provider: 'openrouter' | 'local', seconds: number): number {
  return provider === 'openrouter' ? Math.min(60_000, 10_000 + seconds * 50) : 20_000 + seconds * 250
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
const active = new Set<string>()
/** A fresh work folder `<base>/vid-<uuid>` (0700) for one read; drop it with dropWork. */
export function mediaWork(base: string): string {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const dir = path.join(base, `vid-${crypto.randomUUID()}`)
  fs.mkdirSync(dir, { mode: 0o700 })
  const real = fs.realpathSync(dir)
  active.add(real)
  return real
}
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

/** A provider's answer for one piece -> the piece's segments in file time (whisper's music / blank markers dropped). */
export function pieceOf(r: TranscribeResult, offset: number, length: number): Piece {
  const raw = r.segments?.length ? r.segments : r.text ? [{ start: 0, end: length, text: r.text }] : []
  const segments = raw
    .map((s) => ({ start: offset + Math.max(0, s.start), end: offset + Math.min(Math.max(s.end, s.start), length), text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text && !/^\[(BLANK_AUDIO|MUSIC|음악|music|silence)\]$/i.test(s.text))
  return { segments, language: r.language }
}
