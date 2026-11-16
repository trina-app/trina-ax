// The rules every AI action that reaches another person follows, in a person's own chat and in a shared one (QA TC-3091
// "Sending to a person or a room from a shared chat", TC-3093 "A member shares their own files"). Used by post_to_room
// (chat/post-to-room.ts) and share_with_person (chat/share-with-person.ts); one set of rules, so the two never drift:
//
// - The actor is the person whose turn it is (a turn is its sender's: spec.userId, the latest message's sender), with
//   their own access re-read on every call (TurnExec.livePrincipal). Only the main AI acts: a sub-agent never gets the
//   tools (subagents.ts PARENT_ONLY_TOOLS) and is refused when it reaches one (mainOnly).
// - Their card (`ask_user`, origin server) goes to them alone (TurnExec.waitForPerson: the runner's cards). Other viewers
//   of a shared chat see the step's verb alone (ChatStore.viewSteps).
// - Not offered where nobody can answer a card or where nothing may leave (actionOff): a scheduled run (post_to_room
//   and share_with_person only under the person's Always allow), an approved template's or a restricted run, a confidential chat, a question
//   from Slack.
// - In a shared chat other people's messages are in the AI's context, so the asker's "Always allow" counts only when
//   their own latest message names the recipient (namedByAsker / namesRecipient); several matches are picked on a card
//   only the asker gets (askerPicks), never listed to the AI (it writes where everyone in the chat reads); and a
//   refusal carries no server words (which could name a room or a person) into that transcript.
import type { Database } from 'bun:sqlite'
import { uuidv7 } from '@mycel/shared'
import type { TurnRequest } from '@mycel/shared/api'
import { PERSON_REF } from '../rooms/reader'
import { confidentialChat } from '../safe-ops/confidential'
import { alwaysHere } from './always-allow'
import type { TurnExec } from './turn'

/** Why an action that reaches others is not offered in this turn, or null: it is. `scheduleKind`: the Always allow
 * kind that lets a scheduled run do it without a card (post_to_room), or null when a scheduled run never may. */
export type ActionOff = 'schedule' | 'confidential' | 'slack' | 'restricted'
export function actionOff(exec: Pick<TurnExec, 'restricted' | 'templateRun' | 'spec' | 'rt'> & Partial<Pick<TurnExec, 'alwaysPlace'>>, scheduleKind: 'post_to_room' | 'share_files' | null): ActionOff | null {
  if (exec.spec.clientKind === 'schedule' && (scheduleKind === null || alwaysHere(exec.alwaysPlace?.(), scheduleKind) !== 'on')) return 'schedule'
  if (confidentialChat(exec.rt.db, exec.spec.chatId)) return 'confidential'
  if (exec.spec.clientKind === 'slack') return 'slack'
  if (exec.restricted || exec.templateRun) return 'restricted'
  return null
}

/** Only the main AI acts (the person answers its cards), and only for an active account. A refusal's words, or null. */
export function mainOnly(exec: Pick<TurnExec, 'files' | 'livePrincipal'>, files: unknown): 'sub-agent' | 'disabled' | null {
  if (files !== exec.files) return 'sub-agent'
  try { exec.livePrincipal() } catch { return 'disabled' }
  return null
}

/** Several rooms or people match in a shared chat: the asker picks on a card only they see. The value picked, 'no',
 * or null (no answer in time). */
export async function askerPicks(exec: Pick<TurnExec, 'waitForPerson' | 'rt'>, question: string, options: { label: string; value: string }[]): Promise<string | null> {
  const v0 = await exec.waitForPerson({
    kind: 'ask_user', origin: 'server', requestId: uuidv7(), question, options, multiple: false, allowText: false,
    expiresAt: new Date(Date.now() + exec.rt.askUserTimeoutMs()).toISOString(),
  } as TurnRequest, { timeoutMs: exec.rt.askUserTimeoutMs() })
  const v = Array.isArray(v0) && v0.length === 1 ? v0[0] : v0
  return typeof v === 'string' ? v : null
}

