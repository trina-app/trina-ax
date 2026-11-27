// Transcription (tab 4 "음성", tab 2 OS table), the 'local' speech provider: whisper.cpp on this server — no Python.
// The default provider is 'off'; 'openrouter' sends the audio to OpenRouter (jobs/openrouter-stt.ts). On first use the multilingual GGML model
// is downloaded into <data>/models/whisper/ (size and sha256 pinned below, written to a .part file, verified, then
// renamed). Audio is converted to 16 kHz mono WAV by ffmpeg first (browsers record webm/opus or mp4/aac, which
// whisper-cli can't read); without ffmpeg only wav/mp3/flac/ogg work. On an Apple silicon Mac without ffmpeg, macOS's
// own afconvert decodes instead (jobs/mac-audio.ts; the web app then records voice input as WAV, Me.team.voiceInputWav).
// All run isolated (tools/isolate.ts).
// Missing tools fail the job with a message that says what to install.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_LOCALE, type LocalSpeechTool, type Locale, type TranscribeResult } from '@mycel/shared/api'
import { which } from '../config'
import type { JobHandle } from '../services'
import { readOutput, runIsolated } from '../tools/isolate'
import { JobFailure } from './service'
import { whisperThreads } from '../system/limits'
import { dictationTurn } from './whisper-turns'
import type { SpeechMeter } from '../credentials/hosted-speech'
import { DOWNLOAD_IDLE_MS, downloadDeadline, downloadTotalMs, type DownloadDeadline } from '../http/download-deadline'
import { ToolError } from '../policy/errors'
import { diskReserve, diskStat, DiskSpaceUnknown, type DiskStat } from '../system/disk-stat'
import { extOf, MAC_AUDIO_EXT, macAudioTools, macDecode, macWavPiece, macWavSeconds, type MacAudioTools } from './mac-audio'
import { keepSpeech, silent, soundOf, UNSURE_FIRST_P, type Sound } from './no-speech'
import { copyOffLoop } from '../files/copy-off-loop'

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
  /** read-only model folder shared by the teams of a host ($MYCEL_MODELS_DIR/whisper): used when the file there has the
   * right size and hash, never written */
  sharedModelDir?: string | null
  model: WhisperModel
  /** tests: a different (small, fake) model file instead of WHISPER_MODELS[model] */
  modelOverride?: ModelSpec
  whisperBin: string | null
  ffmpegBin: string | null
  /** an Apple silicon Mac's own audio programs (jobs/mac-audio.ts macAudioTools), used where ffmpeg is missing; absent
   * or null elsewhere (Intel Macs, Linux, tests) */
  mac?: MacAudioTools | null
  /** where models come from (tests point this at a local server) */
  baseUrl: string
  /** tests: shorter model download deadlines (default http/download-deadline.ts: 120 s without data, 10 min + 250 KB/s) */
  /** tests: the disk the model's folder is on (default system/disk-stat.ts diskStat) */
  statfs?: (p: string) => DiskStat
  downloadIdleMs?: number
  downloadTotalMs?: number
  /** scratch folder parent for the converter work folders */
  workBase: string
  threads: number
  /** OpenRouter's speech-to-text endpoint (fixed; tests point it at a local fake) */
  openRouterUrl: string
  /** every OpenRouter speech request goes through it: the hosting service's free hours (credentials/hosted-speech.ts;
   * set by component C, which has the credentials vault). Absent: nothing is counted. */
  meter?: SpeechMeter
}
export const OPENROUTER_STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'

/** What this server lacks for voice input with the 'local' provider: whisper-cli, and ffmpeg, because browsers record
 * webm/opus (Safari mp4/aac), which whisper-cli cannot read. An Apple silicon Mac needs no ffmpeg: macOS decodes the
 * recordings (jobs/mac-audio.ts) and the web app sends WAV there (Me.team.voiceInputWav); the office zip carries
 * whisper-cli for it (scripts/build-office.ts). With one missing, Me.team.voiceInput is false and Team settings names it
 * (GET /api/admin/speech-host localMissing). */
