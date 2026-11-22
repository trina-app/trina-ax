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
import { sha256Regular } from '../files/store'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared'
import type { TurnRequest } from '@mycel/shared/api'
import { PERSON_REF } from '../rooms/reader'
import { confidentialChat } from '../safe-ops/confidential'
import { alwaysHere } from './always-allow'
import { readRooms, withoutQuoteLines } from './read-rooms'
import type { TurnExec } from './turn'

/** Why an action that reaches others is not offered in this turn, or null: it is. `scheduleKind`: the Always allow
 * kind that lets a scheduled run do it without a card (post_to_room, share_files, share_folder), or null when a scheduled
 * run never may. */
export type ActionOff = 'schedule' | 'confidential' | 'slack' | 'restricted'
type ScheduleKind = 'post_to_room' | 'post_files' | 'share_files' | 'share_folder'
export function actionOff(exec: Pick<TurnExec, 'restricted' | 'templateRun' | 'spec' | 'rt'> & Partial<Pick<TurnExec, 'alwaysPlace'>>, scheduleKind: ScheduleKind | readonly ScheduleKind[] | null): ActionOff | null {
  const kinds = scheduleKind === null ? [] : typeof scheduleKind === 'string' ? [scheduleKind] : scheduleKind
  if (exec.spec.clientKind === 'schedule' && !kinds.some((k) => alwaysHere(exec.alwaysPlace?.(), k) === 'on')) return 'schedule'
  if (confidentialChat(exec.rt.db, exec.spec.chatId)) return 'confidential'
  if (exec.spec.clientKind === 'slack') return 'slack'
  if (exec.restricted || exec.templateRun) return 'restricted'
  return null
}

/** A guest (someone outside the team) is among the people of this shared chat (TurnExec.guestAmong): the one place
 * the old per-call guards of a share or post still apply under "Always allow" (docs/decisions/
 * 20261122-always-allow-holds-everywhere.md, the guest limit of 20261122-connector-always-allow.md). Fails closed. */
