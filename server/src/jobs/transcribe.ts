// Transcription (tab 4 "음성", tab 2 OS table) with whisper.cpp — no Python. On first use the multilingual GGML model
// is downloaded into <data>/models/whisper/ (size and sha256 pinned below, written to a .part file, verified, then
// renamed). Audio is converted to 16 kHz mono WAV by ffmpeg first (browsers record webm/opus or mp4/aac, which
// whisper-cli can't read); without ffmpeg only wav/mp3/flac/ogg work. Both run isolated (tools/isolate.ts).
// Missing tools fail the job with a message that says what to install.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Locale, TranscribeResult } from '@mycel/shared/api'
import { which } from '../config'
import type { JobHandle } from '../services'
import { runIsolated } from '../tools/isolate'
import { JobFailure } from './service'

export const WHISPER_MODELS = {
  tiny: { file: 'ggml-tiny.bin', size: 77_691_713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
  base: { file: 'ggml-base.bin', size: 147_951_465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  small: { file: 'ggml-small.bin', size: 487_601_967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
} as const
export type WhisperModel = keyof typeof WHISPER_MODELS
export const DEFAULT_WHISPER_MODEL: WhisperModel = 'small'
export const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
/** audio / video extensions the converter input may keep */
const MEDIA_EXT = new Set(['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'webm', 'weba', 'm4a', 'mp4', 'm4v', 'mov', 'aac', 'aiff', 'aif', 'aifc', 'caf', 'mkv', 'amr', '3gp', 'wma', 'avi'])
/** "in.<ext>" for a known audio / video extension, else "in.bin" */
export const converterInputName = (name: string) => {
  const x = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase()
  return `in.${MEDIA_EXT.has(x) ? x : 'bin'}`
}
/** formats whisper-cli reads itself */
const NATIVE = new Set(['wav', 'mp3', 'flac', 'ogg'])

export interface ModelSpec { file: string; size: number; sha256: string }
export interface TranscribeConfig {
  modelDir: string
  model: WhisperModel
  /** tests: a different (small, fake) model file instead of WHISPER_MODELS[model] */
  modelOverride?: ModelSpec
  whisperBin: string | null
  ffmpegBin: string | null
  /** where models come from (tests point this at a local server) */
  baseUrl: string
  /** scratch folder parent for the converter work folders */
  workBase: string
  threads: number
}

export function transcribeConfig(dataDir: string, env: Record<string, string | undefined> = process.env): TranscribeConfig {
  const m = env.MYCEL_WHISPER_MODEL as WhisperModel | undefined
  return {
    modelDir: env.MYCEL_WHISPER_MODEL_DIR ?? path.join(dataDir, 'models', 'whisper'),
    model: m && m in WHISPER_MODELS ? m : DEFAULT_WHISPER_MODEL,
    whisperBin: env.MYCEL_WHISPER_BIN ?? which('whisper-cli'),
    ffmpegBin: which('ffmpeg'),
    baseUrl: env.MYCEL_WHISPER_BASE_URL ?? MODEL_BASE_URL,
    workBase: path.join(dataDir, 'work'),
    threads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
  }
}

const LABELS = {
  model: { ko: (mb: number) => `음성 인식 모델 내려받는 중 (${mb} MB, 처음 한 번만)`, en: (mb: number) => `Downloading the speech model (${mb} MB, first time only)`, id: (mb: number) => `Mengunduh model suara (${mb} MB, hanya sekali)` },
  convert: { ko: '오디오 변환 중', en: 'Converting audio', id: 'Mengonversi audio' },
  run: { ko: '받아쓰는 중', en: 'Transcribing', id: 'Mentranskripsi' },
}

const fail = (ko: string, en: string, id: string, code: 'unavailable' | 'bad_request' | 'internal' = 'unavailable') => new JobFailure(code, { ko, en, id })

export const MISSING_WHISPER = () => fail(
  '받아쓰기 도구(whisper.cpp)가 서버에 없습니다. 서버 맥에서 `brew install whisper-cpp`를 실행한 뒤 다시 해 주세요.',
  'The transcription tool (whisper.cpp) is not installed on the server. Run `brew install whisper-cpp` on the server Mac, then try again.',
  'Alat transkripsi (whisper.cpp) belum terpasang di server. Jalankan `brew install whisper-cpp` di Mac server, lalu coba lagi.')

const modelSpec = (cfg: TranscribeConfig): ModelSpec => cfg.modelOverride ?? WHISPER_MODELS[cfg.model]

let downloading: Promise<string> | null = null

/** Path of the model file, downloading it first if needed (one download at a time). */
export async function ensureModel(cfg: TranscribeConfig, h?: Pick<JobHandle, 'progress' | 'signal'>, locale: Locale = 'ko'): Promise<string> {
  const spec = modelSpec(cfg)
  const file = path.join(cfg.modelDir, spec.file)
  try { if (fs.statSync(file).size === spec.size) return file } catch { /* not there yet */ }
  if (!downloading) downloading = download(cfg, file, h, locale).finally(() => { downloading = null })
  return downloading
}

async function download(cfg: TranscribeConfig, file: string, h: Pick<JobHandle, 'progress' | 'signal'> | undefined, locale: Locale): Promise<string> {
  const spec = modelSpec(cfg)
  fs.mkdirSync(cfg.modelDir, { recursive: true, mode: 0o700 })
  const part = file + '.part'
  const label = LABELS.model[locale](Math.round(spec.size / 1e6))
  h?.progress(0, label)
  let res: Response
  try { res = await fetch(cfg.baseUrl + spec.file, { signal: h?.signal, redirect: 'follow' }) } catch (e) {
    if (h?.signal.aborted) throw e
    throw fail('음성 인식 모델을 내려받지 못했습니다(인터넷 연결 확인).', 'Could not download the speech model (check the internet connection).', 'Gagal mengunduh model suara (periksa koneksi internet).')
  }
  if (!res.ok || !res.body) throw fail(`음성 인식 모델을 내려받지 못했습니다(HTTP ${res.status}).`, `Could not download the speech model (HTTP ${res.status}).`, `Gagal mengunduh model suara (HTTP ${res.status}).`)
  const hash = crypto.createHash('sha256')
  const fh = await fs.promises.open(part, 'w', 0o600)
  let got = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      got += value.byteLength
      if (got > spec.size) break
      hash.update(value)
      await fh.write(value)
      h?.progress(0.5 * (got / spec.size), label)
    }
  } catch (e) {
    fs.rmSync(part, { force: true })
    if (h?.signal.aborted) throw e
    throw fail('음성 인식 모델을 내려받는 중 연결이 끊겼습니다. 다시 시도해 주세요.', 'The speech model download was interrupted. Please try again.', 'Unduhan model suara terputus. Coba lagi.')
  } finally { try { reader.releaseLock() } catch {} await fh.close() }
  if (got !== spec.size || hash.digest('hex') !== spec.sha256) {
    fs.rmSync(part, { force: true })
    throw fail('내려받은 음성 인식 모델이 손상되었습니다. 다시 시도해 주세요.', 'The downloaded speech model is damaged. Please try again.', 'Model suara yang diunduh rusak. Coba lagi.', 'internal')
  }
  fs.renameSync(part, file)
  return file
}

/** Run whisper.cpp on one audio file. `input` is a server-owned file; it is not modified. */
export async function transcribe(cfg: TranscribeConfig, input: string, name: string, o: { language?: string; locale?: Locale }, h: JobHandle): Promise<TranscribeResult> {
  const loc = o.locale ?? 'ko'
  if (!cfg.whisperBin) throw MISSING_WHISPER()
  const x = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase()
  if (!cfg.ffmpegBin && !NATIVE.has(x)) {
    throw fail(`이 형식(${x || '알 수 없음'})을 읽으려면 서버에 ffmpeg가 필요합니다(\`brew install ffmpeg\`). wav·mp3·flac·ogg는 바로 됩니다.`,
      `Reading this format (${x || 'unknown'}) needs ffmpeg on the server (\`brew install ffmpeg\`). wav, mp3, flac and ogg work without it.`,
      `Format ini (${x || 'tidak dikenal'}) memerlukan ffmpeg di server (\`brew install ffmpeg\`).`)
  }
  const model = await ensureModel(cfg, h, loc)
  fs.mkdirSync(cfg.workBase, { recursive: true, mode: 0o700 })
  const work = fs.realpathSync(fs.mkdtempSync(path.join(cfg.workBase, 'stt-')))
  try {
    // the input's name only keeps a known audio / video extension: ffmpeg picks demuxers by extension, and some
    // (m3u8 playlists, ffconcat) open further files or URLs
    const src = path.join(work, converterInputName(name))
    fs.copyFileSync(input, src, fs.constants.COPYFILE_FICLONE)
    let audio = path.basename(src)
    if (cfg.ffmpegBin) {
      h.progress(0.5, LABELS.convert[loc])
      const r = await runIsolated({ cmd: cfg.ffmpegBin, workDir: work, timeoutMs: 10 * 60_000, signal: h.signal,
        args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', audio, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 'audio.wav'] })
      if (h.signal.aborted) throw new Error('aborted')
      if (r.code !== 0) throw fail('오디오 파일을 읽을 수 없습니다.', 'The audio file could not be read.', 'Berkas audio tidak dapat dibaca.', 'bad_request')
      audio = 'audio.wav'
    }
    const label = LABELS.run[loc]
    h.progress(0.55, label)
    const lang = o.language && /^[a-z]{2}$/.test(o.language) ? o.language : 'auto'
    const r = await runIsolated({
      cmd: cfg.whisperBin, workDir: work, readPaths: [model], gpu: true, timeoutMs: 60 * 60_000, signal: h.signal,
      args: ['-m', model, '-f', audio, '-l', lang, '-oj', '-of', 'out', '-np', '-pp', '-t', String(cfg.threads)],
      onStderr: (s) => {
        const m = /progress\s*=\s*(\d+)%/g
        let last: RegExpExecArray | null = null, k: RegExpExecArray | null
        while ((k = m.exec(s))) last = k
        if (last) h.progress(0.55 + 0.45 * (Number(last[1]) / 100), label)
      },
    })
    if (h.signal.aborted) throw new Error('aborted')
    const out = path.join(work, 'out.json')
    if (r.code !== 0 || !fs.existsSync(out)) {
      throw fail('받아쓰기에 실패했습니다.', `Transcription failed (${r.killed ?? 'exit ' + r.code}).`, 'Transkripsi gagal.', 'internal')
    }
    return parseWhisperJson(fs.readFileSync(out, 'utf8'))
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** whisper-cli -oj output -> TranscribeResult */
export function parseWhisperJson(s: string): TranscribeResult {
  const j = JSON.parse(s) as { result?: { language?: string }; transcription?: { offsets?: { from: number; to: number }; text?: string }[] }
  const segs = (j.transcription ?? []).map((t) => ({ start: (t.offsets?.from ?? 0) / 1000, end: (t.offsets?.to ?? 0) / 1000, text: (t.text ?? '').trim() })).filter((t) => t.text && !/^\[(BLANK_AUDIO|MUSIC|음악)\]$/i.test(t.text))
  return {
    text: segs.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim(),
    language: j.result?.language ?? null,
    durationSec: segs.length ? segs[segs.length - 1]!.end : null,
    segments: segs,
  }
}
