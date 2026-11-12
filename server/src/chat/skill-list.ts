// How the AI learns which skills it may use (docs/DECISIONS.md "Skills: the whole list, the skill tool"), like Claude
// Code's skill listing: every skill the person can use is one line of the instructions ("- name [personal]:
// description", "- name [group: 영업팀]: description", "- name [project: 견적]: description" in that project's chats, the
// description cut at 160 characters, no path) within a fixed
// budget of 8,000 characters. Over the budget every name stays and descriptions go first to the person's own skills,
// then by how much they used a skill, group and team skills alike (each use counts 0.5^(days/7), like Claude Code's
// score; the team's uses count a quarter; on a tie a group's skill before the team's): a person in many groups gets
// more lines, never a bigger list. When even the names do not fit, the last line says how many more there are. The
// full text comes from the skill tool (chat/tools.ts), and find_skills searches all of them by words.
// The description order is fixed for a chat (chat_skill_lists.ranked), so the instructions stay the same from turn
// to turn and the engines' prompt cache holds. A resumed Claude session keeps the instructions it started with: the
// server compares the skills with what that session's instructions listed (chat_skill_lists.listed) and puts what was
// added, changed or removed since then in front of the message (prompt.ts buildTurnContext).
import crypto from 'node:crypto'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { groupOrder, isPersonalSkill, isSkillManifest, skillTier, type Skill } from './skills'

/** characters of the skill lines in the instructions (Claude Code: 1% of a 200K context x 4 characters) */
export const SKILL_LIST_BUDGET = 8_000
/** a description in the list is cut here (the skill tool and find_skills give more) */
export const SKILL_LINE_DESCRIPTION_MAX = 160
/** skills the server puts in front of a message when the list is cut */
export const SKILL_HINTS_MAX = 3
/** find_skills results */
export const FIND_SKILLS_MAX = 10
/** characters of the "changed since this chat started" part of a resumed session's context */
export const SKILL_CHANGES_BUDGET = 2_000
const HALF_LIFE_DAYS = 7
const USAGE_DAYS = 120
const TEAM_USE_WEIGHT = 0.25

const fold = (s: string) => s.normalize('NFC').toLowerCase()
/** one line: white space (also NEL), control characters and line or paragraph separators become one space, so a name or
 * description cannot start a line of its own in the instructions */
export const oneLine = (s: string) => s.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
/** the description as the list shows it: one line, at most 160 characters */
export function shortDescription(d: string, max = SKILL_LINE_DESCRIPTION_MAX): string {
  const t = oneLine(d)
  return [...t].length > max ? [...t].slice(0, max - 1).join('').trimEnd() + '…' : t
}

// ---------------- usage ----------------

/** How much this person used each of `paths` lately: own uses 0.5^(age/7 days) each, other people's a quarter of that.
 * Team and group skills: personal skills are never recorded (admin/skill-usage.ts). */
export function usageScores(db: Database, userId: string, paths: readonly string[], now = new Date()): Map<string, number> {
  const out = new Map<string, number>()
  const team = [...new Set(paths.filter((p) => !isPersonalSkill(p)))]
  if (!team.length) return out
  const from = new Date(now.getTime() - USAGE_DAYS * 86_400_000).toISOString()
  // counted per day (a use's age in whole days: the score changes once a day, not every second)
  for (let i = 0; i < team.length; i += 500) {
    const part = team.slice(i, i + 500)
    let rows: { path: string; day: string; mine: number; n: number }[] = []
    try {
      rows = db.query(`SELECT s.skill_path AS path, substr(t.started_at, 1, 10) AS day, (t.user_id = ?) AS mine, COUNT(*) AS n
        FROM turn_skill_usage s JOIN turns t ON t.id = s.turn_id
        WHERE t.started_at >= ? AND s.skill_path IN (${part.map(() => '?').join(',')}) GROUP BY 1, 2, 3`).all(userId, from, ...part) as typeof rows
    } catch { return out }
    for (const r of rows) {
      const age = Math.max(0, Math.floor((now.getTime() - Date.parse(r.day + 'T00:00:00Z')) / 86_400_000))
      const w = r.n * Math.pow(0.5, age / HALF_LIFE_DAYS) * (r.mine ? 1 : TEAM_USE_WEIGHT)
      out.set(r.path, (out.get(r.path) ?? 0) + w)
    }
  }
  return out
}