export function guestInShared(exec: Partial<Pick<TurnExec, 'shared' | 'guestAmong'>>): boolean {
  if (!exec.shared) return false
  try { return typeof exec.guestAmong === 'function' ? exec.guestAmong() : false } catch { return true }
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

/** Korean particles and honorifics that may follow a name (에게, 한테, 께, 님, 씨, 이랑, 와/과, 도, 의, 에, 이/가, 은/는,
 * 을/를, 으로/로, 에서, 방, 팀, 그룹, 부서, 본부, 만, 하고, 더러), as escapes */
const NAME_TAIL = '(\\uC774\\uC5D0\\uAC8C|\\uC774\\uD558\\uACE0|\\uC774\\uD55C\\uD14C|\\uC73C\\uB85C|\\uC774\\uB791|\\uD55C\\uD14C|\\uC5D0\\uC11C|\\uB2D8\\uAED8|\\uC5D0\\uAC8C|\\uC774\\uB3C4|\\uC774\\uC758|\\uD558\\uACE0|\\uC528\\uAED8|\\uB354\\uB7EC|\\uC774\\uB294|\\uC774\\uB97C|\\uBD80\\uC11C|\\uADF8\\uB8F9|\\uBCF8\\uBD80|\\uC774\\uAC00|\\uAED8|\\uC5D0|\\uB294|\\uB3C4|\\uB9CC|\\uB85C|\\uBC29|\\uC640|\\uC528|\\uB791|\\uB2D8|\\uAC00|\\uB97C|\\uACFC|\\uC774|\\uC740|\\uC758|\\uD300|\\uC744)'
/** A person's, group's or room's name in `said` (folded): whole words outside Hangul (holds); a Hangul name with no
 * letter right before it, and after it nothing, a non-letter, a Latin letter or a particle ("김대리한테", never the
 * "해줘" of "공유해줘"). Never a name inside the ask's own words (nameText). */
const holdsName = (said: string, n: string) => !HANGUL.test(n) ? holds(said, n)
  : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?=$|[^\\p{L}\\p{N}]|[a-z0-9]|${NAME_TAIL})`, 'u').test(said)
/** Short words a name that is one of them never counts as (a person may call themselves anything) */
const NOT_A_NAME = new Set(['with', 'to', 'and', 'the', 'this', 'that', 'it', 'me', 'my', 'our', 'for', 'of', 'file', 'files', 'share', 'send', 'post', 'please', 'dengan', 'ke', 'ini', 'itu'])
/** ...nor, for a person, a title, a pronoun or a group word */
const NOT_A_PERSON_NAME = new Set([
  // titles, pronouns and group words people use for whoever holds them ("대표님께", "share with the team")
  'everyone', 'everybody', 'all', 'them', 'us', 'you', 'him', 'her', 'team', 'the team', 'group', 'boss', 'manager', 'admin', 'owner', 'ceo', 'cto', 'cfo', 'hr', 'semua', 'tim', 'bos',
  // (대표, 사장, 부장, 과장, 차장, 대리, 팀장, 실장, 이사, 상무, 전무, 본부장, 주임, 사원, 선배, 후배, 매니저, 선생님, 고객, 모두, 다들, 전체, 우리, 저, 나, 팀, 그룹)
  '\uB300\uD45C', '\uB300\uD45C\uB2D8', '\uC0AC\uC7A5', '\uBD80\uC7A5', '\uACFC\uC7A5', '\uCC28\uC7A5', '\uB300\uB9AC', '\uD300\uC7A5', '\uC2E4\uC7A5', '\uC774\uC0AC', '\uC0C1\uBB34', '\uC804\uBB34', '\uBCF8\uBD80\uC7A5', '\uC8FC\uC784', '\uC0AC\uC6D0', '\uC120\uBC30', '\uD6C4\uBC30', '\uB9E4\uB2C8\uC800', '\uC120\uC0DD\uB2D8', '\uACE0\uAC1D', '\uBAA8\uB450', '\uB2E4\uB4E4', '\uC804\uCCB4', '\uC6B0\uB9AC', '\uC800', '\uB098', '\uD300', '\uADF8\uB8F9'])
/** ...nor a Hangul name that is a title with 님 (대표님) */
const TITLE_NIM = /\uB2D8$/u
/** The asker's words for matching names: folded, with the ask's own words taken out ("share … with", 공유해줘, 보내줘,
 * "send … to": a name inside them is the verb, not a recipient) */
function nameText(said: string): string {
  let t = fold(said.slice(0, NAME_SCAN))
  for (const r of [SHARE_ASK, POST_ASK]) t = t.replace(new RegExp(r.source.replace(/\{0,80\}/g, '{0,80}?'), 'giu'), ' ')
  return t
}
/** How much of the person's message the name checks read (a request is short; a name past it shows the card) */
const NAME_SCAN = 4000
const nameOk = (n: string) => n.length >= 2 && !NOT_A_NAME.has(n)
/** A person's name: nameOk, and not a department, an outside party or a phrase about someone ("legal", "my boss",
 * 인사팀, 거래처): a member may call themselves that, and the person's words mean the department, not them. */
const NOT_A_PERSON = new Set(['qa', 'pm', 'po', 'dev', 'devs', 'intern', 'interns', 'assistant', 'director', 'lawyer', 'accountant', 'designer', 'developer', 'engineer', 'reviewer', 'review', 'approver', 'editor',
  // (책임, 수석, 선임, 프로, 파트장, 그룹장, 센터장, 소장, 원장, 회장, 부사장, 고문, 인턴, 비서, 연구원, 팀원, 직원, 변호사, 세무사, 회계사, 노무사, 교수, 기자, 작가, 디자이너, 개발자)
  '\uCC45\uC784', '\uC218\uC11D', '\uC120\uC784', '\uD504\uB85C', '\uD30C\uD2B8\uC7A5', '\uADF8\uB8F9\uC7A5', '\uC13C\uD130\uC7A5', '\uC18C\uC7A5', '\uC6D0\uC7A5', '\uD68C\uC7A5', '\uBD80\uC0AC\uC7A5', '\uACE0\uBB38', '\uC778\uD134', '\uBE44\uC11C', '\uC5F0\uAD6C\uC6D0', '\uD300\uC6D0', '\uC9C1\uC6D0', '\uBCC0\uD638\uC0AC', '\uC138\uBB34\uC0AC', '\uD68C\uACC4\uC0AC', '\uB178\uBB34\uC0AC', '\uAD50\uC218', '\uAE30\uC790', '\uC791\uAC00', '\uB514\uC790\uC774\uB108', '\uAC1C\uBC1C\uC790',
  'legal', 'finance', 'accounting', 'sales', 'marketing', 'support', 'client', 'clients', 'customer', 'customers', 'vendor', 'partner', 'partners', 'investor', 'investors', 'it', 'ops', 'design', 'engineering', 'product', 'payroll', 'reception', 'security', 'management', 'board', 'staff', 'keuangan', 'klien',
  // (거래처, 고객, 고객사, 회계, 인사, 총무, 법무, 재무, 영업, 마케팅, 개발, 디자인, 관리자, 담당자)
  '\uAC70\uB798\uCC98', '\uACE0\uAC1D', '\uACE0\uAC1D\uC0AC', '\uD68C\uACC4', '\uC778\uC0AC', '\uCD1D\uBB34', '\uBC95\uBB34', '\uC7AC\uBB34', '\uC601\uC5C5', '\uB9C8\uCF00\uD305', '\uAC1C\uBC1C', '\uB514\uC790\uC778', '\uAD00\uB9AC\uC790', '\uB2F4\uB2F9\uC790'])
const personOk = (n: string) => nameOk(n) && !NOT_A_PERSON_NAME.has(n) && !NOT_A_PERSON_NAME.has(n.replace(TITLE_NIM, '')) && !NOT_A_PERSON_NAME.has(n.replace(/^the /, '')) && !NOT_A_PERSON.has(n.replace(/^(the|my|our) /, '')) && !/^(my|our|your|his|her|their|the|this|these|those|that|a|an|some|any|every|other|another) /.test(n)
  // (not a phrase that points at a thing: 이 파일, 그 보고서, 이거, 그거, 저거, 이것, 그것)
  && !/^(\uC774|\uADF8|\uC800) /u.test(n) && !/^(\uC774|\uADF8|\uC800)(\uAC70|\uAC83)/u.test(n)
  && !/ (team|group|department|dept|division|office)$/.test(n) && !/(\uBD80\uC11C|\uADF8\uB8F9|\uBCF8\uBD80|\uD300)$/u.test(n)
/** Where a recipient's name stands in the person's words (folded), so that a word someone took as their name (파일,
 * report, 보고서) is not one in an ordinary request: right after to, with, cc, @ or "(" (in, into, on, @, # or "(" for a
 * place), or before a Korean particle that says who gets it (한테, 에게, 께, 더러, after 님/씨; "(가) 볼 수 / 보게") or
 * where it goes (에, 에다, 방에 … for a place). A name joined by and, a comma, 와/과, (이)랑 or 하고 counts only in a
 * chain of other recipients of the same call that ends at such a word ("to tess and bob", "김대리와 이과장한테"). */
const BEFORE_PERSON = '(?:(?:^|[^\\p{L}\\p{N}])(?:to|with|cc|ke|dengan|kepada)\\s+@?|[(@]\\s*)'
/** ...but not a "to"/"with" right after a recipient already named ("with tess to review", "to tess with comments": a
 * purpose or a manner, not a second person): one to three words after an earlier to/with/cc, none of them a verb that
 * starts a new ask ("I want to share it with bob" keeps bob) */
const AFTER_ONE_NAMED = '(?<!(?:^|[^\\p{L}\\p{N}])(?:to|with|cc)\\s+@?(?:(?!(?:share|send|post|forward|give|show|pass|email|mail|bagikan|kirim)\\b)[\\p{L}\\p{N}._\'-]+\\s+){0,2}(?!(?:share|send|post|forward|give|show|pass|email|mail|bagikan|kirim)\\b)[\\p{L}\\p{N}._\'-]+)'
const BEFORE_PLACE = '(?:(?:^|[^\\p{L}\\p{N}])(?:to|in|into|on|ke|di)\\s+(?:the\\s+)?[@#]?|[(@#]\\s*)'
const HONORIFIC = '(?:\\s?(?:\\uB2D8|\\uC528))?'
const AFTER_PERSON = `${HONORIFIC}(?:\\uC774\\uC5D0\\uAC8C|\\uC774\\uD55C\\uD14C|\\uB354\\uB7EC|\\uC5D0\\uAC8C|\\uD55C\\uD14C|\\uAED8|(?:\\uC774|\\uAC00)\\s?(?:\\uBCFC\\s?\\uC218(?!\\s?\\uC5C6)|\\uBCF4\\uAC8C|\\uBCF4\\uB3C4\\uB85D))`
/** "(가) 볼 수 / 보게" names a person only with 이/가 or 님/씨 on the name ("바로 볼 수 있게" is an adverb) */
const SEES_AFTER_HONORIFIC = '\\s?(?:\\uB2D8|\\uC528)(?:\\uC774|\\uAC00)?\\s?(?:\\uBCFC\\s?\\uC218(?!\\s?\\uC5C6)|\\uBCF4\\uAC8C|\\uBCF4\\uB3C4\\uB85D)'
const JOIN_KO = '(?:\\uC774\\uD558\\uACE0|\\uC774\\uB791|\\uD558\\uACE0|\\uB791|\\uC640|\\uACFC)'
/** "(님)이랑/랑/와/과/하고 공유해줘" right after a name: share WITH that person ("민호 님이랑 공유해줘", AI scenario
 * FSH-01, 2026-11-17). Only with the request itself next to it (공유해 + 줘, 주세요, 주시겠어요, 주십시오, 달라): "민호 님과
 * 회의한 내용", "민호랑 공유했던 견적서", "민호랑 공유하면 안 되니까", and a request word that goes on as something else
 * ("공유해줘서 고마워요", "공유해줘야 하나요", "공유해줘도 되나", "공유해 달라고 했던") name nobody to share with */
const JOIN_SHARE_KO = `${HONORIFIC}${JOIN_KO}\\s?\\uACF5\\uC720\\s?\\uD574\\s?(?:\\uC918|\\uC8FC\\uC138\\uC694|\\uC8FC\\uC2DC\\uACA0|\\uC8FC\\uC2ED\\uC2DC\\uC624|\\uB2EC\\uB77C)(?!\\s?(?:\\uC11C|\\uC57C|\\uB3C4|\\uACE0|\\uB77C|\\uC694\\s?\\?))`
const AFTER_PLACE = '(?:\\uC5D0\\uB2E4\\uAC00|\\uBC29\\uC73C\\uB85C|\\uCC44\\uB110\\uC5D0|\\uC5D0\\uB2E4|\\uD55C\\uD14C|\\uBC29\\uC5D0|\\uC5D0\\uAC8C|\\uC5D0|\\uAED8)'
function holdsAsRecipient(text: string, n: string, place: boolean, peers: readonly string[] = []): boolean {
  if (!holdsName(text, n)) return false
  const e = escapeRe(n)
  const L = '(?<![\\p{L}\\p{N}])'
  const R = '(?:(?![\\p{L}\\p{N}])|(?=\\p{Script=Hangul}))'
  if (new RegExp(`${place ? BEFORE_PLACE : AFTER_ONE_NAMED + BEFORE_PERSON}${e}${R}`, 'u').test(text)) return true
  if (new RegExp(`${L}${e}(?:${place ? AFTER_PLACE : `${AFTER_PERSON}|${SEES_AFTER_HONORIFIC}|${JOIN_SHARE_KO}`})`, 'u').test(text)) return true
  const ps = [...new Set(peers.map(fold))].filter((p) => p.length >= 2 && p !== n).slice(0, 10).map(escapeRe)
  if (place || !ps.length) return false
  const P = `(?:${ps.join('|')})`
  // in a chain: "to tess, bob and n" with nothing after n but the end of the phrase (never "… and the notes with bob");
  // "n님과 P한테" with 님 or 씨 on n (a Korean list joined by 와/과 is as often one of things: 보고서와 견적서)
  if (new RegExp(`${BEFORE_PERSON}(?:${P}\\s*(?:,|&|and)\\s*(?:and\\s+)?){1,4}${e}(?=\\s*(?:$|[.!?;:)\\n,&]|and\\b|please\\b|too\\b))`, 'u').test(text)) return true
  return new RegExp(`${L}${e}\\s?(?:\\uB2D8|\\uC528)(?:${JOIN_KO}\\s?${P}${HONORIFIC}){1,4}${AFTER_PERSON}`, 'u').test(text)
}

/** Does `said` (the asker's own message) name the recipient? A matched name or username in it, or the words the AI gave
 * (`ref`, 님/씨 dropped) when they are in it and are that name in full or one word of it, or, for a person's Hangul
 * name only, its end (a given name: "대현" for "남대현"); two letters at least (holds: whole words outside Hangul). A
 * room or group name matches only in full or by a whole word. Fails closed. */
export function namesRecipient(said: string, ref: string | undefined, r0: { names: readonly string[]; person: boolean; peers?: readonly string[] }): boolean {
  const text = fold(said.slice(0, NAME_SCAN))
  if (!text) return false
  const place = !r0.person
  const ok = place ? nameOk : personOk
  const ns = r0.names.map(fold).filter(ok)
  if (ns.some((n) => holdsAsRecipient(text, n, place, r0.peers))) return true
  // (the Korean honorifics nim and ssi after a name, as escapes: no Korean text outside the language tables)
  const r = fold((ref ?? '').replace(/\s*(\uB2D8|\uC528)$/u, ''))
  if (!ok(r) || r.startsWith(PERSON_REF) || !holdsAsRecipient(text, r, place, r0.peers)) return false
  return ns.some((n) => n === r || n.split(' ').includes(r) || (r0.person && HANGUL.test(r) && HANGUL.test(n) && n.endsWith(r)))
}

/** A group named in `said` as a group: its full name with a group word next to it (영업팀, 영업 그룹, "Sales team",
 * "tim Sales", @Sales), or a name that is itself one ("Sales Team", 영업본부). A group name is often an ordinary word
 * ("sales", 영업): "the sales report" does not name the group. Fails closed. */
const GROUP_WORD = '(team|group|department|dept|tim|grup|\\uD300|\\uADF8\\uB8F9|\\uBD80\\uC11C|\\uBCF8\\uBD80)'
export function namesGroup(said: string, name: string): boolean {
  const text = nameText(said)
  const n = fold(name)
  if (!nameOk(n) || !holdsName(text, n)) return false
  if (new RegExp(`(^|\\s)${GROUP_WORD}$`, 'iu').test(n) || new RegExp(`\\p{Script=Hangul}${GROUP_WORD}$`, 'u').test(n)) return true
  const e = escapeRe(n)
  // (not a team's member or lead: 팀원, 팀장; not a longer Latin word: "timeline")
  const L = '(?<![\\p{L}\\p{N}])'
  const R = HANGUL.test(n) ? '' : '(?![\\p{L}\\p{N}])'
  return new RegExp(`@${e}${R}|${L}${e}\\s?${GROUP_WORD}(?![a-z0-9\\uC7A5\\uC6D0])|\\b(grup|tim)\\s${e}${R}`, 'iu').test(text)
}

/** A person's names that point at them alone: their username, and their display name only when no other member of
 * the team has the same one or one that holds it (a member may take a colleague's name; then only the username counts). */
export function soleNames(db: Database, userId: string): string[] {
  const u = db.query('SELECT name, username FROM users WHERE id = ?').get(userId) as { name: string; username: string } | null
  if (!u) return []
  // (compared on letters and digits only, without 님/씨 at the end: "Tess Yoon." is "Tess Yoon"; a name inside another's
  // counts as the same: "Hana" in "Hana Kimura", 민수 in 김민수)
  const bare = (x: string | null) => fold((x ?? '').replace(/\s*(\uB2D8|\uC528)\s*$/u, '')).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s*(\uB2D8|\uC528)$/u, '')
  const others = [...(db.query('SELECT name, username FROM users WHERE id <> ?').all(userId) as { name: string | null; username: string | null }[])
    .flatMap((o) => [bare(o.name), bare(o.username)]),
  // (a group's or a room's name is not a person's either: "share it with Finance" means the group)
  ...(db.query('SELECT name FROM groups').all() as { name: string | null }[]).map((g) => bare(g.name)),
  ...(db.query("SELECT name FROM rooms WHERE name IS NOT NULL AND kind <> 'dm'").all() as { name: string | null }[]).map((r) => bare(r.name))].filter(Boolean)
  const inside = (n: string, o: string) => o === n || (HANGUL.test(n) ? o.startsWith(n) || o.endsWith(n) : o.startsWith(n + ' ') || o.endsWith(' ' + n) || o.includes(' ' + n + ' '))
  // the display name and the username each count only when no other member's name or username, group or room name is,
  // or holds, the same
  const theirs = (x: string | null) => { const n = bare(x); return n.length >= 2 && !others.some((o) => inside(n, o)) }
  return [...(theirs(u.name) ? [u.name] : []), ...(theirs(u.username) ? [u.username] : [])]
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

/** The asker's words name this file only without the date or number at its end ("단가표" for 단가표-2026.xlsx;
 * coreName), with no other date or number right after it. Weaker than namesFile: several files can share one such
 * name, so it never skips a card (share_with_person shows its card whatever "Always allow" says) and the explicit-ask
 * skip and who_can_open do not use it. */
export function namesFileCore(said: string, rel: string): boolean {
  const text = fold(said)
  const raw = (rel.split('/').pop() ?? '').replace(/\.[^.]+$/, '')
  const stem = fold(raw), core = coreName(stem)
  if (text && core !== stem && core.length >= 3 && holdsCore(text, core)) return true
  // (a Hangul name also without its separators: "견적서 라마바카페" for 견적서-라마바카페-2026-11.pdf)
  const squash = (x: string) => fold(x).replace(/[\s_.\-]+/g, '')
  const sq = squash(coreName(raw))
  return sq !== squash(raw) && HANGUL.test(sq) && sq.length >= 3 && new RegExp(`${escapeRe(sq)}(?!v?\\d)`, 'u').test(squash(said))
}

/** The name without its date or number (coreName) in the person's words, with no other date or number right after it
 * ("ledger-3" never names ledger-4.txt) and, outside Hangul, as a whole word. */
const holdsCore = (said: string, core: string): boolean =>
  new RegExp(`${HANGUL.test(core) ? '' : `(?<!${WORD_EDGE})`}${escapeRe(core)}(?![\\s_\\-.]*v?\\d)${HANGUL.test(core) ? '' : `(?!${WORD_EDGE})`}`, 'iu').test(said)

/** A file's name without the date, number or version at its end: "단가표" for 단가표-2026, "report" for report_v2,
 * "견적서-라마바카페" for 견적서-라마바카페-2026-11 (people call a file by what it is: AI scenario SHR-01, 2026-11-17).
 * The name itself when nothing is cut. */
export const coreName = (stem: string): string => stem.replace(/(?:[\s_\-.]+v?\d[\d\s_\-.]*)+$/i, '').trim()

/** Quotation marks a person puts around a name: straight, curly, corner brackets, guillemets, backticks. */
const QUOTES: readonly [string, string][] = [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’'], ['「', '」'], ['『', '』'], ['«', '»'], ['`', '`']]
/** a place in words as compared: "My files › Projects › Work", also written with ">" or "/" between the parts */
const placeKey = (s: string) => fold(s).replace(/\s*[›>/]\s*/g, ' › ')

/**
 * Does the asker's own message name this FOLDER (share_folder; security review M9)? `namesFile` is not used for
 * folders: "Work" or "Reports" are in ordinary sentences, and names under 3 characters never match there. A folder is
 * named only by:
 * - its path (the team path, with or without a slash at the end), or its place in words as the app says it
 *   (`place`: "My files › Projects › Work", from chat/place-words.ts);
 * - its name inside quotation marks or backticks ("Work", “Work”, 'Work', 「Work」, `Work`), any length;
 * - the app's own mention of it: attached to the message (`attached`), or linked in it (/files/view?path=… or
 *   /files?path=…, the path the app put there).
 * `said`: the asker's own words of this turn (quoted lines already left out: ownWords). Fails closed.
 */
export function namesFolder(said: string, rel: string, o: { place?: string; attached?: ReadonlySet<string> } = {}): boolean {
  const path = rel.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!path || !said.trim()) return false
  if (o.attached?.has(path) || o.attached?.has(`${path}/`)) return true
  for (const m of said.matchAll(/\/files(?:\/view)?\?(?:[^\s)\]#]*&)?path=([^\s)\]&#]+)/g)) {
    let p = ''
    try { p = decodeURIComponent(m[1]!) } catch { continue }
    if (p.replace(/^\/+/, '').replace(/\/+$/, '') === path) return true
  }
  const text = fold(said)
  // a path of two parts or more ("Sales/Reports", "users/me/Work"), as a whole: nothing that continues a name or a path
  // right before it, no letter or digit right after. A one-part path is the bare name, which is not enough
  const p = fold(path)
  if (p.includes('/') && new RegExp(`(?<![\\p{L}\\p{N}/])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'u').test(text)) return true
  if (o.place) {
    const pl = placeKey(o.place)
    // (the place must hold more than the name: a place of one part is the name alone)
    if (pl.includes(' › ') && placeKey(said).includes(pl)) return true
  }
  const name = fold(path.split('/').pop() ?? '')
  if (!name) return false
  // the name inside quotation marks (any of them, spaces inside allowed), or backticks
  return new RegExp(`["'“”‘’«»「」『』]\\s*${escapeRe(name)}\\s*["'“”‘’«»「」『』]`, 'u').test(text)
    || QUOTES.some(([a, b]) => text.includes(`${fold(a)}${name}${fold(b)}`))
}

