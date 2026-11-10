// The pure part of status messages (docs/DECISIONS.md "상태 메시지"; auth/status-messages.ts has the table, the routes'
// helpers and the clock): when a status starts and clears in the team's time zone, its refusals, how the team and the AI
// see it. No database here, so the web's mock server works a status out by the same rules.
import { addDays, STATUS_DAYS_AHEAD, STATUS_DEFAULT_EMOJI } from '@mycel/shared'
import type { Locale, SetStatusBody, StatusClear, StatusMessage } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { zonedDay, zonedParts, zonedToUtc } from '../system/time-zone'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

/** Refusals of a status, in the person's language. */
export const STATUS_TEXT: Record<'empty' | 'noDay' | 'order' | 'far' | 'gone' | 'tooOften', T> = {
  empty: t('상태를 적거나 이모지를 골라 주세요.', 'Write a status or choose an emoji.', 'Tulis status atau pilih emoji.', 'ステータスを入力するか、絵文字を選んでください。', 'Escriba un estado o elija un emoji.'),
  noDay: t('마지막 날을 골라 주세요.', 'Choose the last day.', 'Pilih hari terakhir.', '最終日を選んでください。', 'Elija el último día.'),
  order: t('마지막 날은 시작일과 같거나 그 뒤여야 해요.', 'The last day must be the first day or after it.', 'Hari terakhir harus sama dengan atau setelah hari pertama.', '最終日は開始日と同じか、それより後にしてください。', 'El último día debe ser el primero o posterior.'),
  far: t('1년 안의 날짜를 골라 주세요.', 'Choose days within a year.', 'Pilih tanggal dalam satu tahun.', '1年以内の日付を選んでください。', 'Elija días dentro de un año.'),
  gone: t('상태가 이미 지워졌어요. 삭제 시간을 다시 골라 주세요.', 'The status has already cleared. Choose when it clears again.', 'Status sudah terhapus. Pilih lagi kapan dihapus.', 'ステータスはすでに消えています。削除する時間を選び直してください。', 'El estado ya se borró. Vuelva a elegir cuándo se borra.'),
  tooOften: t('상태를 너무 자주 바꿨어요. 잠시 뒤 다시 해 주세요.', 'You changed your status too often. Try again in a moment.', 'Status terlalu sering diubah. Coba lagi sebentar lagi.', 'ステータスの変更が多すぎます。しばらくしてからもう一度お試しください。', 'Cambió su estado demasiadas veces. Vuelva a intentarlo en un momento.'),
}
const refuse = (k: keyof typeof STATUS_TEXT, locale: Locale, field: string): never =>
  fail('validation', STATUS_TEXT[k][locale] ?? STATUS_TEXT[k].en, { fields: { [field]: k } })

export interface StatusRow { user_id: string; emoji: string; text: string; clear: StatusClear; starts_at: string | null; clears_at: string | null; until_day: string | null }
const AFTER_MS: Partial<Record<StatusClear, number>> = { '30m': 30 * 60_000, '1h': 60 * 60_000, '2h': 2 * 60 * 60_000 }

/** 00:00 of a "YYYY-MM-DD" day in a time zone, or the day's first instant where its clocks jump over midnight
 * (America/Santiago, America/Havana: zonedToUtc then lands an hour early, on the day before). */
export const dayStart = (day: string, tz: string): Date => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  let t = zonedToUtc(y, m, d, 0, 0, tz).getTime()
  for (let i = 0; i < 12 && zonedDay(new Date(t), tz) < day; i++) t += 15 * 60_000
  return new Date(t)
}

/** The SQL condition of a status the team sees at `?` (twice): started, not cleared (on a row aliased `s`). */
export const LIVE_SQL = '(s.starts_at IS NULL OR s.starts_at <= ?) AND (s.clears_at IS NULL OR s.clears_at > ?)'

/** A row as the team sees it. */
export function statusOut(r: Pick<StatusRow, 'emoji' | 'text' | 'clears_at' | 'until_day'>): StatusMessage {
  return { emoji: r.emoji, text: r.text, ...(r.clears_at ? { until: r.clears_at } : {}), ...(r.until_day ? { untilDay: r.until_day } : {}) }
}