export function missingLocalTools(cfg: Pick<TranscribeConfig, 'whisperBin' | 'ffmpegBin' | 'mac'>): LocalSpeechTool[] {
  return [...(cfg.whisperBin ? [] : ['whisper.cpp' as const]), ...(cfg.ffmpegBin || cfg.mac ? [] : ['ffmpeg' as const])]
}
/** Voice input recordings must come as WAV: the server has no ffmpeg and decodes with macOS's programs, which do not
 * open the webm/opus browsers record (Me.team.voiceInputWav). */
export const wantsWavRecordings = (cfg: Pick<TranscribeConfig, 'ffmpegBin' | 'mac'>): boolean => !cfg.ffmpegBin && !!cfg.mac
/** 'local' works here with nothing to install or turn on, and the machine is meant for it: an Apple silicon Mac with
 * whisper-cli (the office zip's) and macOS's decoders, or any server with whisper-cli and ffmpeg (the Linux kit and the
 * Docker image carry both) that has at least 4 CPU cores and 8 GB (`bigEnough`: shared localSpeechBigEnough; the owner,
 * 2026-11-19). Such a server's voice input reads 'local' while no admin chose a provider (admin/settings.ts
 * setLocalSpeechReady, main.ts). */
export const localSpeechReady = (cfg: Pick<TranscribeConfig, 'whisperBin' | 'ffmpegBin' | 'mac'>, bigEnough = false): boolean =>
  !!cfg.whisperBin && (!!cfg.mac || (!!cfg.ffmpegBin && bigEnough))

export function transcribeConfig(dataDir: string, env: Record<string, string | undefined> = process.env): TranscribeConfig {
  const m = env.MYCEL_WHISPER_MODEL as WhisperModel | undefined
  return {
    modelDir: env.MYCEL_WHISPER_MODEL_DIR ?? path.join(dataDir, 'models', 'whisper'),
    sharedModelDir: env.MYCEL_MODELS_DIR ? path.join(env.MYCEL_MODELS_DIR, 'whisper') : null,
    model: m && m in WHISPER_MODELS ? m : DEFAULT_WHISPER_MODEL,
    whisperBin: env.MYCEL_WHISPER_BIN ?? which('whisper-cli'),
    ffmpegBin: which('ffmpeg'),
    mac: macAudioTools(),
    baseUrl: env.MYCEL_WHISPER_BASE_URL ?? MODEL_BASE_URL,
    workBase: path.join(dataDir, 'work'),
    // min(8, cores − 1) as before; where limits apply max(1, min(4, plan cores − 1)) (system/limits.ts)
    threads: whisperThreads(),
    openRouterUrl: OPENROUTER_STT_URL,
  }
}

export const LABELS = {
  model: { ko: (mb: number) => `음성 인식 모델 내려받는 중 (${mb} MB, 처음 한 번만)`, en: (mb: number) => `Downloading the speech model (${mb} MB, first time only)`, id: (mb: number) => `Mengunduh model suara (${mb} MB, hanya sekali)`, ja: (mb: number) => `音声認識モデルをダウンロード中（${mb} MB、初回のみ）`, es: (mb: number) => `Descargando el modelo de voz (${mb} MB, solo la primera vez)`, zh: (mb: number) => `正在下载语音识别模型（${mb} MB，仅首次需要）` },
  convert: { ko: '오디오 변환 중', en: 'Converting audio', id: 'Mengonversi audio', ja: "音声を変換中", es: "Convirtiendo audio", zh: "正在转换音频" },
  run: { ko: '받아쓰는 중', en: 'Transcribing', id: 'Mentranskripsi', ja: "文字起こし中", es: "Transcribiendo", zh: "正在转写" },
}

export const fail = (ko: string, en: string, id: string, ja: string, es: string, zh: string, code: 'unavailable' | 'bad_request' | 'internal' | 'rate_limited' | 'payload_too_large' | 'forbidden' = 'unavailable', reason?: string) => new JobFailure(code, { ko, en, id, ja, es, zh }, reason)

