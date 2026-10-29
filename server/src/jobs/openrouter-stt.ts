// Voice input through OpenRouter's speech-to-text API (docs/DECISIONS.md "Voice input through OpenRouter"): the
// speech provider 'openrouter'. Browsers record webm/opus, which the API does not take, so ffmpeg (isolated,
// tools/isolate.ts) converts to 16 kHz mono WAV first; without ffmpeg only wav/mp3/flac/ogg/m4a/aac go as they are.
// The audio goes base64 in a JSON body to one fixed address (OPENROUTER_STT_URL), with zero data retention and no
// data collection requested from the provider. The key is never in an error, a log line or a progress message.
// Egress: the server account may reach public https hosts (native/cmd/mycel-ctl/firewall.go server_out blocks only
// private and link-local ranges), the same as the whisper model download from huggingface.co.
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE, type Locale, type TranscribeResult } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { JobHandle } from '../services'
import { converterInputName, convertToWav, fail, LABELS, type TranscribeConfig } from './transcribe'

/** formats the API takes as they are (when there is no ffmpeg) */
const DIRECT = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'])
/** audio larger than this (after conversion) is refused before it is sent */
export const OPENROUTER_MAX_BYTES = 25 * 1024 * 1024
export const OPENROUTER_TIMEOUT_MS = 60_000

export const SPEECH_OFF = () => fail(
  '음성 입력이 꺼져 있습니다. 관리자가 관리 › 팀 설정에서 켤 수 있습니다.',
  'Voice input is off. An admin can turn it on in Admin › Team settings.',
  'Input suara nonaktif. Admin dapat mengaktifkannya di Admin › Pengaturan tim.', "音声入力はオフです。管理者が「管理 › チーム設定」で有効にできます。", "La entrada de voz está desactivada. Un administrador puede activarla en Administración › Configuración del equipo.")
export const SPEECH_NO_KEY = () => fail(
  '음성 입력에 쓸 OpenRouter 키가 없습니다. 관리자가 관리 › 팀 설정에서 키를 넣어야 합니다.',
  'There is no OpenRouter key for voice input. An admin must add it in Admin › Team settings.',
  'Belum ada kunci OpenRouter untuk input suara. Admin harus menambahkannya di Admin › Pengaturan tim.', "音声入力用のOpenRouterキーがありません。管理者が「管理 › チーム設定」で追加してください。", "No hay clave de OpenRouter para la entrada de voz. Un administrador debe añadirla en Administración › Configuración del equipo.")
const TOO_LARGE = () => fail(
  '녹음이 너무 깁니다(최대 25 MB, 약 13분). 짧게 나눠서 다시 해 주세요.',
  'The recording is too long (max 25 MB, about 13 minutes). Split it into shorter parts and try again.',
  'Rekaman terlalu panjang (maks. 25 MB, sekitar 13 menit). Bagi menjadi bagian yang lebih pendek lalu coba lagi.', "録音が長すぎます（最大25 MB、約13分）。短く分割して再試行してください。", "La grabación es demasiado larga (máximo 25 MB, unos 13 minutos). Divídala en partes más cortas y vuelva a intentarlo.", 'payload_too_large')
const BAD_KEY = () => fail(
  'OpenRouter가 키를 거부했습니다. 관리자가 관리 › 팀 설정에서 키를 확인해야 합니다.',
  'OpenRouter refused the key. An admin must check it in Admin › Team settings.',
  'OpenRouter menolak kuncinya. Admin harus memeriksanya di Admin › Pengaturan tim.', "OpenRouterがキーを拒否しました。管理者が「管理 › チーム設定」で確認してください。", "OpenRouter rechazó la clave. Un administrador debe revisarla en Administración › Configuración del equipo.")
const NO_CREDITS = () => fail(
  'OpenRouter 크레딧이 부족합니다. 관리자가 OpenRouter에서 크레딧을 충전해야 합니다.',
  'The OpenRouter account has no credits left. An admin must add credits on OpenRouter.',
  'Kredit OpenRouter habis. Admin harus menambah kredit di OpenRouter.', "OpenRouterアカウントのクレジットがありません。管理者がOpenRouterでクレジットを追加してください。", "La cuenta de OpenRouter no tiene créditos. Un administrador debe añadir créditos en OpenRouter.")
const RATE_LIMITED = () => fail(
  'OpenRouter 요청이 너무 많습니다. 잠시 후 다시 해 주세요.',
  'Too many requests to OpenRouter. Please try again in a moment.',
  'Terlalu banyak permintaan ke OpenRouter. Coba lagi sebentar lagi.', "OpenRouterへのリクエストが多すぎます。しばらくしてから再試行してください。", "Hay demasiadas solicitudes a OpenRouter. Vuelva a intentarlo en un momento.", 'rate_limited')
