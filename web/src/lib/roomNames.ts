// Room ids in a text, as people read them (docs/DECISIONS.md "A scheduled task's instruction names rooms by their
// names"). A scheduled task the AI makes from a chat names a room by its id ("… room_id 0195…"): the AI was given the
// id (chat/turn.ts roomRefsBlock), and a run reads that exact room with room_read, so the stored text keeps it. Where
// the text is shown (the Scheduled pages, a run's question) each id reads as the room's name, from the rooms the viewer
// is in now (the app's room list: the server sends a person only their own rooms). A room the viewer is not in is never
// named, even when the text carries a name (a "#" token): it reads "a conversation you're not in". A bare id that is not
// one of the viewer's rooms stays as it is (it may be a file's or a thread's). No React, no requests:
// test/unit/room-names.test.tsx.

const UUID7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
// in this order: a "#" token (shared/src/api/rooms.ts ROOM_REF_RE), the form the AI is given earlier messages in
// (roomRefsByIdOnly), "room_id <id>" / "room_id=<id>" / "room id: <id>" / "roomId <id>", "room:<id>", and a bare id;
// none in a path or a query ("users/<id>/", "?room_id=<id>") or a web address. One run of spaces only before the id:
// two runs that can trade characters ("[ \t]*[=:]?[ \t]*") take time that grows with the square of the run (review).
const ROOM_ID_RE = new RegExp([
  `#\\[([^\\[\\]\\n]{1,80})\\]\\(room:(${UUID7})\\)`,
  `\\[#room room_id=(${UUID7})\\]`,
  `(?<![/?&=.#])\\broom[_ ]?id[ \\t]*(?:[=:][ \\t]*)?(${UUID7})(?![0-9a-z-])`,
  `(?<![/?&=.#])\\broom:(${UUID7})(?![0-9a-z-])`,
  `(?<![0-9a-z_/=?&.#:-])(${UUID7})(?![0-9a-z_-])`,
].join('|'), 'gi')
/** web addresses: an id inside one stays as written (the link must keep working when it is copied) */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi

/** A room the viewer is in, as the app names it (lib/rooms.ts roomTitle): a 1:1 chat by the other person. */
export interface SeenRoom { name: string; dm: boolean }

/**
 * A part of the text: as written, or a room. `name` is the room's name for a viewer in it; null when the viewer is not
 * in it ("a conversation you're not in"); undefined for a "#" token while the viewer's rooms are not known yet (a
 * placeholder, never the token's title; an id alone names nobody, so it stays as written until then). `picked`: a
 * token shown by the title it was picked by (`tokenTitles`).
 */
export type RoomNamePart = { text: string } | { room: { id: string; name: string | null | undefined; dm: boolean; picked?: true } }

/** Does the text name a room by its id at all (cheap: no lookup). */
export const mentionsRoomId = (text: string) => new RegExp(UUID7, 'i').test(text)

/**
 * The text split at the rooms it names by id. `seen(id)`: the room as the viewer sees it, or null when they are not
 * in it; undefined for `seen` itself: their rooms are not known yet. `tokenTitles`: a "#" token shows the title it was
 * picked by (an ordinary chat message: the person's own pick, components/chat/RoomRefMenu.tsx WithRoomRefs); off, a
 * token is a room id like the others (a scheduled task's instruction, which the AI wrote).
 */
export function roomNameParts(text: string, seen: ((id: string) => SeenRoom | null) | undefined, o: { tokenTitles?: boolean } = {}): RoomNamePart[] {
  const out: RoomNamePart[] = []
  let at = 0
  const push = (s: string) => { if (!s) return; const last = out[out.length - 1]; if (last && 'text' in last) last.text += s; else out.push({ text: s }) }
  const links = [...text.matchAll(URL_RE)].map((u) => [u.index!, u.index! + u[0].length] as const)
  for (const m of text.matchAll(ROOM_ID_RE)) {
    const whole = m[0]
    if (links.some(([a, b]) => m.index! < b && m.index! + whole.length > a)) continue
    const token = m[2] !== undefined
    const bare = m[6] !== undefined
    const id = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6])!.toLowerCase()
    push(text.slice(at, m.index))
    at = m.index! + whole.length
    if (token && o.tokenTitles) { out.push({ room: { id, name: m[1]!, dm: false, picked: true } }); continue }
    // the viewer's rooms are not known yet: an id stays as written (it names nobody); a token's title is held back
    if (!seen) { if (token) out.push({ room: { id, name: undefined, dm: false } }); else push(whole); continue }
    const room = seen(id)
    // a bare id is a room only when it is one of the viewer's (else it may be anything: left as written)
    if (bare && !room) { push(whole); continue }
    out.push({ room: { id, name: room?.name ?? null, dm: !!room?.dm } })
  }
  push(text.slice(at))
  return out
}