export const MISSING_WHISPER = () => fail(
  '받아쓰기 도구(whisper.cpp)가 서버에 없어요. 서버 맥에서 `brew install whisper-cpp`를 실행한 뒤 다시 해 주세요.',
  'The transcription tool (whisper.cpp) is not installed on the server. Run `brew install whisper-cpp` on the server Mac, then try again.',
  'Alat transkripsi (whisper.cpp) belum terpasang di server. Jalankan `brew install whisper-cpp` di Mac server, lalu coba lagi.', "文字起こしツール（whisper.cpp）がサーバーにありません。サーバーのMacで`brew install whisper-cpp`を実行して再試行してください。", "La herramienta de transcripción (whisper.cpp) no está instalada en el servidor. Ejecute `brew install whisper-cpp` en el Mac del servidor y vuelva a intentarlo.", "服务器上没有安装转写工具（whisper.cpp）。请在服务器 Mac 上运行 `brew install whisper-cpp`，然后重试。")

const modelSpec = (cfg: TranscribeConfig): ModelSpec => cfg.modelOverride ?? WHISPER_MODELS[cfg.model]

let downloading: Promise<string> | null = null
/** the model is being downloaded now (an AI read on a Mac says so instead of "not on this server yet") */
export const modelDownloading = () => downloading !== null
/** how far the running download is (bytes so far, the model's size, when it started), null when none runs: an AI read
 * that meets it says how much is left (files/service.ts) */
let progress: { got: number; total: number; startedAt: number } | null = null
export const modelProgress = (): { got: number; total: number; startedAt: number } | null => (downloading && progress ? { ...progress } : null)

/** Path of the model file, downloading it first if needed (one download at a time). */
/** sha256 of a shared model file, checked once per file version per process (the small model is 488 MB) */
const sharedOk = new Map<string, string>()
async function sharedModel(cfg: TranscribeConfig, spec: ModelSpec): Promise<string | null> {
  if (!cfg.sharedModelDir) return null
  const f = path.join(cfg.sharedModelDir, spec.file)
  let st: fs.Stats
  try { st = fs.statSync(f) } catch { return null }
  if (!st.isFile() || st.size !== spec.size) return null
  const key = `${st.size}:${st.mtimeMs}`
  if (sharedOk.get(f) === key) return f
  const h = crypto.createHash('sha256')
  for await (const c of fs.createReadStream(f)) h.update(c as Buffer)
  if (h.digest('hex') !== spec.sha256) return null
  sharedOk.set(f, key)
  return f
}

export async function ensureModel(cfg: TranscribeConfig, h?: Pick<JobHandle, 'progress' | 'signal'>, locale: Locale = DEFAULT_LOCALE): Promise<string> {
  const ready = await modelReady(cfg)
  if (ready) return ready
  if (!downloading) {
    progress = { got: 0, total: modelSpec(cfg).size, startedAt: Date.now() }
    downloading = download(cfg, path.join(cfg.modelDir, modelSpec(cfg).file), h, locale).finally(() => { downloading = null; progress = null })
  }
  return downloading
}

/** The model file when it is on this server already (the shared folder or <data>/models/whisper), else null: never
 * downloads (an AI read of a video must not start a 488 MB download; voice input does that on first use). */
export async function modelReady(cfg: TranscribeConfig): Promise<string | null> {
  const spec = modelSpec(cfg)
  const shared = await sharedModel(cfg, spec)
  if (shared) return shared
  const file = path.join(cfg.modelDir, spec.file)
  try { if (fs.statSync(file).size === spec.size) return file } catch { /* not there yet */ }
  return null
}

/** Whether the model file is on this server (the shared folder or <data>/models/whisper) by its size alone, without
 * hashing it: what Team settings says ("downloads about 488 MB the first time"); reads use modelReady. */
export function modelOnDisk(cfg: TranscribeConfig): boolean {
  const spec = modelSpec(cfg)
  for (const dir of [cfg.sharedModelDir, cfg.modelDir]) {
    if (!dir) continue
    try { if (fs.statSync(path.join(dir, spec.file)).size === spec.size) return true } catch { /* not there */ }
  }
  return false
}

