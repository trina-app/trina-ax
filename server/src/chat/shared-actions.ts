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

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
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
