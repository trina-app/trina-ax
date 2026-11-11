// Home's "what my group often asks" (docs/DECISIONS.md "Home: what my group often asks"; plan
// docs/AGENTS/plan/20261111-0950-group-often-asks.md): under the box, three generic one-line questions that people of my
// group (else my team) often ask; More shows up to 10; a click fills the box. Never raw text, never who asked, how many
// or when. This file holds everything but the AI turn (chat/often-asked-run.ts):
// - the material: the short first lines people typed in the app in their own AI chats since the switch was turned on,
//   in the last 30 days, masked (links, emails, numbers, secrets, people's, projects' and private rooms' names). Never
//   project chats, rooms, side chats, Slack, confidential chats, scheduled or server-made turns, skill runs or the
//   app's own prompts;
// - the checks: the AI only groups the lines and writes one sentence per group; the server decides who may see it.
//   A sentence passes for an audience (a group, or the whole team) only when 3+ people of it back it with a real shared
//   word, every word of it is a fixed generic word or one 3+ people of it typed, and the people behind it are not all
//   inside one smaller circle (a group, a team project, a group chat) that leaves someone of the audience out;
// - the lists: per audience, only when 5+ of its members asked something; an item that stops passing stays 3 days;
// - the read for the caller (GET /api/questions/often-asked).
import type { Database } from 'bun:sqlite'
import { hideThreadRef, plainRoomRefs, OFTEN_ASKED_ITEMS_MAX, OFTEN_ASKED_TEXT_MAX, type Locale, type OftenAsked } from '@mycel/shared/api'
import { maskSecrets } from '@mycel/shared'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { getSetting, getTeamSettings, setSetting } from '../admin/settings'
import { safeOpsEnabled } from '../safe-ops/runner'
import { notInternalChat } from './internal-chats'
import { APP_PROMPTS, ENDINGS, GENERIC, STOP } from './often-asked-words'

export const OFTEN_ASKED = {
  /** the window, in days */
  days: 30,
  /** different people behind an item, and behind every word of it that someone typed */
  minPeople: 3,
  /** members of a group (or the team) who asked something before it has a list at all */
  minAudience: 5,
  /** items a list needs before it shows */
  minItems: 3,
  /** an item that stops passing stays this long; a list no run renewed is gone after it too */
  holdDays: 3,
  /** a question's first line, at most (longer: pasted text, not a question) */
  lineChars: 200,
  /** entries per person (the newest), and in all */
  perPerson: 40,
  entries: 600,
  /** the material's characters, about */
  materialChars: 60_000,
  /** items read from the AI's answer */
  aiItems: 30,
} as const

/** settings: only questions sent from then count (the build's first start; the switch turned on) */
export const SINCE_KEY = 'oftenAsked.since'
/** settings: the last run that stored lists, and the last time a run was tried */
export const LAST_RUN_KEY = 'oftenAsked.lastRun'
export const LAST_TRY_KEY = 'oftenAsked.lastTry'
/** what a person sends in the app (turns.client_kind); anything else (a schedule, Slack, the server itself) is not
 * a question someone typed */
const TYPED = ['web', 'desktop', 'mobile'] as const

const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString()

// ---------------------------------------------------------------- reading the questions