async function download(cfg: TranscribeConfig, file: string, h: Pick<JobHandle, 'progress' | 'signal'> | undefined, locale: Locale): Promise<string> {
  const spec = modelSpec(cfg)
  fs.mkdirSync(cfg.modelDir, { recursive: true, mode: 0o700 })
  // the disk keeps its reserve after the model (as save_url's downloads do): a full disk is refused before any byte
  try {
    const st = (cfg.statfs ?? diskStat)(cfg.modelDir)
    const free = Number(st.bavail) * Number(st.bsize)
    const reserve = diskReserve(Number(st.blocks) * Number(st.bsize))
    if (free - spec.size < reserve) {
      const gb = (n: number) => (n / 1024 ** 3).toFixed(1)
      throw fail(`디스크 여유가 ${gb(free)} GB뿐이라 음성 인식 모델(${Math.round(spec.size / 1e6)} MB)을 내려받지 않았어요. 디스크에 ${gb(reserve)} GB는 남겨 둬야 해요. 파일이나 휴지통을 정리해 주세요.`,
        `Only ${gb(free)} GB of disk space is free, so the speech model (${Math.round(spec.size / 1e6)} MB) was not downloaded: ${gb(reserve)} GB must stay free. Free up space (files, trash).`,
        `Ruang disk yang kosong hanya ${gb(free)} GB, jadi model suara (${Math.round(spec.size / 1e6)} MB) tidak diunduh: ${gb(reserve)} GB harus tetap kosong. Kosongkan ruang (berkas, tempat sampah).`,
        `ディスクの空きが ${gb(free)} GB しかないため、音声認識モデル（${Math.round(spec.size / 1e6)} MB）をダウンロードしませんでした。${gb(reserve)} GB は空けておく必要があります。ファイルやゴミ箱を整理してください。`,
        `Solo quedan ${gb(free)} GB libres en el disco, así que el modelo de voz (${Math.round(spec.size / 1e6)} MB) no se descargó: deben quedar ${gb(reserve)} GB libres. Libere espacio (archivos, papelera).`,
        `磁盘只剩 ${gb(free)} GB 可用空间，所以没有下载语音识别模型（${Math.round(spec.size / 1e6)} MB）：必须保留 ${gb(reserve)} GB。请清理文件或回收站。`, 'unavailable', `disk: ${free} B free, ${reserve} B reserve, ${spec.size} B needed`)
    }
  } catch (e) { if (!(e instanceof DiskSpaceUnknown)) throw e }
  const part = file + '.part'
  const label = LABELS.model[locale](Math.round(spec.size / 1e6))
  h?.progress(0, label)
  // a connection that stops sending would hold the one transcription slot of the server forever: give up after
  // DOWNLOAD_IDLE_MS without data or downloadTotalMs in all
  const dl = downloadDeadline({ signal: h?.signal, idleMs: cfg.downloadIdleMs ?? DOWNLOAD_IDLE_MS, totalMs: cfg.downloadTotalMs ?? downloadTotalMs(spec.size) })
  try { return await downloadTo(cfg, spec, file, part, label, dl, h) } finally { dl.done() }
}

const STALLED = () => fail('음성 인식 모델 내려받기가 멈췄거나 너무 느려서 중단했어요(인터넷 연결 확인). 다시 시도해 주세요.', 'The speech model download stopped or was too slow, so it was cancelled (check the internet connection). Please try again.', 'Unduhan model suara berhenti atau terlalu lambat sehingga dibatalkan (periksa koneksi internet). Coba lagi.', "音声認識モデルのダウンロードが止まったか遅すぎたため中止しました（インターネット接続を確認してください）。再試行してください。", "La descarga del modelo de voz se detuvo o era demasiado lenta y se canceló (revise la conexión a internet). Vuelva a intentarlo.", "语音识别模型下载停住了或太慢，已取消（请检查网络连接）。请重试。", 'unavailable', 'stalled')

