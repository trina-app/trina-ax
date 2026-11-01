// The hosting service's free speech-to-text hours (docs/DECISIONS.md "Hosted speech-to-text"): a hosted team without
// its own OpenRouter key turns voice input and video sound into text with the key the hosting service made for it
// (credentials/speech-key.ts), HOSTED_SPEECH_FREE_SEC of sound a calendar month (Korea time). Every request with that
// key goes through the meter (jobs/openrouter-stt.ts postAudio): refused before it is sent once the month's hours are
// used, counted after OpenRouter answered with the seconds of sound it heard (also a retry or a second try in another
// language: what was sent). The count is one settings row (no sound, text or key in it); a new month starts from 0.
// With the team's own key nothing is counted or refused. The key's own monthly dollar limit at OpenRouter is the
// backstop the control plane sets.
import type { Database } from 'bun:sqlite'
import type { HostedSpeechUsage } from '@mycel/shared/api'
import { JobFailure } from '../jobs/service'

export const HOSTED_SPEECH_FREE_HOURS = 10
export const HOSTED_SPEECH_FREE_SEC = HOSTED_SPEECH_FREE_HOURS * 3600
export const HOSTED_SPEECH_USAGE_SETTING = 'speech.hostedUsage'
/** the month is Korea's (UTC+9, no daylight saving time): the hours come back at 00:00 KST on the 1st */
const KST_MS = 9 * 3600_000

/** "2026-11": the calendar month in Korea at `now` */
export function hostedSpeechMonth(now: number): string {
  return new Date(now + KST_MS).toISOString().slice(0, 7)
}

/** This month's free hours: seconds used (a request may go a little past the end) and the free seconds. */
export function hostedSpeechUsage(db: Database, now = Date.now()): HostedSpeechUsage {
  const month = hostedSpeechMonth(now)
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_SPEECH_USAGE_SETTING) as { value: string } | null
  let usedSec = 0
  try {
    const v = row ? JSON.parse(row.value) as { month?: unknown; seconds?: unknown } : null
    if (v && v.month === month && typeof v.seconds === 'number' && Number.isFinite(v.seconds) && v.seconds > 0) usedSec = v.seconds
  } catch { /* a broken row counts as nothing used */ }
  return { month, usedSec: Math.round(usedSec * 10) / 10, freeSec: HOSTED_SPEECH_FREE_SEC }
}

/** Seconds of sound left this month (0 when used up). */
export function hostedSpeechLeft(db: Database, now = Date.now()): number {
  const u = hostedSpeechUsage(db, now)
  return Math.max(0, u.freeSec - u.usedSec)
}

/** Count `seconds` of sound sent with the hosting key, in one statement (reads and voice input may run at once). */
export function chargeHostedSpeech(db: Database, seconds: number, now = Date.now()): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return
  const month = hostedSpeechMonth(now)
  db.query(`INSERT INTO settings (key, value) VALUES (?1, json_object('month', ?2, 'seconds', ?3))
    ON CONFLICT(key) DO UPDATE SET value = CASE
      WHEN json_valid(value) AND json_extract(value, '$.month') = ?2 AND typeof(json_extract(value, '$.seconds')) IN ('integer', 'real')
      THEN json_object('month', ?2, 'seconds', json_extract(value, '$.seconds') + ?3)
      ELSE json_object('month', ?2, 'seconds', ?3) END`).run(HOSTED_SPEECH_USAGE_SETTING, month, seconds)
}

/** The month's free hours are used up (voice input; a video read gets the same as its note). */
export const SPEECH_FREE_USED = () => new JobFailure('rate_limited', {
  ko: `이번 달 무료 받아쓰기 ${HOSTED_SPEECH_FREE_HOURS}시간을 다 썼어요. 다음 달 1일에 다시 생겨요. 지금 더 쓰려면 관리자가 관리 › 팀 설정 › 음성 입력에 팀의 OpenRouter 키를 넣어 주세요.`,
  en: `This month's ${HOSTED_SPEECH_FREE_HOURS} free hours of transcription are used up. They come back on the 1st. To go on now, an admin can add the team's own OpenRouter key in Admin › Team settings › Voice input.`,
  id: `${HOSTED_SPEECH_FREE_HOURS} jam transkripsi gratis bulan ini sudah habis. Jatahnya kembali tanggal 1. Untuk lanjut sekarang, admin dapat menambahkan kunci OpenRouter tim di Admin › Pengaturan tim › Input suara.`,
  ja: `今月の無料文字起こし${HOSTED_SPEECH_FREE_HOURS}時間を使い切りました。来月1日にまた使えます。今すぐ続けるには、管理者が「管理 › チーム設定 › 音声入力」でチームの OpenRouter キーを追加してください。`,
  es: `Se han agotado las ${HOSTED_SPEECH_FREE_HOURS} horas gratuitas de transcripción de este mes. Vuelven el día 1. Para seguir ahora, un administrador puede añadir la clave de OpenRouter del equipo en Administración › Configuración del equipo › Entrada de voz.`,
})
/** OpenRouter refused the hosting key (taken away, paused with a suspended team, or its monthly backstop reached) */
export const HOSTED_KEY_REFUSED = () => new JobFailure('unavailable', {
  ko: '호스팅 받아쓰기를 지금 쓸 수 없어요. 계속되면 트리나 지원팀에 알려 주세요. 관리자가 관리 › 팀 설정 › 음성 입력에 팀의 OpenRouter 키를 넣으면 그 키로 쓸 수 있어요.',
  en: 'Hosted transcription is not available right now. If this goes on, tell Trina support. An admin can add the team\'s own OpenRouter key in Admin › Team settings › Voice input and use that instead.',
  id: 'Transkripsi hosting sedang tidak tersedia. Jika berlanjut, beri tahu dukungan Trina. Admin dapat menambahkan kunci OpenRouter tim di Admin › Pengaturan tim › Input suara dan memakainya.',
  ja: 'ホスティングの文字起こしは今使えません。続く場合は Trina サポートにお知らせください。管理者が「管理 › チーム設定 › 音声入力」でチームの OpenRouter キーを追加すれば、そのキーで使えます。',
  es: 'La transcripción alojada no está disponible ahora. Si continúa, avise al soporte de Trina. Un administrador puede añadir la clave de OpenRouter del equipo en Administración › Configuración del equipo › Entrada de voz y usarla.',
})

/** What every OpenRouter speech request goes through (TranscribeConfig.meter; jobs/openrouter-stt.ts postAudio). */
export interface SpeechMeter {
  /** before a request with `key`: throws SPEECH_FREE_USED when it is the hosting key and the month's hours are used */
  before(key: string): void
  /** OpenRouter answered `key`'s request with `seconds` of sound */
  after(key: string, seconds: number): void
  /** the failure people see when OpenRouter refused `key` with `status` (null: the usual one for the team's key) */
  refused(key: string, status: number): Error | null
}

/** The meter of a server: `hostedKey` reads the hosting key in clear (null without one); only its requests count. */
export function hostedSpeechMeter(db: Database, hostedKey: () => string | null, now: () => number = Date.now): SpeechMeter {
  const isHosted = (key: string) => { const h = hostedKey(); return h !== null && h === key }
  return {
    before(key) { if (isHosted(key) && hostedSpeechLeft(db, now()) <= 0) throw SPEECH_FREE_USED() },
    after(key, seconds) { if (isHosted(key)) chargeHostedSpeech(db, seconds, now()) },
    refused(key, status) { return isHosted(key) && (status === 401 || status === 402 || status === 403) ? HOSTED_KEY_REFUSED() : null },
  }
}
