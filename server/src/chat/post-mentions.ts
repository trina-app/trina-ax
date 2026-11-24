// Real mentions in a post the AI makes for a person (post_to_room; docs/decisions/20261118-ai-post-real-mentions.md).
// A room message mentions the people its sender picked (room_messages.mentions: user ids), and shows each as "@Name" in
// its text; the web app marks a name only for a person the message mentions (web lib/rooms.ts mentionParts), and only a
// mention notifies (rooms/service.ts recordNotices). A shared answer mentions nobody, so "@Full Name" the AI wrote was
// plain text that notified no one.
//
// Here the people come from the server's records only: the members of the room the post goes to (or the other person of
// a 1:1 chat made on send), never the asker. The AI names them in `mention` (a name, or person:<id> from the
// candidates), and an "@Name" in its text that is exactly one such person's name counts too; any other "@word" stays
// plain text (a look-alike, a non-member, a name two members share). "@everyone" (each language's word, shared
// ROOM_MENTION_ALL_WORDS, and the "@channel"/"@here" other apps use) only when the asker's own message wrote it.
// No database writes, no network: tests/unit/post-mentions.test.ts.
import type { Database } from 'bun:sqlite'
import { ROOM_MENTION_ALL_WORDS, roomMentionAllIn } from '@mycel/shared/api'
import { fold } from './shared-actions'

/** A person the post may mention: in the room (or the 1:1 chat it opens), not the asker, an active account. */
export interface Mentionable { id: string; name: string; username: string }

/** At most this many people in one post the AI makes (a person typing may pick up to ROOM_MENTIONS_MAX) */
export const POST_MENTIONS_MAX = 20