/** a text as compared: NFKC, lower case, one space */
export const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const HANGUL = /\p{Script=Hangul}/u
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `n` is in `said`: Hangul as a part (particles follow a name: "대현에게"), any other script as whole words only
 * ("jo" is not in "join", "design" not in "redesign"): no letter or digit right before or after it, but a Hangul one
 * (a particle after a Latin name: "Bob에게") */
const WORD_EDGE = '(?!\\p{Script=Hangul})[\\p{L}\\p{N}]'
const holds = (said: string, n: string) => HANGUL.test(n) ? said.includes(n) : new RegExp(`(?<!${WORD_EDGE})${escapeRe(n)}(?!${WORD_EDGE})`, 'u').test(said)

/** Does `said` (the asker's own message) name the recipient? A matched name or username in it, or the words the AI gave
 * (`ref`, 님/씨 dropped) when they are in it and are that name in full or one word of it, or, for a person's Hangul
 * name only, its end (a given name: "대현" for "남대현"); two letters at least (holds: whole words outside Hangul). A
 * room or group name matches only in full or by a whole word. Fails closed. */
export function namesRecipient(said: string, ref: string | undefined, r0: { names: readonly string[]; person: boolean }): boolean {
  const text = fold(said)
  if (!text) return false
  const ns = r0.names.map(fold).filter((n) => n.length >= 2)
  if (ns.some((n) => holds(text, n))) return true
  // (the Korean honorifics nim and ssi after a name, as escapes: no Korean text outside the language tables)
  const r = fold((ref ?? '').replace(/\s*(\uB2D8|\uC528)$/u, ''))
  if (r.length < 2 || r.startsWith(PERSON_REF) || !holds(text, r)) return false
  return ns.some((n) => n === r || n.split(' ').includes(r) || (r0.person && HANGUL.test(r) && HANGUL.test(n) && n.endsWith(r)))
}

/** The turn's own question (`messageId`): its text. */
export const askerText = (db: Database, messageId: string): string => (db.query('SELECT content FROM messages WHERE id = ?').get(messageId) as { content: string | null } | null)?.content ?? ''

/** namesRecipient on the turn's own question (`messageId`). */
export function namedByAsker(db: Database, messageId: string, ref: string | undefined, r0: { names: readonly string[]; person: boolean }): boolean {
  return namesRecipient(askerText(db, messageId), ref, r0)
}

/** Does the asker's own message name this file: its name (3 characters at least; whole words outside Hangul, as
 * names are matched) or its path? Fails closed. */
export function namesFile(said: string, rel: string): boolean {
  const text = fold(said)
  if (!text) return false
  const name = fold(rel.split('/').pop() ?? '')
  const stem = name.replace(/\.[^.]+$/, '')
  return [fold(rel), name, stem].some((n) => n.length >= 3 && holds(text, n))
}

/** The team files the asker attached to their own message of this turn. */
export function attachedPaths(db: Database, messageId: string): Set<string> {
  const row = db.query('SELECT attachments FROM messages WHERE id = ?').get(messageId) as { attachments: string | null } | null
  const out = new Set<string>()
  try { for (const a of JSON.parse(row?.attachments ?? '[]') as { path?: unknown }[]) if (typeof a?.path === 'string') out.add(a.path) } catch {}
  return out
}

/** The AI made or changed the file at `rel` in this turn (its own write, upload or move there). */
export function madeInTurn(db: Database, turnId: string, rel: string): boolean {
  return !!db.query("SELECT 1 FROM file_events WHERE turn_id = ? AND path = ? AND action IN ('create','update','upload') LIMIT 1").get(turnId, rel)
}