/** Which skills get their description first: personal skills (by name), then group and team skills by usage (on a
 * tie a group's before the team's), then by name. */
export function descriptionOrder(skills: readonly Skill[], scores: ReadonlyMap<string, number>): string[] {
  const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  const personal = skills.filter((s) => isPersonalSkill(s.path)).sort(byName)
  const shared = skills.filter((s) => !isPersonalSkill(s.path)).sort((a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || skillTier(a) - skillTier(b) || byName(a, b))
  return [...personal, ...shared].map((s) => s.path)
}

/** The tag a list line gives a skill: " [personal]", " [group: <name>]", " [project: <name>]" (the group's or project's
 * current name, chosen by its people: one line, at most 40 characters, no brackets, through `tag`), or nothing for a
 * team skill. */
export function skillTag(s: Pick<Skill, 'path' | 'group' | 'project'>, tag: (s: string) => string = (x) => x): string {
  if (isPersonalSkill(s.path)) return ' [personal]'
  if (s.project) return ` [project: ${tag(shortDescription(s.project.name.replace(/[[\]]/g, ''), GROUP_TAG_MAX))}]`
  return s.group ? ` [group: ${tag(shortDescription(s.group.name, GROUP_TAG_MAX).replace(/[[\]]/g, ''))}]` : ''
}
const GROUP_TAG_MAX = 40

// ---------------- the list ----------------

export interface SkillList {
  /** the "- name: description" lines (and the "N more" line), in the list's fixed order */
  lines: string[]
  /** every skill the person can use */
  total: number
  /** listed with a description */
  described: number
  /** listed by name only */
  nameOnly: number
  /** not listed at all (even the names did not fit): find_skills finds them */
  unlisted: number
  /** some skills are listed by name only or not at all */
  cut: boolean
  /** the skills, in the list's order */
  skills: Skill[]
}

/** Personal skills first, then each group's (groups in groupOrder), then team skills, then the project's, each by name
 * (the order lines are written in). */
export function listOrder(skills: readonly Skill[]): Skill[] {
  const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  return [...skills].sort((a, b) => skillTier(a) - skillTier(b) || (a.group && b.group ? groupOrder(a.group, b.group) : 0) || byName(a, b))
}

/** A name that two skills share gets its path, so the skill tool can tell them apart. */
function duplicateNames(skills: readonly Skill[]): Set<string> {
  const seen = new Set<string>(), dup = new Set<string>()
  for (const s of skills) { const k = fold(s.name); if (seen.has(k)) dup.add(k); seen.add(k) }
  return dup
}

/**
 * The skill lines within `budget` characters. `order`: which skills get a description (and, when the names alone
 * do not fit, a line) first: descriptionOrder, or the chat's fixed order; skills not in it come after, by name.
 * `tag` writes text into the instructions (prompt.ts neutralizeTags).
 */
export function buildSkillList(skills: readonly Skill[], o: { order?: readonly string[]; budget?: number; tag?: (s: string) => string } = {}): SkillList {
  const budget = o.budget ?? SKILL_LIST_BUDGET
  const tag = o.tag ?? ((s: string) => s)
  const shown = listOrder(skills)
  const dup = duplicateNames(shown)
  const head = (s: Skill) => `- ${tag(oneLine(s.name))}${dup.has(fold(s.name)) ? ` (${s.path})` : ''}${skillTag(s, tag)}`
  const desc = (s: Skill) => (s.description.trim() ? ': ' + tag(shortDescription(s.description)) : '')
  const rank = new Map<string, number>()
  for (const p of o.order ?? []) if (!rank.has(p)) rank.set(p, rank.size)
  const at = new Map(shown.map((s, i) => [s, i]))
  const priority = [...shown].sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity) || at.get(a)! - at.get(b)!)
  // names first: every one that fits (in priority order when they do not all fit), keeping room for the "N more" line
  const names = new Map(shown.map((s) => [s.path, head(s)]))
  let used = [...names.values()].reduce((n, l) => n + l.length + 1, 0)
  const listed = new Set(shown.map((s) => s.path))
  // room for the "… and N more" line when not every name fits
  let limit = budget
  if (used > budget) {
    listed.clear()
    used = 0
    limit = budget - 80
    for (const s of priority) {
      const l = names.get(s.path)!.length + 1
      if (used + l > limit) break
      listed.add(s.path)
      used += l
    }
  }
  // then descriptions, in priority order, while they fit
  const described = new Set<string>()
  for (const s of priority) {
    if (!listed.has(s.path)) continue
    const d = desc(s)
    if (!d || used + d.length > limit) continue
    described.add(s.path)
    used += d.length
  }
  const lines = shown.filter((s) => listed.has(s.path)).map((s) => names.get(s.path)! + (described.has(s.path) ? desc(s) : ''))
  const unlisted = shown.length - listed.size
  if (unlisted > 0) lines.push(`- … and ${unlisted} more skill${unlisted === 1 ? '' : 's'} not listed here: find them with find_skills`)
  const withDescription = shown.filter((s) => s.description.trim()).length
  return {
    lines, total: shown.length, described: described.size, nameOnly: listed.size - described.size, unlisted,
    cut: unlisted > 0 || described.size < withDescription, skills: shown,
  }
}