/** The words that mean "everyone here" in the post's `mention`, folded: each language's word and other apps' ones */
const BROADCAST = new Set([...ROOM_MENTION_ALL_WORDS, 'all', 'everybody', 'channel', 'here', 'room'].map((w) => fold(w)))
/** "@channel", "@here" and the like written in a text (each language's word is roomMentionAllIn's) */
const BROADCAST_AT = /(^|[\s([{"'“‘])@(channel|here|all|everybody)(?![\p{L}\p{N}_])/iu
/** where a mention's "@" may stand: the start, or after a space or an opening mark (web lib/rooms.ts mentionCanStart) */
const canStart = (text: string, at: number) => at === 0 || /[\s([{"'“‘]/.test(text[at - 1] ?? '')
const HANGUL_END = /\p{Script=Hangul}$/u
const strip = (ref: string) => ref.trim().replace(/^@+/, '').trim()

/** The people a post to `roomId` may mention: its members but `me`, active accounts, with their name and username. */
export function mentionablesOf(db: Database, roomId: string, me: string): Mentionable[] {
  return (db.query("SELECT u.id, u.name, u.username FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND m.user_id <> ? AND u.status = 'active' AND u.deleted_at IS NULL ORDER BY u.name, u.id")
    .all(roomId, me) as { id: string; name: string | null; username: string | null }[]).map((r) => ({ id: r.id, name: r.name ?? '', username: r.username ?? '' }))
}
/** One person (a 1:1 chat made on send): the same, when their account is active. */
export function mentionableUser(db: Database, userId: string): Mentionable[] {
  const r = db.query("SELECT id, name, username FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId) as { id: string; name: string | null; username: string | null } | null
  return r ? [{ id: r.id, name: r.name ?? '', username: r.username ?? '' }] : []
}

/** Does `ref` (a word of `mention`) ask for everyone here? */
export const isBroadcastRef = (ref: string) => BROADCAST.has(fold(strip(ref)))
/** Does a text hold "@everyone" in any language, "@channel" or "@here" where a mention may start? */
export const broadcastIn = (text: string) => roomMentionAllIn(text) || BROADCAST_AT.test(text)
/** `text` without its "@everyone" words (each language's, "@channel", "@here" ...) where a mention may start: whether
 * own words are the person's text is read apart from where they put the everyone mention, which the post checks on its
 * own (QA b5 F6: "<text> 이라고 @everyone 으로 올려줘" went as "@전체 <text>" and was taken as other words) */
export function withoutBroadcast(text: string): string {
  const words = [...ROOM_MENTION_ALL_WORDS, 'channel', 'here', 'all', 'everybody', 'everyone'].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return text.replace(new RegExp(`(^|[\\s([{"'“‘])@(?:${words.join('|')})(?![A-Za-z0-9_])`, 'giu'), '$1').replace(/\s+/g, ' ').trim()
}

export type PickedMentions =
  | { ok: true; ids: string[]; all: boolean; byName: { ref: string; id: string }[] }
  | { ok: false; unknown: string[]; many: { ref: string; people: Mentionable[] }[]; broadcast: boolean; tooMany: boolean }

/**
 * The people `refs` (the tool's `mention`) name among `people`: person:<id> of one of them; else a name or username
 * equal to the ref (folded: case, width and spaces); else one person whose name holds the ref as whole words. Several
 * that fit, none, everyone without `allowAll`, or more than POST_MENTIONS_MAX: not ok, with which ones. `byName`: the
 * name each person was found by (never a person:<id>), for whether the asker's own words used it.
 */
export function pickMentions(people: readonly Mentionable[], refs: readonly string[], o: { allowAll: boolean; personRef: string }): PickedMentions {
  const ids: string[] = [], unknown: string[] = [], many: { ref: string; people: Mentionable[] }[] = [], byName: { ref: string; id: string }[] = []
  let all = false, broadcast = false
  for (const raw of refs) {
    const ref = strip(raw)
    if (!ref) continue
    if (isBroadcastRef(ref)) {
      if (o.allowAll) all = true
      else broadcast = true
      continue
    }
    if (ref.startsWith(o.personRef)) {
      const p = people.find((x) => x.id === ref.slice(o.personRef.length).trim())
      if (p) { if (!ids.includes(p.id)) ids.push(p.id) } else unknown.push(raw)
      continue
    }
    const f = fold(ref)
    let hits = people.filter((x) => fold(x.name) === f || (!!x.username && fold(x.username) === f))
    if (!hits.length) {
      // a part of the name as whole words ("Erin" for "Erin Yoo"), only when one person fits
      const words = (s: string) => ` ${fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
      const w = words(ref)
      hits = w.trim() ? people.filter((x) => words(x.name).includes(w)) : []
    }
    if (hits.length === 1) { if (!ids.includes(hits[0]!.id)) ids.push(hits[0]!.id); byName.push({ ref, id: hits[0]!.id }) }
    else if (hits.length > 1) many.push({ ref: raw, people: hits })
    else unknown.push(raw)
  }
  const tooMany = ids.length > POST_MENTIONS_MAX
  if (unknown.length || many.length || broadcast || tooMany) return { ok: false, unknown, many, broadcast, tooMany }
  return { ok: true, ids, all, byName }
}

/** One "@Name" found in a text: where it stands and whose it is (`all`: "@everyone"). */
interface Token { start: number; end: number; id?: string; all?: boolean }

/** Korean particles and honorifics that may follow a Hangul name (as escapes): an honorific (nim, ssi), then a
 * particle (ege, hante, i, ga, eun, neun, ...), each at most once, with no letter after them: a longer name is not
 * the shorter one inside it */
const HANGUL_TAIL = /^(?:\uB2D8|\uC528)?(?:\uAED8\uC11C|\uC5D0\uAC8C|\uD55C\uD14C|\uC774\uB791|\uD558\uACE0|\uAED8|\uC774|\uAC00|\uC740|\uB294|\uC744|\uB97C|\uC758|\uB3C4|\uB791|\uACFC|\uC640|\uB9CC)?(?![\p{L}\p{N}_])/u
const LETTER = /[\p{L}\p{N}_]/u

/**
 * The "@Name"s in a text that are exactly one of `people`'s names as the app shows them (never a username: "@erin" of
 * "@Erin Yo0" is not Erin Yoo), ignoring case, the longest name first, with no letter or digit right after (after a
 * Hangul name only a particle: HANGUL_TAIL). A name two of them share is plain text, and so is any shorter name inside
 * it ("@Erin Yoo" with two Erin Yoos is never Erin's). "@everyone" (and "@channel"/"@here") only with `allowAll`.
 * `plain`: the other "@words", as written.
 */
export function textMentions(text: string, people: readonly Mentionable[], o: { allowAll: boolean }): { tokens: Token[]; plain: string[] } {
  const owners = new Map<string, { name: string; ids: Set<string> }>()
  for (const p of people) {
    const n = p.name.replace(/\s+/g, ' ').trim()
    if (!n) continue
    const k = n.toLowerCase()
    if (!owners.has(k)) owners.set(k, { name: n, ids: new Set() })
    owners.get(k)!.ids.add(p.id)
  }
  // every name, the longest first (a shared one too: it stops a shorter name from matching inside it)
  const names = [...owners.values()].sort((a, b) => b.name.length - a.name.length)
  // (compared at each position, so a character whose lower case is longer elsewhere in the text moves nothing)
  const at = (i: number, n: string) => text.slice(i, i + n.length).toLowerCase() === n.toLowerCase()
  const edge = (end: number, n: string) => (HANGUL_END.test(n) ? HANGUL_TAIL.test(text.slice(end)) : !LETTER.test(text[end] ?? ''))
  const tokens: Token[] = [], plain: string[] = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (!canStart(text, i)) continue
    const hit = names.find((n) => at(i + 1, n.name) && edge(i + 1 + n.name.length, n.name))
    if (hit && hit.ids.size === 1) { tokens.push({ start: i, end: i + 1 + hit.name.length, id: [...hit.ids][0]! }); i += hit.name.length; continue }
    // (a name two people there share: plain, as the whole name, so the result never calls it nobody of the room)
    if (hit) { plain.push(`@${hit.name}`); i += hit.name.length; continue }
    const word = /^@[^\s@]{1,40}/u.exec(text.slice(i))?.[0] ?? ''
    if (!hit && o.allowAll && word && broadcastIn(word)) {
      const w = word.slice(1).replace(/[^\p{L}\p{N}_]+$/u, '')
      tokens.push({ start: i, end: i + 1 + w.length, all: true })
      continue
    }
    if (word.length > 1) plain.push(word.replace(/[.,:;!?)\]}"'”’]+$/u, ''))
  }
  return { tokens, plain: [...new Set(plain)].filter((w) => w.length > 1) }
}

/** Does `said` (the asker's own words) name this person: their display name or username as whole words (a Hangul one
 * followed only by a particle, HANGUL_TAIL: a longer Hangul name does not name a shorter one), ignoring case? */
export function namesPerson(said: string, p: Pick<Mentionable, 'name' | 'username'>): boolean {
  const text = said.replace(/\s+/g, ' ')
  const lower = text.toLowerCase()
  for (const raw of [p.name, p.username]) {
    const n = raw.replace(/\s+/g, ' ').trim()
    if (n.length < 2) continue
    const k = n.toLowerCase()
    for (let i = lower.indexOf(k); i >= 0; i = lower.indexOf(k, i + 1)) {
      if (lower.length !== text.length || LETTER.test(text[i - 1] ?? '')) continue
      const end = i + n.length
      if (HANGUL_END.test(n) ? HANGUL_TAIL.test(text.slice(end)) : !LETTER.test(text[end] ?? '')) return true
    }
  }
  return false
}

/** The length of the run of mentions a text starts with ("@Erin Yoo, @Bob Lee: …"), and of the marks after them;
 * 0 when it does not start with one, or nothing else would be left. */
export function leadingMentions(text: string, tokens: readonly Token[]): number {
  let at = 0
  for (;;) {
    const ws = /^\s*/.exec(text.slice(at))![0].length
    const t = tokens.find((x) => x.start === at + ws)
    if (!t) break
    at = t.end
    at += /^\s*[,:;\-–—]?/.exec(text.slice(at))![0].length
  }
  return at > 0 && text.slice(at).trim() ? at : 0
}

/** "@Name @Name …" as the start of the person's own line: each name as the room shows it, then "@<everyone word>". */
export function mentionHead(names: readonly string[], allWord: string | null): string {
  return [...names.map((n) => `@${n}`), ...(allWord ? [`@${allWord}`] : [])].join(' ')
}

/** A text with each token written as the person's name exactly (the web app marks the exact name), the rest as it was. */
export function withExactNames(text: string, tokens: readonly Token[], nameOf: (id: string) => string, allWord: string): string {
  let out = '', at = 0
  for (const t of [...tokens].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, t.start) + (t.all ? `@${allWord}` : `@${nameOf(t.id!)}`)
    at = t.end
  }
  return out + text.slice(at)
}