// ---- "no card after an explicit ask" (docs/decisions/20261116-no-card-after-explicit-ask.md, QA TC-3812) ----
// Deterministic, from the asker's own message of this turn (never another member's, never a quoted room message): the
// request form of the action's verb and its target in the person's words, and no "don't". When unsure, the card stays.
// Korean and Japanese words as escapes (no Korean text outside the language tables).
const re = (parts: string[]) => new RegExp(parts.join('|'), 'iu')
// Korean request endings after a verb stem's last syllable: 줘, 주세요, 주시겠어요, 달라 (해줘, 해 주세요 …)
const ASK_END = '\\s?(\\uC918|\\uC8FC\\uC138\\uC694|\\uC8FC\\uC2DC\\uACA0|\\uC8FC\\uC2ED\\uC2DC\\uC624|\\uB2EC\\uB77C)'
/** share a file with someone, as a request: 공유해줘 / 공유해 주세요, share … with, bagikan, 共有して */
export const SHARE_ASK = re([`\\uACF5\\uC720\\s?\\uD574${ASK_END}`, `\\uACF5\\uC720\\s?\\uD574\\s?\\uB46C`, '\\bshare\\b[^\\n]{0,80}\\bwith\\b', '\\bbagikan\\b', '\\u5171\\u6709\\u3057\\u3066'])
/** post or send to a room or a person, as a request: 올려줘, 보내줘, 전달해줘, 공유해줘, post, send … to, kirim */
export const POST_ASK = re([`\\uC62C\\uB824${ASK_END}`, `\\uBCF4\\uB0B4${ASK_END}`, `\\uC804\\uB2EC\\s?\\uD574${ASK_END}`, `\\uACF5\\uC720\\s?\\uD574${ASK_END}`, '\\bpost (it|this|that|them|to)\\b', '\\bsend\\b[^\\n]{0,80}\\bto\\b', '\\bkirim(kan)?\\b', '\\bpublicar\\b'])
/** change something at a connected service, as a request: 바꿔줘, 고쳐줘, 수정해줘, 추가해줘, 넣어줘, 만들어줘, 작성해줘,
 * 업데이트해줘, 변경해줘, 등록해줘, 옮겨줘, 달아줘, update, change, add, create, make, set, move, write, edit, fix, comment */
export const WRITE_ASK = re([`(\\uBC14\\uAFD4|\\uACE0\\uCCD0|\\uB123\\uC5B4|\\uB9CC\\uB4E4\\uC5B4|\\uC62E\\uACA8|\\uB2EC\\uC544)${ASK_END}`,
  `(\\uC218\\uC815|\\uCD94\\uAC00|\\uC791\\uC131|\\uC5C5\\uB370\\uC774\\uD2B8|\\uBCC0\\uACBD|\\uB4F1\\uB85D)\\s?\\uD574${ASK_END}`,
  '\\b(update|change|add|create|make|set|move|write|edit|fix|comment|ubah|tambah|buat)\\b'])
/** "don't" in the person's words: -지 마 / -지 말 / 하지 않, 안 해, don't, do not, never, jangan, no … */
const ASK_NOT = re(['\\uC9C0\\s?\\uB9C8', '\\uC9C0\\s?\\uB9D0', '\\uC9C0\\s?\\uC54A', "\\b(don'?t|do not|never|jangan)\\b"])

/** The asker's own words of this turn without quoted lines (a quote is someone else's words). */
export function ownWords(said: string): string {
  return said.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n')
}

/** The person's words ask for this kind of action: its request form and no "don't". */
export const asksFor = (verbs: RegExp, said: string): boolean => verbs.test(said) && !ASK_NOT.test(said)

/** namesFile, and for a name with Hangul also with its separators left out ("거래처 목록" names 거래처-목록.csv). */
export function namesFileLoose(said: string, rel: string): boolean {
  if (namesFile(said, rel)) return true
  const squash = (x: string) => fold(x).replace(/[\s_.\-]+/g, '')
  const stem = squash((rel.split('/').pop() ?? '').replace(/\.[^.]+$/, ''))
  return HANGUL.test(stem) && stem.length >= 3 && squash(said).includes(stem)
}