// ---------------- finding skills by words ----------------

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'at', 'by', 'with', 'from', 'use', 'used', 'when', 'this', 'that',
  'these', 'is', 'are', 'be', 'it', 'its', 'my', 'me', 'our', 'we', 'you', 'your', 'i', 'please', 'can', 'could', 'would', 'will', 'do', 'make', 'md', 'skill', 'skills'])
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/

/** Words of a text for matching: Latin and other words in lower case (stop words left out), Korean (and other runs
 * without spaces: Japanese, Chinese) as two-letter pieces, since particles stick to the word ("견적서를" still finds
 * "견적서"). */
export function skillTokens(text: string): string[] {
  const out: string[] = []
  for (const m of fold(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0]
    const cjk = HANGUL.test(w) || /[\u3040-\u30ff\u4e00-\u9fff]/.test(w)
    if (!cjk) { if ((w.length >= 2 || /\d/.test(w)) && !STOP.has(w)) out.push(w); continue }
    const chars = [...w]
    if (chars.length === 1) { out.push(w); continue }
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!)
  }
  return out
}

const tokenMatch = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && !HANGUL.test(a) && (a.startsWith(b) || b.startsWith(a)))

/** The words of a skill's path that say something, not "skills", "users", the id: `own` is the skill's own file or
 * folder name ("견적서" of skills/영업/견적서/SKILL.md or skills/영업/견적서.md), `parents` the folders above it. */
function pathWords(p: string): { own: string; parents: string } {
  const segs = p.split('/')
  const rest = (segs[0] === 'users' || segs[0] === 'groups' ? segs.slice(3) : segs.slice(1)).filter((s) => s !== 'SKILL.md').map((s) => s.replace(/\.md$/, ''))
  return { own: rest.at(-1) ?? '', parents: rest.slice(0, -1).join(' ') }
}

export interface SkillMatch { skill: Skill; score: number; words: number }

/**
 * Skills that match `query` by words, best first. Each word of the query found in the name or in the skill's own
 * folder or file name counts 3 (people name the folder in their language and the skill in another: "견적서/SKILL.md"
 * with "name: quote"), in the description 1, in the folders above it 1; the whole query inside the name or that folder
 * or file name 3 more. Then usage (as in the list) adds a little. Only skills with a word match. (A project's own
 * skills are in its chats' list; the bonus for folder words shared with the project folder is gone.)
 */
export function matchSkills(skills: readonly Skill[], query: string, o: { scores?: ReadonlyMap<string, number>; limit?: number } = {}): SkillMatch[] {
  const q = [...new Set(skillTokens(query))].slice(0, 200)
  if (!q.length) return []
  const whole = fold(oneLine(query))
  const out: SkillMatch[] = []
  for (const s of skills) {
    const at = pathWords(s.path)
    const name = [...skillTokens(s.name), ...skillTokens(at.own)], description = skillTokens(s.description), parents = skillTokens(at.parents)
    let score = 0, words = 0
    for (const t of q) {
      const n = name.some((x) => tokenMatch(x, t)), d = description.some((x) => tokenMatch(x, t)), p = parents.some((x) => tokenMatch(x, t))
      if (n || d || p) words++
      score += (n ? 3 : 0) + (d ? 1 : 0) + (p ? 1 : 0)
    }
    if (!words) continue
    if (whole.length >= 2 && (fold(s.name).includes(whole) || fold(at.own).includes(whole))) score += 3
    const used = o.scores?.get(s.path) ?? 0
    if (used > 0) score += Math.min(2, Math.log2(1 + used))
    out.push({ skill: s, score, words })
  }
  return out.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name) || a.skill.path.localeCompare(b.skill.path)).slice(0, o.limit ?? FIND_SKILLS_MAX)
}

