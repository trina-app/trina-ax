// Voice input through OpenRouter's speech-to-text API (docs/DECISIONS.md "Voice input through OpenRouter"): the
// speech provider 'openrouter'. Browsers record webm/opus, which the API does not take, so ffmpeg (isolated,
// tools/isolate.ts) converts to 16 kHz mono WAV first, then raises quiet sound and packs it losslessly as FLAC
// (openRouterAudio); without ffmpeg only wav/mp3/flac/ogg/m4a/aac go as they are. The audio goes base64 in a JSON body
// to one fixed address (OPENROUTER_STT_URL), with zero data retention and no data collection requested, and only the
// providers in OPENROUTER_STT_PROVIDERS. The key is never in an error, a log line or a progress message.
// Egress: the server account may reach public https hosts (native/cmd/mycel-ctl/firewall.go server_out blocks only
// private and link-local ranges), the same as the whisper model download from huggingface.co.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_LOCALE, type Locale, type TranscribeResult } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { JobHandle } from '../services'
import { readOutput, runIsolated, type OutputRead } from '../tools/isolate'
import { converterInputName, convertToWav, fail, LABELS, UNREADABLE, type TranscribeConfig } from './transcribe'
import { keepLongRetry, languageCode, LONG_PIECE_SEC, longRetryLanguage, scoreSegments, type ScoredAnswer } from './speech-language'

/** formats the API takes as they are (when there is no ffmpeg) */
const DIRECT = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'])
/** audio larger than this (after conversion) is refused before it is sent */
export const OPENROUTER_MAX_BYTES = 25 * 1024 * 1024
export const OPENROUTER_TIMEOUT_MS = 60_000
/** The providers OpenRouter may send the sound to, in the order it should try them: DeepInfra (US; $0.012 an hour of
 * sound, zero data retention, no training; plans stt-hosted-2026-11-01), then Groq when DeepInfra is down (the
 * founder; the hosted key's guardrail allows these two). OpenRouter's transcription endpoint does not apply `order` /
 * `only` / `allow_fallbacks` yet (its STT guide; measured: a provider that does not exist was answered by DeepInfra,
 * and 9 of 54 parallel requests went to Groq), so the key's own provider guardrail is what limits it today; the
 * request asks for it anyway, and is routed so the day the endpoint honours it. */
export const OPENROUTER_STT_PROVIDERS: readonly string[] = ['deepinfra', 'groq']
/** the request's `provider` object: the listed providers in their order, the next one when one is down (fallbacks on),
 * and none outside the list (`only`) */
export const openRouterRouting = () => ({
  zdr: true, data_collection: 'deny', order: [...OPENROUTER_STT_PROVIDERS], only: [...OPENROUTER_STT_PROVIDERS], allow_fallbacks: true,
})

export const SPEECH_OFF = () => fail(
  '음성 입력이 꺼져 있어요. 관리자가 관리 › 팀 설정에서 켤 수 있어요.',
  'Voice input is off. An admin can turn it on in Admin › Team settings.',
  'Input suara nonaktif. Admin dapat mengaktifkannya di Admin › Pengaturan tim.', "音声入力はオフです。管理者が「管理 › チーム設定」で有効にできます。", "La entrada de voz está desactivada. Un administrador puede activarla en Administración › Configuración del equipo.")
export const SPEECH_NO_KEY = () => fail(
  '음성 입력에 쓸 OpenRouter 키가 없어요. 관리자가 관리 › 팀 설정에서 키를 넣어야 해요.',
  'There is no OpenRouter key for voice input. An admin must add it in Admin › Team settings.',
  'Belum ada kunci OpenRouter untuk input suara. Admin harus menambahkannya di Admin › Pengaturan tim.', "音声入力用のOpenRouterキーがありません。管理者が「管理 › チーム設定」で追加してください。", "No hay clave de OpenRouter para la entrada de voz. Un administrador debe añadirla en Administración › Configuración del equipo.")
