import { fetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import { parseTeamAddress } from './address'
export { parseTeamAddress } from './address'
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
export async function checkTeam(origin: string): Promise<boolean> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000)
  try {
    const response = await fetch(`${origin}/api/health`, { headers: { accept: 'application/json' }, redirect: 'error', signal: abort.signal })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) return false
    const reader = response.body?.getReader()
    if (!reader) return false
    let size = 0, text = ''
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); return false }
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())?.ok === true
  } catch { return false } finally { clearTimeout(timer) }
}