/** The team files the asker attached to their own message of this turn. */
export function attachedPaths(db: Database, messageId: string): Set<string> {
  const row = db.query('SELECT attachments FROM messages WHERE id = ?').get(messageId) as { attachments: string | null } | null
  const out = new Set<string>()
  try { for (const a of JSON.parse(row?.attachments ?? '[]') as { path?: unknown }[]) if (typeof a?.path === 'string') out.add(a.path) } catch {}
  return out
}

/** file_events detail keys that say a file's content came from somewhere else than the AI's own writing: a copy, a
 * move, a conflict copy, a file built from other files, a page or a room (one list for every place that asks "did the
 * AI write this itself": madeInTurn here, chat/answer-share.ts madeHereOnly) */
export const MADE_FROM_ELSEWHERE = ['sourcePaths', 'conflictCopyOf', 'copiedFrom', 'movedFrom', 'via', 'url', 'from', 'originalPath', 'pieces', 'pages', 'files', 'copy'] as const
/** ...as SQL on a file_events row `alias`: an event of the AI's own writing: write or edit, or make_file from its own
 * text alone (detail.own, which make_file sets only when no file's bytes went into the output: no source, embedded
 * image or template), with none of those keys. Every other tool that places a file builds it from something else
 * (make_file with a source, stamp_pdf, edit_pdf, split_pdf, merge_pdfs, edit_hwp, comment_docx, save_url,
 * save_room_file, a video), and an event without the mark (an older build's, a publication's) is not counted: fails
 * closed. */
