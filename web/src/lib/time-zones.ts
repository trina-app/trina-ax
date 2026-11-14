// IANA time zones for the team's time zone (Admin > Settings, the setup page). The browser's own list when it has one
// (Intl.supportedValuesOf), else a short list of the zones our customers use; the current value is always offered.
const FALLBACK = ['Asia/Seoul', 'Asia/Tokyo', 'Asia/Jakarta', 'Asia/Singapore', 'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Manila', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC']

/** The browser's zone, or null when it does not say. */
export function browserTimeZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { return null }
}

/** A zone this browser can show times in. The server's list is its own: Intl throws on a name the browser does not know. */
export function isKnownTimeZone(z: string | null | undefined): z is string {
  if (!z) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true } catch { return false }
}

/** The zones our customers use, shown first (the same list as the trina-cloud console's picker, src/shared/timezones.ts). */
export const COMMON_ZONES = ['Asia/Seoul', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Manila', 'Asia/Kuala_Lumpur', 'Asia/Taipei', 'Asia/Hong_Kong', 'Australia/Sydney', 'Europe/London', 'America/Los_Angeles', 'America/New_York', 'UTC']

/** The city of each common zone in the page languages. Intl has no city names (DisplayNames knows no time zones, and
 *  timeZoneName says "Indochina Time" for both Bangkok and Ho Chi Minh), so they are named here (copied from the cloud
 *  console, plus ja, es and id); English uses the IANA city. */
const CITY: Record<string, Record<string, string>> = {
  ko: { 'Asia/Seoul': '서울', 'Asia/Jakarta': '자카르타', 'Asia/Makassar': '마카사르', 'Asia/Jayapura': '자야푸라', 'Asia/Tokyo': '도쿄', 'Asia/Singapore': '싱가포르', 'Asia/Bangkok': '방콕', 'Asia/Ho_Chi_Minh': '호찌민', 'Asia/Manila': '마닐라', 'Asia/Kuala_Lumpur': '쿠알라룸푸르', 'Asia/Taipei': '타이베이', 'Asia/Hong_Kong': '홍콩', 'Australia/Sydney': '시드니', 'Europe/London': '런던', 'America/Los_Angeles': '로스앤젤레스', 'America/New_York': '뉴욕' },
  ja: { 'Asia/Seoul': 'ソウル', 'Asia/Jakarta': 'ジャカルタ', 'Asia/Makassar': 'マカッサル', 'Asia/Jayapura': 'ジャヤプラ', 'Asia/Tokyo': '東京', 'Asia/Singapore': 'シンガポール', 'Asia/Bangkok': 'バンコク', 'Asia/Ho_Chi_Minh': 'ホーチミン', 'Asia/Manila': 'マニラ', 'Asia/Kuala_Lumpur': 'クアラルンプール', 'Asia/Taipei': '台北', 'Asia/Hong_Kong': '香港', 'Australia/Sydney': 'シドニー', 'Europe/London': 'ロンドン', 'America/Los_Angeles': 'ロサンゼルス', 'America/New_York': 'ニューヨーク' },
  es: { 'Asia/Seoul': 'Seúl', 'Asia/Tokyo': 'Tokio', 'Asia/Singapore': 'Singapur', 'Asia/Manila': 'Manila', 'Asia/Taipei': 'Taipéi', 'Asia/Hong_Kong': 'Hong Kong', 'Australia/Sydney': 'Sídney', 'Europe/London': 'Londres', 'America/Los_Angeles': 'Los Ángeles', 'America/New_York': 'Nueva York' },
  id: { 'Asia/Singapore': 'Singapura', 'Asia/Seoul': 'Seoul', 'Asia/Tokyo': 'Tokyo' },
}

/** "Seoul (UTC+9)" / "서울 (UTC+9)" instead of the raw IANA id "Asia/Seoul" (the value stays the IANA id), in the page
 *  language. A zone outside the common list is named by its IANA city in every language (Intl's own zone names are shared
 *  by many cities: "중부유럽 표준시" is Paris, Berlin and Rome alike). */
export function zoneLabel(z: string, locale = 'en', at = new Date()): string {
  if (z === 'UTC') return 'UTC'
  const lang = locale.slice(0, 2)
  let off = ''
  try { off = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' }).formatToParts(at).find((x) => x.type === 'timeZoneName')?.value ?? '' } catch { return z }
  let city: string | undefined = CITY[lang]?.[z]
  city ??= (z.split('/').pop() ?? z).replace(/_/g, ' ')
  return `${city} (${off === 'GMT' ? 'UTC+0' : off.replace(/^GMT/, 'UTC') || 'UTC+0'})`
}

/** ICU's list still has the old names of a few zones (Asia/Saigon, Asia/Calcutta); the picker shows the current ones. */
const MODERN: Record<string, string> = { 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Rangoon': 'Asia/Yangon', 'Atlantic/Faeroe': 'Atlantic/Faroe', 'Pacific/Truk': 'Pacific/Chuuk', 'Pacific/Ponape': 'Pacific/Pohnpei' }

function allZones(): string[] {
  let all: string[] = FALLBACK
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    if (f) all = f('timeZone')
  } catch { /* the fallback list */ }
  return [...new Set(all.map((z) => MODERN[z] ?? z))].filter((z) => isKnownTimeZone(z))
}

export interface ZoneChoice { value: string; label: string }
/** `none`: a search that no zone matches (the current zone stays in `common` so the picker can show it) */
export interface ZoneGroups { common: ZoneChoice[]; other: ZoneChoice[]; none: boolean }

// about 420 labels, each made with Intl: once per language, not on every key typed in the search
const LABELS = new Map<string, string>()
const labelOf = (z: string, locale: string) => { const k = `${locale.slice(0, 2)}|${z}`; let l = LABELS.get(k); if (!l) LABELS.set(k, l = zoneLabel(z, locale)); return l }

const norm = (s: string) => s.toLowerCase().replace(/[\s_/]+/g, '')

/** The picker's zones in two groups: the common ones first (with the saved zone and the browser's own on top when they
 *  are not among them), then every other zone the browser knows by city. `query` keeps the zones whose city, IANA name
 *  or offset has it ("seoul", "서울", "utc+9", "asia"); the current zone always stays so the picker can show it. */
export function zoneGroups(current: string | null | undefined, locale = 'en', query = '', browser: string | null = browserTimeZone()): ZoneGroups {
  const known = allZones()
  const choice = (z: string): ZoneChoice => ({ value: z, label: labelOf(z, locale) })
  const top = [current, browser].filter((z, i, a): z is string => !!z && a.indexOf(z) === i && !COMMON_ZONES.includes(z) && (isKnownTimeZone(z) || z === current))
  const common = [...top, ...COMMON_ZONES.filter(isKnownTimeZone)].map(choice)
  const shown = new Set(common.map((c) => c.value))
  const other = known.filter((z) => !shown.has(z) && z !== 'Etc/UTC' && z !== 'UTC').map(choice)
  const q = norm(query.trim())
  if (!q) return { common, other, none: false }
  const hit = (c: ZoneChoice) => norm(`${c.label} ${c.value}`).includes(q)
  const keep = (c: ZoneChoice) => c.value === current || hit(c)
  return { common: common.filter(keep), other: other.filter(keep), none: ![...common, ...other].some(hit) }
}