export interface StatusPlan { emoji: string; text: string; clear: StatusClear; startsAt: string | null; clearsAt: string | null; untilDay: string | null }

/**
 * When a status starts and clears, in the team's zone `tz`, or a refusal in the person's language. `current`: the
 * person's status now (not cleared; maybe still to start), for 'keep'.
 */
export function planStatus(body: SetStatusBody, now: Date, tz: string, current: StatusRow | null, locale: Locale): StatusPlan {
  const p = plan(body, now, tz, current, locale)
  // never saved already ended (it would be no status at all)
  if (p.clearsAt && p.clearsAt <= now.toISOString()) refuse('gone', locale, 'body.clear')
  return p
}
function plan(body: SetStatusBody, now: Date, tz: string, current: StatusRow | null, locale: Locale): StatusPlan {
  const text = body.text
  const emoji = body.emoji ?? (text ? STATUS_DEFAULT_EMOJI : '')
  if (!emoji) refuse('empty', locale, 'body.text')
  // days come only with chosen days (a stray one is a mistake of the caller, not something to guess at)
  if (body.clear !== 'dates' && (body.from !== undefined || body.to !== undefined)) refuse('noDay', locale, body.from !== undefined ? 'body.from' : 'body.to')
  const base = { emoji, text }
  const today = zonedDay(now, tz)
  switch (body.clear) {
    case 'keep':
      if (!current) return refuse('gone', locale, 'body.clear')
      return { ...base, clear: current.clear, startsAt: current.starts_at, clearsAt: current.clears_at, untilDay: current.until_day }
    case 'never':
      return { ...base, clear: 'never', startsAt: null, clearsAt: null, untilDay: null }
    case '30m': case '1h': case '2h':
      return { ...base, clear: body.clear, startsAt: null, clearsAt: new Date(now.getTime() + AFTER_MS[body.clear]!).toISOString(), untilDay: null }
    case 'today':
      return { ...base, clear: 'today', startsAt: null, clearsAt: dayStart(addDays(today, 1), tz).toISOString(), untilDay: today }
    case 'week': {
      // the week ends with its Sunday (Monday to Sunday); on a Sunday that is today
      const last = addDays(today, (7 - zonedParts(now, tz).wd) % 7)
      return { ...base, clear: 'week', startsAt: null, clearsAt: dayStart(addDays(last, 1), tz).toISOString(), untilDay: last }
    }
    case 'dates': {
      if (!body.to) return refuse('noDay', locale, 'body.to')
      // a first day already past (another device's clock, a dialog left open overnight) is today
      const from = body.from && body.from > today ? body.from : today
      if (body.to < from) refuse('order', locale, 'body.to')
      if (body.to > addDays(today, STATUS_DAYS_AHEAD)) refuse('far', locale, 'body.to')
      return { ...base, clear: 'dates', startsAt: from > today ? dayStart(from, tz).toISOString() : null, clearsAt: dayStart(addDays(body.to, 1), tz).toISOString(), untilDay: body.to }
    }
  }
}

const INVISIBLE = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}\uFE00-\uFE0D\u{E0000}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0\u2800]|(?!\u200D)\p{Cf}/gu

/** One status for the AI's lines (rooms/reader.ts, the remote connector's people_list): "🌴 휴가 중 until 2026-11-14"
 * (the last day) or "until 2026-11-10 15:30" (a time, the team's zone). The caller makes the words safe for its form. */
export function statusForAi(s: StatusMessage, tz: string): string {
  // nothing invisible reaches the model, even from a row written before a rule was tightened (a subdivision flag's tag
  // letters too: it reads as a plain 🏴)
  const words = `${s.emoji} ${s.text}`.replace(INVISIBLE, '').trim()
  if (s.untilDay) return `${words} until ${s.untilDay}`
  if (!s.until) return words
  const p = zonedParts(new Date(s.until), tz)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${words} until ${p.y}-${two(p.m)}-${two(p.d)} ${two(p.h)}:${two(p.min)}`
}