const ownWritingSql = (alias: string) => `${alias}.detail IS NOT NULL AND json_valid(${alias}.detail)
  AND (COALESCE(json_extract(${alias}.detail, '$.tool'), '') IN ('write', 'edit') OR (json_extract(${alias}.detail, '$.tool') = 'make_file' AND json_extract(${alias}.detail, '$.own') = 1))
  AND ${MADE_FROM_ELSEWHERE.map((k) => `json_extract(${alias}.detail, '$.${k}') IS NULL`).join(' AND ')}`
/** A file_events row `e` by which the AI wrote a new file itself. */
export const WROTE_IT_SQL = `e.action = 'create' AND ${ownWritingSql('e')}`

/** The AI made the file at `rel` in this turn: a new file it wrote itself there (WROTE_IT_SQL), with nothing at that
 * path before (no event, or the last one removed the file), and nothing but its own writing of this turn at that path
 * since (a tool that built the same output from another file, a copy over it, a person's save: not the AI's file any
 * more). Not a file moved, renamed or copied into place, not one a tool built from another file, a page or a room, and
 * not an edit of a file that existed before the turn: none of them makes an older file, or someone else's content,
 * one the asker brought. Fails closed. */
export function madeInTurn(db: Database, turnId: string, rel: string): boolean {
  try {
    const made = db.query(`SELECT e.id FROM file_events e WHERE e.turn_id = ? AND e.path = ? AND ${WROTE_IT_SQL} ORDER BY e.id LIMIT 1`).get(turnId, rel) as { id: number } | null
    if (!made) return false
    const prev = db.query("SELECT action FROM file_events WHERE path = ? AND id < ? AND action <> 'rejected' ORDER BY id DESC LIMIT 1").get(rel, made.id) as { action: string } | null
    if (prev && prev.action !== 'delete') return false
    if (db.query(`SELECT 1 FROM file_events p WHERE p.path = ?1 AND p.id > ?2 AND p.action <> 'rejected'
      AND NOT (p.turn_id IS NOT NULL AND p.turn_id = ?3 AND p.action IN ('create', 'update') AND ${ownWritingSql('p')}) LIMIT 1`).get(rel, made.id, turnId)) return false
    return !folderAboveChanged(db, rel, made.id)
  } catch { return false }
}

