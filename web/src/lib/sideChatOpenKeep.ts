// Which rooms had the ✦ side chat open in this tab, kept across a reload (QA TC-4963,
// docs/decisions/20261118-side-chat-reload.md). In sessionStorage, per person: a reload of the tab finds them, another
// tab or a browser opened again does not. The room page writes it as the side chat opens and closes (store/rooms.ts
// setSide, close: leaving the room closes it, as before); what was there when the page loaded is read once
// (sideChatWasOpen), so a room opened again later in the same page session starts closed as before.
const KEY_PREFIX = 'mycel.sideChatOpen.'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const storage = (): StorageLike | null => { try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null } }

/** The rooms stored for this person (none when it cannot be read). */
export function readOpenRooms(userId: string, s: StorageLike | null = storage()): string[] {
  try {
    const v = JSON.parse(s?.getItem(KEY_PREFIX + userId) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []
  } catch { return [] }
}

/** The side chat of `roomId` opened (true) or closed (false) in this tab. */
export function keepSideChatOpen(userId: string, roomId: string, open: boolean, s: StorageLike | null = storage()) {
  if (!s) return
  const rooms = readOpenRooms(userId, s).filter((r) => r !== roomId)
  if (open) rooms.push(roomId)
  try {
    if (rooms.length) s.setItem(KEY_PREFIX + userId, JSON.stringify(rooms.slice(-50)))
    else s.removeItem(KEY_PREFIX + userId)
  } catch { /* full or blocked: nothing kept, it opens closed as before */ }
}

/** What was kept when this page loaded (this module is read with the app, before any room page opens), per person. */
let atLoad: Map<string, Set<string>> | null = null
function loadedWith(s: StorageLike | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  try {
    const all = s as (StorageLike & { length?: number; key?: (i: number) => string | null }) | null
    for (let i = 0; all?.key && i < (all.length ?? 0); i++) {
      const k = all.key(i)
      if (k?.startsWith(KEY_PREFIX)) out.set(k.slice(KEY_PREFIX.length), new Set(readOpenRooms(k.slice(KEY_PREFIX.length), s)))
    }
  } catch { /* nothing kept */ }
  return out
}
atLoad = loadedWith(storage())

/** Was the side chat of `roomId` open in this tab before the page loaded (a reload)? Told once per room: the next time
 * the room opens in this page session it starts closed, as before. */
export function sideChatWasOpen(userId: string, roomId: string): boolean {
  return !!atLoad?.get(userId)?.delete(roomId)
}

/** For tests: read what is kept as a page load would. */
export function resetSideChatOpenForTest(s: StorageLike | null = storage()) { atLoad = loadedWith(s) }
