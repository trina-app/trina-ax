// "Ask people to clean up" (Admin › System › Storage; docs/decisions/20261116-room-files-cleanup.md). Like Slack, the
// people who sent the files in conversations are the ones who delete them; an owner or admin can ask them all at once.
// The server picks who: each active person whose own files in conversations take more than 1 GB together (ROOM_FILE_MAX),
// or, when nobody does, more than 100 MB; counted where they can still delete them (a message of theirs that is not
// deleted, in a conversation they are a member of now that is not archived). Each gets an Activity notice
// (storage.cleanup, storage_notices, by_user = who asked) that opens "Files you sent". Once a day for the team, by the
// team's time zone (the notice's source is that day, so a second press, or two admins at once, sends nothing more). The
// answer, the audit row (storage.ask_cleanup, the actor only) and the storage card's "Asked today" never say who or how
// many; the notices are recorded after the answer, so its time does not tell either.
import type { Database } from 'bun:sqlite'
import { ROOM_FILE_MAX } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { getSetting, setSetting, teamTimeZone } from '../admin/settings'
import { notificationsOf } from '../notifications/service'
import { zonedParts } from './time-zone'
import { SEE_MEMBER_SQL } from '../rooms/store'
import { dmPairOk } from '../rooms/guest-reach'

/** { day: 'YYYY-MM-DD' in the team's time zone, at: ISO time } of the last ask */
export const CLEANUP_KEY = 'system.storageCleanupAsked'
export const CLEANUP_OVER = ROOM_FILE_MAX
export const CLEANUP_OVER_FALLBACK = 100 * 1024 * 1024

const dayOf = (db: Database, t: Date) => { const p = zonedParts(t, teamTimeZone(db)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` }

/** The last ask while it is still that day in the team's time zone, else null (GET /api/admin/storage cleanupAskedAt). */
export function cleanupAskedAt(db: Database, now = new Date()): string | null {
  const v = getSetting<{ day: string; at: string } | null>(db, CLEANUP_KEY)
  return v && v.day === dayOf(db, now) ? v.at : null
}

/** The people whose own files in conversations take more than `over` bytes together (see the header): the files
 * "Files you sent" lists them (rooms/search.ts listMyRoomFiles): a message of theirs they still see (SEE_MEMBER_SQL), in
 * a conversation they are a member of now, not archived, and not a DM closed to a guest (dmPairOk). */
export function peopleOver(db: Database, over: number): string[] {
  const rows = db.query(`SELECT f.user_id AS id, r.kind AS kind, r.dm_key AS dm_key, SUM(f.size) AS n FROM room_files f
      JOIN room_messages m ON m.id = f.message_id AND m.room_id = f.room_id AND m.deleted_at IS NULL AND m.event IS NULL AND m.author_kind = 'user' AND m.author_id = f.user_id
      JOIN rooms r ON r.id = f.room_id AND r.archived_at IS NULL
      JOIN room_members mm ON mm.room_id = f.room_id AND mm.user_id = f.user_id
      JOIN users u ON u.id = f.user_id AND u.status = 'active' AND u.deleted_at IS NULL
    WHERE f.message_id IS NOT NULL AND ${SEE_MEMBER_SQL} GROUP BY f.user_id, f.room_id`).all() as { id: string; kind: string; dm_key: string | null; n: number }[]
  const sum = new Map<string, number>()
  for (const r of rows) if (dmPairOk(db, r.kind, r.dm_key)) sum.set(r.id, (sum.get(r.id) ?? 0) + r.n)
  return [...sum].filter(([, n]) => n > over).map(([id]) => id)
}

/** POST /api/admin/storage/ask-cleanup by `actorId`: the ask's time (today's first one when it was asked already). */
export function askCleanup(ctx: AppContext, actorId: string, now = new Date()): { askedAt: string } {
  const db = ctx.db
  const day = dayOf(db, now)
  const at = now.toISOString()
  const first = db.transaction(() => {
    const v = getSetting<{ day: string; at: string } | null>(db, CLEANUP_KEY)
    if (v && v.day === day) return { fresh: false, at: v.at }
    setSetting(db, CLEANUP_KEY, { day, at })
    return { fresh: true, at }
  })()
  if (!first.fresh) return { askedAt: first.at }
  audit(db, { actor: actorId, action: 'storage.ask_cleanup', target: null, detail: {} })
  // after the answer: one notice each, with that day as its source (a second one the same day is a no-op)
  setTimeout(() => {
    try {
      let ids = peopleOver(db, CLEANUP_OVER)
      if (!ids.length) ids = peopleOver(db, CLEANUP_OVER_FALLBACK)
      for (const id of ids) notificationsOf(ctx).storageCleanupNotice(id, day, actorId, at)
    } catch (e) {
      // nobody was told: the day is free again, so "Asked today" does not stand for an ask that never went out
      try { if (getSetting<{ at: string } | null>(db, CLEANUP_KEY)?.at === at) setSetting(db, CLEANUP_KEY, null) } catch { /* the database is gone */ }
      ctx.log.warn('clean-up notices not recorded', { err: e })
    }
  }, 0)
  return { askedAt: at }
}