/** A table some test databases lack (another component's): its condition only when it is there. */
function hasTable(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

export interface Question { user: string; content: string; at: string }

/**
 * The messages that may count, on their chat's active branch: the person's own AI chat (no project, room, side chat,
 * Slack thread or confidential chat, not one of the server's own, not deleted), typed by them in the app (every turn of
 * it from the web, desktop or phone app; never a schedule, Slack or a request the server wrote), not auto-sent, in the
 * window and since the switch was turned on. A chat that was in a project (moved out, its project deleted) counts only
 * what came after it left. While safe operations are on every conversation is confidential: none.
 */
export function readQuestions(db: Database, now = new Date()): Question[] {
  if (safeOpsEnabled()) return []
  const to = now.toISOString()
  const from = iso(now.getTime() - OFTEN_ASKED.days * DAY)
  const since = getSetting<string>(db, SINCE_KEY)
  if (typeof since !== 'string' || !since || since >= to) return []
  const chatOk = [
    'c.active_leaf_id IS NOT NULL', 'c.deleted_at IS NULL', 'c.room_id IS NULL', 'c.side_room_id IS NULL', 'c.project_id IS NULL',
    "u.status = 'active'", 'u.deleted_at IS NULL', 'c.updated_at >= $from', notInternalChat(db, 'c.id'),
    ...(hasTable(db, 'slack_threads') ? ['NOT EXISTS (SELECT 1 FROM slack_threads s WHERE s.chat_id = c.id)'] : []),
    ...(hasTable(db, 'safe_ops_chats') ? ['NOT EXISTS (SELECT 1 FROM safe_ops_chats o WHERE o.chat_id = c.id AND o.material != 0)'] : []),
  ].join(' AND ')
  const typed = TYPED.map((k) => `'${k}'`).join(',')
  return db.query(`WITH RECURSIVE branch(id, chat_id) AS (
      SELECT c.active_leaf_id, c.id FROM chats c JOIN users u ON u.id = c.user_id WHERE ${chatOk}
      UNION
      SELECT p.id, p.chat_id FROM branch b JOIN messages m ON m.id = b.id AND m.chat_id = b.chat_id
        JOIN messages p ON p.id = m.parent_id AND p.chat_id = m.chat_id WHERE p.created_at >= $from
    )
    SELECT c.user_id AS user, m.content AS content, m.created_at AS at
    FROM branch b JOIN messages m ON m.id = b.id AND m.chat_id = b.chat_id JOIN chats c ON c.id = m.chat_id
    WHERE m.role = 'user' AND m.author_id = c.user_id AND m.auto_sent = 0 AND length(m.content) <= 4000
      AND m.created_at >= $from AND m.created_at >= $since AND m.created_at < $to
      AND EXISTS (SELECT 1 FROM turns t WHERE t.chat_id = m.chat_id AND t.user_message_id = m.id AND t.client_kind IN (${typed}))
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.chat_id = m.chat_id AND t.user_message_id = m.id AND (t.client_kind IS NULL OR t.client_kind NOT IN (${typed}) OR t.schedule_id IS NOT NULL))
      ${hasTable(db, 'chat_project_left') ? 'AND NOT EXISTS (SELECT 1 FROM chat_project_left l WHERE l.chat_id = m.chat_id AND m.created_at < l.left_at)' : ''}
    ORDER BY m.created_at DESC, m.id`).all({ $from: from, $since: since, $to: to }) as Question[]
}

/** The question in a message: its first line that is not a quote, at most OFTEN_ASKED.lineChars; null for a skill
 * run ("/name …"), a longer line (pasted text) or nothing. */
export function questionLine(content: string): string | null {
  const text = hideThreadRef(content).normalize('NFC')
  if (text.trimStart().startsWith('/')) return null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line || line.startsWith('>')) continue
    if ([...line].length > OFTEN_ASKED.lineChars) return null
    return line
  }
  return null
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const APP_RE = Object.values(APP_PROMPTS).flat().map((t) => new RegExp('^' + t.split(/\{[a-z]+\}/i).map(escape).join('.+?'), 'i'))
/** A line the app wrote itself (Home's ready questions, a file's "Read the file … and", …), in any language. */
export const isAppPrompt = (line: string) => APP_RE.some((re) => re.test(line))

// ---------------------------------------------------------------- names and masking

/** A name and how it is looked for: `latin` (whole words; parts of 2 letters as written, longer ones in any case) or
 * anywhere in other scripts. */
export interface Name { s: string; latin: boolean; exactCase: boolean; plain?: boolean }
/** `plain`: name parts that are also plain words (a given name 수정, "Will", "Dan"): looked for only where they stand
 * for a person (see asPerson), and a sentence word that is one is always a topic (3 people must have typed it). */