export const TOO_LARGE = () => fail(
  '녹음이 너무 길어요(최대 25 MB, 약 13분). 짧게 나눠서 다시 해 주세요.',
  'The recording is too long (max 25 MB, about 13 minutes). Split it into shorter parts and try again.',
  'Rekaman terlalu panjang (maks. 25 MB, sekitar 13 menit). Bagi menjadi bagian yang lebih pendek lalu coba lagi.', "録音が長すぎます（最大25 MB、約13分）。短く分割して再試行してください。", "La grabación es demasiado larga (máximo 25 MB, unos 13 minutos). Divídala en partes más cortas y vuelva a intentarlo.", 'payload_too_large')
const BAD_KEY = () => fail(
  'OpenRouter가 키를 거부했어요. 관리자가 관리 › 팀 설정에서 키를 확인해야 해요.',
  'OpenRouter refused the key. An admin must check it in Admin › Team settings.',
  'OpenRouter menolak kuncinya. Admin harus memeriksanya di Admin › Pengaturan tim.', "OpenRouterがキーを拒否しました。管理者が「管理 › チーム設定」で確認してください。", "OpenRouter rechazó la clave. Un administrador debe revisarla en Administración › Configuración del equipo.")
const NO_CREDITS = () => fail(
  'OpenRouter 크레딧이 부족해요. 관리자가 OpenRouter에서 크레딧을 충전해야 해요.',
  'The OpenRouter account has no credits left. An admin must add credits on OpenRouter.',
  'Kredit OpenRouter habis. Admin harus menambah kredit di OpenRouter.', "OpenRouterアカウントのクレジットがありません。管理者がOpenRouterでクレジットを追加してください。", "La cuenta de OpenRouter no tiene créditos. Un administrador debe añadir créditos en OpenRouter.")
const RATE_LIMITED = () => fail(
  'OpenRouter 요청이 너무 많아요. 잠시 뒤 다시 해 주세요.',
  'Too many requests to OpenRouter. Please try again in a moment.',
  'Terlalu banyak permintaan ke OpenRouter. Coba lagi sebentar lagi.', "OpenRouterへのリクエストが多すぎます。しばらくしてから再試行してください。", "Hay demasiadas solicitudes a OpenRouter. Vuelva a intentarlo en un momento.", 'rate_limited')
const PROVIDER_DOWN = () => fail(
  '음성 인식 서비스(OpenRouter)에 연결할 수 없어요. 잠시 뒤 다시 해 주세요.',
  'The speech service (OpenRouter) is not reachable. Please try again later.',
  'Layanan suara (OpenRouter) tidak dapat dihubungi. Coba lagi nanti.', "音声サービス（OpenRouter）に接続できません。後で再試行してください。", "No se puede conectar con el servicio de voz (OpenRouter). Vuelva a intentarlo más tarde.")
const REFUSED = (status: number) => fail(
  `OpenRouter가 요청을 거절했어요(HTTP ${status}).`,
  `OpenRouter refused the request (HTTP ${status}).`,
  `OpenRouter menolak permintaan (HTTP ${status}).`, `OpenRouterがリクエストを拒否しました（HTTP ${status}）。`, `OpenRouter rechazó la solicitud (HTTP ${status}).`, 'internal')

/** HTTP status of the OpenRouter answer -> the failure people see */
export function openRouterFailure(status: number) {
  if (status === 401 || status === 403) return BAD_KEY()
  if (status === 402) return NO_CREDITS()
  if (status === 429) return RATE_LIMITED()
  if (status >= 500) return PROVIDER_DOWN()
  return REFUSED(status)
}

interface OrAnswer { text?: unknown; language?: unknown; duration?: unknown; segments?: unknown }
/** an OpenRouter answer: how sure whisper was of it (speech-language.ts), the request's generation id
 * (`X-Generation-Id`, for OpenRouter's own record of which provider served it) and that provider when the answer
 * names it */
export type OpenRouterAnswer = ScoredAnswer & { generation?: string; served?: string }

/** OpenRouter's JSON -> TranscribeResult (language, duration, segments are optional there). The language as whisper's
 * code: Groq answers "Korean" where DeepInfra answers "ko". */