async function downloadTo(cfg: TranscribeConfig, spec: ModelSpec, file: string, part: string, label: string, dl: DownloadDeadline, h: Pick<JobHandle, 'progress' | 'signal'> | undefined): Promise<string> {
  let res: Response
  try { res = await fetch(cfg.baseUrl + spec.file, { signal: dl.signal, redirect: 'follow' }) } catch (e) {
    if (h?.signal.aborted) throw e
    if (dl.stalled()) throw STALLED()
    throw fail('음성 인식 모델을 내려받지 못했어요(인터넷 연결 확인).', 'Could not download the speech model (check the internet connection).', 'Gagal mengunduh model suara (periksa koneksi internet).', "音声認識モデルをダウンロードできませんでした。インターネット接続を確認してください。", "No se pudo descargar el modelo de voz. Revise la conexión a internet.", "无法下载语音识别模型（请检查网络连接）。")
  }
  if (!res.ok || !res.body) throw fail(`음성 인식 모델을 내려받지 못했어요(HTTP ${res.status}).`, `Could not download the speech model (HTTP ${res.status}).`, `Gagal mengunduh model suara (HTTP ${res.status}).`, `音声認識モデルをダウンロードできませんでした（HTTP ${res.status}）。`, `No se pudo descargar el modelo de voz (HTTP ${res.status}).`, `无法下载语音识别模型（HTTP ${res.status}）。`)
  const hash = crypto.createHash('sha256')
  const fh = await fs.promises.open(part, 'w', 0o600)
  let got = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      dl.tick()
      got += value.byteLength
      if (got > spec.size) break
      hash.update(value)
      await fh.write(value)
      if (progress) progress.got = got
      h?.progress(0.5 * (got / spec.size), label)
    }
  } catch (e) {
    fs.rmSync(part, { force: true })
    if (h?.signal.aborted) throw e
    if (dl.stalled()) throw STALLED()
    throw fail('음성 인식 모델을 내려받는 중 연결이 끊겼어요. 다시 시도해 주세요.', 'The speech model download was interrupted. Please try again.', 'Unduhan model suara terputus. Coba lagi.', "音声認識モデルのダウンロードが中断されました。再試行してください。", "La descarga del modelo de voz se interrumpió. Vuelva a intentarlo.", "语音识别模型下载中断了。请重试。")
  } finally { try { reader.releaseLock() } catch {} await fh.close() }
  const digest = hash.digest('hex')
  if (got !== spec.size || digest !== spec.sha256) {
    fs.rmSync(part, { force: true })
    // why, for the log (jobs/model-prefetch.ts logs the reason): cut short, too long, or other bytes
    const why = got !== spec.size ? `got ${got} of ${spec.size} bytes${got > spec.size ? ' (more than the model)' : ''}` : `sha256 ${digest}, expected ${spec.sha256}`
    throw fail('내려받은 음성 인식 모델이 손상됐어요. 다시 시도해 주세요.', 'The downloaded speech model is damaged. Please try again.', 'Model suara yang diunduh rusak. Coba lagi.', "ダウンロードした音声認識モデルが破損しています。再試行してください。", "El modelo de voz descargado está dañado. Vuelva a intentarlo.", "下载的语音识别模型已损坏。请重试。", 'internal', `damaged: ${why}`)
  }
  fs.renameSync(part, file)
  return file
}

