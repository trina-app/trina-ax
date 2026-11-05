// Pure helpers of the team chat rooms ("대화방" v1, shared/src/api/rooms.ts): a room's title, runs of one author's
// messages, and @mentions (the "@name" being typed, the members that fit it, and the parts of a sent text). No React,
// no requests: unit tested in test/unit/rooms-lib.test.ts.
import { ROOM_AI_NAMES, ROOM_MENTIONS_MAX, roomAiCalled, type Room, type RoomAiRun, type RoomMessage, type Step } from '@mycel/shared/api'

/** The words a title falls back to: `all` for the everyone room, `gone` for a DM whose other person is gone. */
export interface TitleWords { all: string; gone: string }

/** team: the group's name; all: the app's word for everyone; dm: the other person (peers[0]). */
export function roomTitle(room: Pick<Room, 'kind' | 'name' | 'peers'>, words: TitleWords): string {
  if (room.kind === 'dm') return room.peers[0]?.name ?? words.gone
  return room.name ?? words.all
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

/** Cut the messages (oldest first) into runs of one author. */
export function groupRuns(messages: RoomMessage[], dayOf: (iso: string) => string = localDayKey): MessageRun[] {
  const runs: MessageRun[] = []
  let prev: RoomMessage | null = null
  let prevDay: string | null = null
  for (const m of messages) {
    const day = dayOf(m.createdAt)
    const sameDay = day === prevDay
    const joins = prev !== null && sameDay && authorKey(prev) === authorKey(m) && (m.author !== null || m.authorKind === 'ai') && Date.parse(m.createdAt) - Date.parse(prev.createdAt) <= RUN_GAP_MS
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

/** The people picked from the list whose "@name" is still in the text (one typed away again is not mentioned). */
export function keptMentions(text: string, picked: { id: string; name: string }[]): string[] {
  const ids: string[] = []
  for (const p of picked) if (p.name && text.includes(`@${p.name}`) && !ids.includes(p.id)) ids.push(p.id)
  return ids.slice(0, ROOM_MENTIONS_MAX)
}

/** A sent text cut into plain parts and the "@name"s of the people it mentions (the longest name wins where one name
 * starts another). Only shown as text: another member's words are never HTML. */
export function mentionParts(body: string, mentioned: { id: string; name: string }[]): { text: string; userId?: string }[] {
  const names = mentioned.filter((p) => p.name).sort((a, b) => b.name.length - a.name.length)
  if (!names.length || !body.includes('@')) return [{ text: body }]
  const parts: { text: string; userId?: string }[] = []
  let plain = ''
  for (let i = 0; i < body.length; ) {
    const hit = body[i] === '@' && (i === 0 || /[\s([{"'“‘]/.test(body[i - 1]!)) ? names.find((p) => body.startsWith(p.name, i + 1)) : undefined
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

/** The newest loaded message's position: what "read up to here" sends once the bottom of the room is in sight. */
export function newestSeq(messages: RoomMessage[]): number {
  return messages.at(-1)?.seq ?? 0
}

/** The total for the 대화 tab: every room's own badge, added. */
export function totalUnread(rooms: Pick<Room, 'unreadCount'>[]): number {
  return rooms.reduce((n, r) => n + r.unreadCount, 0)
}

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