/** The tools whose save is the whole file, made in that answer from what it may already show (QA TC-f2-a04):
 * the AI's own text, a file it made, and its own chat or work folder file handed over. Never an edit (the older text
 * stays around it), a stamp or a page edit of an older file, a copy, a move or a restore. */
const WHOLE_SAVE_TOOLS = ['write', 'make_file', 'save_work_file', 'save_chat_file'] as const
const WHOLE_SAVE_NOT = ['movedFrom', 'copiedFrom', 'movedTo', 'conflictCopyOf', 'conflictOf', 'originalPath', 'copy', 'trashId'] as const
/**
 * This answer itself saved the whole file at `rel`, and nothing changed it since (QA TC-f2-a04: a save card and then a
 * copy card for the same file in one answer): the newest event at that path is this turn's create or update by one of
 * WHOLE_SAVE_TOOLS with none of WHOLE_SAVE_NOT, and no folder above it changed since. What it holds then came from
 * this answer, whose reads the person already answered for, so reading it back in the same answer is no new read of
 * the place (chat/turn.ts sharedSources). From file_events only; fails closed.
 */
export function wholeSavedInTurn(db: Database, teamRoot: string, turnId: string, rel: string): boolean {
  try {
    const last = db.query(`SELECT e.id, e.turn_id, e.action, e.detail, e.sha256 FROM file_events e WHERE e.path = ? AND e.action <> 'rejected' ORDER BY e.id DESC LIMIT 1`).get(rel) as { id: number; turn_id: string | null; action: string; detail: string | null; sha256: string | null } | null
    if (!last || last.turn_id !== turnId || !['create', 'update'].includes(last.action) || !last.detail) return false
    const d = JSON.parse(last.detail) as Record<string, unknown>
    if (!(WHOLE_SAVE_TOOLS as readonly string[]).includes(String(d.tool)) || WHOLE_SAVE_NOT.some((k) => d[k] !== undefined && d[k] !== null)) return false
    return !folderAboveChanged(db, rel, last.id) && sameBytesAsEvent(teamRoot, rel, last.sha256)
  } catch { return false }
}