/** Run whisper.cpp on one audio file. `input` is a server-owned file; it is not modified. */
export async function transcribe(cfg: TranscribeConfig, input: string, name: string, o: { language?: string; locale?: Locale; onTimed?: (elapsedMs: number, seconds: number) => void }, h: JobHandle): Promise<TranscribeResult> {
  const loc = o.locale ?? DEFAULT_LOCALE
  if (!cfg.whisperBin) throw MISSING_WHISPER()
  const x = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase()
  const mac = !cfg.ffmpegBin ? cfg.mac ?? null : null
  if (mac && !MAC_AUDIO_EXT.has(x)) throw MAC_FORMAT(x)
  if (!cfg.ffmpegBin && !mac && !NATIVE.has(x)) {
    throw fail(`이 형식(${x || '알 수 없음'})을 읽으려면 서버에 ffmpeg가 필요해요(\`brew install ffmpeg\`). wav·mp3·flac·ogg는 바로 돼요.`,
      `Reading this format (${x || 'unknown'}) needs ffmpeg on the server (\`brew install ffmpeg\`). wav, mp3, flac and ogg work without it.`,
      `Format ini (${x || 'tidak dikenal'}) memerlukan ffmpeg di server (\`brew install ffmpeg\`).`, `この形式（${x || "不明"}）を読み取るにはサーバーにffmpegが必要です（\`brew install ffmpeg\`）。wav、mp3、flac、oggはそのまま使えます。`, `Leer este formato (${x || "desconocido"}) requiere ffmpeg en el servidor (\`brew install ffmpeg\`). wav, mp3, flac y ogg funcionan sin él.`, `读取这种格式（${x || "未知"}）需要服务器上有 ffmpeg（\`brew install ffmpeg\`）。wav、mp3、flac 和 ogg 不需要它也能用。`)
  }
  const model = await ensureModel(cfg, h, loc)
  // voice input goes before a video read's sound (jobs/whisper-turns.ts): a piece running now stops, none starts
  return dictationTurn(async () => {
    fs.mkdirSync(cfg.workBase, { recursive: true, mode: 0o700 })
    const work = fs.realpathSync(fs.mkdtempSync(path.join(cfg.workBase, 'stt-')))
    try {
      // the input's name only keeps a known audio / video extension: ffmpeg picks demuxers by extension, and some
      // (m3u8 playlists, ffconcat) open further files or URLs
      const src = path.join(work, converterInputName(name))
      await copyOffLoop(input, src)
      let audio = path.basename(src)
      if (cfg.ffmpegBin) audio = await convertToWav(cfg.ffmpegBin, work, audio, h, loc, 0.5)
      else if (mac) audio = await macToWav(mac, work, audio, h, loc, 0.5)
      // a recording with no sound goes to no model; whisper's words for noise or a beep are dropped (jobs/no-speech.ts)
      const sound = soundOfFile(work, audio)
      if (silent(sound)) return { text: '', language: null, durationSec: sound!.seconds, segments: [] }
      const label = LABELS.run[loc]
      h.progress(0.55, label)
      const t0 = Date.now()
      const r = await whisperFile(cfg, model, work, audio, { language: o.language, signal: h.signal, timeoutMs: 60 * 60_000, tokens: true, onProgress: (f) => h.progress(0.55 + 0.45 * f, label) })
      // this server's speed for video reads (files/media.ts recordLocalSpeed): the length of the WAV ffmpeg made
      if (audio === 'audio.wav') { try { o.onTimed?.(Date.now() - t0, Math.max(0, fs.lstatSync(path.join(work, audio)).size - 44) / 32_000) } catch { /* not timed */ } }
      const { sure, ...heard } = keepSpeech(r, sound, whisperUnsure(r))
      return heard
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }, h.signal)
}

/** whisper.cpp (isolated) on `audio`, a file in the work folder `work` that the server made; `model` from ensureModel /
 * modelReady. Throws a JobFailure (localized, `reason` 'timeout', 'memory', 'exit N' …) when it fails; 'aborted' when it was killed because
 * `signal` fired. Its CPU limit counts all `cfg.threads` threads (system/cgroups.ts cgexecPrefix). `noFallback`: -nf, no
 * temperature fallback (a video read's pieces: measured on odd sound 20 s instead of 72 s for a 5.6 s clip, and on
 * speech the same Korean CER and +1.8 points English WER over 4.5 minutes; voice input keeps the fallback). */
export async function whisperFile(cfg: TranscribeConfig, model: string, work: string, audio: string,
  o: { language?: string; signal?: AbortSignal; timeoutMs: number; onProgress?: (fraction: number) => void; noFallback?: boolean
    /** whisper.cpp's own guess of the language and how sure it is (0-1): its log line, so -np (no prints) is left out */
    onLanguage?: (language: string, p: number) => void
    /** -ojf: each token's probability, for how sure whisper was (WhisperResult.sure; voice input pieces) */
    tokens?: boolean }): Promise<WhisperResult> {
  if (!cfg.whisperBin) throw MISSING_WHISPER()
  const lang = o.language && /^[a-z]{2}$/.test(o.language) ? o.language : 'auto'
  const r = await runIsolated({
    cmd: cfg.whisperBin, workDir: work, readPaths: [model], gpu: true, timeoutMs: o.timeoutMs, signal: o.signal, cpuThreads: cfg.threads,
    args: ['-m', model, '-f', audio, '-l', lang, '-oj', ...(o.tokens ? ['-ojf'] : []), '-of', 'out', ...(o.onLanguage ? [] : ['-np']), '-pp', '-t', String(cfg.threads), ...(o.noFallback ? ['-nf'] : [])],
    onStderr: (s) => {
      const d = /auto-detected language: ([a-z]{2,3}) \(p = ([\d.]+)\)/.exec(s)
      if (d) o.onLanguage?.(d[1]!, Number(d[2]))
      const m = /progress\s*=\s*(\d+)%/g
      let last: RegExpExecArray | null = null, k: RegExpExecArray | null
      while ((k = m.exec(s))) last = k
      if (last) o.onProgress?.(Number(last[1]) / 100)
    },
  })
  // stopped (Stop, or voice input taking the turn): only a run that was killed for it; one that finished keeps its answer
  if (r.killed === 'aborted') throw new Error('aborted')
  // read without following a link (tools/isolate.ts readOutput): whisper could leave one in place of out.json
  const out = r.code === 0 ? readOutput(work, 'out.json', WHISPER_JSON_MAX) : null
  if (!out?.ok) {
    const why = r.killed ?? (r.code !== 0 ? 'exit ' + r.code : 'no output')
    throw fail(`받아쓰기에 실패했어요(${why}).`, `Transcription failed (${why}).`, `Transkripsi gagal (${why}).`, `文字起こしに失敗しました（${why}）。`, `La transcripción falló (${why}).`, `转写失败（${why}）。`, 'internal', why)
  }
  return parseWhisperJson(out.bytes.toString('utf8'))
}

/** ffmpeg (isolated) in `work`: `audio` -> work/audio.wav, 16 kHz mono 16-bit PCM, without the recording's tags (ffmpeg
 * copies a title or comment into the WAV by default, and the WAV may go to OpenRouter). Returns "audio.wav". */
export async function convertToWav(ffmpeg: string, work: string, audio: string, h: JobHandle, loc: Locale, at: number): Promise<string> {
  h.progress(at, LABELS.convert[loc])
  const r = await runIsolated({ cmd: ffmpeg, workDir: work, timeoutMs: 10 * 60_000, signal: h.signal,
    args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', audio, '-vn', '-map_metadata', '-1', '-fflags', '+bitexact', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 'audio.wav'] })
  if (h.signal.aborted) throw new Error('aborted')
  if (r.code !== 0) throw UNREADABLE()
  return 'audio.wav'
}

/** macOS's afconvert (isolated, jobs/mac-audio.ts) in `work`: `audio` -> work/audio.wav, 16 kHz mono 16-bit PCM.
 * `plain`: a plain 44-byte header and nothing of the recording's tags (it goes to OpenRouter), at most `maxBytes`, else
 * afconvert's own WAV as it is (whisper.cpp reads it; nothing is read into memory). Returns "audio.wav". */
export async function macToWav(mac: MacAudioTools, work: string, audio: string, h: Pick<JobHandle, 'progress' | 'signal'>, loc: Locale, at: number,
  o: { plain?: boolean; maxBytes?: number; tooLarge?: () => Error } = {}): Promise<string> {
  h.progress(at, LABELS.convert[loc])
  try {
    await macDecode(mac, work, audio, 'mac-full.wav', { signal: h.signal, timeoutMs: 10 * 60_000, maxSeconds: 6 * 3600 })
  } catch (e) {
    if (h.signal.aborted) throw new Error('aborted')
    if (e instanceof ToolError && e.code === 'media_mac_format') throw MAC_FORMAT(extOf(audio))
    throw UNREADABLE()
  }
  const seconds = macWavSeconds(work, 'mac-full.wav')
  if (!seconds) throw UNREADABLE()
  if (!o.plain) { fs.renameSync(path.join(work, 'mac-full.wav'), path.join(work, 'audio.wav')); return 'audio.wav' }
  if (o.maxBytes !== undefined && 44 + seconds * 32_000 > o.maxBytes) throw o.tooLarge?.() ?? UNREADABLE()
  const wav = macWavPiece(work, 'mac-full.wav', 0, Infinity)
  if (!wav) throw UNREADABLE()
  fs.rmSync(path.join(work, 'mac-full.wav'), { force: true })
  fs.writeFileSync(path.join(work, 'audio.wav'), wav, { flag: 'wx', mode: 0o600 })
  return 'audio.wav'
}
/** a format macOS does not open (webm, ogg vorbis, wma …) on a Mac without ffmpeg */
export const MAC_FORMAT = (x: string) => fail(`이 형식(${x || '알 수 없음'})의 소리는 여기서 읽을 수 없어요. mp3·m4a·wav·aiff·flac 파일과 mp4·mov 영상은 돼요.`,
  `Sound in this format (${x || 'unknown'}) can't be read here. mp3, m4a, wav, aiff and flac files and mp4 and mov videos work.`,
  `Suara dalam format ini (${x || 'tidak dikenal'}) tidak bisa dibaca di sini. Berkas mp3, m4a, wav, aiff, dan flac serta video mp4 dan mov bisa.`,
  `この形式（${x || '不明'}）の音声はここでは読み取れません。mp3、m4a、wav、aiff、flac のファイルと mp4、mov の動画は使えます。`,
  `El sonido en este formato (${x || 'desconocido'}) no se puede leer aquí. Funcionan los archivos mp3, m4a, wav, aiff y flac y los videos mp4 y mov.`,
  `这里无法读取这种格式（${x || '未知'}）的声音。mp3、m4a、wav、aiff、flac 文件以及 mp4、mov 视频可以。`, 'bad_request')

/** whisper's JSON of one recording (a few MB for an hour) */
const WHISPER_JSON_MAX = 32 * 1024 ** 2
export const UNREADABLE = () => fail('오디오 파일을 읽을 수 없어요.', 'The audio file could not be read.', 'Berkas audio tidak dapat dibaca.', "音声ファイルを読み取れませんでした。", "No se pudo leer el archivo de audio.", "无法读取音频文件。", 'bad_request')

/** whisper-cli's answer, with how sure it was of its surest line's start (token probability 0-1, from -ojf; absent
 * without token data) */
export type WhisperResult = TranscribeResult & { sure?: number }
/** whisper.cpp was unsure of every line (jobs/no-speech.ts UNSURE_FIRST_P) */
export const whisperUnsure = (r: WhisperResult): boolean => r.sure !== undefined && r.sure < UNSURE_FIRST_P

/** how sure whisper was of a line's start: its first word's probability, or the mean of its first two or three words
 * when that is at least LINE_MEAN_SURE (whisper-cli keeps the probability of a CJK character's first byte piece, which
 * can be low on a word it was sure of; a loop over noise stays low: 0.06, 0.07, 0.84 -> 0.32; 0.08, 0.48, 0.84 -> 0.47) */
const LINE_MEAN_SURE = 0.5
const lineStart = (ps: number[]): number | undefined => {
  if (ps.length < 2) return ps[0]
  const head = ps.slice(0, 3), mean = head.reduce((a, p) => a + p, 0) / head.length
  return mean >= LINE_MEAN_SURE ? Math.max(ps[0]!, mean) : ps[0]!
}

/** whisper-cli -oj / -ojf output -> WhisperResult */
export function parseWhisperJson(s: string): WhisperResult {
  type Tok = { text?: string; p?: number }
  const j = JSON.parse(s) as { result?: { language?: string }; transcription?: { offsets?: { from: number; to: number }; text?: string; tokens?: Tok[] }[] }
  let sure: number | undefined
  // [BLANK_AUDIO], [MUSIC], and [music] in Korean
  const blank = /^\[(BLANK_AUDIO|MUSIC|\uC74C\uC545)\]$/i
  const segs = (j.transcription ?? []).filter((t) => (t.text ?? '').trim() && !blank.test((t.text ?? '').trim())).map((t) => {
    // the words: tokens with a letter (whisper's own tokens are [_BEG_], [_TT_50]; " -" can come first)
    const words = (t.tokens ?? []).filter((k) => typeof k.p === 'number' && !/^\[_/.test(k.text ?? '') && /\p{L}/u.test(k.text ?? '')).map((k) => k.p!)
    const p = lineStart(words)
    if (p !== undefined) sure = Math.max(sure ?? 0, p)
    return { start: (t.offsets?.from ?? 0) / 1000, end: (t.offsets?.to ?? 0) / 1000, text: (t.text ?? '').trim() }
  })
  return {
    text: segs.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim(),
    language: j.result?.language ?? null,
    durationSec: segs.length ? segs[segs.length - 1]!.end : null,
    segments: segs,
    ...(sure !== undefined ? { sure } : {}),
  }
}

/** voice input checks at most this much of a recording's WAV for sound (about 17 minutes) */
const SOUND_CHECK_MAX = 32 * 1024 ** 2
/** soundOf the server's WAV `name` in `work` (read without following a link), or null (not such a WAV, too long) */
function soundOfFile(work: string, name: string): Sound | null {
  if (!/\.wav$/i.test(name)) return null
  const got = readOutput(work, name, SOUND_CHECK_MAX)
  return got.ok ? soundOf(got.bytes) : null
}