const PROVIDER_DOWN = () => fail(
  '음성 인식 서비스(OpenRouter)에 연결할 수 없습니다. 잠시 후 다시 해 주세요.',
  'The speech service (OpenRouter) is not reachable. Please try again later.',
  'Layanan suara (OpenRouter) tidak dapat dihubungi. Coba lagi nanti.', "音声サービス（OpenRouter）に接続できません。後で再試行してください。", "No se puede conectar con el servicio de voz (OpenRouter). Vuelva a intentarlo más tarde.")
const REFUSED = (status: number) => fail(
  `OpenRouter가 요청을 거절했습니다(HTTP ${status}).`,
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

/** OpenRouter's JSON -> TranscribeResult (language, duration, segments are optional there) */
export function parseOpenRouter(j: OrAnswer, fallback: { language: string | null; durationSec: number | null }): TranscribeResult {
  const text = typeof j.text === 'string' ? j.text.replace(/\s+/g, ' ').trim() : ''
  const duration = typeof j.duration === 'number' && Number.isFinite(j.duration) && j.duration >= 0 ? j.duration : fallback.durationSec
  const raw = Array.isArray(j.segments) ? j.segments as { start?: unknown; end?: unknown; text?: unknown }[] : []
  let segments = raw
    .map((s) => ({ start: typeof s?.start === 'number' ? s.start : 0, end: typeof s?.end === 'number' ? s.end : 0, text: typeof s?.text === 'string' ? s.text.trim() : '' }))
    .filter((s) => s.text)
  if (!segments.length && text) segments = [{ start: 0, end: duration ?? 0, text }]
  return {
    text,
    language: typeof j.language === 'string' && j.language ? j.language : fallback.language,
    durationSec: duration,
    segments,
  }
}

/** Send one server-owned audio file to OpenRouter. `input` is not modified. */
export async function transcribeOpenRouter(cfg: TranscribeConfig, key: string, model: string, input: string, name: string,
  o: { language?: string; locale?: Locale }, h: JobHandle): Promise<TranscribeResult> {
  const loc = o.locale ?? DEFAULT_LOCALE
  const x = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase()
  if (!cfg.ffmpegBin && !DIRECT.has(x)) {
    throw fail(`이 형식(${x || '알 수 없음'})을 보내려면 서버에 ffmpeg가 필요합니다. wav·mp3·flac·ogg·m4a·aac는 바로 됩니다.`,
      `Sending this format (${x || 'unknown'}) needs ffmpeg on the server. wav, mp3, flac, ogg, m4a and aac work without it.`,
      `Format ini (${x || 'tidak dikenal'}) memerlukan ffmpeg di server. wav, mp3, flac, ogg, m4a, dan aac bisa langsung.`, `この形式（${x || "不明"}）を送信するにはサーバーにffmpegが必要です。wav、mp3、flac、ogg、m4a、aacはそのまま使えます。`, `Enviar este formato (${x || "desconocido"}) requiere ffmpeg en el servidor. wav, mp3, flac, ogg, m4a y aac funcionan sin él.`)
  }
  fs.mkdirSync(cfg.workBase, { recursive: true, mode: 0o700 })
  const work = fs.realpathSync(fs.mkdtempSync(path.join(cfg.workBase, 'stt-')))
  try {
    let audio: string, format: string
    if (cfg.ffmpegBin) {
      // the input's name keeps only a known audio / video extension (see transcribe.ts)
      const src = path.join(work, converterInputName(name))
      fs.copyFileSync(input, src, fs.constants.COPYFILE_FICLONE)
      audio = path.join(work, await convertToWav(cfg.ffmpegBin, work, path.basename(src), h, loc, 0.1))
      format = 'wav'
    } else { audio = input; format = x }
    const size = fs.statSync(audio).size
    if (size > OPENROUTER_MAX_BYTES) throw TOO_LARGE()
    // 16 kHz mono 16-bit PCM: 32 000 bytes a second after the 44-byte header
    const wavSec = format === 'wav' && cfg.ffmpegBin ? Math.max(0, size - 44) / 32_000 : null
    const lang = o.language && /^[a-z]{2}$/.test(o.language) ? o.language : undefined
    const body = JSON.stringify({
      model,
      input_audio: { data: fs.readFileSync(audio).toString('base64'), format },
      ...(lang ? { language: lang } : {}),
      response_format: 'verbose_json',
      provider: { zdr: true, data_collection: 'deny' },
    })
    h.progress(0.4, LABELS.run[loc])
    let res: Response
    try {
      res = await fetch(cfg.openRouterUrl, {
        method: 'POST', body, redirect: 'error',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': PRODUCT.displayName },
        signal: AbortSignal.any([h.signal, AbortSignal.timeout(OPENROUTER_TIMEOUT_MS)]),
      })
    } catch (e) {
      if (h.signal.aborted) throw e
      throw PROVIDER_DOWN()
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw openRouterFailure(res.status) }
    let j: OrAnswer
    try { j = await res.json() as OrAnswer } catch (e) {
      if (h.signal.aborted) throw e
      throw PROVIDER_DOWN()
    }
    h.progress(1, LABELS.run[loc])
    return parseOpenRouter(j ?? {}, { language: lang ?? null, durationSec: wavSec })
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}