/** The largest file sameBytesAsEvent hashes (a bigger one fails: the card asks). It runs synchronously inside a read
 * card's check, so it is kept small (review of batch 3, #381: 64 MB held the server): 8 MiB hashes in a few ms */
export const HASH_MAX = 8 * 1024 * 1024
/** The file at `rel` (a regular file, one link) still holds the bytes its last file event recorded (`sha256`): a change
 * made outside the app (a dev box run, a sync, a disk edit) logs no event, so the history alone cannot tell (as
 * chat-file-tool.ts chatFileCopyOf checks a copy). No hash recorded, or anything unreadable: false. */
export function sameBytesAsEvent(teamRoot: string, rel: string, sha256: string | null): boolean {
  try {
    if (!sha256) return false
    const abs = path.join(teamRoot, ...rel.split('/'))
    const st = fs.lstatSync(abs)
    if (!st.isFile() || st.nlink !== 1 || st.size > HASH_MAX) return false
    // in 4 MiB pieces from one descriptor (never the whole file in memory), up to the size checked above
    return sha256Regular(abs, st) === sha256
  } catch { return false }
}

/** A folder above `rel` moved, renamed, removed or made after the file_events row `sinceId`: what is at the path now may
 * be another file (a folder rename logs events at the folder's path only, never at the paths of the files inside). */
