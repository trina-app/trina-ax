// The team's time zone (docs/DECISIONS.md "클라우드 리눅스 서버"). A Mac in the office runs in the office's zone, but a
// Linux server (and every hosted cloud tenant) usually runs in UTC: "today", "this month", schedules, the nightly
// backup and conflict-copy names must follow the team, not the process. Team setting `timeZone` (IANA name, Admin >
// Settings; the setup page sends the browser's); without one: MYCEL_TEAM_TZ (set by the control plane), else the
// process's own zone, else UTC. Calendar arithmetic in a zone is here so every part uses the same two functions.

/** Calendar parts of an instant in a time zone. */
export function zonedParts(t: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    .formatToParts(t).map((x) => [x.type, x.value]))
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, s: +p.second!, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!) }
}

/** The instant of a wall-clock time in a time zone (DST-safe: corrected by the zone's offset at that moment). */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  let t = Date.UTC(y, m - 1, d, h, min)
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), tz)
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
    t += Date.UTC(y, m - 1, d, h, min) - shown
  }
  return new Date(t)
}

/** An IANA zone this runtime knows ("Asia/Seoul", "UTC"); aliases the runtime accepts count too. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

/** The process's own zone (the Mac's; UTC on most Linux servers). */
export function processTimeZone(): string {
  const z = Intl.DateTimeFormat().resolvedOptions().timeZone
  return isValidTimeZone(z) ? z : 'UTC'
}

/** The zone a team gets when it has not chosen one: MYCEL_TEAM_TZ (control plane), else the process's, else UTC. */
export function defaultTimeZone(env: Record<string, string | undefined> = process.env): string {
  const z = env.MYCEL_TEAM_TZ
  return isValidTimeZone(z) ? z : processTimeZone()
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function zonedDay(t: Date, tz: string): string {
  const p = zonedParts(t, tz)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

// The engines get the team's zone as TZ (engine/claude.ts, engine/codex.ts): a process setting, since one server
// process serves one team. The chat runtime registers where it comes from (the team settings).
let source: (() => string) | null = null
export function setTeamTimeZoneSource(fn: (() => string) | null) { source = fn }
/** TZ for the engine's environment, or null when nothing registered (tests building launch requests directly) or when
 * it is the process's own zone anyway (the engine then sees the same clock without it: a Mac's launch request stays
 * exactly as before). */
export function engineTimeZone(): string | null {
  try { const z = source?.(); return isValidTimeZone(z) && z !== processTimeZone() ? z : null } catch { return null }
}
