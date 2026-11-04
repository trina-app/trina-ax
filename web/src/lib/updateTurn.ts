// When a release waiting for this server's turn in its staged roll-out installs (server/src/system/rollout.ts; the update
// status's turnAt): in the team's update window that holds the turn, or the next one after it, in the team's time zone.
// Admin Home words it with the same day wording as an ordinary automatic update (today / tomorrow, dawn / day / night),
// or with the date when the turn is further away.

const DAY_MS = 86_400_000

/** the team-zone calendar day (as a UTC midnight, ms) of an instant and its minutes after midnight */
function zoned(t: Date, timeZone: string): { day: number; min: number } {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t)) p[x.type] = x.value
  return { day: Date.UTC(+p.year!, +p.month! - 1, +p.day!), min: (+p.hour! % 24) * 60 + +p.minute! }
}

export type TurnWhen = { day: 'today' | 'tomorrow' | 'date'; /** the window's start day (UTC midnight of that team-zone date) */ date: Date }

/**
 * The window a turn installs in, by the day that window starts on, against today in the team's zone. null when the
 * window or the turn cannot be read. A window may pass midnight ("23:00-01:00"): a turn after midnight inside it belongs
 * to the window that started the evening before.
 */
export function turnWhen(turnAt: string, window: string, timeZone: string, now = new Date()): TurnWhen | null {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window)
  const t = new Date(turnAt)
  if (!m || Number.isNaN(t.getTime())) return null
  const from = +m[1]! * 60 + +m[2]!, to = +m[3]! * 60 + +m[4]!
  if (from === to) return null
  let turn: { day: number; min: number }, today: number
  try { turn = zoned(t, timeZone); today = zoned(now, timeZone).day } catch { return null }
  const wraps = from > to
  const inside = wraps ? turn.min >= from || turn.min < to : turn.min >= from && turn.min < to
  // the start day of the window it installs in
  const start = inside ? (wraps && turn.min < to ? turn.day - DAY_MS : turn.day) : turn.min < from ? turn.day : turn.day + DAY_MS
  const diff = Math.round((start - today) / DAY_MS)
  return { day: diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : 'date', date: new Date(start) }
}
