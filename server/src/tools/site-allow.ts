// The sites a person allowed for good, as Settings › Allowed for Trina lists them (GET /api/ai-allowances; docs/decisions/
// 20261122-always-allow-holds-everywhere.md B3): "이 사이트 항상 허용" on the AI's address card (user_allowed_sites,
// tools/url-gate.ts ①b) and "항상 허용" on the in-app browser's office-network card (browser_site_grants, chat/tools.ts
// browserTool). Only the person's own rows; removing one brings that card back.
import type { Database } from 'bun:sqlite'
import { domainToUnicode } from 'node:url'
import type { SiteAllowance } from '@mycel/shared/api'
import { audit } from '../admin/audit'

type Place = SiteAllowance['place']
const idOf = (place: Place, host: string) => `site:${Buffer.from(JSON.stringify([place, host])).toString('base64url')}`
function parseId(id: string): [Place, string] | null {
  if (!id.startsWith('site:')) return null
  try {
    const v = JSON.parse(Buffer.from(id.slice(5), 'base64url').toString('utf8')) as unknown
    return Array.isArray(v) && v.length === 2 && (v[0] === 'web' || v[0] === 'office') && typeof v[1] === 'string' ? [v[0], v[1]] : null
  } catch { return null }
}

/** A site as Settings names it: the Unicode form of a punycode name (예시.한국), else as kept. */
const shown = (host: string) => { const u = domainToUnicode(host); return u || host }

/** The person's sites for good, newest first. */
export function listSiteAllows(db: Database, userId: string): SiteAllowance[] {
  const web = (db.query('SELECT site AS host, created_at FROM user_allowed_sites WHERE user_id = ?').all(userId) as { host: string; created_at: string }[])
    .map((r) => ({ kind: 'site' as const, id: idOf('web', r.host), site: shown(r.host), place: 'web' as const, createdAt: r.created_at }))
  const office = (db.query('SELECT host, created_at FROM browser_site_grants WHERE user_id = ?').all(userId) as { host: string; created_at: string }[])
    .map((r) => ({ kind: 'site' as const, id: idOf('office', r.host), site: shown(r.host), place: 'office' as const, createdAt: r.created_at }))
  return [...web, ...office].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/** Take one back by its id; false when it is not this person's or not there. Audited. */
export function dropSiteAllow(db: Database, userId: string, id: string): boolean {
  const p = parseId(id)
  if (!p) return false
  const [place, host] = p
  const n = place === 'web'
    ? db.query('DELETE FROM user_allowed_sites WHERE user_id = ? AND site = ?').run(userId, host).changes
    : db.query('DELETE FROM browser_site_grants WHERE user_id = ? AND host = ?').run(userId, host).changes
  if (n) audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: place === 'web' ? 'web_site' : 'office_site', site: host, on: false, via: 'settings' } })
  return n > 0
}
