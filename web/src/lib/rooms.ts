// Pure helpers of the team chat rooms ("대화방" v1, shared/src/api/rooms.ts): a room's title, runs of one author's
// messages, event lines, and @mentions (the "@name" being typed, the members that fit it, and the parts of a sent
// text). No React, no requests: unit tested in test/unit/rooms-lib.test.ts.
import { ROOM_AI_NAMES, ROOM_MENTIONS_MAX, roomAiCalled, roomAiMentions, type Room, type RoomAiRun, type RoomEventLine, type RoomMessage, type Step, type UserRef } from '@mycel/shared/api'

/** The words a title falls back to: `all` for the everyone room, `gone` for a DM whose other person is gone, and for an
 * unnamed group chat its other members ("가, 나, 다 외 2명"; `alone` when nobody else is left). */
export interface TitleWords { all: string; gone: string; names?: (names: string, more: number) => string; sep?: string; alone?: string }

/** How many of a group chat's other members its title names before "외 N명". */
export const TITLE_NAMES = 3

/** The room's own name when it has one; else team: the group's name; all: the app's word for everyone; dm: the other
 * person (peers[0]); group: the other members (the first TITLE_NAMES of peers, then how many more). */
export function roomTitle(room: Pick<Room, 'kind' | 'name' | 'peers'> & Partial<Pick<Room, 'memberCount'>>, words: TitleWords): string {
  if (room.kind === 'dm') return room.peers[0]?.name ?? words.gone
  if (room.kind === 'group' && !room.name) {
    const shown = room.peers.slice(0, TITLE_NAMES).map((p) => p.name)
    if (!shown.length) return words.alone ?? words.gone
    const others = Math.max(shown.length, (room.memberCount ?? room.peers.length + 1) - 1)
    const list = shown.join(words.sep ?? ', ')
    return words.names ? words.names(list, others - shown.length) : list
  }
  return room.name ?? words.all
}

/** The words of an event line (lib, not React: the component passes t). `person` puts a language's honorific after a
 * name ("{name}님"), `quote` puts a room name in the language's quotes. */
export interface EventWords {
  t: (key: 'rooms.event.invited' | 'rooms.event.invitedMore' | 'rooms.event.renamed' | 'rooms.event.renamedBack' | 'rooms.event.left' | 'rooms.event.removed' | 'rooms.event.unknown' | 'rooms.event.person' | 'rooms.event.quoted' | 'rooms.nameSep', params?: Record<string, string | number>) => string
  nameOf: (u: UserRef | null) => string
}
/** "가나님이 다라님, 마바님을 초대했어요": every name but the last gets the language's honorific here, the last one the
 * text's own (so a name that ends with 님 already gets no second one, and the particle after it fits); past TITLE_NAMES
 * names "외 N명". */
export function eventText(e: RoomEventLine, author: UserRef | null, w: EventWords): string {
  const actor = w.nameOf(author)
  switch (e.type) {
    case 'created':
    case 'added': {
      const names = e.users.map((u) => w.nameOf(u))
      const shown = names.slice(0, TITLE_NAMES)
      const list = shown.map((n, i) => (i < shown.length - 1 ? w.t('rooms.event.person', { name: n }) : n)).join(w.t('rooms.nameSep'))
      return names.length > shown.length ? w.t('rooms.event.invitedMore', { actor, names: list, n: names.length - shown.length }) : w.t('rooms.event.invited', { actor, names: list })
    }
    case 'renamed':
      return e.name ? w.t('rooms.event.renamed', { actor, name: w.t('rooms.event.quoted', { name: e.name }) }) : w.t('rooms.event.renamedBack', { actor })
    case 'left':
      return w.t('rooms.event.left', { actor })
    case 'removed':
      return w.t('rooms.event.removed', { actor, name: w.nameOf(e.user) })
    case 'unknown':
      return w.t('rooms.event.unknown')
  }
}

/** Messages of one author close together share one avatar, name and time: a new run after another author, a pause
 * longer than this, or a new day. */
export const RUN_GAP_MS = 5 * 60_000

/** The local calendar day of a time ("2026-11-05"), for the day line between messages. */
export function localDayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface MessageRun {
  /** the first message's id */
  key: string
  messages: RoomMessage[]
  /** the first run of its day (the list shows the date above it) */
  newDay: boolean
}