function folderAboveChanged(db: Database, rel: string, sinceId: number): boolean {
  const segs = rel.split('/')
  const above = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('/'))
  return !!above.length && !!db.query(`SELECT 1 FROM file_events WHERE id > ? AND action <> 'rejected' AND path IN (${above.map(() => '?').join(',')}) LIMIT 1`).get(sinceId, ...above)
}

/** The tools whose file_events count as this chat making or changing a file itself (madeInChat): the AI's own text
 * (write, edit, make_file) or a file it produced as asked from files it may read (make_file from a source, edit_hwp,
 * stamp_pdf): new bytes written at that path. Never a copy, move or rename (copy_files, move_files, rename_file, the
 * Files screen), a save from the web or a room (save_url, save_room_file), an upload, a restore or a conflict copy. */
const CHAT_MADE_TOOLS = ['write', 'edit', 'make_file', 'edit_hwp', 'stamp_pdf'] as const
/** detail keys that say a row put an older file, or another place's bytes as they were, at the path */
const RELOCATED = ['copiedFrom', 'movedFrom', 'movedTo', 'conflictCopyOf', 'conflictOf', 'originalPath', 'copy', 'via', 'url', 'trashId', 'folder'] as const
const chatWritingSql = (alias: string) => `${alias}.detail IS NOT NULL AND json_valid(${alias}.detail)
  AND COALESCE(json_extract(${alias}.detail, '$.tool'), '') IN (${CHAT_MADE_TOOLS.map((t) => `'${t}'`).join(', ')})
  AND ${RELOCATED.map((k) => `json_extract(${alias}.detail, '$.${k}') IS NULL`).join(' AND ')}`

/**
 * This chat made the file at `rel` (as the file layer names it), in any of the person's own answers of it, and nothing
 * else has touched it since (docs/decisions/20261117-own-folder-chat-made-no-card.md): the newest 'create' at that path
 * is a row of a turn of this chat by this person, written by one of CHAT_MADE_TOOLS with none of the RELOCATED keys; no
 * live file was at the path before it (no row, or the last one removed it); every row at the path since is an 'update'
 * by this chat's turns of this person through those tools (a person's save, an upload, a restore, a conflict, another
 * chat, a delete: not the chat's file any more); and no folder above it changed since. Like madeInTurn, from the
 * server's own file_events, never from what the AI says; fails closed.
 */
export function madeInChat(db: Database, chatId: string, userId: string, rel: string): boolean {
  try {
    const last = db.query("SELECT id FROM file_events WHERE path = ? AND action = 'create' ORDER BY id DESC LIMIT 1").get(rel) as { id: number } | null
    if (!last) return false
    const mine = `SELECT id FROM turns WHERE chat_id = ? AND user_id = ?`
    const made = db.query(`SELECT e.id FROM file_events e WHERE e.id = ? AND e.user_id = ? AND e.turn_id IN (${mine}) AND ${chatWritingSql('e')}`).get(last.id, userId, chatId, userId) as { id: number } | null
    if (!made) return false
    const prev = db.query("SELECT action FROM file_events WHERE path = ? AND id < ? AND action <> 'rejected' ORDER BY id DESC LIMIT 1").get(rel, made.id) as { action: string } | null
    if (prev && prev.action !== 'delete') return false
    if (db.query(`SELECT 1 FROM file_events p WHERE p.path = ? AND p.id > ? AND p.action <> 'rejected'
      AND NOT (p.action = 'update' AND p.user_id = ? AND p.turn_id IN (${mine}) AND ${chatWritingSql('p')}) LIMIT 1`).get(rel, made.id, userId, chatId, userId)) return false
    return !folderAboveChanged(db, rel, made.id)
  } catch { return false }
}

