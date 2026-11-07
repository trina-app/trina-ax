// The hosting service's free speech-to-text hours (docs/DECISIONS.md "Hosted speech-to-text"): a hosted team without
// its own OpenRouter key turns voice input and video sound into text with the key the hosting service made for it
// (credentials/speech-key.ts), the plan's free hours of sound a calendar month (Korea time; hostedSpeechFreeHours: the
// control plane writes them per plan in plan.json, else 10). Every request with that key goes through the meter
// (jobs/openrouter-stt.ts postAudio), a retry or a second try in another language too:
// refused before it is sent once the month's hours are used; the sound's length is held against the month while the
// request is out (so requests sent at the same time cannot all pass the last minutes), then counted as the length of
// what was sent (the WAV the server made; else what OpenRouter says it heard), or given back when no answer came. The
// count is one settings row (no sound, text or key in it); a new month starts from 0 and the month never goes back
// (a clock set back keeps counting into the newer month). With the team's own key nothing is counted or refused. The
// key's own monthly dollar limit at OpenRouter is the backstop the control plane sets.
import type { Database } from 'bun:sqlite'
import { DEFAULT_SPEECH_MODEL, type HostedSpeechUsage } from '@mycel/shared/api'
import { JobFailure } from '../jobs/service'
import { HOSTED_SPEECH_USAGE_SETTING } from '../admin/settings'
import { currentPlan } from '../system/limits'

/** the free hours a month when the plan does not say (a plan.json without speechFreeHours, or none) */
export const HOSTED_SPEECH_DEFAULT_FREE_HOURS = 10
/** This team's free hours a month: its plan's `speechFreeHours` (shared/src/cloud-protocol PlanFile; the control plane
 * writes it per plan), else HOSTED_SPEECH_DEFAULT_FREE_HOURS. Read at each check, so a plan change applies within a
 * minute (system/limits.ts reads plan.json again when it changes), to this month's count as it stands. */
export function hostedSpeechFreeHours(): number {
  return currentPlan()?.speechFreeHours ?? HOSTED_SPEECH_DEFAULT_FREE_HOURS
}
export const hostedSpeechFreeSec = (): number => hostedSpeechFreeHours() * 3600
export { HOSTED_SPEECH_USAGE_SETTING }
/** the one model the hosting key may use (the control plane's guardrail at OpenRouter allows no other); a team's own
 * key uses the model chosen in Team settings */
export const HOSTED_SPEECH_MODEL = DEFAULT_SPEECH_MODEL
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
    // a row of a later month than the clock says (a clock set back) still counts: the month never goes back
    if (v && typeof v.month === 'string' && v.month >= month && typeof v.seconds === 'number' && Number.isFinite(v.seconds) && v.seconds > 0) usedSec = v.seconds
  } catch { /* a broken row counts as nothing used */ }
  return { month, usedSec: Math.round(usedSec * 10) / 10, freeSec: hostedSpeechFreeSec() }
}

/** Seconds of sound left this month (0 when used up). */
export function hostedSpeechLeft(db: Database, now = Date.now()): number {
  const u = hostedSpeechUsage(db, now)
  return Math.max(0, u.freeSec - u.usedSec)
}

/** Count `seconds` of sound sent with the hosting key, in one statement (reads and voice input may run at once), into
 * this month's row (or a later month's, when the clock was set back). One request counts at most the month's free
 * seconds (an answer claiming more cannot fill the row with nonsense). Returns the row's month. */
export function chargeHostedSpeech(db: Database, seconds: number, now = Date.now()): string {
  const month = hostedSpeechMonth(now)
  const sec = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, hostedSpeechFreeSec()) : 0
  const r = db.query(`INSERT INTO settings (key, value) VALUES (?1, json_object('month', ?2, 'seconds', ?3))
    ON CONFLICT(key) DO UPDATE SET value = CASE
      WHEN json_valid(value) AND json_extract(value, '$.month') >= ?2 AND typeof(json_extract(value, '$.seconds')) IN ('integer', 'real')
      THEN json_object('month', json_extract(value, '$.month'), 'seconds', json_extract(value, '$.seconds') + ?3)
      ELSE json_object('month', ?2, 'seconds', ?3) END
    RETURNING json_extract(value, '$.month') AS month`).get(HOSTED_SPEECH_USAGE_SETTING, month, sec) as { month: string } | null
  return r?.month ?? month
}

/** Add `delta` seconds (less than 0: give back) to the row of `month`, only while the row is still that month, never
 * below 0 (a request answered after a new month began changes neither month). */
function adjustHostedSpeech(db: Database, month: string, delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return
  db.query(`UPDATE settings SET value = json_object('month', ?2, 'seconds', max(0, json_extract(value, '$.seconds') + ?3))
    WHERE key = ?1 AND json_valid(value) AND json_extract(value, '$.month') = ?2 AND typeof(json_extract(value, '$.seconds')) IN ('integer', 'real')`)
    .run(HOSTED_SPEECH_USAGE_SETTING, month, delta)
}

/** a length in seconds the meter takes: finite, 0 or more, at most the month's free seconds; else null */
export const meterSeconds = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, hostedSpeechFreeSec()) : null)