export function parseOpenRouter(j: OrAnswer, fallback: { language: string | null; durationSec: number | null }): ScoredAnswer {
  const text = typeof j.text === 'string' ? j.text.replace(/\s+/g, ' ').trim() : ''
  const duration = typeof j.duration === 'number' && Number.isFinite(j.duration) && j.duration >= 0 ? j.duration : fallback.durationSec
  const raw = Array.isArray(j.segments) ? j.segments as { start?: unknown; end?: unknown; text?: unknown; avg_logprob?: unknown }[] : []
  let segments = raw
    .map((s) => ({ start: typeof s?.start === 'number' ? s.start : 0, end: typeof s?.end === 'number' ? s.end : 0, text: typeof s?.text === 'string' ? s.text.trim() : '' }))
    .filter((s) => s.text)
  if (!segments.length && text) segments = [{ start: 0, end: duration ?? 0, text }]
  const scored = scoreSegments(raw)
  return {
    text,
    language: languageCode(j.language) ?? fallback.language,
    durationSec: duration,
    segments,
    ...(scored ? { scored } : {}),
  }
}
/** what a voice input job gives back (nothing of how sure whisper was, or which request it was) */
const plain = (r: TranscribeResult): TranscribeResult => ({ text: r.text, language: r.language, durationSec: r.durationSec, segments: r.segments })

// ---------------- the sound OpenRouter gets ----------------
/** The samples of a WAV's data chunk (any other chunk, such as ffmpeg's LIST, is skipped); null when it is not one. */
export function wavData(wav: Uint8Array): Buffer | null {
  const b = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength)
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null
  for (let pos = 12; pos + 8 <= b.length;) {
    const id = b.toString('latin1', pos, pos + 4), size = b.readUInt32LE(pos + 4)
    if (id === 'data') return b.subarray(pos + 8, Math.min(b.length, pos + 8 + size))
    pos += 8 + size + (size & 1)
  }
  return null
}
/** quiet sound is raised until its speech level reaches this (dBFS), never further */
const LEVEL_FLOOR_DB = -40
/** and by at most this much */
const GAIN_MAX_DB = 20
/**
 * The gain (dB) for a server-made 16 kHz mono 16-bit WAV: sound whose speech level (the 95th percentile of the RMS of
 * its 100 ms frames that have sound) is under LEVEL_FLOOR_DB is raised to it, by at most GAIN_MAX_DB, and never so far
 * that the loudest samples (the 99.9th percentile) pass -1 dBFS; anything louder is left as it is (0). Measured
 * (plans stt-hosted-2026-11-01) on a room microphone peaking at -45 dBFS: 10.2% CER as WAV, 19.3% as MP3, 0.0-0.6%
 * raised by 10-40 dB (0.6% as FLAC at +15.7 dB, this rule's gain for it); room tone with no speech stayed without words
 * up to +20 dB and became "Thank you." from +30 dB (ffmpeg's loudnorm too), so nothing is raised past -40 dBFS or by
 * more than 20 dB. ffmpeg's loudnorm was not used: it took 14 s for 10 minutes on one thread (it works at 192 kHz).
 */
export function quietGainDb(wav: Uint8Array): number {
  const data = wavData(wav)
  if (!data || data.length < 3200) return 0
  const per = 1600, frames: number[] = [], hist = new Uint32Array(32769)
  const n = Math.floor(data.length / 2)
  for (let f = 0; (f + 1) * per <= n; f++) {
    let sum = 0
    for (let i = f * per; i < (f + 1) * per; i++) { const x = data.readInt16LE(i * 2); sum += x * x; hist[Math.abs(x)]!++ }
    const rms = Math.sqrt(sum / per)
    if (rms > 32768 * 10 ** (-70 / 20)) frames.push(rms)
  }
  if (!frames.length) return 0
  frames.sort((a, b) => a - b)
  const db = (v: number) => 20 * Math.log10(Math.max(v, 1) / 32768)
  const speech = db(frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))]!)
  let peak = 0
  for (let v = 32768, seen = 0, total = Math.floor(n / per) * per; v >= 0; v--) { seen += hist[v]!; if (seen > total * 0.001) { peak = v; break } }
  const gain = Math.min(GAIN_MAX_DB, LEVEL_FLOOR_DB - speech, -1 - db(peak))
  return gain >= 1 ? Math.round(gain * 10) / 10 : 0
}
const ENCODE_TIMEOUT_MS = 60_000
const ENCODE_RSS_MIB = 256
/** OpenRouter's audio as FLAC: lossless, so the answer is the WAV's (the same words and avg_logprob on every clip
 * measured), at 38-49% of its size (10 minutes: 7.1-9.5 MB instead of 19.2 MB), from ffmpeg's own encoder (no library
 * to install). Not MP3: 48, 64 and 96 kbps MP3 and 32 kbps Opus all changed what whisper wrote on a two-minute
 * Korean-English meeting (an English line came back translated into Korean: 5.4% CER as WAV or FLAC, 13.6-22.6%
 * lossy), though 10 minutes of Korean alone was the same (3.2% against 3.4%) */
