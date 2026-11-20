// Conversation categories (shared/src/api/room-categories.ts; migration 428). The team's own: admins and the owner make,
// rename, order and delete them and put channels in them (the routes are auth 'admin'); everyone reads the same list.
// A room carries its category (rooms.category_id, Room.categoryId) for every member alike. Only channels go in one: a
// 1:1 or an unnamed group chat is personal (409 room_category_personal). A category never changes who is in a room.
import type { Database } from 'bun:sqlite'
import { navFolderName, ROOM_CATEGORIES_MAX, type Locale, type Room, type RoomCategory } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { fail } from '../http/errors'
import { tr } from '../chat/i18n'
import { roomsOf } from './service'

interface CategoryRow { id: string; name: string; name_key: string; position: number }

const nameKey = (name: string): string => navFolderName(name).toLowerCase()
const out = (r: CategoryRow): RoomCategory => ({ id: r.id, name: r.name, position: r.position })
const all = (db: Database): CategoryRow[] => db.query('SELECT id, name, name_key, position FROM room_categories ORDER BY position, created_at, id').all() as CategoryRow[]
const one = (db: Database, id: string): CategoryRow => (db.query('SELECT id, name, name_key, position FROM room_categories WHERE id = ?').get(id) as CategoryRow | null) ?? fail('not_found')
const nameTaken = (locale: Locale) => fail('conflict', tr('roomCategoryNameTaken', locale), { fields: { 'body.name': 'room_category_name_taken' }, params: { reason: 'room_category_name_taken' } })
const isUniqueClash = (e: unknown) => e instanceof Error && /UNIQUE constraint failed: room_categories\./.test(e.message)
/** every open window reads the list again */
const changed = (ctx: AppContext) => ctx.services.realtime.publishEach(() => ({ type: 'roomCategories.changed', data: {} }))

/** The category a room is in, or null (Room.categoryId). */
export function categoryOf(db: Database, roomId: string): string | null {
  return (db.query('SELECT category_id FROM rooms WHERE id = ?').get(roomId) as { category_id: string | null } | null)?.category_id ?? null
}

export function listRoomCategories(db: Database): RoomCategory[] {
  return all(db).map(out)
}

export function createRoomCategory(ctx: AppContext, userId: string, rawName: string, locale: Locale): RoomCategory {
  const db = ctx.db
  const name = navFolderName(rawName), key = nameKey(rawName)
  const id = newId()
  db.transaction(() => {
    const n = db.query('SELECT COUNT(*) n, MAX(position) p FROM room_categories').get() as { n: number; p: number | null }
    if (n.n >= ROOM_CATEGORIES_MAX) fail('conflict', tr('roomCategoriesFull', locale, { n: String(ROOM_CATEGORIES_MAX) }), { params: { reason: 'room_categories_full' } })
    if (db.query('SELECT 1 FROM room_categories WHERE name_key = ?').get(key)) nameTaken(locale)
    const now = nowIso()
    try {
      db.query('INSERT INTO room_categories (id, name, name_key, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, key, (n.p ?? -1) + 1, userId, now, now)
    } catch (e) { if (isUniqueClash(e)) nameTaken(locale); throw e }
  })()
  changed(ctx)
  return out(one(db, id))
}

export function renameRoomCategory(ctx: AppContext, id: string, rawName: string, locale: Locale): RoomCategory {
  const db = ctx.db
  const c = one(db, id)
  const name = navFolderName(rawName), key = nameKey(rawName)
  if (name !== c.name) {
    if (db.query('SELECT 1 FROM room_categories WHERE name_key = ? AND id <> ?').get(key, id)) nameTaken(locale)
    try {
      db.query('UPDATE room_categories SET name = ?, name_key = ?, updated_at = ? WHERE id = ?').run(name, key, nowIso(), id)
    } catch (e) { if (isUniqueClash(e)) nameTaken(locale); throw e }
    changed(ctx)
  }
  return out(one(db, id))
}

function renumber(db: Database, first: readonly string[]) {
  const now = all(db)
  const byId = new Map(now.map((c) => [c.id, c]))
  const seen = new Set<string>()
  const order: CategoryRow[] = []
  for (const id of first) { const c = byId.get(id); if (c && !seen.has(id)) { seen.add(id); order.push(c) } }
  for (const c of now) if (!seen.has(c.id)) order.push(c)
  const set = db.query('UPDATE room_categories SET position = ? WHERE id = ? AND position <> ?')
  order.forEach((c, i) => set.run(i, c.id, i))
}

export function orderRoomCategories(ctx: AppContext, ids: readonly string[]): RoomCategory[] {
  ctx.db.transaction(() => renumber(ctx.db, ids))()
  changed(ctx)
  return listRoomCategories(ctx.db)
}

/** Only the category goes: its channels go back to Channels for everyone (their members hear room.updated). */
export function deleteRoomCategory(ctx: AppContext, id: string): void {
  const db = ctx.db
  one(db, id)
  const rooms = (db.query('SELECT id FROM rooms WHERE category_id = ?').all(id) as { id: string }[]).map((r) => r.id)
  db.transaction(() => {
    db.query('UPDATE rooms SET category_id = NULL WHERE category_id = ?').run(id)
    db.query('DELETE FROM room_categories WHERE id = ?').run(id)
    renumber(db, [])
  })()
  changed(ctx)
  const svc = roomsOf(ctx)
  for (const r of rooms) svc.roomEvent(r, 'updated')
}

/** A channel's category for everyone (null: out). The caller is in the room (404 otherwise, as every room call). */
export function setRoomCategory(ctx: AppContext, userId: string, roomId: string, categoryId: string | null, locale: Locale): Room {
  const db = ctx.db
  const svc = roomsOf(ctx)
  const { room } = svc.mine(userId, roomId)
  if (room.kind === 'dm' || (room.kind === 'group' && !room.name)) fail('conflict', tr('roomCategoryPersonal', locale), { params: { reason: 'room_category_personal' } })
  if (categoryId !== null) one(db, categoryId)
  if (categoryOf(db, roomId) !== categoryId) {
    db.query('UPDATE rooms SET category_id = ? WHERE id = ?').run(categoryId, roomId)
    svc.roomEvent(roomId, 'updated')
  }
  return svc.get(userId, roomId)
}
