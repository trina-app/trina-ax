// IANA time zones for the team's time zone (Admin > Settings, the setup page). The browser's own list when it has one
// (Intl.supportedValuesOf), else a short list of the zones our customers use; the current value is always offered.
const FALLBACK = ['Asia/Seoul', 'Asia/Tokyo', 'Asia/Jakarta', 'Asia/Singapore', 'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Manila', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC']

/** The browser's zone, or null when it does not say. */
export function browserTimeZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { return null }
}

export function timeZoneOptions(current?: string | null): string[] {
  let all: string[] = FALLBACK
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    if (f) all = f('timeZone')
  } catch { /* the fallback list */ }
  const set = new Set(all)
  if (!set.has('UTC')) all = [...all, 'UTC']
  return current && !set.has(current) ? [current, ...all] : all
}