const authorKey = (m: RoomMessage) => (m.authorKind === 'ai' ? `ai:${m.askedBy?.id ?? ''}` : `user:${m.author?.id ?? ''}`)

/** Cut the messages (oldest first) into runs of one author. An event line is a run of its own and ends the one before
 * it (the next message starts a new run with its name and time). */
export function groupRuns(messages: RoomMessage[], dayOf: (iso: string) => string = localDayKey): MessageRun[] {
  const runs: MessageRun[] = []
  let prev: RoomMessage | null = null
  let prevDay: string | null = null
  for (const m of messages) {
    const day = dayOf(m.createdAt)
    const sameDay = day === prevDay
    const joins = prev !== null && sameDay && !prev.event && !m.event && authorKey(prev) === authorKey(m) && (m.author !== null || m.authorKind === 'ai') && Date.parse(m.createdAt) - Date.parse(prev.createdAt) <= RUN_GAP_MS
    if (joins) runs.at(-1)!.messages.push(m)
    else runs.push({ key: m.id, messages: [m], newDay: !sameDay })
    prev = m
    prevDay = day
  }
  return runs
}

/** The "@word" being typed right before the caret: where its "@" is and what follows it. null: the caret is not in one
 * ("a@b" in an address is not a mention; a space or a new line ends it). */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query) || query.length > 40) return null
  return { start: at, query }
}

