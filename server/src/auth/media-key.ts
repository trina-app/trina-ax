// The browser keeps a picture that never changes (the thumbnail of a file sent in a room: its id always means the same
// bytes) without asking again, but only for the sign-in that read it (docs/DECISIONS.md "Room pictures are kept per
// sign-in"). Signing out also tells the browser to forget its cache (Clear-Site-Data, routes/auth.ts logout).
//
// Every request that reaches the server is checked as before (room membership, the message still there and visible,
// the download-only list). What changes is the answer's Cache-Control: when the address carries this session's media
// key (?k=, given only to this session in GET /api/me session.mediaKey), the answer is `private, max-age=…, immutable`,
// so this browser shows it again without a round trip. Any other request (no key, another session's key, a key of a
// session that ended) gets `private, no-cache` as before: the browser asks the server every time.
//
// Why a key per sign-in: a browser keeps answers by address, not by person. If the addresses were the same for
// everyone, the next person signed in on this browser (a shared computer) would be shown the last person's kept
// pictures without the server being asked. With the key, the next person's app asks for other addresses, which the
// browser has never kept, so the server checks them. The key is made from the session's token hash (never sent to a
// browser) with HMAC, so it cannot be worked out from anything a person sees, and it changes with every sign-in. (Someone
// with a copy of the database could work it out; all it gives is a browser cache hint, never access.) Only thumbnails
// carry it: they are only ever an <img>, never an address a link opens and the browser's history keeps.
//
// Never `public`: no shared cache (a proxy, a CDN) keeps a team's private picture.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Database } from 'bun:sqlite'

/** How long a kept picture is used without asking at most (and never past the session's end): a day. */
export const KEPT_MEDIA_MAX_AGE_S = 86_400
/** Below this many seconds of the session left, nothing is kept: the browser asks again. */
const MIN_AGE_S = 60

const keyOf = (tokenHash: string) => createHmac('sha256', tokenHash).update('mycel:media-cache:v1').digest('base64url').slice(0, 22)

/** This session's media key, or null (no such session). */
export function mediaKeyOf(db: Database, sessionId: string): string | null {
  const row = db.query('SELECT token_hash FROM sessions WHERE id = ?').get(sessionId) as { token_hash: string } | null
  return row ? keyOf(row.token_hash) : null
}

/**
 * The Cache-Control for a picture that never changes, read by `session` with the key `k` from its address: kept (private,
 * immutable, at most a day and never past the session's end) when `k` is that session's own media key; null otherwise
 * (the caller keeps `private, no-cache`).
 */
export function keptMediaCache(db: Database, session: { id: string; expiresAt?: string }, k: string | undefined, now = Date.now()): `private, ${string}` | null {
  if (!k) return null
  const mine = mediaKeyOf(db, session.id)
  if (!mine) return null
  const a = Buffer.from(k)
  const b = Buffer.from(mine)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const left = session.expiresAt ? Math.floor((Date.parse(session.expiresAt) - now) / 1000) : KEPT_MEDIA_MAX_AGE_S
  const age = Math.min(KEPT_MEDIA_MAX_AGE_S, Number.isFinite(left) ? left : 0)
  if (age < MIN_AGE_S) return null
  return `private, max-age=${age}, immutable`
}
