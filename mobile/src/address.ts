export interface TeamAddress { origin: string; entryPath: string }
/** An address or an explicit invite link. Never silently discard an invite, query, password or path. */
export function parseTeamAddress(raw: string): TeamAddress | null {
  let value = raw.trim()
  if (!value || value.length > 2048) return null
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = 'https://' + value
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash) return null
    if (u.pathname !== '/' && !/^\/invite\/[A-Za-z0-9_-]{8,200}$/.test(u.pathname)) return null
    return { origin: u.origin, entryPath: u.pathname }
  } catch { return null }
}
