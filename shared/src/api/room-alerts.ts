// What a room message is to me, and whether it may make a sound or a push now (docs/DECISIONS.md "대화방 알림 설정").
// One rule for every place that alerts: the server's room notices (rooms/service.ts notify), Web Push and the phone
// push (notifications/push-service.ts, through the notices) and the web app's sound (web/src/lib/roomSound.ts). The
// server tells the app each room's level (Room.notify) and my quiet hours (the rooms list's `alerts`), so the app never
// guesses them; these functions are the same code on both sides.
//
// - My default (Settings › Notifications › 대화, "알림 받을 메시지"): 'direct' (1:1 and group chats: every message; team
//   rooms and the everyone room: what mentions me), 'all' (every message of every room I am in) or 'none' (nothing).
// - A room's own level (the room's bell): 'all', 'mentions' or 'off'; none set = my default for its kind.
// - A mention of me ("@전체" from someone else counts as one), and a reply in a thread I follow (when "내가 참여한
//   스레드의 답글" is on), count at every level but 'off' (and 'none', which is 'off' for every room without a level of
//   its own).
// - Quiet hours ("방해 금지 시간"): no push and no sound; the notice and the badges stay.
import { z } from 'zod'

/** A room's own level (null: my default). */
export const RoomNotifyLevel = z.enum(['all', 'mentions', 'off'])
export type RoomNotifyLevel = z.infer<typeof RoomNotifyLevel>
/** My default for rooms without a level of their own. */
export const RoomNotifyDefault = z.enum(['direct', 'all', 'none'])
export type RoomNotifyDefault = z.infer<typeof RoomNotifyDefault>

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 00:00–23:59')
/** Quiet hours in the team's time zone: from `start` to `end` (across midnight when end <= start; 22:00–08:00 by
 * default), and with `weekends` all of Saturday and Sunday as well. `start` and `end` differ. */
export const QuietHours = z.object({ on: z.boolean(), start: HHMM, end: HHMM, weekends: z.boolean() }).strict()
  .refine((q) => q.start !== q.end, { message: 'start and end must differ', path: ['end'] })
export type QuietHours = z.infer<typeof QuietHours>
export const QUIET_HOURS_DEFAULT: QuietHours = { on: false, start: '22:00', end: '08:00', weekends: false }

/** What the app needs besides each room's level to decide the sound (the rooms list's `alerts`). */
export const RoomAlertSettings = z.object({
  /** "내가 참여한 스레드의 답글": replies in threads I follow alert me */
  threadReplies: z.boolean(),
  quietHours: QuietHours,
  /** the team's time zone (IANA): quiet hours are read in it */
  timeZone: z.string(),
})
export type RoomAlertSettings = z.infer<typeof RoomAlertSettings>

/** The level that applies to me in a room: its own when I set one, else my default for its kind ('team' and 'all' are
 * the rooms everyone is put in; any other kind is a conversation of picked people). */
export function roomLevel(kind: string, own: RoomNotifyLevel | null | undefined, def: RoomNotifyDefault | null | undefined): RoomNotifyLevel {
  if (own) return own
  if (def === 'none') return 'off'
  if (def === 'all') return 'all'
  return kind === 'team' || kind === 'all' ? 'mentions' : 'all'
}

export interface RoomAlertInput {
  /** roomLevel() for me in the message's room */
  level: RoomNotifyLevel
  /** it mentions me */
  mentioned: boolean
  /** a reply in a thread */
  reply: boolean
  /** a reply that was sent to the room's timeline too */
  alsoInRoom: boolean
  /** I follow the reply's thread */
  following: boolean
  /** my "replies in threads I follow" switch */
  threadReplies: boolean
}
/** What a new message (for the whole room, not mine, one I can see) is to me: 'mention', 'message' (anything else that
 * is for me), or null. A reply that stays in its thread is for me only when I follow the thread or it mentions me. */
export function roomAlert(i: RoomAlertInput): 'mention' | 'message' | null {
  if (i.level === 'off') return null
  if (i.mentioned) return 'mention'
  if (i.reply && i.following && i.threadReplies) return 'message'
  if (i.reply && !i.alsoInRoom) return null
  return i.level === 'all' ? 'message' : null
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const formats = new Map<string, Intl.DateTimeFormat>()
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const clockFormat = (timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' })
/** The weekday (0 Sunday … 6 Saturday; -1 when it cannot be read, which is no weekend) and the minute of the day at
 * `now` in `timeZone` (an unknown zone: UTC). */
export function zonedClock(now: number, timeZone: string): { weekday: number; minute: number } {
  let f = formats.get(timeZone)
  if (!f) {
    try { f = clockFormat(timeZone) } catch { f = clockFormat('UTC') }
    if (formats.size > 50) formats.clear()
    formats.set(timeZone, f)
  }
  let weekday = -1, hour = 0, minute = 0
  for (const p of f.formatToParts(new Date(now))) {
    if (p.type === 'weekday') weekday = WEEKDAYS.indexOf(p.value)
    else if (p.type === 'hour') hour = Number(p.value) % 24
    else if (p.type === 'minute') minute = Number(p.value)
  }
  return { weekday, minute: hour * 60 + minute }
}

/** Is `now` inside my quiet hours (in the team's time zone)? From start up to (not including) end; an end at or before
 * the start runs across midnight (22:00–08:00 is quiet from 22:00 to 07:59). With weekends, all of Saturday and Sunday. */
export function inQuietHours(q: QuietHours | null | undefined, timeZone: string, now: number): boolean {
  if (!q?.on) return false
  const { weekday, minute } = zonedClock(now, timeZone)
  if (q.weekends && (weekday === 0 || weekday === 6)) return true
  const start = minutes(q.start), end = minutes(q.end)
  if (start === end) return false
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}