export interface TeamNames { people: Name[]; titled: string[]; projects: Name[]; rooms: Name[]; plain: Name[] }
const HANGUL = /^[\p{Script=Hangul}]+$/u
const CJK_NAME = /^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u
const LATIN = /^[\p{Script=Latin}\p{N}_.\-' ]+$/u
const KO_TITLES = '님|씨|과장|대리|부장|차장|팀장|사원|주임|이사|대표|선배|매니저|실장|본부장|선생님|책임|선임|수석'
const JA_TITLES = 'さん|様|さま|くん|君|ちゃん|先生|氏'
/** Accents off Latin letters only ("José" reads as "Jose"; Japanese and Korean stay as they are). */
export const plainLatin = (s: string) => s.normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC')
const nameOf = (raw: string, minChars = 2): Name | null => {
  const v = plainLatin(raw.normalize('NFKC').trim())
  if ([...v].length < minChars) return null
  const latin = LATIN.test(v)
  // a name part that is also a plain word (a given name 수정, "fix"; Will; Dan): not looked for everywhere, or every
  // "수정해 줘" would be masked and dropped; only where it stands for a person (asPerson)
  const plain = GENERIC.has(v.toLowerCase()) || STOP.has(v.toLowerCase())
  return { s: v, latin, exactCase: latin && v.length < 3, ...(plain ? { plain: true } : {}) }
}
const names = (xs: (Name | null)[]) => {
  const seen = new Set<string>()
  return xs.filter((x): x is Name => !!x && !seen.has(x.s + x.exactCase) && !!seen.add(x.s + x.exactCase))
}

/** The names a line must not carry: everyone's names and usernames, written together too ("이 서연" as "이서연"), every
 * part of 2+ letters (a Korean or Japanese given name or surname alone: "민수", "田中"; a Latin part as a whole word,
 * "Li" as written), a one-letter surname with a title ("김 과장"); the projects' names; the group chats' names. Group
 * names and the team's rooms stay: not secret, and often what a group's questions are about. */
export function teamNames(db: Database): TeamNames {
  const users = db.query('SELECT name, username FROM users').all() as { name: string | null; username: string | null }[]
  const people: (Name | null)[] = []
  const titled = new Set<string>()
  for (const u of users) {
    const name = plainLatin((u.name ?? '').normalize('NFKC').trim())
    people.push(nameOf(name), nameOf(name.replace(/\s+/g, '')), nameOf(u.username ?? '', 3))
    const parts = name.split(/\s+/).filter(Boolean)
    for (const part of parts) { people.push(nameOf(part)); titled.add(part) }
    if (CJK_NAME.test(name.replace(/\s+/g, ''))) titled.add(name.replace(/\s+/g, ''))
    // a Korean name written together ("김민수"): its surname (with a title) and its given name ("민수")
    const one = name.replace(/\s+/g, '')
    if (HANGUL.test(one) && [...one].length >= 3) { titled.add([...one][0]!); people.push(nameOf([...one].slice(1).join(''))) }
    for (const part of parts) if (CJK_NAME.test(part)) titled.add(part)
  }
  const projects = (db.query('SELECT name FROM projects').all() as { name: string }[]).map((r) => nameOf(r.name))
  const rooms = hasTable(db, 'rooms') ? (db.query("SELECT name FROM rooms WHERE kind = 'group' AND name IS NOT NULL").all() as { name: string }[]).map((r) => nameOf(r.name)) : []
  const all = names(people)
  return { people: all.filter((x) => !x.plain), titled: [...titled], projects: names(projects).filter((x) => !x.plain), rooms: names(rooms).filter((x) => !x.plain), plain: all.filter((x) => x.plain) }
}

/** A name as a pattern: Latin whole words, other scripts anywhere. */
const namePattern = (n: Name) => (n.latin ? `(?<![\\p{L}\\p{N}])${escape(n.s)}(?![\\p{L}\\p{N}])` : escape(n.s))
const nameRegex = (xs: Name[], flags: string) => {
  const sorted = [...xs].sort((a, b) => b.s.length - a.s.length)
  return sorted.length ? new RegExp(sorted.map(namePattern).join('|'), flags) : null
}
/** Find any of these names in a text (Latin parts of 2 letters as written, the rest in any case). */
export function nameFinder(xs: Name[]): { re: RegExp[]; test: (t: string) => boolean } {
  const re = [nameRegex(xs.filter((n) => !n.exactCase), 'giu'), nameRegex(xs.filter((n) => n.exactCase), 'gu')].filter((r): r is RegExp => !!r)
  return { re, test: (t) => re.some((r) => { r.lastIndex = 0; return r.test(t) }) }
}

/** Where a plain-word name part stands for a person: in Korean or Japanese followed by a person's particle or a title
 * ("수정한테", "수정 님"); in Latin script capitalized as the name is, anywhere but the start of a sentence ("email to
 * Dan"). */
export function asPerson(n: TeamNames): RegExp | null {
  const cjk = n.plain.filter((x) => !x.latin).map((x) => escape(x.s))
  const latin = n.plain.filter((x) => x.latin).map((x) => escape(x.s.charAt(0).toUpperCase() + x.s.slice(1)))
  const parts = [
    ...(cjk.length ? [`(?:${cjk.join('|')})(?=\\s?(?:한테|에게|께서|께|이랑|랑|${KO_TITLES}|${JA_TITLES}))`] : []),
    ...(latin.length ? [`(?<=[^\\s.!?。！？]\\s+)(?:${latin.join('|')})(?![\\p{L}\\p{N}])`] : []),
  ]
  return parts.length ? new RegExp(parts.join('|'), 'gu') : null
}

/** The masks, built once per run. */
export function masker(n: TeamNames): (line: string) => string {
  const person = nameFinder(n.people), project = nameFinder(n.projects), room = nameFinder(n.rooms), standsFor = asPerson(n)
  const titled = n.titled.length
    ? new RegExp(`(?:${[...n.titled].sort((a, b) => b.length - a.length).map(escape).join('|')})\\s?(?:${KO_TITLES}|${JA_TITLES})`, 'gu')
    : null
  // names first, as marks no name can match inside, then the words people read
  const PERSON = '\uE000', PROJECT = '\uE001', ROOM = '\uE002'
  return (line) => {
    let s = plainRoomRefs(plainLatin(line))
    if (titled) s = s.replace(titled, PERSON)
    if (standsFor) s = s.replace(standsFor, PERSON)
    for (const r of person.re) s = s.replace(r, PERSON)
    for (const r of project.re) s = s.replace(r, PROJECT)
    for (const r of room.re) s = s.replace(r, ROOM)
    s = maskSecrets(s, ' (secret) ')
    s = s.replace(/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi, '(link)')
    s = s.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '(email)')
    s = s.replace(/`[^`]*`/g, '(file)')
    s = s.replace(/\S*[\\/]\S*/g, '(file)')
    s = s.replace(/[\p{L}\p{N}_-]+\.(?:pdf|docx?|xlsx?|pptx?|hwpx?|csv|txt|md|png|jpe?g|gif|webp|zip|json|html?|key|pages|numbers)\b/giu, '(file)')
    s = s.replace(/@\S+/g, PERSON).replace(/#\S+/g, ROOM)
    s = s.replace(/[\p{Nd}][\p{Nd},.:/-]*/gu, '(number)')
    s = s.replaceAll(PERSON, '(person)').replaceAll(PROJECT, '(project)').replaceAll(ROOM, '(room)')
    return s.replace(/\s+/g, ' ').trim()
  }
}

// ---------------------------------------------------------------- words

const SEG = new Intl.Segmenter(undefined, { granularity: 'word' })
const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const norm = (s: string) => plainLatin(s.normalize('NFKC')).toLowerCase()
/** The words of a text, as the checks read them (lower case, accents off Latin letters, a possessive "'s" off). */
export function wordsOf(text: string): string[] {
  const out: string[] = []
  for (const s of SEG.segment(norm(text))) if (s.isWordLike) out.push(s.segment.replace(/['’]s$/u, ''))
  return out.filter(Boolean)
}
const graphemes = (s: string) => [...s]
/** A Latin-script word on a list, as it is (or without a plural "s"). */
const listed = (w: string, set: Set<string>) => set.has(w) || (w.endsWith('s') && set.has(w.slice(0, -1)))

/** One word of a sentence as the checks read it: a function word (`stop`), a plain word for what to do (`generic`),
 * or a topic: the forms it may have been typed in (`forms`: the word, and in Korean and Japanese the word without a
 * known ending, never shorter than 2 letters). Every person behind an item must have typed one of a topic's forms. */
export type SentenceWord = { kind: 'stop' } | { kind: 'generic' } | { kind: 'topic'; forms: Unit[] }
export interface Unit { cjk: boolean; s: string }

export function readWord(w: string, nameParts: ReadonlySet<string> = new Set()): SentenceWord {
  if (!CJK.test(w)) {
    // a word that is also a colleague's name ("dan", "will") is a topic: 3 people must have typed it
    if (nameParts.has(w)) return { kind: 'topic', forms: [{ cjk: false, s: w }] }
    if (listed(w, STOP)) return { kind: 'stop' }
    if (listed(w, GENERIC)) return { kind: 'generic' }
    return { kind: 'topic', forms: [{ cjk: false, s: w }] }
  }
  // Korean and Japanese: the word, and the word without each ending it has
  const stems = [w, ...ENDINGS.filter((e) => w.endsWith(e) && w.length > e.length).map((e) => w.slice(0, -e.length))]
  if (stems.some((s) => nameParts.has(s))) return { kind: 'topic', forms: stems.filter((s) => graphemes(s).length >= 2).map((s) => ({ cjk: true, s })) }
  if (stems.some((s) => STOP.has(s))) return { kind: 'stop' }
  if (stems.some((s) => GENERIC.has(s))) return { kind: 'generic' }
  // a stem of one letter says too little to be looked for: never a form, so such a word drops the sentence
  return { kind: 'topic', forms: stems.filter((s) => graphemes(s).length >= 2).map((s) => ({ cjk: true, s })) }
}

/** A person's lines as the checks search them. */
export interface Said { compact: string; words: string[] }
export const saidOf = (line: string): Said => ({ compact: norm(line).replace(/\s+/g, ''), words: wordsOf(line) })
export const saidOfAll = (xs: Said[]): Said => ({ compact: xs.map((x) => x.compact).join('\u0000'), words: xs.flatMap((x) => x.words) })
/** Did they type this form? Korean and Japanese: the form itself in their line (spaces aside). Other words: the word,
 * its plural or possessive, or a longer word of theirs that starts with it (at most 3 letters more: "report" in
 * "reporting"); never the other way round, so "Salesforce" is not "sales" and "Williams" not "will". */
export function holds(said: Said, u: Unit): boolean {
  if (u.cjk) return said.compact.includes(u.s)
  return said.words.some((x) => x === u.s || x === u.s + 's' || u.s === x + 's' || (u.s.length >= 4 && x.startsWith(u.s) && x.length - u.s.length <= 3))
}

/** A sentence's shape: one line, at most 80 characters (as the API counts them), letters, spaces and plain punctuation
 * only (no digit, link, email, @, #, path, file name, bracket, placeholder, emoji, symbol or invisible character), and
 * none of the team's masked names. */
export function genericShape(text: string, n: TeamNames): boolean {
  if (text.length > OFTEN_ASKED_TEXT_MAX || [...text].length < 4) return false
  if (/[^\p{L}\p{M}\s.,?!'’"“”:;~\-…·、。，？！]/u.test(text) || /[\r\n\t]/.test(text)) return false
  if (/https?|www\.|\.(?:pdf|docx?|xlsx?|pptx?|hwpx?|csv|txt|md|png|jpe?g|zip|json|html?)\b/i.test(text)) return false
  const t = plainLatin(text.normalize('NFKC'))
  const standsFor = asPerson(n)
  if (standsFor && standsFor.test(t)) return false
  return ![n.people, n.projects, n.rooms].some((xs) => nameFinder(xs).test(t))
}

// ---------------------------------------------------------------- the team, its audiences and circles

export interface Entry { id: string; user: string; text: string; at: string; said: Said }
export interface Audience { key: string; groupId: string | null; members: Set<string>; entries: Entry[]; askers: Set<string> }
export interface Snapshot { entries: Entry[]; audiences: Audience[]; circles: Set<string>[]; names: TeamNames; current: string[]; since: string | null }

/** Everyone who is in a circle: the groups, the team projects (the people who read its folder by a rule, not by
 * their role) and the group chats of 3 or more. A thing 3 people share inside one of them stays inside it. */
export function circlesOf(db: Database, rules: RuleSet, people: Principal[]): Set<string>[] {
  const out: Set<string>[] = []
  const groups = new Map<string, Set<string>>()
  for (const r of db.query('SELECT gm.group_id AS g, gm.user_id AS u FROM group_members gm').all() as { g: string; u: string }[]) {
    if (!groups.has(r.g)) groups.set(r.g, new Set())
    groups.get(r.g)!.add(r.u)
  }
  out.push(...groups.values())
  const projects = db.query("SELECT folder_path FROM projects WHERE folder_path LIKE 'projects/%'").all() as { folder_path: string }[]
  for (const p of projects) {
    const segs = p.folder_path.split('/')
    out.push(new Set(people.filter((x) => { try { return atLeast(rules.access({ ...x, role: 'member' }, segs), 'read') } catch { return false } }).map((x) => x.id)))
  }
  if (hasTable(db, 'rooms')) {
    const rooms = new Map<string, Set<string>>()
    for (const r of db.query("SELECT rm.room_id AS r, rm.user_id AS u FROM room_members rm JOIN rooms ro ON ro.id = rm.room_id WHERE ro.kind = 'group' AND ro.archived_at IS NULL").all() as { r: string; u: string }[]) {
      if (!rooms.has(r.r)) rooms.set(r.r, new Set())
      rooms.get(r.r)!.add(r.u)
    }
    out.push(...[...rooms.values()].filter((s) => s.size >= OFTEN_ASKED.minPeople))
  }
  return out
}

/** Are these people enough for this audience: 3 or more of it, and not all inside one circle that leaves someone of
 * the audience out? */
export function spread(people: Set<string>, a: Pick<Audience, 'members'>, circles: Set<string>[]): boolean {
  const mine = [...people].filter((p) => a.members.has(p))
  if (mine.length < OFTEN_ASKED.minPeople) return false
  for (const c of circles) {
    if ([...a.members].every((m) => c.has(m))) continue
    if (mine.every((p) => c.has(p))) return false
  }
  return true
}

/** The entries one line each: masked, one per person per distinct line, the newest first, at most perPerson each
 * and `entries` in all (taken in turns so no one person fills it), in an order that says nothing of who wrote them. */
export function buildSnapshot(db: Database, rules: RuleSet, o: { now?: Date; random?: () => number } = {}): Snapshot {
  const now = o.now ?? new Date()
  const random = o.random ?? Math.random
  const names = teamNames(db)
  const mask = masker(names)
  const current = (db.query('SELECT DISTINCT text FROM often_asked_items').all() as { text: string }[]).map((r) => r.text)
  const shown = new Set(current.map((t) => norm(t).replace(/\s+/g, ' ').trim()))
  const per = new Map<string, { text: string; at: string }[]>()
  for (const q of readQuestions(db, now)) {
    const line = questionLine(q.content)
    if (!line || isAppPrompt(line)) continue
    const masked = mask(line)
    const key = norm(masked)
    if (!/[\p{L}]/u.test(masked) || shown.has(norm(line).replace(/\s+/g, ' ').trim())) continue
    const mine = per.get(q.user) ?? []
    if (mine.length >= OFTEN_ASKED.perPerson || mine.some((x) => norm(x.text) === key)) continue
    mine.push({ text: masked, at: q.at })
    per.set(q.user, mine)
  }
  // in turns: everyone's newest, then everyone's second, …
  const taken: { user: string; text: string; at: string }[] = []
  let chars = 0
  for (let i = 0; i < OFTEN_ASKED.perPerson && taken.length < OFTEN_ASKED.entries; i++) {
    for (const [user, xs] of per) {
      const x = xs[i]
      if (!x || taken.length >= OFTEN_ASKED.entries || chars + x.text.length > OFTEN_ASKED.materialChars) continue
      taken.push({ user, ...x })
      chars += x.text.length
    }
  }
  for (let i = taken.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [taken[i], taken[j]] = [taken[j]!, taken[i]!] }
  const entries: Entry[] = taken.map((x, i) => ({ id: `q${i + 1}`, user: x.user, text: x.text, at: x.at, said: saidOf(x.text) }))

  const people = (db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)
  const active = new Set(people)
  const principals = people.map((id) => ({ id, name: id, role: 'member' as const, groups: (db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(id) as { group_id: string }[]).map((r) => r.group_id) }))
  const audiences: Audience[] = [{ key: 'team', groupId: null, members: active, entries, askers: new Set(entries.map((e) => e.user)) }]
  const since = db.query('SELECT gs.group_id AS g, gs.user_id AS u, gs.since AS since FROM group_member_since gs JOIN group_members gm ON gm.group_id = gs.group_id AND gm.user_id = gs.user_id WHERE gs.left_at IS NULL').all() as { g: string; u: string; since: string }[]
  // a group counts nothing from before its last real change of people (group_count_from: someone added, disabled,
  // enabled or deleted; or someone still out since they were taken out): reshaping a group around one person cannot
  // single out what that person asked before
  const reset = new Map<string, string>()
  const later = (g: string, t: string | null) => { if (t && t > (reset.get(g) ?? '')) reset.set(g, t) }
  for (const r of db.query('SELECT group_id AS g, since FROM group_count_from').all() as { g: string; since: string }[]) later(r.g, r.since)
  for (const r of db.query('SELECT group_id AS g, MAX(left_at) AS t FROM group_member_since WHERE left_at IS NOT NULL GROUP BY group_id').all() as { g: string; t: string }[]) later(r.g, r.t)
  const byGroup = new Map<string, Map<string, string>>()
  for (const r of since) if (active.has(r.u)) {
    if (!byGroup.has(r.g)) byGroup.set(r.g, new Map())
    const from = reset.get(r.g)
    byGroup.get(r.g)!.set(r.u, from && from > r.since ? from : r.since)
  }
  for (const [g, joined] of byGroup) {
    const mine = entries.filter((e) => joined.has(e.user) && e.at >= joined.get(e.user)!)
    audiences.push({ key: g, groupId: g, members: new Set(joined.keys()), entries: mine, askers: new Set(mine.map((e) => e.user)) })
  }
  return { entries, audiences, circles: circlesOf(db, rules, principals), names, current, since: getSetting<string>(db, SINCE_KEY) ?? null }
}

/** Does any audience have enough people who asked something to need a run? */
export const worthARun = (s: Snapshot) => s.audiences.some((a) => a.askers.size >= OFTEN_ASKED.minAudience)

// ---------------------------------------------------------------- the checks

export interface AiItem { text: string; ids: string[] }
export interface Passed { text: string; people: number }

/**
 * The items that pass for one audience, best first, at most OFTEN_ASKED_ITEMS_MAX. A sentence passes when its shape
 * is generic, it has at least one topic word, and the people of the audience who typed EVERY topic word of it (in their
 * own lines of the item) are 3 or more and not all inside one circle that leaves someone of the audience out. So no
 * word of it comes from fewer than 3 people, and those 3 asked about the same things, not each about one of them.
 */
export function passing(s: Snapshot, a: Audience, items: AiItem[]): Passed[] {
  if (a.askers.size < OFTEN_ASKED.minAudience) return []
  const byId = new Map(a.entries.map((e) => [e.id, e]))
  const nameParts = new Set(s.names.plain.map((x) => norm(x.s)))
  const out: Passed[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const text = item.text.replace(/\s+/g, ' ').trim()
    if (seen.has(norm(text)) || !genericShape(text, s.names)) continue
    const topics = wordsOf(text).map((w) => readWord(w, nameParts)).filter((w): w is Extract<SentenceWord, { kind: 'topic' }> => w.kind === 'topic')
    if (!topics.length || topics.some((w) => !w.forms.length)) continue
    // each person's lines in the item, together
    const lines = new Map<string, Said[]>()
    for (const id of new Set(item.ids)) {
      const e = byId.get(id)
      if (e) lines.set(e.user, [...(lines.get(e.user) ?? []), e.said])
    }
    const backers = new Set([...lines].filter(([, xs]) => { const all = saidOfAll(xs); return topics.every((w) => w.forms.some((f) => holds(all, f))) }).map(([user]) => user))
    if (!spread(backers, a, s.circles)) continue
    seen.add(norm(text))
    out.push({ text, people: backers.size })
  }
  return out.sort((x, y) => y.people - x.people || (x.text < y.text ? -1 : x.text > y.text ? 1 : 0)).slice(0, OFTEN_ASKED_ITEMS_MAX)
}

// ---------------------------------------------------------------- the lists

/** Store a run's lists: what passed gets this run's time and its place; what did not keeps its old time and goes once
 * it is older than the hold. Nothing is stored while the switch is off. */
export function storeLists(db: Database, s: Snapshot, items: AiItem[], now = new Date()): void {
  // off, or turned off and on again while the AI wrote (its material is from before): nothing is stored
  if (!getTeamSettings(db).oftenAsked || (getSetting<string>(db, SINCE_KEY) ?? null) !== s.since) return
  const at = now.toISOString()
  db.transaction(() => {
    const put = db.query('INSERT INTO often_asked_items (audience, group_id, text, position, passed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (audience, text) DO UPDATE SET position = excluded.position, passed_at = excluded.passed_at')
    for (const a of s.audiences) passing(s, a, items).forEach((p, i) => put.run(a.key, a.groupId, p.text, i, at))
    setSetting(db, LAST_RUN_KEY, at)
  })()
  expireLists(db, now)
}

/** Items that last passed longer ago than the hold are gone (also when no run renewed them). */
export function expireLists(db: Database, now = new Date()): void {
  db.query('DELETE FROM often_asked_items WHERE passed_at < ?').run(iso(now.getTime() - OFTEN_ASKED.holdDays * DAY))
}

/** The switch changed (Admin › Team settings): on, counting starts again now; off, every list goes at once. */
export function oftenAskedSwitched(db: Database, on: boolean, now = new Date()): void {
  if (on) setSetting(db, SINCE_KEY, now.toISOString())
  else db.query('DELETE FROM often_asked_items').run()
}

/** One audience's list as shown: by each item's last place (a held item keeps its own, so the order does not show
 * which ones are fading), at most 10; none under 3 items. */
function listOf(db: Database, audience: string, now: Date): string[] {
  const rows = db.query('SELECT text FROM often_asked_items WHERE audience = ? AND passed_at >= ? ORDER BY position, text LIMIT ?')
    .all(audience, iso(now.getTime() - OFTEN_ASKED.holdDays * DAY), OFTEN_ASKED_ITEMS_MAX) as { text: string }[]
  return rows.length >= OFTEN_ASKED.minItems ? rows.map((r) => r.text) : []
}

const NONE: OftenAsked = { scope: 'none', items: [] }

/** GET /api/questions/often-asked: the caller's group's list (several groups: taking turns), else the team's, else
 * nothing. Only the caller's own groups, read now. */
export function oftenAskedFor(db: Database, userId: string, now = new Date()): OftenAsked {
  if (!getTeamSettings(db).oftenAsked) return NONE
  if (!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId)) return NONE
  const groups = db.query('SELECT g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? ORDER BY g.name, g.id').all(userId) as { id: string; name: string }[]
  const lists = groups.map((g) => ({ g, items: listOf(db, g.id, now) })).filter((x) => x.items.length)
  if (lists.length === 1) return { scope: 'group', group: lists[0]!.g.name, items: lists[0]!.items }
  if (lists.length > 1) {
    const out: string[] = []
    for (let i = 0; out.length < OFTEN_ASKED_ITEMS_MAX && lists.some((l) => i < l.items.length); i++)
      for (const l of lists) { const t = l.items[i]; if (t && !out.includes(t) && out.length < OFTEN_ASKED_ITEMS_MAX) out.push(t) }
    return { scope: 'groups', items: out }
  }
  const team = listOf(db, 'team', now)
  return team.length ? { scope: 'team', items: team } : NONE
}

/** The team's language: the sentences are written in it. */
export const sentenceLocale = (db: Database): Locale => getTeamSettings(db).defaultLocale