/** The members whose name holds the query (names that start with it first), never the person typing, at most `limit`. */
export function matchMembers<T extends { id: string; name: string }>(members: T[], query: string, meId: string | null, limit = 8): T[] {
  const q = query.toLocaleLowerCase()
  const starts = (m: T) => m.name.toLocaleLowerCase().startsWith(q)
  return members
    .filter((m) => m.id !== meId && m.name.toLocaleLowerCase().includes(q))
    .sort((a, b) => Number(!starts(a)) - Number(!starts(b)) || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/** "@name " in place of the "@query" from `start` to the caret: the new text and where the caret goes. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length }
}

/** A text with "\n" line breaks only, as a text area gives it back. */
export const lineBreaks = (text: string) => text.replace(/\r\n?/g, '\n')

/** Where a mention's "@" may stand: at the start, or after a space or an opening mark (the server's "@트리나" check,
 * shared roomAiMentions, and mentionParts go by the same rule). */
export const mentionCanStart = (text: string, at: number) => at === 0 || /[\s([{"'“‘]/.test(text[at - 1] ?? '')

/** A person picked from the "@" list, and where their "@name" went in the message box. */
export interface PickedMention { start: number; end: number; id: string; name: string }
/** A mention as the message box shows it: a person the message will notify, or the AI it will ask ("@트리나"). */
export interface MentionToken { start: number; end: number; kind: 'person' | 'ai'; id: string }

/** The mentions in a message box, which are what is sent: the picked people whose "@name" is still whole where it was put
 * and may start a mention there (a letter typed right before it pauses it); with `ai`, every "@<AI name>" the server
 * will take as a call (roomAiMentions with those people's names: a person of that name wins). Text that only looks like
 * a mention (pasted, typed without the list, a picked name broken by an edit) is plain text: it notifies nobody. */
export function mentionTokens(text: string, picked: readonly PickedMention[], ai: boolean): MentionToken[] {
  let kept = picked.filter((p) => p.name && p.end === p.start + p.name.length + 1 && text.startsWith(`@${p.name}`, p.start) && mentionCanStart(text, p.start))
  // a person's "@name" that an AI name runs past ("@트리" + "나"): the call wins, as on the sent message; the server
  // asks the AI and the person is not sent (a person whose name goes past the AI name keeps it: roomAiMentions). The
  // calls are then counted with the names that are sent, as the server counts them
  let calls = ai ? roomAiMentions(text, kept.map((p) => p.name)) : []
  for (let i = 0; i < 3 && ai; i++) {
    const next = kept.filter((p) => !calls.some((r) => r.start < p.end && p.start < r.end))
    if (next.length === kept.length) break
    kept = next
    calls = roomAiMentions(text, kept.map((p) => p.name))
  }
  const tokens: MentionToken[] = [...kept.map((p) => ({ start: p.start, end: p.end, kind: 'person' as const, id: p.id })), ...calls.map((r) => ({ start: r.start, end: r.end, kind: 'ai' as const, id: AI_MENTION_ID }))]
  return tokens.sort((a, b) => a.start - b.start)
}

/** The people a message mentions, for what is sent: its people's tokens, each once, at most ROOM_MENTIONS_MAX. */
export function tokenMentions(tokens: readonly MentionToken[]): string[] {
  const ids: string[] = []
  for (const x of tokens) if (x.kind === 'person' && !ids.includes(x.id)) ids.push(x.id)
  return ids.slice(0, ROOM_MENTIONS_MAX)
}

/** These people's "@name"s in a text (a message to edit, a send that came back), as mentionParts marks them. */
export function mentionsIn(text: string, people: { id: string; name: string }[]): PickedMention[] {
  const out: PickedMention[] = []
  let at = 0
  for (const part of mentionParts(text, people)) {
    if (part.userId) out.push({ start: at, end: at + part.text.length, id: part.userId, name: part.text.slice(1) })
    at += part.text.length
  }
  return out
}

/** A sent text cut into plain parts and the "@name"s of the people it mentions (the longest name wins where one name
 * starts another). Only shown as text: another member's words are never HTML. */
export function mentionParts(body: string, mentioned: { id: string; name: string }[]): { text: string; userId?: string }[] {
  const names = mentioned.filter((p) => p.name).sort((a, b) => b.name.length - a.name.length)
  if (!names.length || !body.includes('@')) return [{ text: body }]
  const parts: { text: string; userId?: string }[] = []
  let plain = ''
  for (let i = 0; i < body.length; ) {
    const hit = body[i] === '@' && mentionCanStart(body, i) ? names.find((p) => body.startsWith(p.name, i + 1)) : undefined
    if (hit) {
      if (plain) parts.push({ text: plain })
      plain = ''
      parts.push({ text: `@${hit.name}`, userId: hit.id })
      i += hit.name.length + 1
    } else {
      plain += body[i]
      i++
    }
  }
  if (plain) parts.push({ text: plain })
  return parts
}

/** The newest loaded message's position (an event line's too): what "read up to here" sends once the bottom of the room
 * is in sight. */
export function newestSeq(messages: RoomMessage[]): number {
  return messages.at(-1)?.seq ?? 0
}

/** A room's count for me: its unread messages, and the threads I follow there with replies I have not read (each one
 * thing to read). Thread replies never count otherwise (docs/DECISIONS.md "스레드와 반응"). */
export const roomUnread = (r: Pick<Room, 'unreadCount'> & Partial<Pick<Room, 'threadsUnread'>>) => r.unreadCount + (r.threadsUnread ?? 0)

/** The total for the 대화 tab: every room's own badge, added; a muted room's never (its badge is grey). */
export function totalUnread(rooms: (Pick<Room, 'unreadCount' | 'muted'> & Partial<Pick<Room, 'threadsUnread'>>)[]): number {
  return rooms.reduce((n, r) => n + (r.muted ? 0 : roomUnread(r)), 0)
}

/** A room's badge: "@" when one of the unread messages (or followed replies) mentions me (the count would read as a
 * count of mentions), else the count. */
export const roomBadge = (r: Pick<Room, 'unreadCount' | 'mentioned'> & Partial<Pick<Room, 'threadsUnread'>>) => (r.mentioned ? '@' : badgeText(roomUnread(r)))

/** Who put a reaction there, for its tooltip: the names given ("가나, 다라"), then how many more ("외 3명"). */
export function reactionWho(r: { count: number; users: { name: string }[] }, w: { sep: string; more: (names: string, n: number) => string }): string {
  const names = r.users.map((u) => u.name).join(w.sep)
  const more = r.count - r.users.length
  return more > 0 ? w.more(names, more) : names
}

/** An AI answer's Markdown as one plain line for the rooms list: no #, **, list marks, backticks or link addresses (the
 * excerpt may end inside a link). */
export function plainLine(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)?/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)?/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}*_])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/`+/g, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}.*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Opening a thread from the room page (pages/Room.tsx): a new history entry from the room, marked as reached from it;
 * from an open thread it replaces that one and keeps how it was reached (a thread opened from a link or a notice stays
 * unmarked, so closing it never steps back out of the room). */
export function threadOpening(roomId: string, rootId: string, open: { threadId: string | null; fromRoom: boolean }): { path: string; replace: boolean; state: { fromRoom: boolean } } {
  return { path: `/rooms/${roomId}/t/${rootId}`, replace: !!open.threadId, state: { fromRoom: open.threadId ? open.fromRoom : true } }
}
/** Closing it: one step back when the room is that step, else to the room in place of the thread. */
export const threadClosing = (roomId: string, fromRoom: boolean): -1 | { path: string; replace: true } => (fromRoom ? -1 : { path: `/rooms/${roomId}`, replace: true })

/** "99+" past 99, like the Inbox count. */
export const badgeText = (n: number) => (n > 99 ? '99+' : String(n))

// ---------------- the AI in a room (docs/DECISIONS.md "대화방의 트리나") ----------------
/** The AI's entry in the "@" list fits the query when one of its names starts with it ("" too: it comes first). */
export function aiMatches(query: string): boolean {
  const q = query.toLocaleLowerCase()
  return ROOM_AI_NAMES.some((n) => n.toLocaleLowerCase().startsWith(q))
}

/** The "@<AI name>" in a message, as pseudo-mentions for mentionParts (so they stand out like a person's). */
export function aiMentionNames(body: string, people: { name: string }[] = []): { id: string; name: string }[] {
  if (!roomAiCalled(body, people.map((p) => p.name))) return []
  return ROOM_AI_NAMES.map((name) => ({ id: AI_MENTION_ID, name }))
}
export const AI_MENTION_ID = '@ai'

/** A run of mine in its place: by turn id; steps the newer copy lacks (a state change carries none) are kept. */
export function withRun(runs: RoomAiRun[], run: RoomAiRun): RoomAiRun[] {
  const i = runs.findIndex((r) => r.turnId === run.turnId)
  if (i < 0) return [...runs, run]
  const prev = runs[i]!
  const next = { ...run, steps: run.steps.length ? run.steps : prev.steps }
  return runs.map((r, j) => (j === i ? next : r))
}

/** A step of one of my runs: replaced by id, or added at the end. */
export function withRunStep(runs: RoomAiRun[], turnId: string, step: Step): RoomAiRun[] {
  return runs.map((r) => {
    if (r.turnId !== turnId) return r
    const i = r.steps.findIndex((s) => s.id === step.id)
    return { ...r, state: r.state === 'queued' ? 'running' : r.state, position: 0, steps: i < 0 ? [...r.steps, step] : r.steps.map((s, j) => (j === i ? step : s)) }
  })
}

/** queue.position of a run of mine (0: it runs now). */
export function withRunPosition(runs: RoomAiRun[], turnId: string, position: number): RoomAiRun[] {
  return runs.map((r) => (r.turnId === turnId && (r.state === 'queued' || r.state === 'running') ? { ...r, state: position > 0 ? 'queued' : 'running', position } : r))
}

/** Is the run still working (its block shows the steps and Stop)? */
export const runActive = (r: Pick<RoomAiRun, 'state'>) => r.state === 'queued' || r.state === 'running'

/** What my question's answer is doing now, in plain words (the room shows no search patterns or paths): finding files,
 * reading a document (its name without folders or extension), looking at the web, or working. */
export type RoomStepWords = { kind: 'find' } | { kind: 'read'; name: string } | { kind: 'web' } | { kind: 'work' }
const FIND_TOOLS = new Set(['glob', 'grep', 'list', 'search', 'find_skills'])
export function roomStepWords(step: Pick<Step, 'kind' | 'tool' | 'label'>): RoomStepWords {
  if (step.kind === 'web_search' || step.tool === 'web_fetch' || step.tool === 'save_url') return { kind: 'web' }
  if (step.tool && FIND_TOOLS.has(step.tool)) return { kind: 'find' }
  if (step.tool === 'read') {
    // "<verb> · <path>": the file's own name, without its folders and extension
    const i = step.label.lastIndexOf(' · ')
    const file = i < 0 ? '' : (step.label.slice(i + 3).split('/').filter(Boolean).at(-1) ?? '')
    const name = file.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim()
    return name ? { kind: 'read', name } : { kind: 'find' }
  }
  return { kind: 'work' }
}
