import { fetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import { parseTeamAddress } from './address'
import { relayAnswer, relayRename } from './team-link'
export { parseTeamAddress, readTeamInput } from './address'
export { sameTeam } from './protocol'
const KEY = 'team-ax.origin', SINCE = 'team-ax.since'
export async function savedTeamUrl(): Promise<string | null> {
  try { const raw = await SecureStore.getItemAsync(KEY); return raw ? parseTeamAddress(raw)?.origin ?? null : null } catch { return null }
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
/** How a team address answered GET /api/health: a relay's own answers are told apart (src/team-link.ts relayAnswer), and
 * a team renamed at its relay (308) is followed once, only to another name under the same team domain (relayRename);
 * `origin` is then the new address. Any other redirect is not a team server. */
export type TeamCheck = { ok: true; origin: string; renamed: boolean } | { ok: false; reason: 'unreachable' | 'notTeam' | 'unknown' | 'suspended' }
export async function checkTeam(origin: string, teamDomain: string | null = null): Promise<TeamCheck> {
  const first = await health(origin)
  if (first.kind !== 'redirect') return first.kind === 'ok' ? { ok: true, origin, renamed: false } : { ok: false, reason: first.kind }
  const renamed = relayRename(origin, first.location, { teamDomain, loopbackHttp: false })
  if (!renamed) return { ok: false, reason: 'notTeam' }
  const second = await health(renamed)
  return second.kind === 'ok' ? { ok: true, origin: renamed, renamed: true } : { ok: false, reason: second.kind === 'redirect' ? 'notTeam' : second.kind }
}
type Health = { kind: 'ok' | 'unreachable' | 'notTeam' | 'unknown' | 'suspended' } | { kind: 'redirect'; location: string | null }
async function health(origin: string): Promise<Health> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000)
  try {
    // never followed by the platform: a redirect is looked at here (a relay rename) and otherwise refused
    const response = await fetch(`${origin}/api/health`, { headers: { accept: 'application/json' }, redirect: 'manual', signal: abort.signal })
    if (response.status >= 300 && response.status < 400) return { kind: 'redirect', location: response.headers.get('location') }
    const relay = relayAnswer(response.status, response.headers.get('x-relay-error'))
    if (relay === 'unknown' || relay === 'suspended') return { kind: relay }
    if (relay === 'offline' || response.status >= 500) return { kind: 'unreachable' }
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) return { kind: 'notTeam' }
    const reader = response.body?.getReader()
    if (!reader) return { kind: 'notTeam' }
    let size = 0, text = ''
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); return { kind: 'notTeam' } }
      text += decoder.decode(value, { stream: true })
    }
    try { return { kind: JSON.parse(text + decoder.decode())?.ok === true ? 'ok' : 'notTeam' } } catch { return { kind: 'notTeam' } }
  } catch { return { kind: 'unreachable' } } finally { clearTimeout(timer) }
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