/** A person or place named in full in the person's words (a full name, a username, a room's name; two letters at
 * least, whole words outside Hangul): never by a part ("하나" in "파일 하나" is not 최하나). */
export function namedInFull(said: string, names: readonly string[]): boolean {
  const text = fold(said)
  return names.map(fold).some((n) => n.length >= 2 && holds(text, n))
}

/** Keys whose value says who or where else sees what is sent: the asker must have written that value themselves. */
const AUDIENCE_KEY = /(^|_)(to|cc|bcc)$|recipient|conversation|chat|channel|email|user|member|assignee|owner|invite|attendee|share|visib|public|folder|parent|team|workspace|org|url|link|webhook|endpoint|address|domain|host/i
/** Keys of a place inside the service (a row, page, issue, cell): an identifier the AI found there may be used */
const PLACE_KEY = /(^|_)(id|ids|key|ref|uuid|range|sheet|row|rows?_?index|column|col|cell|index|number|page|database|issue|document|spreadsheet|presentation)$/i
/** an identifier: letters, digits and . _ - ! # (no ":" or "/": never an address) */
const ID_LIKE = /^[\w.!#-]{1,80}$/
/** a service tool that adds or changes content (the card stays for anything else: send, publish, merge, share, delete…) */
const WRITE_TOOL = /^(?:[a-z0-9]+[_-])*(update|create|add|append|insert|set|edit|replace|write|comment|rename|patch|upsert|change)(?:[_-][a-z0-9]+)*$/i
const OTHER_TOOL = /send|publish|merge|share|invite|permission|transfer|delete|remove|archive|trash|destroy|purge|erase|revoke|cancel|close|clear|reset|move|grant|post|email|mail|message|notify/i
export const explicitWriteTool = (name: string): boolean => WRITE_TOOL.test(name) && !OTHER_TOOL.test(name)

/**
 * Does everything this connector call writes come from the asker's own message of this turn? Every text is in their
 * words (two characters at least, whole words outside Hangul; a number also by its digits: "1,580,000원" holds
 * 1580000), a place identifier (a row, page or cell id, a small number under a place key) may come from the service,
 * and a recipient-like value must be theirs. Nothing empty or null (that clears a field). At least one written value
 * must come from their words (an id-only call keeps its card). Fails closed: anything else, more than 40 values.
 */
export function writtenByAsker(args: unknown, said: string): boolean {
  const text = fold(ownWords(said))
  const digits = text.replace(/[,\s]/g, '')
  if (!text) return false
  let n = 0, theirs = 0
  const leaf = (key: string, v: unknown, under: boolean): boolean => {
    if (++n > 40) return false
    // a value inside a recipient-like key (parent: { page_id }, folder: { id }) says where it goes too
    const audience = under || AUDIENCE_KEY.test(key)
    const place = !audience && PLACE_KEY.test(key)
    if (typeof v === 'boolean') return place
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false
      if (String(Math.abs(v)).length >= 2 && digits.includes(String(Math.abs(v)))) { theirs++; return true }
      return place && Number.isInteger(v) && Math.abs(v) < 1000
    }
    if (typeof v !== 'string') return false
    const t = fold(v)
    if (!t) return false
    if (t.length >= 2 && holds(text, t)) { theirs++; return true }
    const d = t.replace(/[^\d]/g, '')
    if (/^[\d.,\s\uC6D0₩$-]+$/.test(t) && d.length >= 3 && digits.includes(d)) { theirs++; return true }
    return place && ID_LIKE.test(v)
  }
  const walk = (key: string, v: unknown, depth: number, under: boolean): boolean => {
    if (depth > 4) return false
    const below = under || (key !== '' && AUDIENCE_KEY.test(key))
    if (Array.isArray(v)) return v.length > 0 && v.every((x) => walk(key, x, depth + 1, under))
    if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).every(([k, x]) => walk(k, x, depth + 1, below))
    return v === undefined ? true : leaf(key, v, under)
  }
  return walk('', args, 0, false) && theirs > 0
}