/** What find_skills gives when no word matches (Korean words against English descriptions, QA): the skills this
 * person uses most (usage as in the list), then their own, then their groups', then by name, at most `limit`. `used`:
 * how many of them were used at all. Only `skills`, the person's own list: nothing they cannot read. */
export function frequentSkills(skills: readonly Skill[], scores: ReadonlyMap<string, number>, limit = FIND_SKILLS_MAX): { skills: Skill[]; used: number } {
  const used = (s: Skill) => scores.get(s.path) ?? 0
  const top = [...skills].sort((a, b) => used(b) - used(a) || skillTier(a) - skillTier(b) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path)).slice(0, limit)
  return { skills: top, used: top.filter((s) => used(s) > 0).length }
}

/** The skills worth naming in front of this message when the list is cut: a few with a clear word match. */
export function hintSkills(skills: readonly Skill[], message: string, o: { scores?: ReadonlyMap<string, number> } = {}): Skill[] {
  return matchSkills(skills, message.slice(0, 2000), { ...o, limit: 20 })
    .filter((m) => m.score >= 3 && (m.words >= 2 || m.score >= 4))
    .slice(0, SKILL_HINTS_MAX).map((m) => m.skill)
}

/** Resolve the name the AI gave the skill tool: the exact name, else the exact path, else the file or folder name, else
 * the name as its list line writes it (with its path, " [personal]", " [group: …]" or " [project: …]"). Only `skills`
 * (the person's own list) are candidates. `ambiguous`: several skills answer to it (their paths tell them apart). */
export function resolveSkill(skills: readonly Skill[], input: string): { skill: Skill } | { ambiguous: Skill[] } | null {
  const exact = resolveName(skills, input)
  if (exact) return exact
  // the name as its list line writes it (buildSkillList): "Weekly (skills/a/weekly.md)", "draft-mail [personal]",
  // "quote [group: Sales]"
  const t = oneLine(input).replace(/ \[personal\]$/i, '').replace(/ \[(?:group|project): [^\]]*\]$/i, '')
  // "name (path)" for any skill of the list, a project's path included
  const asLine = skills.filter((s) => fold(t) === fold(`${oneLine(s.name)} (${s.path})`))
  if (asLine.length === 1) return { skill: asLine[0]! }
  const line = /^(.*?) \(((?:skills|users|groups)\/[^()]+)\)$/.exec(t)
  if (line) {
    const hit = skills.filter((s) => fold(s.path) === fold(line[2]!) && fold(oneLine(s.name)) === fold(line[1]!))
    return hit.length === 1 ? { skill: hit[0]! } : null
  }
  return t !== oneLine(input) ? resolveName(skills, t) : null
}

