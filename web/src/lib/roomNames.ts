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
// none in a path, a query or a Markdown link ("users/<id>/", "?room_id=<id>", "[label](room:<id>)") nor a quoted value
// ('"roomId":"<id>"'). One run of spaces only before the id: two runs that can trade characters ("[ \t]*[=:]?[ \t]*")
// take time that grows with the square of the run (review).
const ROOM_ID_RE = new RegExp([
  `#\\[([^\\[\\]\\n]{1,80})\\]\\(room:(${UUID7})\\)`,
  `\\[#room room_id=(${UUID7})\\]`,
  `(?<![/?&=.#])\\broom[_ ]?id[ \\t]*(?:[=:][ \\t]*)?(${UUID7})(?![0-9a-z-])`,
  `(?<![/?&=.#(])\\broom:(${UUID7})(?![0-9a-z-])`,
  `(?<![0-9a-z_/=?&.#:"'-])(${UUID7})(?![0-9a-z_-])`,
].join('|'), 'gi')
/** where an id stays as written: a web address (a copied link must keep working) and code, a fenced block or a
 * `backtick` span (an id there is data someone pasted) */
const KEEP_RE = /```[\s\S]*?```|`[^`\n]+`|\bhttps?:\/\/[^\s<>"'`]+/gi

/** A room the viewer is in, as the app names it (lib/rooms.ts roomTitle): a 1:1 chat by the other person. */
export interface SeenRoom { name: string; dm: boolean }

/** A room id the text names: where it stands (`at`, `end`), the id, and how it is written ('token': "#[title](room:<id>)"
 * with its `title`; 'named': "room_id <id>" and the like; 'bare': the id alone). */
export interface RoomIdMatch { at: number; end: number; id: string; kind: 'token' | 'named' | 'bare'; title?: string }

/**
 * A part of the text: as written, or a room. `name` is the room's name for a viewer in it; null when the viewer is not
 * in it ("a conversation you're not in"); undefined for a "#" token while the viewer's rooms are not known yet (a
 * placeholder, never the token's title; an id alone names nobody, so it stays as written until then). `picked`: a
 * token shown by the title it was picked by (`tokenTitles`). `raw`: what a copy of it gives (components/RoomNames.tsx
 * copyRoomIds): the text as written, or, for a token of a room the viewer is not in, "room:<id>" (never its title).
 */
export type RoomNamePart = { text: string } | { room: { id: string; name: string | null | undefined; dm: boolean; picked?: true; raw: string } }

/** Does the text name a room by its id at all (cheap: no lookup). */
export const mentionsRoomId = (text: string) => new RegExp(UUID7, 'i').test(text)

/** Where the text names rooms by id, in order (no lookup: what the viewer may see is roomNameParts'). Linear in the
 * text: the places an id stays as written are walked with one pointer (review: a check of every place for every id
 * took seconds on a long pasted log). */
export function roomIdMatches(text: string): RoomIdMatch[] {
  const keep = [...text.matchAll(KEEP_RE)].map((k) => [k.index!, k.index! + k[0].length] as const)
  const out: RoomIdMatch[] = []
  let k = 0
  for (const m of text.matchAll(ROOM_ID_RE)) {
    const at = m.index!, end = at + m[0].length
    while (k < keep.length && keep[k]![1] <= at) k++
    if (k < keep.length && keep[k]![0] < end) continue
    const kind = m[2] !== undefined ? 'token' : m[6] !== undefined ? 'bare' : 'named'
    out.push({ at, end, id: (m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6])!.toLowerCase(), kind, ...(kind === 'token' ? { title: m[1]! } : {}) })
  }
  return out
}

/**
 * The text split at the rooms it names by id. `seen(id)`: the room as the viewer sees it, or null when they are not
 * in it; undefined for `seen` itself: their rooms are not known yet. `tokenTitles`: a "#" token shows the title it was
 * picked by (an ordinary chat message: the person's own pick, components/chat/RoomRefMenu.tsx WithRoomRefs); off, a
 * token is a room id like the others (a scheduled task's instruction, which the AI wrote). `matches`: roomIdMatches of
 * the same text, when the caller keeps them.
 */
export function roomNameParts(text: string, seen: ((id: string) => SeenRoom | null) | undefined, o: { tokenTitles?: boolean } = {}, matches = roomIdMatches(text)): RoomNamePart[] {
  const out: RoomNamePart[] = []
  let at = 0
  const push = (s: string) => { if (!s) return; const last = out[out.length - 1]; if (last && 'text' in last) last.text += s; else out.push({ text: s }) }
  for (const m of matches) {
    const whole = text.slice(m.at, m.end)
    push(text.slice(at, m.at))
    at = m.end
    const token = m.kind === 'token'
    if (token && o.tokenTitles) { out.push({ room: { id: m.id, name: m.title!, dm: false, picked: true, raw: whole } }); continue }
    // the viewer's rooms are not known yet: an id stays as written (it names nobody); a token's title is held back
    if (!seen) { if (token) out.push({ room: { id: m.id, name: undefined, dm: false, raw: `room:${m.id}` } }); else push(whole); continue }
    const room = seen(m.id)
    // a bare id is a room only when it is one of the viewer's (else it may be anything: left as written)
    if (m.kind === 'bare' && !room) { push(whole); continue }
    out.push({ room: { id: m.id, name: room?.name ?? null, dm: !!room?.dm, raw: token && !room ? `room:${m.id}` : whole } })
  }
  push(text.slice(at))
  return out
}
