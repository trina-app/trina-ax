// When "Ask people to clean up" was last pressed (storage-cleanup.ts). Kept apart from storage-cleanup.ts on purpose:
// storage.ts reads it for the storage card, and storage.ts is loaded by the office installer's CLI (office/cli.ts →
// office/update.ts), so this file must import nothing beyond settings and time; storage-cleanup.ts pulls in rooms and
// notifications, which made the office CLI load ~520 modules instead of ~70.
import type { Database } from 'bun:sqlite'
import { getSetting, teamTimeZone } from '../admin/settings'
import { zonedParts } from './time-zone'

/** { day: 'YYYY-MM-DD' in the team's time zone, at: ISO time } of the last ask */
export const CLEANUP_KEY = 'system.storageCleanupAsked'

export const cleanupDayOf = (db: Database, t: Date) => { const p = zonedParts(t, teamTimeZone(db)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` }

/** The last ask while it is still that day in the team's time zone, else null (GET /api/admin/storage cleanupAskedAt). */
export function cleanupAskedAt(db: Database, now = new Date()): string | null {
  const v = getSetting<{ day: string; at: string } | null>(db, CLEANUP_KEY)
  return v && v.day === cleanupDayOf(db, now) ? v.at : null
}
