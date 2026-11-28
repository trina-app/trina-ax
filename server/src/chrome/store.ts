// The Chromes people link to this team (docs/decisions/20261128-trina-in-chrome.md): one-time codes the signed-in
// team page makes for the extension that opened it, and the link each code turns into. Only hashes are kept: a code's
// and a token's sha256, and the challenge the extension made (the sha256 of a secret only it holds, PKCE: a copied
// code is useless without that secret). A person links many browser profiles (one per extension install), each with
// its own name and site rules. Pure database code; the routes are routes/chrome.ts, the live connections chrome/links.ts.
import type { Database } from 'bun:sqlite'
import crypto from 'node:crypto'
import { CHROME_CODE_TTL_MS, CHROME_LINK_IDLE_DAYS, CHROME_LINKS_MAX, type BrowserTarget } from '@mycel/shared/api'
import { cutLabel } from '@mycel/shared/chrome-native'
import { newId } from '../db'

const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
/** the challenge a verifier answers: base64url of its sha256 (the extension computes the same) */
export const challengeOf = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url')
export const newSecret = () => crypto.randomBytes(32).toString('base64url')
const iso = (ms: number) => new Date(ms).toISOString()

export interface LinkRow { id: string; user_id: string; label: string; version: string | null; only_listed: number; created_at: string; last_seen_at: string | null; email: string | null; browser: string | null }
const COLS = 'id, user_id, label, version, only_listed, created_at, last_seen_at, email, browser'

/** live codes a person holds at once: the desktop app links several profiles one after the other ("모두 연결") */
export const LIVE_CODES_MAX = 5

