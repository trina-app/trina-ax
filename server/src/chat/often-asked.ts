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
import { APP_PROMPTS, ENDINGS, STOP, TASK } from './often-asked-words'

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
 * window and since the switch was turned on. While safe operations are on every conversation is confidential: none.
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
      AND EXISTS (SELECT 1 FROM turns t WHERE t.user_message_id = m.id AND t.client_kind IN (${typed}))
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.user_message_id = m.id AND (t.client_kind IS NULL OR t.client_kind NOT IN (${typed}) OR t.schedule_id IS NOT NULL))
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

export interface TeamNames { people: string[]; honorific: string[]; projects: string[]; rooms: string[] }
const HANGUL = /^[\p{Script=Hangul}]+$/u
const KO_TITLES = '님|씨|과장|대리|부장|차장|팀장|사원|주임|이사|대표|선배|매니저|실장|본부장|선생님|책임|선임|수석'
const JA_TITLES = 'さん|様|さま|くん|君|ちゃん|先生|氏'

/** The names a line must not carry: everyone's names and usernames (also a surname or given name with a title, "김
 * 과장", "田中さん"), the projects' names and the names of group chats. Group names and the team's rooms stay: they are
 * not secret, and often what a group's questions are about. */
export function teamNames(db: Database): TeamNames {
  const users = db.query('SELECT name, username FROM users').all() as { name: string; username: string }[]
  const people = new Set<string>(), honorific = new Set<string>()
  for (const u of users) {
    const name = (u.name ?? '').normalize('NFKC').trim()
    if ([...name].length >= 2) people.add(name)
    if ((u.username ?? '').length >= 3) people.add(u.username.normalize('NFKC'))
    for (const part of name.split(/\s+/)) {
      if (/^[\p{Script=Latin}]+$/u.test(part) && part.length >= 3) people.add(part)
      if (part.length >= 1) honorific.add(part)
    }
    // a Korean name written together ("김민수"): its surname and its given name, with a title
    const one = name.replace(/\s+/g, '')
    if (HANGUL.test(one) && [...one].length >= 3) { honorific.add([...one][0]!); honorific.add([...one].slice(1).join('')) }
  }
  const projects = (db.query('SELECT name FROM projects').all() as { name: string }[]).map((r) => r.name.normalize('NFKC').trim()).filter((n) => [...n].length >= 2)
  const rooms = hasTable(db, 'rooms')
    ? (db.query("SELECT name FROM rooms WHERE kind = 'group' AND name IS NOT NULL").all() as { name: string }[]).map((r) => r.name.normalize('NFKC').trim()).filter((n) => [...n].length >= 2)
    : []
  return { people: [...people], honorific: [...honorific], projects, rooms }
}

const byLength = (xs: string[]) => [...new Set(xs)].sort((a, b) => b.length - a.length)
/** A name as a pattern: whole words in Latin script (case-insensitive), anywhere in other scripts. */
const namePattern = (n: string) => (/^[\p{Script=Latin}\p{N}_.\- ]+$/u.test(n) ? `(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])` : escape(n))

