import { fetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import { parseTeamAddress } from './address'
import type { Slot } from './device'
import { pageLocale, type PageLocale } from './protocol'
import { checkTeamWith, type CheckIo, type TeamCheck } from './team-check'
export { parseTeamAddress, readTeamInput } from './address'
export { sameTeam } from './protocol'
const KEY = 'team-ax.origin', SINCE = 'team-ax.since', LEFT = 'team-ax.left-sessions'
export async function savedTeamUrl(): Promise<string | null> {
  try { const raw = await SecureStore.getItemAsync(KEY); return raw ? parseTeamAddress(raw)?.origin ?? null : null } catch { return null }
}
/** Teams left on this phone whose sign-out the server has not confirmed yet (src/leave.ts). */
export const leftSessions: Slot = {
  get: () => SecureStore.getItemAsync(LEFT),
  set: value => value === null ? SecureStore.deleteItemAsync(LEFT) : SecureStore.setItemAsync(LEFT, value),
}
/** When the current team was chosen (ms). A notification older than this may come from the previous team. */
export async function savedTeamSince(): Promise<number> {
  try { const n = Number(await SecureStore.getItemAsync(SINCE)); return Number.isSafeInteger(n) && n > 0 ? n : 0 } catch { return 0 }
}
export async function saveTeamUrl(origin: string | null) {
  if (origin === null) { await SecureStore.deleteItemAsync(KEY); await SecureStore.deleteItemAsync(SINCE) }
  else {
    const checked = parseTeamAddress(origin)
    if (!checked || checked.entryPath !== '/' || checked.origin !== origin) throw new Error('invalid_team')
    await SecureStore.setItemAsync(KEY, origin)
    await SecureStore.setItemAsync(SINCE, String(Date.now()))
  }
}
/** The add-team check (src/team-check.ts): a relay rename is followed once, a sleeping trial team is woken and
 * waited for; `onWaking` is told when it is starting. */
export type { TeamCheck } from './team-check'
export function checkTeam(origin: string, teamDomain: string | null = null, onWaking?: () => void, signal?: AbortSignal): Promise<TeamCheck> {
  return checkTeamWith({ fetch: fetch as unknown as CheckIo['fetch'], onWaking, signal }, origin, teamDomain)
}

// the team whose last page padded itself (src/look.ts padding): its next launch starts edge to edge, with no jump
const PADS = 'team-ax.self-padded'
export async function selfPaddedTeam(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(PADS) } catch { return null }
}
export async function rememberSelfPadded(origin: string, pads: boolean): Promise<void> {
  try {
    if (pads) await SecureStore.setItemAsync(PADS, origin)
    else if ((await SecureStore.getItemAsync(PADS)) === origin) await SecureStore.deleteItemAsync(PADS)
  } catch { /* the app then starts padded and the page confirms */ }
}

// the language the team's page last said (language-v1, src/protocol.ts): the app's own screens use it at the next
// launch too, for that team only (another team's screens follow the phone's language until its page says)
const LANGUAGE = 'team-ax.page-language'
export async function pageLanguageOf(origin: string): Promise<PageLocale | null> {
  try {
    const saved: unknown = JSON.parse((await SecureStore.getItemAsync(LANGUAGE)) ?? 'null')
    return saved && typeof saved === 'object' && (saved as { origin?: unknown }).origin === origin && pageLocale((saved as { locale?: unknown }).locale) ? (saved as { locale: PageLocale }).locale : null
  } catch { return null }
}
export async function rememberPageLanguage(origin: string, locale: PageLocale): Promise<void> {
  try { await SecureStore.setItemAsync(LANGUAGE, JSON.stringify({ origin, locale })) } catch { /* the phone's language at the next launch, until the page says */ }
}