export type OpenRouterAudio = { ok: true; bytes: Buffer; format: 'flac'; gainDb: number } | { ok: false; why: 'failed' | 'damaged' }
/**
 * `wav` (`name` in the work folder `work`, made by the server) as OpenRouter gets it: raised when quiet (quietGainDb)
 * and packed as 16 kHz mono FLAC without tags, by ffmpeg in the converter isolation (only the WAV demuxer and PCM
 * decoder), read back without following a link. 'failed': ffmpeg could not make it (send the WAV); 'damaged': the run
 * replaced its work folder or left something other than a plain file (a converter taken over: nothing is sent).
 * `workBytes`: what the work folder holds already.
 */
export async function openRouterAudio(ffmpeg: string, work: string, name: string, wav: Uint8Array,
  o: { signal?: AbortSignal; timeoutMs?: number; workBytes: number }): Promise<OpenRouterAudio> {
  const gainDb = quietGainDb(wav)
  // a name of its own: ffmpeg (8.1 measured) does not replace an existing file without -y and still exits 0, so a
  // fixed name would send the piece before again
  const out = `send-${crypto.randomUUID()}.flac`
  const r = await runIsolated({
    cmd: ffmpeg, workDir: work, signal: o.signal, timeoutMs: Math.max(1, Math.min(ENCODE_TIMEOUT_MS, o.timeoutMs ?? ENCODE_TIMEOUT_MS)), maxRssMiB: ENCODE_RSS_MIB,
    maxStdout: 1024 * 1024, maxWorkBytes: o.workBytes + OPENROUTER_MAX_BYTES + 16 * 1024 ** 2,
    args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-protocol_whitelist', 'file', '-format_whitelist', 'wav', '-codec_whitelist', 'pcm_s16le',
      '-i', name, '-map', '0:a:0', '-vn', '-sn', '-dn', ...(gainDb ? ['-af', `volume=${gainDb}dB`] : []),
      '-map_metadata', '-1', '-fflags', '+bitexact', '-y', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-c:a', 'flac', '-f', 'flac', out],
  })
  o.signal?.throwIfAborted()
  if (r.killed === 'workdir') return { ok: false, why: 'damaged' }
  if (r.killed || r.code !== 0) return { ok: false, why: 'failed' }
  const got = readOutput(work, out, OPENROUTER_MAX_BYTES)
  if (!got.ok) return { ok: false, why: got.why === 'not_regular' ? 'damaged' : 'failed' }
  // the run ended in the folder the server made (runIsolated checked it), so the name is removed there
  fs.rmSync(path.join(work, out), { force: true })
  return { ok: true, bytes: got.bytes, format: 'flac', gainDb }
}

/** Send one server-owned audio file to OpenRouter. `input` is not modified. `team`: the team's language; a recording of
 * LONG_PIECE_SEC or more that whisper heard in an unlikely language is sent once more told it, and the answer whisper
 * is surer of is kept (speech-language.ts; the told language is then not reported as heard). */
