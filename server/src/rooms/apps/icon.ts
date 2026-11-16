// A plain Other app's own icon (docs/decisions/20261116-other-app-icon.md, migration 356 room_app_icons): an image or
// one emoji, set in the app's settings ("Change icon") by the people who manage the room's apps. Without one the app
// shows its name's first letter (the web app colours its tile from the app id). Never set from what a service sends:
// a message cannot name another icon or sender (owner decision 3, the impersonation risk).
//
// The image follows the profile photo's rules (auth/avatar.ts prepareAvatar): PNG, JPEG or WebP only (never SVG), the
// first bytes must say the same type, a square of 64–512 px, at most 256 KiB, no animation, every metadata block cut
// out. The version only grows, so an address with ?v= never shows another picture and is cached for good.
import type { Database } from 'bun:sqlite'
import { AVATAR_MAX_BYTES, AVATAR_MAX_PX, AVATAR_MIN_PX } from '@mycel/shared'
import { roomAppIconUrl, type Locale, type RoomAppIcon } from '@mycel/shared/api'
import { fail, HttpError } from '../../http/errors'
import { prepareAvatar, type AvatarProblem } from '../../auth/avatar'
import { appText } from './text'

interface IconRow { app_id: string; room_id: string; emoji: string | null; has_image: number; version: number }

/** The icons of these apps (the ones that have one), as a message and the settings show them. */
export function iconsOf(db: Database, appIds: readonly string[]): Map<string, RoomAppIcon> {
  const out = new Map<string, RoomAppIcon>()
  if (!appIds.length) return out
  const rows = db.query(`SELECT i.app_id, a.room_id, i.emoji, i.image IS NOT NULL has_image, i.version FROM room_app_icons i JOIN room_apps a ON a.id = i.app_id
    WHERE i.app_id IN (${appIds.map(() => '?').join(',')})`).all(...appIds) as IconRow[]
  for (const r of rows) {
    if (r.has_image) out.set(r.app_id, { image: roomAppIconUrl(r.room_id, r.app_id, r.version) })
    else if (r.emoji) out.set(r.app_id, { emoji: r.emoji })
  }
  return out
}

/** The image of an app's icon (null: none, or an emoji). */
export function iconImage(db: Database, appId: string): { bytes: Uint8Array; type: string; version: number } | null {
  const r = db.query('SELECT image, image_type, version FROM room_app_icons WHERE app_id = ? AND image IS NOT NULL').get(appId) as { image: Uint8Array; image_type: string; version: number } | null
  return r ? { bytes: r.image, type: r.image_type, version: r.version } : null
}

const prevVersion = (db: Database, appId: string) =>
  (db.query('SELECT version FROM room_app_icons WHERE app_id = ?').get(appId) as { version: number } | null)?.version ?? null
/** a clock that only grows: an address with ?v= is never reused for another picture, even within one millisecond */
const nextVersion = (before: number | null) => Math.max(Date.now(), (before ?? 0) + 1)

const KB = AVATAR_MAX_BYTES / 1024
function refuse(problem: AvatarProblem, locale: Locale): never {
  const text = problem === 'too_big' ? appText('iconTooBig', locale, { kb: KB })
    : problem === 'animated' ? appText('iconAnimated', locale)
    : problem === 'not_square' || problem === 'too_small' || problem === 'too_large' ? appText('iconShape', locale, { min: AVATAR_MIN_PX, max: AVATAR_MAX_PX })
    : appText('iconType', locale)
  return fail(problem === 'too_big' ? 'payload_too_large' : 'validation', text, {
    params: { reason: problem },
    ...(problem === 'too_big' ? {} : { fields: { [problem === 'type' ? 'query.type' : 'body']: problem } }),
  })
}

/** Read the upload (bounded by the contract) and check it; the bytes to store. */
export async function readIconUpload(body: AsyncIterable<Uint8Array>, declared: string, locale: Locale): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string }> {
  const parts: Uint8Array[] = []
  try {
    for await (const ch of body) parts.push(ch)
  } catch (e) {
    if (e instanceof HttpError && e.code === 'payload_too_large') refuse('too_big', locale)
    throw e
  }
  const r = prepareAvatar(new Uint8Array(Buffer.concat(parts)), declared)
  if (!r.ok) return refuse(r.problem, locale)
  return { bytes: r.bytes, type: r.type }
}

/** Store an image or an emoji as the app's icon (one replaces the other). The version before (null: none). */
export function writeIcon(db: Database, appId: string, icon: { bytes: Uint8Array; type: string } | { emoji: string }): { before: number | null } {
  const before = prevVersion(db, appId)
  const version = nextVersion(before)
  const image = 'bytes' in icon ? icon : null
  db.query(`INSERT INTO room_app_icons (app_id, image, image_type, emoji, version) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(app_id) DO UPDATE SET image = excluded.image, image_type = excluded.image_type, emoji = excluded.emoji, version = excluded.version`)
    .run(appId, image?.bytes ?? null, image?.type ?? null, 'emoji' in icon ? icon.emoji : null, version)
  return { before }
}

/** Take the icon away (the letter again). Whether there was one. */
export function dropIcon(db: Database, appId: string): boolean {
  return db.query('DELETE FROM room_app_icons WHERE app_id = ?').run(appId).changes > 0
}