function resolveName(skills: readonly Skill[], input: string): { skill: Skill } | { ambiguous: Skill[] } | null {
  const want = fold(oneLine(input).replace(/^\//, ''))
  if (!want) return null
  const pick = (hits: Skill[]) => (hits.length === 1 ? { skill: hits[0]! } : hits.length > 1 ? { ambiguous: hits } : null)
  // a personal skill already replaces a group's or the team's skill of the same name in the list, and a group's the
  // team's (skills.ts scanSkills); two groups' skills of one name are ambiguous: their paths tell them apart
  const byName = pick(skills.filter((s) => fold(s.name) === want))
  if (byName) return byName
  const byPath = pick(skills.filter((s) => fold(s.path) === want || (isSkillManifest(s.path) && fold(path.posix.dirname(s.path)) === want)))
  if (byPath) return byPath
  const alias = (s: Skill) => fold(isSkillManifest(s.path) ? path.posix.basename(path.posix.dirname(s.path)) : path.posix.basename(s.path, '.md'))
  const byAlias = skills.filter((s) => alias(s) === want)
  const best = Math.min(...byAlias.map(skillTier))
  return pick(byAlias.filter((s) => skillTier(s) === best))
}

// ---------------- what changed since the session's instructions ----------------

/** What a session's instructions knew of one skill: path, name, and a hash of its name, description and text. */
export interface ListedEntry { p: string; n: string; h: string }
export const listedEntry = (s: Skill): ListedEntry => ({ p: s.path, n: s.name, h: crypto.createHash('sha256').update(`${s.name}\n${s.description}\n${s.body}`).digest('hex').slice(0, 16) })

export interface SkillChanges { added: Skill[]; changed: Skill[]; removed: { path: string; name: string }[] }

export function skillChanges(before: readonly ListedEntry[], now: readonly Skill[]): SkillChanges {
  const old = new Map(before.map((e) => [e.p, e]))
  const cur = new Set(now.map((s) => s.path))
  const added: Skill[] = [], changed: Skill[] = []
  for (const s of now) {
    const e = old.get(s.path)
    if (!e) added.push(s)
    else if (e.h !== listedEntry(s).h) changed.push(s)
  }
  const removed = before.filter((e) => !cur.has(e.p)).map((e) => ({ path: e.p, name: e.n }))
  return { added, changed, removed }
}

/** The part of a resumed session's context about skills (empty when nothing changed). `stale`: the session's
 * instructions are from before this list existed, or from another session: their list may be out of date. */
export function skillChangesText(c: SkillChanges | 'stale', tag: (s: string) => string = (s) => s): string {
  if (c === 'stale') return '## Skills\nThe skill list in your instructions may be out of date. Load a skill with the skill tool by its name; when none you know fits, look with find_skills.'
  if (!c.added.length && !c.changed.length && !c.removed.length) return ''
  const lines: string[] = []
  let used = 0, left = 0
  const add = (l: string) => { if (used + l.length + 1 > SKILL_CHANGES_BUDGET) { left++; return } lines.push(l); used += l.length + 1 }
  const line = (s: Skill) => `${tag(oneLine(s.name))}${skillTag(s, tag)}${s.description.trim() ? ': ' + tag(shortDescription(s.description)) : ''}`
  for (const s of c.added) add(`- added: ${line(s)}`)
  for (const s of c.changed) add(`- changed: ${line(s)} (load it again with the skill tool before you follow it)`)
  for (const r of c.removed) add(`- removed: ${tag(oneLine(r.name))} (no longer available: do not use it)`)
  if (left) lines.push(`- … and ${left} more change${left === 1 ? '' : 's'}: look with find_skills`)
  return ['## Skills changed since this chat started', 'The skill list in your instructions is from the start of this chat. Since then:', ...lines].join('\n')
}

// ---------------- the chat's stored order and listing ----------------

interface ListRow { user_id: string; ranked: string; listed: string | null; session_id: string | null }
const parse = <T>(s: string | null, fallback: T): T => { try { const v = s === null ? fallback : JSON.parse(s); return v ?? fallback } catch { return fallback } }

/** The chat's description order: fixed at its first turn (so the instructions stay the same turn to turn). */
export function chatSkillOrder(db: Database, chatId: string, userId: string, compute: () => string[]): string[] {
  const row = db.query('SELECT user_id, ranked, listed, session_id FROM chat_skill_lists WHERE chat_id = ?').get(chatId) as ListRow | null
  if (row && row.user_id === userId) return parse<string[]>(row.ranked, [])
  const ranked = compute()
  db.query(`INSERT INTO chat_skill_lists (chat_id, user_id, ranked, listed, session_id, updated_at) VALUES (?,?,?,NULL,NULL,?)
    ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, ranked = excluded.ranked, listed = NULL, session_id = NULL, updated_at = excluded.updated_at`)
    .run(chatId, userId, JSON.stringify(ranked), new Date().toISOString())
  return ranked
}

/** Fresh instructions started a Claude session of this chat: they list `skills` (what a resumed turn of that session
 * is compared with). Engines that start fresh every turn never resume, so nothing is recorded for them. */
export function recordListed(db: Database, chatId: string, skills: readonly Skill[], sessionId: string): void {
  db.query('UPDATE chat_skill_lists SET listed = ?, session_id = ?, updated_at = ? WHERE chat_id = ?')
    .run(JSON.stringify(skills.map(listedEntry)), sessionId, new Date().toISOString(), chatId)
}

/** What a resumed session's instructions listed, or 'stale' when they were written for another session (or before),
 * or for another person (a shared project chat: one person's skills are never compared with another's). */
export function listedFor(db: Database, chatId: string, sessionId: string, userId: string): ListedEntry[] | 'stale' {
  const row = db.query('SELECT user_id, ranked, listed, session_id FROM chat_skill_lists WHERE chat_id = ?').get(chatId) as ListRow | null
  if (!row || row.user_id !== userId || row.session_id !== sessionId || row.listed === null) return 'stale'
  return parse<ListedEntry[]>(row.listed, [])
}