export async function transcribeOpenRouter(cfg: TranscribeConfig, key: string, model: string, input: string, name: string,
  o: { language?: string; locale?: Locale; team?: string }, h: JobHandle): Promise<TranscribeResult> {
  const loc = o.locale ?? DEFAULT_LOCALE
  const x = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase()
  if (!cfg.ffmpegBin && !DIRECT.has(x)) {
    throw fail(`이 형식(${x || '알 수 없음'})을 보내려면 서버에 ffmpeg가 필요해요. wav·mp3·flac·ogg·m4a·aac는 바로 돼요.`,
      `Sending this format (${x || 'unknown'}) needs ffmpeg on the server. wav, mp3, flac, ogg, m4a and aac work without it.`,
      `Format ini (${x || 'tidak dikenal'}) memerlukan ffmpeg di server. wav, mp3, flac, ogg, m4a, dan aac bisa langsung.`, `この形式（${x || "不明"}）を送信するにはサーバーにffmpegが必要です。wav、mp3、flac、ogg、m4a、aacはそのまま使えます。`, `Enviar este formato (${x || "desconocido"}) requiere ffmpeg en el servidor. wav, mp3, flac, ogg, m4a y aac funcionan sin él.`)
  }
  fs.mkdirSync(cfg.workBase, { recursive: true, mode: 0o700 })
  const work = fs.realpathSync(fs.mkdtempSync(path.join(cfg.workBase, 'stt-')))
  try {
    let audio: OutputRead, format: string, seconds: number | null = null
    if (cfg.ffmpegBin) {
      // the input's name keeps only a known audio / video extension (see transcribe.ts)
      const src = path.join(work, converterInputName(name))
      fs.copyFileSync(input, src, fs.constants.COPYFILE_FICLONE)
      // what ffmpeg wrote is read without following a link: a converter taken over by the file could leave a link to
      // any file the server can read in place of audio.wav, and that file would go to OpenRouter (tools/isolate.ts)
      const wavName = await convertToWav(cfg.ffmpegBin, work, path.basename(src), h, loc, 0.1)
      audio = readOutput(work, wavName, OPENROUTER_MAX_BYTES)
      format = 'wav'
      if (audio.ok) {
        // 16 kHz mono 16-bit PCM: 32 000 bytes a second
        seconds = (wavData(audio.bytes)?.length ?? Math.max(0, audio.bytes.length - 44)) / 32_000
        const packed = await openRouterAudio(cfg.ffmpegBin, work, wavName, audio.bytes, { signal: h.signal, workBytes: fs.statSync(src).size + audio.bytes.length })
        if (packed.ok) { audio = { ok: true, bytes: packed.bytes }; format = packed.format }
        else if (packed.why === 'damaged') throw UNREADABLE()
      }
    } else { audio = readOutput(path.dirname(input), path.basename(input), OPENROUTER_MAX_BYTES); format = x }
    if (!audio.ok && audio.why === 'too_large') throw TOO_LARGE()
    if (!audio.ok) throw UNREADABLE()
    h.progress(0.4, LABELS.run[loc])
    let r = await sendToOpenRouter(cfg, key, model, audio.bytes, format, { language: o.language, signal: h.signal, seconds })
    const told = !o.language && o.team && (seconds ?? r.durationSec ?? 0) >= LONG_PIECE_SEC ? longRetryLanguage(r, { team: o.team }) : undefined
    if (told) {
      h.progress(0.7, LABELS.run[loc])
      // a retry that fails keeps the first answer (Stop still ends the job)
      const again = await sendToOpenRouter(cfg, key, model, audio.bytes, format, { language: told, signal: h.signal, seconds }).catch(() => { h.signal.throwIfAborted(); return null })
      if (again && keepLongRetry(r, again, told)) r = { ...again, language: null }
    }
    h.progress(1, LABELS.run[loc])
    return plain(r)
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/**
 * One request to OpenRouter's speech-to-text API: `audio` (at most OPENROUTER_MAX_BYTES) in `format`, zero data
 * retention and no data collection requested, only OPENROUTER_STT_PROVIDERS, no redirects, OPENROUTER_TIMEOUT_MS (or
 * `timeoutMs`, if shorter) plus `signal`. Failures are JobFailures that never hold the key. `seconds`: the length of
 * the sound when the server knows it (the WAV it made), for an answer without one.
 */
export async function sendToOpenRouter(cfg: TranscribeConfig, key: string, model: string, audio: Uint8Array, format: string,
  o: { language?: string; signal?: AbortSignal; timeoutMs?: number; seconds?: number | null }): Promise<OpenRouterAnswer> {
  if (audio.byteLength > OPENROUTER_MAX_BYTES) throw TOO_LARGE()
  const lang = o.language && /^[a-z]{2}$/.test(o.language) ? o.language : undefined
  const body = JSON.stringify({
    model,
    input_audio: { data: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64'), format },
    ...(lang ? { language: lang } : {}),
    response_format: 'verbose_json',
    provider: openRouterRouting(),
  })
  const signals = [AbortSignal.timeout(Math.max(1, Math.min(OPENROUTER_TIMEOUT_MS, o.timeoutMs ?? OPENROUTER_TIMEOUT_MS)))]
  if (o.signal) signals.push(o.signal)
  let res: Response
  try {
    res = await fetch(cfg.openRouterUrl, {
      method: 'POST', body, redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': PRODUCT.displayName },
      signal: AbortSignal.any(signals),
    })
  } catch (e) {
    if (o.signal?.aborted) throw e
    throw PROVIDER_DOWN()
  }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw openRouterFailure(res.status) }
  let j: OrAnswer
  try { j = await res.json() as OrAnswer } catch (e) {
    if (o.signal?.aborted) throw e
    throw PROVIDER_DOWN()
  }
  return { ...parseOpenRouter(j ?? {}, { language: lang ?? null, durationSec: o.seconds ?? null }), ...requestOf(res.headers) }
}

// ---------------- which provider served a request ----------------
/** An answer's generation id and the provider that served it, from its headers (`X-Generation-Id`; the provider only
 * when the answer names it): only the fields found. */
export function requestOf(headers: Headers): { generation?: string; served?: string } {
  const generation = generationId(headers.get('x-generation-id'))
  const served = providerSlug(headers.get('x-provider-name'))
  return { ...(generation ? { generation } : {}), ...(served ? { served } : {}) }
}
/** OpenRouter's generation id ("gen-stt-1793497549-g9WWurhY5bOSKVBoplrc"), or undefined for anything else */
export const generationId = (v: unknown): string | undefined => (typeof v === 'string' && /^gen-[A-Za-z0-9_-]{1,120}$/.test(v) ? v : undefined)
/** a provider's name as a slug ("DeepInfra" -> "deepinfra"), or undefined */
export const providerSlug = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) : ''
  return s || undefined
}
/** OpenRouter has a generation's record a few seconds after the answer (measured 5.5-7.5 s) */
let servedDelayMs = 8_000
const SERVED_TRIES = 3
const SERVED_EVERY_MS = 8_000
const SERVED_TIMEOUT_MS = 10_000
/** tests: how long the lookup waits before it starts (null: the default) */
export function setServedDelayForTests(ms: number | null) { servedDelayMs = ms ?? 8_000 }
/**
 * The provider that served each generation id, from OpenRouter's record of it (`GET /api/v1/generation?id=`, on the
 * same host as the transcription address; the key only in the header, no sound or text sent, no redirects). The
 * transcription answer does not name it. Best effort: a few tries, then whatever was found.
 */
export async function openRouterServed(cfg: TranscribeConfig, key: string, ids: string[]): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  let left = [...new Set(ids.filter((id) => generationId(id)))].slice(0, 50)
  for (let t = 0; t < SERVED_TRIES && left.length; t++) {
    // a wait that never holds the process open (a server stopping, a test run ending)
    await new Promise((r) => { (setTimeout(r, t ? SERVED_EVERY_MS : servedDelayMs) as { unref?: () => void }).unref?.() })
    for (const id of left) {
      const url = new URL('/api/v1/generation', cfg.openRouterUrl)
      url.searchParams.set('id', id)
      try {
        const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(SERVED_TIMEOUT_MS) })
        if (!res.ok) { await res.body?.cancel().catch(() => {}); continue }
        const name = providerSlug(((await res.json()) as { data?: { provider_name?: unknown } } | null)?.data?.provider_name)
        if (name) found[id] = name
      } catch { /* not this time */ }
    }
    left = left.filter((id) => !(id in found))
  }
  return found
}