/**
 * This chat handed the file at `rel` over from its own work folder (save_work_file or copy_files of chat:work/…, detail
 * `from: 'work folder'`; chat/places-copy.ts), in one of the person's own answers of it, and nothing touched it since:
 * a video or a deck its box_shell commands made (QA TC-7261, the owner's 11-22 promo video). The Share dialog's "Share
 * with files" offers it like a file the chat wrote (chat/chat-files-share.ts madeFilesOf); madeInChat itself stays as
 * it is (no own-folder card change). From file_events only; fails closed.
 */
export function handedOverInChat(db: Database, chatId: string, userId: string, rel: string): boolean {
  try {
    const mine = `SELECT id FROM turns WHERE chat_id = ? AND user_id = ?`
    const last = db.query("SELECT id FROM file_events WHERE path = ? AND action = 'create' ORDER BY id DESC LIMIT 1").get(rel) as { id: number } | null
    if (!last) return false
    const made = db.query(`SELECT e.id FROM file_events e WHERE e.id = ? AND e.user_id = ? AND e.turn_id IN (${mine}) AND e.detail IS NOT NULL AND json_valid(e.detail)
      AND COALESCE(json_extract(e.detail, '$.tool'), '') IN ('save_work_file', 'copy_files') AND json_extract(e.detail, '$.from') = 'work folder'
      AND json_extract(e.detail, '$.conflictCopyOf') IS NULL`).get(last.id, userId, chatId, userId) as { id: number } | null
    if (!made) return false
    const prev = db.query("SELECT action FROM file_events WHERE path = ? AND id < ? AND action <> 'rejected' ORDER BY id DESC LIMIT 1").get(rel, made.id) as { action: string } | null
    if (prev && prev.action !== 'delete') return false
    // anything since but the chat's own writes (madeInChat's rule): not the chat's file any more
    if (db.query(`SELECT 1 FROM file_events p WHERE p.path = ? AND p.id > ? AND p.action <> 'rejected'
      AND NOT (p.action = 'update' AND p.user_id = ? AND p.turn_id IN (${mine}) AND ${chatWritingSql('p')}) LIMIT 1`).get(rel, made.id, userId, chatId, userId)) return false
    return !folderAboveChanged(db, rel, made.id)
  } catch { return false }
}

// ---- content written by others (docs/decisions/20261116-always-allow-more-cards.md "Content written by others") ----
/**
 * Other people's words are in this turn: a shared chat, a chat others wrote in, one that read rooms (a side chat,
 * room_read, a quoted message), or one that read content someone else wrote (TurnExec.othersWords: a teammate's team
 * file, a file shared with the person, a web page, a connected service's answer…). Any of it can ask for an action, so
 * the person's "Always allow" for an action that reaches other people then counts only for what their own message
 * names. Read at the call: a read can come in this very turn.
 */
export function othersWordsIn(exec: Pick<TurnExec, 'shared' | 'otherAuthors' | 'roomsSeen' | 'spec' | 'rt'> & Partial<Pick<TurnExec, 'othersWords'>>): boolean {
  return !!exec.shared || !!exec.otherAuthors || readRooms(exec) || !!exec.othersWords
}

/** Every file is one the asker brought into this turn themselves: attached to their own message, named in it (quoted
 * lines left out; a Hangul name also without its separators), or made or changed by the AI in this answer. */
/** The asker's own message of this turn (quoted lines left out) asks to share, send or post something: the request
 * form of one of those verbs and no "don't". Naming a person is not asking to send to them ("summarise the notes Tess
 * wrote"), so where other people's words are in the chat "Always allow" also needs this. */
export function asksToSend(db: Database, messageId: string): boolean {
  const said = withoutQuoteLines(askerText(db, messageId))
  return asksFor(SHARE_ASK, said) || asksFor(POST_ASK, said)
}

export function fromAsker(db: Database, spec: { userMessageId: string; turnId: string }, paths: Iterable<string>): boolean {
  const said = withoutQuoteLines(askerText(db, spec.userMessageId))
  const attached = attachedPaths(db, spec.userMessageId)
  for (const p of paths) if (!(attached.has(p) || namesFileLoose(said, p) || madeInTurn(db, spec.turnId, p))) return false
  return true
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

/** The person's words say "don't" (a narrowing action that needs no request verb reads this alone: chat/stop-sharing.ts). */
export const saysDont = (said: string): boolean => ASK_NOT.test(said)

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
export function namedInFull(said: string, names: readonly string[], o: { place?: boolean; peers?: readonly string[] } = {}): boolean {
  const text = fold(said.slice(0, NAME_SCAN))
  const ok = o.place ? nameOk : personOk
  return names.map(fold).some((n) => ok(n) && holdsAsRecipient(text, n, !!o.place, o.peers))
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
