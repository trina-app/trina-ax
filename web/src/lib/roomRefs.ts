// "#" in the AI chat's message box (docs/DECISIONS.md "내 AI 채팅에서 대화방 읽기"): typing "#" lists the rooms I am in;
// picking one writes "#<title> " into the box, shown as one token, and remembers the room. What is sent carries the
// room's id: each kept "#<title>" of a picked room becomes `#[<title>](room:<id>)` (shared/src/api/rooms.ts
// roomRefToken), so the AI reads exactly that room and never guesses from a name. Only in the AI chat's box, never in a
// room's (a room's name would reach people who are not in it). No React, no requests: test/unit/room-refs.test.ts.
import { plainRoomRefs, roomRefsOf, roomRefToken, roomRefTitle, type Room } from '@mycel/shared/api'

/** A room picked from the "#" list: its id and the title it was picked by (what the box shows after "#"). */
export interface PickedRoom { id: string; title: string }
/** A token in the box: where "#<title>" stands, and the room. */
export interface TokenRange { start: number; end: number; room: PickedRoom }

/** The "#word" being typed right before the caret: where its "#" is and what follows it. null: the caret is not in
 * one (a "#" inside a word, "C#", a heading's "## " or a new line in between is not it). Spaces are allowed, as room
 * titles have them ("주간 회의"); the list closes when nothing fits. */
export function roomRefAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('#')
  if (at < 0) return null
  if (at > 0 && !/[\s([{"'“‘]/.test(before[at - 1]!)) return null
  const query = before.slice(at + 1)
  if (query.includes('\n') || query.length > 40 || /^[#\s]/.test(query)) return null
  return { start: at, query }
}

const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase().replace(/\s+/g, '')

/** The rooms whose title (or, for a 1:1 chat or a group chat, a member's name) holds the query: titles that start with
 * it first, then the most recent activity; at most `limit`. `title` is the app's name for the room (RoomIcon
 * useRoomTitle). */
export function matchRooms<T extends Pick<Room, 'id' | 'kind' | 'peers' | 'activityAt'>>(rooms: T[], query: string, title: (r: T) => string, limit = 50): T[] {
  const q = fold(query)
  const hit = (r: T) => !q || fold(title(r)).includes(q) || ((r.kind === 'dm' || r.kind === 'group') && r.peers.some((p) => fold(p.name).includes(q)))
  const starts = (r: T) => !!q && fold(title(r)).startsWith(q)
  return rooms.filter(hit).sort((a, b) => Number(starts(b)) - Number(starts(a)) || b.activityAt.localeCompare(a.activityAt)).slice(0, limit)
}

/** "#<title> " in place of the "#query" from `start` to the caret: the new text and where the caret goes. */
export function insertRoomRef(text: string, start: number, caret: number, title: string): { text: string; caret: number } {
  const insert = `#${roomRefTitle(title)} `
  // a space already after the caret is not doubled
  const rest = text.slice(caret)
  const out = text.slice(0, start) + (rest.startsWith(' ') ? insert.trimEnd() : insert) + rest
  return { text: out, caret: start + insert.length }
}

/** Where the picked rooms' "#<title>" stand in the text: whole titles only (after a space, an opening mark or the start,
 * before a space, punctuation or the end), the longest title first where two would overlap; one picked room's title
 * counts each time it is there. */
export function tokenRanges(text: string, picked: PickedRoom[]): TokenRange[] {
  const out: TokenRange[] = []
  const rooms = [...picked].sort((a, b) => b.title.length - a.title.length)
  for (const room of rooms) {
    const word = `#${room.title}`
    for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
      const end = i + word.length
      if (i > 0 && !/[\s([{"'“‘]/.test(text[i - 1]!)) continue
      if (end < text.length && !/[\s.,!?;:)\]}"'”’~…·]/.test(text[end]!)) continue
      if (out.some((r) => i < r.end && end > r.start)) continue
      out.push({ start: i, end, room })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The picked rooms whose token is still in the text (one typed or deleted away is forgotten). */
export function keepPicked(picked: PickedRoom[], text: string): PickedRoom[] {
  const used = new Set(tokenRanges(text, picked).map((r) => r.room.id))
  return picked.filter((p) => used.has(p.id))
}

/** The text as it is sent: each token as `#[<title>](room:<id>)`. */
export function toWire(text: string, picked: PickedRoom[]): string {
  let out = '', at = 0
  for (const r of tokenRanges(text, picked)) { out += text.slice(at, r.start) + roomRefToken(r.room.id, r.room.title); at = r.end }
  return out + text.slice(at)
}

/** A sent (or saved) text back in the box: "#<title>" in its place, and the rooms it names. */
export function fromWire(wire: string): { text: string; picked: PickedRoom[] } {
  return { text: plainRoomRefs(wire), picked: roomRefsOf(wire) }
}

/** Backspace right after a token (or Delete right before one) takes the whole token: the new text and caret, or null
 * when the key is not at a token (a selection is left to the box). */
export function deleteToken(text: string, selStart: number, selEnd: number, key: 'Backspace' | 'Delete', ranges: TokenRange[]): { text: string; caret: number } | null {
  if (selStart !== selEnd) return null
  const r = ranges.find((x) => (key === 'Backspace' ? selStart > x.start && selStart <= x.end : selStart >= x.start && selStart < x.end))
  if (!r) return null
  return { text: text.slice(0, r.start) + text.slice(r.end), caret: r.start }
}

/** A caret inside a token goes to its end (a token is one piece: it is never typed into). */
export function outsideToken(caret: number, ranges: TokenRange[]): number {
  const r = ranges.find((x) => caret > x.start && caret < x.end)
  return r ? r.end : caret
}