/** The masks, built once per run. */
export function masker(names: TeamNames): (line: string) => string {
  const re = (xs: string[]) => (xs.length ? new RegExp(byLength(xs).map(namePattern).join('|'), 'giu') : null)
  const person = re(names.people), project = re(names.projects), room = re(names.rooms)
  const titled = names.honorific.length
    ? new RegExp(`(?:${byLength(names.honorific).map(escape).join('|')})\\s?(?:${KO_TITLES}|${JA_TITLES})`, 'gu')
    : null
  return (line) => {
    let s = maskSecrets(plainRoomRefs(line), ' (secret) ')
    s = s.replace(/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi, '(link)')
    s = s.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '(email)')
    s = s.replace(/`[^`]*`/g, '(file)')
    s = s.replace(/\S*[\\/]\S*/g, '(file)')
    s = s.replace(/[\p{L}\p{N}_-]+\.(?:pdf|docx?|xlsx?|pptx?|hwpx?|csv|txt|md|png|jpe?g|gif|webp|zip|json|html?|key|pages|numbers)\b/giu, '(file)')
    s = s.replace(/@\S+/g, '(person)').replace(/#\S+/g, '(room)')
    if (titled) s = s.replace(titled, '(person)')
    if (person) s = s.replace(person, '(person)')
    if (project) s = s.replace(project, '(project)')
    if (room) s = s.replace(room, '(room)')
    s = s.replace(/[\p{Nd}][\p{Nd},.:/-]*/gu, '(number)')
    return s.replace(/\s+/g, ' ').trim()
  }
}

// ---------------------------------------------------------------- words

const SEG = new Intl.Segmenter(undefined, { granularity: 'word' })
const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const norm = (s: string) => s.normalize('NFKC').toLowerCase()
/** The words of a text, as the checks read them (lower case; a possessive "'s" off). */
export function wordsOf(text: string): string[] {
  const out: string[] = []
  for (const s of SEG.segment(norm(text))) if (s.isWordLike) out.push(s.segment.replace(/['’]s$/u, ''))
  return out.filter(Boolean)
}
const graphemes = (s: string) => [...s]
const bigrams = (s: string) => { const g = graphemes(s); return g.length < 2 ? [s] : g.slice(0, -1).map((c, i) => c + g[i + 1]) }
/** A Latin-script word on the lists, as it is (or without a plural "s"): the form to look for, else null. */
const listed = (w: string, set: Set<string>) => (set.has(w) ? w : w.endsWith('s') && set.has(w.slice(0, -1)) ? w.slice(0, -1) : null)

/** One word of a sentence as the checks read it: a function word (`stop`), a generic task word (`task`, its `unit`
 * is how it is looked for in a line), or the units 3+ people must have typed (`typed`: a list of ways to read it; one
 * way is enough, and every unit of that way must be backed). */
export type SentenceWord = { kind: 'stop' } | { kind: 'task'; unit: Unit } | { kind: 'typed'; ways: Unit[][] }
export interface Unit { cjk: boolean; s: string }

export function readWord(w: string): SentenceWord {
  if (!CJK.test(w)) {
    if (listed(w, STOP)) return { kind: 'stop' }
    const task = listed(w, TASK)
    if (task) return { kind: 'task', unit: { cjk: false, s: task } }
    return { kind: 'typed', ways: [[{ cjk: false, s: w }]] }
  }
  // Korean and Japanese: the word, and the word without each ending it has
  const stems = [w, ...ENDINGS.filter((e) => w.endsWith(e) && w.length > e.length).map((e) => w.slice(0, -e.length))]
  if (stems.some((s) => STOP.has(s))) return { kind: 'stop' }
  const task = stems.find((s) => TASK.has(s))
  if (task) return { kind: 'task', unit: { cjk: true, s: task } }
  // a stem of one character says too little to be looked for (it is in too many lines): never a way to read it, so
  // such a word drops the sentence
  return { kind: 'typed', ways: stems.filter((s) => graphemes(s).length >= 2).map((s) => bigrams(s).map((b) => ({ cjk: true, s: b }))) }
}

/** A person's lines as the checks search them. */
export interface Said { compact: string; words: string[] }
export const saidOf = (line: string): Said => ({ compact: norm(line).replace(/\s+/g, ''), words: wordsOf(line) })
/** Does this line hold the unit? Korean and Japanese pieces anywhere (spaces aside); other words whole, or one the
 * start of the other (4+ letters: "acme" and "acme's", "report" and "reporting"). `loose` (backing a person for an
 * item): also a shared start of 5+ letters ("summary", "summarize"). */
export function holds(said: Said, u: Unit, loose = false): boolean {
  if (u.cjk) return said.compact.includes(u.s)
  return said.words.some((x) => x === u.s
    || (Math.min(x.length, u.s.length) >= 4 && (x.startsWith(u.s) || u.s.startsWith(x)))
    || (loose && Math.min(x.length, u.s.length) >= 5 && x.slice(0, 5) === u.s.slice(0, 5)))
}

/** A sentence's shape: one line, 4–80 characters, no digit, link, email, @, #, path, file name, Markdown, bracket or
 * placeholder, and none of the team's masked names. */
export function genericShape(text: string, names: TeamNames): boolean {
  const n = [...text].length
  if (n < 4 || n > OFTEN_ASKED_TEXT_MAX) return false
  if (/[\r\n\t]/.test(text) || /\p{Nd}/u.test(text)) return false
  if (/[@#/\\<>[\]{}()（）「」『』*_`|~^=+$%&]/u.test(text)) return false
  if (/https?:|www\.|\.(?:pdf|docx?|xlsx?|pptx?|hwpx?|csv|txt|md|png|jpe?g|zip|json|html?)\b/i.test(text)) return false
  const t = norm(text)
  for (const x of [...names.people, ...names.projects, ...names.rooms]) {
    const v = norm(x)
    if (/^[\p{Script=Latin}\p{N}_.\- ]+$/u.test(v) ? new RegExp(namePattern(v), 'iu').test(t) : t.includes(v)) return false
  }
  return true
}