/** A new code for this person's extension. Each is bound to its own challenge; past LIVE_CODES_MAX the oldest goes. */
export function mintCode(db: Database, userId: string, challenge: string, now = Date.now()): { code: string; expiresAt: string } {
  const code = newSecret()
  const expiresAt = iso(now + CHROME_CODE_TTL_MS)
  db.transaction(() => {
    db.query('DELETE FROM chrome_pair_codes WHERE user_id = ? AND (expires_at <= ? OR challenge = ?)').run(userId, iso(now), challenge)
    db.query(`DELETE FROM chrome_pair_codes WHERE id IN (SELECT id FROM chrome_pair_codes WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ${LIVE_CODES_MAX - 1})`).run(userId)
    db.query('INSERT INTO chrome_pair_codes (id, user_id, code_hash, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), userId, sha256hex(code), challenge, iso(now), expiresAt)
  }).immediate()
  return { code, expiresAt }
}

/**
 * Spend a code with its verifier: the person's new link and its token (shown once), or null (unknown, spent, expired,
 * a verifier that does not answer the challenge, or the person is no longer active). Spent at the first try whatever
 * the verifier: a guessed code is gone for its owner too, never tried twice. One more profile of the person, or the
 * install's own earlier link renewed (`previous`); 'full' past CHROME_LINKS_MAX (nothing is removed).
 */
export function redeemCode(db: Database, o: { code: string; verifier: string; label: string; version: string; previous?: string; email?: string; browser?: string }, now = Date.now()): { link: LinkRow; token: string; replaced: string | null } | 'full' | null {
  return db.transaction(() => {
    const row = db.query('DELETE FROM chrome_pair_codes WHERE code_hash = ? RETURNING user_id, challenge, expires_at').get(sha256hex(o.code)) as { user_id: string; challenge: string; expires_at: string } | null
    if (!row || row.expires_at <= iso(now)) return null
    const a = Buffer.from(row.challenge), b = Buffer.from(challengeOf(o.verifier))
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    const u = db.query('SELECT status, deleted_at, guest FROM users WHERE id = ?').get(row.user_id) as { status: string; deleted_at: string | null; guest: number } | null
    if (!u || u.status !== 'active' || u.deleted_at || u.guest === 1) return null
    // the install linked before (its own token): that one link is replaced, its site rules kept
    const prev = o.previous ? db.query('SELECT id FROM chrome_links WHERE token_hash = ? AND user_id = ?').get(sha256hex(o.previous), row.user_id) as { id: string } | null : null
    const count = (db.query('SELECT COUNT(*) AS n FROM chrome_links WHERE user_id = ?').get(row.user_id) as { n: number }).n
    if (!prev && count >= CHROME_LINKS_MAX) return 'full'
    const token = newSecret()
    const label = distinctLabel(db, row.user_id, o.label, prev?.id ?? null)
    if (prev) {
      db.query('UPDATE chrome_links SET token_hash = ?, label = ?, version = ?, last_seen_at = ?, email = COALESCE(?, email), browser = COALESCE(?, browser) WHERE id = ?').run(sha256hex(token), label, o.version, iso(now), o.email ?? null, o.browser ?? null, prev.id)
      return { link: linkOf(db, row.user_id, prev.id)!, token, replaced: prev.id }
    }
    const link: LinkRow = { id: newId(), user_id: row.user_id, label, version: o.version, only_listed: 0, created_at: iso(now), last_seen_at: iso(now), email: o.email ?? null, browser: o.browser ?? null }
    db.query('INSERT INTO chrome_links (id, user_id, token_hash, label, version, created_at, last_seen_at, email, browser) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(link.id, link.user_id, sha256hex(token), link.label, link.version, link.created_at, link.last_seen_at, link.email, link.browser)
    return { link, token, replaced: null }
  }).immediate()
}

/** `label`, or with a number ("Chrome on Mac 2") when another of the person's links already has that name (ignoring
 * case): two profiles that would both be "Chrome on Mac" never look alike in Settings or to the AI. At most 60 units. */
export function distinctLabel(db: Database, userId: string, label: string, exceptId: string | null = null): string {
  const taken = new Set((db.query('SELECT id, label FROM chrome_links WHERE user_id = ?').all(userId) as { id: string; label: string }[])
    .filter((r) => r.id !== exceptId).map((r) => r.label.trim().toLowerCase()))
  if (!taken.has(label.trim().toLowerCase())) return label
  for (let n = 2; n <= CHROME_LINKS_MAX + 1; n++) {
    const tail = ` ${n}`
    const v = `${cutLabel(label, 60 - tail.length)}${tail}`
    if (!taken.has(v.toLowerCase())) return v
  }
  return label
}

/** The live link a token belongs to, for an active member (not a guest), or null. */
export function linkByToken(db: Database, token: string, now = Date.now()): LinkRow | null {
  const row = db.query(`SELECT l.id, l.user_id, l.label, l.version, l.only_listed, l.created_at, l.last_seen_at, l.email, l.browser FROM chrome_links l JOIN users u ON u.id = l.user_id
    WHERE l.token_hash = ? AND u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0`).get(sha256hex(token)) as LinkRow | null
  if (!row) return null
  if (Date.parse(row.last_seen_at ?? row.created_at) < now - CHROME_LINK_IDLE_DAYS * 86_400_000) return null
  return row
}

export function touchLink(db: Database, linkId: string, version: string | null, now = Date.now()) {
  db.query('UPDATE chrome_links SET last_seen_at = ?, version = COALESCE(?, version) WHERE id = ?').run(iso(now), version, linkId)
}

export function linksOf(db: Database, userId: string): LinkRow[] {
  return db.query(`SELECT ${COLS} FROM chrome_links WHERE user_id = ? ORDER BY created_at ASC`).all(userId) as LinkRow[]
}

/** End one link of this person (false: not theirs or gone). */
export function unlink(db: Database, userId: string, linkId: string): boolean {
  return db.query('DELETE FROM chrome_links WHERE id = ? AND user_id = ?').run(linkId, userId).changes > 0
}

/** Told when links end outside a route (the runtime closes their live connections at once: chrome/links.ts). */
const ended: ((ids: string[]) => void)[] = []
export function onLinksEnded(l: (ids: string[]) => void): () => void { ended.push(l); return () => { const i = ended.indexOf(l); if (i >= 0) ended.splice(i, 1) } }
const tellEnded = (ids: string[]) => { if (ids.length) for (const l of ended) try { l(ids) } catch { /* the next ping closes it */ } }

/** End every link and code of a person (their sessions all ended: sign out everywhere, password, disabled, deleted). */
export function unlinkAll(db: Database, userId: string): string[] {
  db.query('DELETE FROM chrome_pair_codes WHERE user_id = ?').run(userId)
  const ids = (db.query('DELETE FROM chrome_links WHERE user_id = ? RETURNING id').all(userId) as { id: string }[]).map((r) => r.id)
  tellEnded(ids)
  return ids
}

/** Spent and expired codes, links unused for CHROME_LINK_IDLE_DAYS. */
export function sweepChrome(db: Database, now = Date.now()): string[] {
  db.query('DELETE FROM chrome_pair_codes WHERE expires_at <= ?').run(iso(now))
  const cut = iso(now - CHROME_LINK_IDLE_DAYS * 86_400_000)
  const ids = (db.query('DELETE FROM chrome_links WHERE COALESCE(last_seen_at, created_at) < ? RETURNING id').all(cut) as { id: string }[]).map((r) => r.id)
  tellEnded(ids)
  return ids
}

export function browserTarget(db: Database, userId: string): BrowserTarget {
  const r = db.query('SELECT target FROM user_browser_target WHERE user_id = ?').get(userId) as { target: BrowserTarget } | null
  return r?.target ?? 'app'
}

export function setBrowserTarget(db: Database, userId: string, target: BrowserTarget, now = Date.now()) {
  db.query('INSERT INTO user_browser_target (user_id, target, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at')
    .run(userId, target, iso(now))
}

export function linkOf(db: Database, userId: string, linkId: string): LinkRow | null {
  return db.query(`SELECT ${COLS} FROM chrome_links WHERE id = ? AND user_id = ?`).get(linkId, userId) as LinkRow | null
}

/** The sites the AI may use in this profile without asking, sorted. */
export function linkSites(db: Database, linkId: string): string[] {
  return (db.query('SELECT site FROM chrome_link_sites WHERE link_id = ? ORDER BY site').all(linkId) as { site: string }[]).map((r) => r.site)
}

/** Keep a site for this profile (an Always on the Chrome site card, or the person adding it in Settings). */
export function addLinkSite(db: Database, linkId: string, site: string, now = Date.now()): boolean {
  return db.query('INSERT OR IGNORE INTO chrome_link_sites (link_id, site, created_at) VALUES (?, ?, ?)').run(linkId, site, iso(now)).changes > 0
}

export function removeLinkSite(db: Database, linkId: string, site: string): boolean {
  return db.query('DELETE FROM chrome_link_sites WHERE link_id = ? AND site = ?').run(linkId, site).changes > 0
}

export function updateLink(db: Database, userId: string, linkId: string, o: { label?: string; onlyListed?: boolean }): boolean {
  const l = linkOf(db, userId, linkId)
  if (!l) return false
  if (o.label !== undefined) db.query('UPDATE chrome_links SET label = ? WHERE id = ?').run(o.label, linkId)
  if (o.onlyListed !== undefined) db.query('UPDATE chrome_links SET only_listed = ? WHERE id = ?').run(o.onlyListed ? 1 : 0, linkId)
  return true
}

/** Does `host` fall under one of these sites (the site itself or a subdomain; a key with a port matches only it)? */
export function siteCovers(sites: readonly string[], host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  const bare = h.replace(/:\d+$/, '')
  return sites.some((s) => s === h || s === bare || bare.endsWith('.' + s))
}