/** JobFailure.reason of SPEECH_FREE_USED (a video read stops with its own note) */
export const FREE_USED = 'free_used'
/** The month's free hours (`hours`, the plan's) are used up (voice input; a video read gets the same as its note). */
export const SPEECH_FREE_USED = (hours = hostedSpeechFreeHours()) => new JobFailure('rate_limited', {
  ko: `이번 달 무료 받아쓰기 ${hours}시간을 다 썼어요. 다음 달 1일에 다시 생겨요. 지금 더 쓰려면 관리자가 관리 › 팀 설정 › 음성 입력에 팀의 OpenRouter 키를 넣어 주세요.`,
  en: `This month's ${hours} free hours of transcription are used up. They come back on the 1st. To go on now, an admin can add the team's own OpenRouter key in Admin › Team settings › Voice input.`,
  id: `${hours} jam transkripsi gratis bulan ini sudah habis. Jatahnya kembali tanggal 1. Untuk lanjut sekarang, admin dapat menambahkan kunci OpenRouter tim di Admin › Pengaturan tim › Input suara.`,
  ja: `今月の無料文字起こし${hours}時間を使い切りました。来月1日にまた使えます。今すぐ続けるには、管理者が「管理 › チーム設定 › 音声入力」でチームの OpenRouter キーを追加してください。`,
  es: `Se han agotado las ${hours} horas gratuitas de transcripción de este mes. Vuelven el día 1. Para seguir ahora, un administrador puede añadir la clave de OpenRouter del equipo en Administración › Configuración del equipo › Entrada de voz.`,
}, FREE_USED)
/** OpenRouter refused the hosting key (taken away, paused with a suspended team, or its monthly backstop reached) */
export const HOSTED_KEY_REFUSED = () => new JobFailure('unavailable', {
  ko: '호스팅 받아쓰기를 지금 쓸 수 없어요. 계속되면 트리나 지원팀에 알려 주세요. 관리자가 관리 › 팀 설정 › 음성 입력에 팀의 OpenRouter 키를 넣으면 그 키로 쓸 수 있어요.',
  en: 'Hosted transcription is not available right now. If this goes on, tell Trina support. An admin can add the team\'s own OpenRouter key in Admin › Team settings › Voice input and use that instead.',
  id: 'Transkripsi hosting sedang tidak tersedia. Jika berlanjut, beri tahu dukungan Trina. Admin dapat menambahkan kunci OpenRouter tim di Admin › Pengaturan tim › Input suara dan memakainya.',
  ja: 'ホスティングの文字起こしは今使えません。続く場合は Trina サポートにお知らせください。管理者が「管理 › チーム設定 › 音声入力」でチームの OpenRouter キーを追加すれば、そのキーで使えます。',
  es: 'La transcripción alojada no está disponible ahora. Si continúa, avise al soporte de Trina. Un administrador puede añadir la clave de OpenRouter del equipo en Administración › Configuración del equipo › Entrada de voz y usarla.',
})

/** The seconds a request with the hosting key holds against its month until it is answered (SpeechMeter). */
export interface SpeechHold { month: string; sec: number }

/** What every OpenRouter speech request goes through (TranscribeConfig.meter; jobs/openrouter-stt.ts postAudio). */
export interface SpeechMeter {
  /** before each request with `key`, a retry too: with the hosting key, throws SPEECH_FREE_USED when the month's hours
   * are used, else holds `seconds` (the sound's length when the server knows it) against the month; null for any
   * other key. Everything held is settled once: `after` or `release`. */
  before(key: string, seconds: number | null): SpeechHold | null
  /** OpenRouter answered the request: it counts `seconds` of sound instead of what was held */
  after(hold: SpeechHold | null, seconds: number): void
  /** no answer (the provider failed, a timeout, Stop, a refusal): what was held goes back */
  release(hold: SpeechHold | null): void
  /** the failure people see when OpenRouter refused `key` with `status` (null: the usual one for the team's key) */
  refused(key: string, status: number): Error | null
}

/** The meter of a server: `hostedKey` reads the hosting key in clear (null without one); only its requests count. All
 * of it is synchronous, so a check and its hold are one step even with many requests at once. */
export function hostedSpeechMeter(db: Database, hostedKey: () => string | null, now: () => number = Date.now): SpeechMeter {
  const isHosted = (key: string) => { const h = hostedKey(); return h !== null && h === key }
  return {
    before(key, seconds) {
      if (!isHosted(key)) return null
      const t = now()
      if (hostedSpeechLeft(db, t) <= 0) throw SPEECH_FREE_USED()
      const sec = meterSeconds(seconds) ?? 0
      // the row is made now even for 0 s, so what the answer then counts has a row to go to
      return { month: chargeHostedSpeech(db, sec, t), sec }
    },
    // in the month the hold went to (a request answered after midnight on the 1st does not count in the new month)
    after(hold, seconds) { if (hold) adjustHostedSpeech(db, hold.month, (meterSeconds(seconds) ?? hold.sec) - hold.sec) },
    release(hold) { if (hold) adjustHostedSpeech(db, hold.month, -hold.sec) },
    refused(key, status) { return isHosted(key) && (status === 401 || status === 402 || status === 403) ? HOSTED_KEY_REFUSED() : null },
  }
}