// ---------------------------------------------------------------- the team, its audiences and circles

export interface Entry { id: string; user: string; text: string; at: string; said: Said }
export interface Audience { key: string; groupId: string | null; members: Set<string>; entries: Entry[]; askers: Set<string> }
export interface Snapshot { entries: Entry[]; audiences: Audience[]; circles: Set<string>[]; names: TeamNames; current: string[] }

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
  const byGroup = new Map<string, Map<string, string>>()
  for (const r of since) if (active.has(r.u)) { if (!byGroup.has(r.g)) byGroup.set(r.g, new Map()); byGroup.get(r.g)!.set(r.u, r.since) }
  for (const [g, joined] of byGroup) {
    const mine = entries.filter((e) => joined.has(e.user) && e.at >= joined.get(e.user)!)
    audiences.push({ key: g, groupId: g, members: new Set(joined.keys()), entries: mine, askers: new Set(mine.map((e) => e.user)) })
  }
  return { entries, audiences, circles: circlesOf(db, rules, principals), names, current }
}

/** Does any audience have enough people who asked something to need a run? */
export const worthARun = (s: Snapshot) => s.audiences.some((a) => a.askers.size >= OFTEN_ASKED.minAudience)

// ---------------------------------------------------------------- the checks

export interface AiItem { text: string; ids: string[] }
export interface Passed { text: string; people: number }

/** The items that pass for one audience, best first, at most OFTEN_ASKED_ITEMS_MAX (the rules at the top). */
export function passing(s: Snapshot, a: Audience, items: AiItem[]): Passed[] {
  if (a.askers.size < OFTEN_ASKED.minAudience) return []
  const byId = new Map(a.entries.map((e) => [e.id, e]))
  // who of the audience typed a unit, looked up once per unit
  const users = new Map<string, Set<string>>()
  const typedBy = (u: Unit) => {
    const k = (u.cjk ? 'c:' : 'w:') + u.s
    let set = users.get(k)
    if (!set) { set = new Set(a.entries.filter((e) => holds(e.said, u)).map((e) => e.user)); users.set(k, set) }
    return set
  }
  const out: Passed[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const text = item.text.replace(/\s+/g, ' ').trim()
    if (seen.has(norm(text)) || !genericShape(text, s.names)) continue
    const words = wordsOf(text).map(readWord)
    if (!words.length) continue
    // every word: a fixed word, or one way of reading it whose every piece 3+ people of the audience typed
    if (!words.every((w) => w.kind !== 'typed' || w.ways.some((way) => way.every((u) => spread(typedBy(u), a, s.circles))))) continue
    // backed: a person counts when a line of theirs in the item holds a word of the sentence that is not a function
    // word
    const units = words.flatMap((w) => (w.kind === 'task' ? [w.unit] : w.kind === 'typed' ? w.ways.flat() : []))
    const backers = new Set<string>()
    for (const id of new Set(item.ids)) {
      const e = byId.get(id)
      if (e && units.some((u) => holds(e.said, u, true))) backers.add(e.user)
    }
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
  if (!getTeamSettings(db).oftenAsked) return
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

/** One audience's list as shown: today's items first, then the ones held, at most 10; none under 3 items. */
function listOf(db: Database, audience: string, now: Date): string[] {
  const rows = db.query('SELECT text FROM often_asked_items WHERE audience = ? AND passed_at >= ? ORDER BY passed_at DESC, position, text LIMIT ?')
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
