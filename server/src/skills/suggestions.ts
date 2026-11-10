// "스킬로 제안" → [등록] / [거절] (docs/DECISIONS.md "팀 스킬 관리"). Anyone can turn an answer from their own chat or a
// file in their own folder into a suggested skill. It is stored here on the server, never in skills/, and only two
// kinds of people ever see it: the person who suggested it, and the people who manage its target folder (WRITE on
// it, computed from the folder rules when asked). A manager reviews it (preview, edit name / description / content)
// and registers it (the file is written under skills/ with the manager's own rights: audited, version history, the
// owner and admins are told) or turns it down. The suggester sees the status and hears the result.
// Members contribute (docs/DECISIONS.md "MC"): a member's suggestion may carry one skill folder from their own computer,
// read in the browser (lib/skillScan.ts: a skill with a key never leaves it) and sent with others as one batch
// (contributeSkills). The server checks each folder again with the checks of 내 스킬 가져오기 (share-check.ts: secrets,
// scripts, plugin, size, names, paths on the member's computer, a team skill of the same name) and keeps what passes
// outside the team files (skill_suggestion_files, migration 257). No AI judges it: an owner or admin does, and only
// they see and approve such a suggestion; approving writes skills/<name>/ with its files as them and never moves the
// invite's or the 7-day goal's skill (onboarding/welcome.ts recordShared is not called). One Inbox line per batch;
// at most CONTRIBUTE_LIMITS.batch folders in one send and CONTRIBUTE_LIMITS.open suggestions of a member waiting.
import type { Database } from 'bun:sqlite'
import {
  CONTRIBUTE_LIMITS, Locale, readSkillTitle, SKILL_CONTENT_MAX, skillTitle,
  type ContributedSkills, type ContributeRefusal, type ContributeSkillsBody, type ShareApp, type ShareCandidate, type SkillSuggestion, type SkillsOverview,
} from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { loadPrincipal, RuleSet, atLeast, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { notifySkillSuggestion } from '../notifications/service'
import { groupOfSkillFolder, groupSkillFolders, isGroupSkillFolder, isSkillFolder, managedSkillFolders, managesSkillFolder, visibleSkillFolders } from './managers'
import { st } from './text'
import { checkSkill, listSkills, listTeamSkills, SKILL_NAME_MAX, writableGroupSkillRoots, type SkillProblem } from '../chat/skills'
import { checkShare, needsScripts, readHeader, writeSkillMd } from './share-check'
import fs from 'node:fs'
import path from 'node:path'
import { SKILLS_DIR } from './guard'
import { buildSkillList, descriptionOrder, usageScores } from '../chat/skill-list'
import { severalAuthors } from '../chat/shared'
import { neutralizeTags, teamRuleFiles } from '../chat/prompt'

interface Row {
  id: string; suggester_id: string; target_folder: string; name: string; description: string; content: string
  source_kind: 'message' | 'file'; source_ref: string | null; status: SkillSuggestion['status']; reviewer_id: string | null
  review_note: string | null; result_path: string | null; created_at: string; reviewed_at: string | null
  /** 'folder': a skill folder from the suggester's computer (source_kind stays 'file': its CHECK; migration 257) */
  source_detail: string | null; batch_id: string | null; folder_info: string | null
}
const COLS = 'id, suggester_id, target_folder, name, description, content, source_kind, source_ref, status, reviewer_id, review_note, result_path, created_at, reviewed_at, source_detail, batch_id, folder_info'
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))

/** What the review shows of a skill folder (folder_info): never a file's content. */
type FolderInfo = NonNullable<SkillSuggestion['folder']>
const isFolder = (r: Pick<Row, 'source_detail'>) => r.source_detail === 'folder'
function folderOf(r: Row): FolderInfo | null {
  if (!isFolder(r)) return null
  try { return JSON.parse(r.folder_info ?? 'null') as FolderInfo | null } catch { return null }
}
const staff = (p: Principal) => p.role === 'owner' || p.role === 'admin'
/** May register or turn it down: a manager of its target folder; a skill folder from a member's computer only an owner
 * or admin (docs/DECISIONS.md "MC": what a member's own folder holds is untrusted until one of them read it). */
function reviews(ctx: AppContext, p: Principal, r: Row, rules: RuleSet): boolean {
  return managesSkillFolder(ctx, p, r.target_folder, rules) && (!isFolder(r) || staff(p))
}
/** A skill folder's name: lowercase a–z, 0–9 and hyphens, at most 64 (chat/skills.ts checkSkill wants it so). */
const VALID_NAME = (n: string) => n.length <= SKILL_NAME_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)
/** The suggester's suggestions that still wait (every kind counts towards CONTRIBUTE_LIMITS.open). */
const openOf = (db: Database, userId: string) => (db.query("SELECT COUNT(*) AS n FROM skill_suggestions WHERE suggester_id = ? AND status = 'pending'").get(userId) as { n: number }).n
function openLimit(ctx: AppContext, userId: string, adding: number, locale: Locale): void {
  const open = openOf(ctx.db, userId)
  if (open + adding <= CONTRIBUTE_LIMITS.open) return
  fail('conflict', st('openLimit', locale, { n: String(CONTRIBUTE_LIMITS.open), left: String(Math.max(0, CONTRIBUTE_LIMITS.open - open)) }), { params: { reason: 'open_limit', open, limit: CONTRIBUTE_LIMITS.open } })
}

function person(ctx: AppContext, id: string): Principal {
  const p = loadPrincipal(ctx.db, id)
  if (!p) fail('forbidden')
  return p!
}
const nameOf = (db: Database, id: string | null) => (id ? { id, name: (db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | null)?.name ?? id } : null)

function toSuggestion(ctx: AppContext, r: Row, viewer: Principal, rules: RuleSet): SkillSuggestion {
  return {
    id: r.id, status: r.status, targetFolder: r.target_folder, name: r.name, description: r.description, content: r.content,
    source: isFolder(r) ? { kind: 'folder', path: null } : { kind: r.source_kind, path: r.source_kind === 'file' ? r.source_ref : null },
    suggester: nameOf(ctx.db, r.suggester_id)!, reviewer: nameOf(ctx.db, r.reviewer_id), reviewNote: r.review_note, resultPath: r.result_path,
    createdAt: r.created_at, reviewedAt: r.reviewed_at, canReview: reviews(ctx, viewer, r, rules),
    ...(isFolder(r) ? { folder: folderOf(r), batchId: r.batch_id } : {}),
    // a group's skills folder: the group by its name now
    ...((() => { const g = groupOfSkillFolder(ctx, r.target_folder); return g ? { targetGroup: g } : {} })()),
  }
}

/** Who may see one suggestion: its suggester and the people who may review it (reviews). */
function visible(ctx: AppContext, r: Row, viewer: Principal, rules: RuleSet): boolean {
  return r.suggester_id === viewer.id || reviews(ctx, viewer, r, rules)
}

function getRow(db: Database, id: string): Row | null {
  return db.query(`SELECT ${COLS} FROM skill_suggestions WHERE id = ?`).get(id) as Row | null
}

/** The active owners and admins, with their language: who reviews a member's skill folders. */
function staffOf(ctx: AppContext): { id: string; locale: Locale }[] {
  const def = teamDefaultLocale(ctx.db)
  return (ctx.db.query("SELECT id, locale FROM users WHERE role IN ('owner', 'admin') AND status = 'active' AND deleted_at IS NULL ORDER BY created_at").all() as { id: string; locale: string }[])
    .map((u) => ({ id: u.id, locale: Locale.safeParse(u.locale).success ? (u.locale as Locale) : def }))
}

/** Active people who manage `folder` (owner and admins included for a team folder; a group's folder: its members who
 * may write it), with their language. */
function managersOf(ctx: AppContext, folder: string): { id: string; locale: Locale }[] {
  const rules = RuleSet.load(ctx.db)
  const def = teamDefaultLocale(ctx.db)
  const users = ctx.db.query("SELECT id, locale FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string; locale: string }[]
  const out: { id: string; locale: Locale }[] = []
  for (const u of users) {
    const p = loadPrincipal(ctx.db, u.id)
    if (p && managesSkillFolder(ctx, p, folder, rules)) out.push({ id: u.id, locale: Locale.safeParse(u.locale).success ? (u.locale as Locale) : def })
  }
  return out
}
function localeOf(ctx: AppContext, id: string): Locale {
  const v = Locale.safeParse((ctx.db.query('SELECT locale FROM users WHERE id = ?').get(id) as { locale: string } | null)?.locale)
  return v.success ? v.data : teamDefaultLocale(ctx.db)
}
/** The live banner, and an inbox entry for later (R2-SKILL-12): a person who is offline now sees it on return. */
function notify(ctx: AppContext, userId: string, code: 'skill_suggested' | 'skill_suggestion_reviewed', message: string, link: string, suggestionId: string) {
  try { ctx.services.realtime.publish(userId, { type: 'notice', data: { level: 'info', code, message, link } }) } catch (err) { ctx.log.warn('skill notice failed', { err }) }
  notifySkillSuggestion(ctx, userId, code === 'skill_suggested' ? 'skill.suggested' : 'skill.reviewed', suggestionId)
}

/** The actual on-disk spelling of a skills folder the person can see, or a validation error (same for hidden and
 * missing). A group's skills folder only for a member of that group; its root may not be on disk yet (the first skill
 * saved there makes it). */
function targetFolder(ctx: AppContext, p: Principal, typed: string, locale: Locale): string {
  try {
    const r = authorize(ctx.files.fx, ctx.files.rules(), p, typed, 'read', { mustExist: false })
    const mine = isGroupSkillFolder(r.rel) && groupSkillFolders(ctx, p).some((g) => r.rel === g.root || r.rel.startsWith(g.root + '/'))
    if (r.exists && r.st!.isDirectory() && (isSkillFolder(r.rel) || mine)) return r.rel
    if (!r.exists && mine && groupSkillFolders(ctx, p).some((g) => g.root === r.rel)) return r.rel
  } catch (e) { if (!(e instanceof Denied || e instanceof ToolError)) throw e }
  return fail('validation', st('folderNotSkills', locale), { fields: { 'body.targetFolder': 'not a skills folder you can see' } })
}

export function skillsOverview(ctx: AppContext, userId: string): SkillsOverview {
  const p = person(ctx, userId)
  const rules = RuleSet.load(ctx.db)
  const managed = managedSkillFolders(ctx, p, rules)
  const suggest = visibleSkillFolders(ctx, p, rules)
  const pending = ctx.db.query(`SELECT ${COLS} FROM skill_suggestions WHERE status = 'pending'`).all() as Row[]
  // what the AI's list holds of this person's skills (no chat: the order by usage now)
  const skills = listSkills(ctx.files, p)
  const list = buildSkillList(skills, { order: descriptionOrder(skills, usageScores(ctx.db, userId, skills.map((s) => s.path))), tag: neutralizeTags })
  const teamRules = teamRuleFiles(ctx.files, p)
  // open share proposals others made to a group whose skills folder this person may write (docs/DECISIONS.md "Group
  // skills"): what they may apply, beside the suggestions
  const writable = writableGroupSkillRoots(ctx.files, p).map((g) => g.id)
  let sharesToReview = 0
  if (writable.length) {
    try {
      sharesToReview = (ctx.db.query(`SELECT COUNT(*) AS n FROM skill_shares WHERE target_group_id IN (${writable.map(() => '?').join(',')}) AND created_by <> ? AND status IN ('checking','ready') AND expires_at > ?`)
        .get(...writable, userId, new Date().toISOString()) as { n: number }).n
    } catch { sharesToReview = 0 }
  }
  return {
    managedFolders: managed,
    suggestFolders: suggest,
    pendingReview: pending.filter((r) => reviews(ctx, p, r, rules)).length,
    myPending: pending.filter((r) => r.suggester_id === userId).length,
    sharesToReview,
    aiList: { skills: list.total, described: list.described, nameOnly: list.nameOnly, unlisted: list.unlisted, cut: list.cut, rules: teamRules.total, rulesFollowed: teamRules.followed },
  }
}

export function createSuggestion(ctx: AppContext, userId: string, b: { source: { kind: 'message'; chatId: string; messageId: string } | { kind: 'file'; path: string }; targetFolder: string; name: string; description: string; content: string }, locale: Locale): SkillSuggestion {
  const p = person(ctx, userId)
  openLimit(ctx, userId, 1, locale)
  let ref: string
  if (b.source.kind === 'message') {
    // an answer in one of the caller's own chats (not deleted): nobody suggests from someone else's conversation, nor
    // from a shared project chat (several people wrote it; docs/DECISIONS.md "Shared project chats"), also once it stopped
    // being shared (a deleted project's, the rollback guard: chat/shared.ts severalAuthors)
    const m = ctx.db.query('SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND c.id = ? AND c.user_id = ? AND c.deleted_at IS NULL AND c.shared_at IS NULL')
      .get(b.source.messageId, b.source.chatId, userId) as { id: string } | null
    if (m && severalAuthors(ctx.db, b.source.chatId)) fail('not_found', st('sourceNotYours', locale, { me: userId }))
    if (!m) fail('not_found', st('sourceNotYours', locale, { me: userId }))
    ref = b.source.messageId
  } else {
    // a file in the caller's own folder that they can read (same answer for missing and hidden)
    let rel: string | null = null
    try {
      const r = authorize(ctx.files.fx, ctx.files.rules(), p, b.source.path, 'read')
      if (!r.st!.isDirectory() && r.segs[0] === 'users' && r.segs[1] === userId) rel = r.rel
    } catch (e) { if (!(e instanceof Denied || e instanceof ToolError)) throw e }
    if (!rel) fail('not_found', st('sourceNotYours', locale, { me: userId }))
    ref = rel!
  }
  const target = targetFolder(ctx, p, b.targetFolder, locale)
  const row: Row = {
    id: newId(), suggester_id: userId, target_folder: target, name: b.name.trim(), description: b.description.replace(/\s+/g, ' ').trim(), content: b.content,
    source_kind: b.source.kind, source_ref: ref, status: 'pending', reviewer_id: null, review_note: null, result_path: null, created_at: new Date().toISOString(), reviewed_at: null,
    source_detail: null, batch_id: null, folder_info: null,
  }
  ctx.db.query(`INSERT INTO skill_suggestions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`).run(row.id, row.suggester_id, row.target_folder, row.name, row.description, row.content,
    row.source_kind, row.source_ref, row.status, null, null, null, row.created_at, null)
  audit(ctx.db, { actor: userId, action: 'skills.suggest', target: target, detail: { suggestionId: row.id, name: row.name, source: row.source_kind } })
  for (const m of managersOf(ctx, target)) {
    if (m.id === userId) continue
    notify(ctx, m.id, 'skill_suggested', st('suggested', m.locale, { who: p.name, name: row.name, folder: target + '/' }), `/skills?review=${row.id}`, row.id)
  }
  return toSuggestion(ctx, row, p, RuleSet.load(ctx.db))
}

export function listSuggestions(ctx: AppContext, userId: string, q: { scope: 'mine' | 'review'; status?: SkillSuggestion['status']; cursor?: string; limit?: number }) {
  const p = person(ctx, userId)
  const rules = RuleSet.load(ctx.db)
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
  const where: string[] = []
  const args: string[] = []
  if (q.scope === 'mine') { where.push('suggester_id = ?'); args.push(userId) }
  if (q.status) { where.push('status = ?'); args.push(q.status) }
  if (q.cursor) {
    const [at, id] = q.cursor.split('|')
    if (!at || !id) fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
    where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(at!, at!, id!)
  }
  // review: only what the caller manages (filtered here, so nothing of anyone else's folder leaves the server)
  const rows = (ctx.db.query(`SELECT ${COLS} FROM skill_suggestions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (status = 'pending') DESC, created_at DESC, id DESC`).all(...args) as Row[])
    .filter((r) => (q.scope === 'mine' ? r.suggester_id === userId : reviews(ctx, p, r, rules)))
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return { items: page.map((r) => toSuggestion(ctx, r, p, rules)), nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null }
}

export function getSuggestion(ctx: AppContext, userId: string, id: string): SkillSuggestion {
  const p = person(ctx, userId)
  const rules = RuleSet.load(ctx.db)
  const r = getRow(ctx.db, id)
  if (!r || !visible(ctx, r, p, rules)) return fail('not_found')
  const out = toSuggestion(ctx, r, p, rules)
  // a skill folder's reviewer reads every file that would go with it, not only SKILL.md (what the team's AI will read)
  if (out.folder && out.canReview && r.status === 'pending') {
    const kept = new Map((ctx.db.query('SELECT path, data FROM skill_suggestion_files WHERE suggestion_id = ?').all(r.id) as { path: string; data: Uint8Array }[]).map((f) => [f.path, f.data]))
    out.folder = { ...out.folder, files: out.folder.files.map((f) => {
      const d = f.path === 'SKILL.md' ? null : kept.get(f.path)
      return d && !IMAGE_FILE.test(f.path) ? { ...f, text: Buffer.from(d).toString('utf8') } : f
    }) }
  }
  return out
}
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i
/** A file of a member's folder that would make the team's AI (or a browser opening it) run something: a command or a
 * code fence of a shell or a language (share-check.ts needsScripts, now on every text file, not only SKILL.md), or
 * active content in a page or an image (a script tag, an event handler, a javascript: address). The owner's import
 * checks SKILL.md only; a member's folder is read by someone else first, so every file is checked. */
function runsSomething(rel: string, text: string): boolean {
  if (needsScripts(text, [])) return true
  return /\.(?:html?|svg|xml)$/i.test(rel) && /<script\b|\bjavascript:|\son[a-z]+\s*=|<iframe\b|<object\b|<embed\b/i.test(text)
}

/** The row a reviewer acts on: 404 when the caller cannot see it at all, 403 for the suggester who does not manage it. */
function forReview(ctx: AppContext, p: Principal, id: string, locale: Locale): Row {
  const rules = RuleSet.load(ctx.db)
  const r = getRow(ctx.db, id)
  if (!r || !visible(ctx, r, p, rules)) return fail('not_found')
  if (!reviews(ctx, p, r, rules)) fail('forbidden', st('notManager', locale))
  if (r.status !== 'pending') fail('conflict', st('alreadyReviewed', locale))
  return r
}

/** "주간 보고서" -> "주간-보고서" (a file name the team folder accepts). */
export function skillFileName(name: string): string {
  const s = name.normalize('NFC').replace(/[<>:"|?*\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)
  return s || 'skill'
}

/** The skill file: the header the server reads (skills.ts checkSkill), then the steps. Each header value is written
 * as a YAML double-quoted string (JSON string syntax), so a quote, bracket, colon or "#" in a value never breaks the
 * header. Both the legacy reader and the YAML reader decode it to the typed text. */
export function skillFileText(name: string, description: string, content: string): string {
  // Each character that splits a line for the header reader (CR, LF, VT, FF, U+0085, U+2028, U+2029) becomes a
  // space. JSON.stringify writes U+2028 and U+2029 raw, and the reader regex does not match a line that has them.
  const one = (s: string) => JSON.stringify(s.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ').trim())
  return `---\nname: ${one(name)}\ndescription: ${one(description)}\n---\n${content.replace(/^\s*\n/, '')}${content.endsWith('\n') ? '' : '\n'}`
}

/** The text to save at `rel` for a registered suggestion, or the reason it would not load there. The server never
 * saves a skill file that its own reader rejects (for example a SKILL.md whose name is not its folder name). */
export function registeredSkillText(rel: string, name: string, description: string, content: string):
  { ok: true; text: string } | { ok: false; problem: SkillProblem; field: string } {
  const text = skillFileText(name, description, content)
  const r = checkSkill(text, rel)
  if (r.ok) return { ok: true, text }
  const field = r.problem === 'name' || r.problem === 'name_folder' ? 'body.name'
    : r.problem === 'description' ? 'body.description'
    : r.problem === 'location' ? 'body.fileName' : 'body.content'
  return { ok: false, problem: r.problem, field }
}

export function approveSuggestion(ctx: AppContext, userId: string, id: string, b: { targetFolder: string; name: string; description: string; content: string; fileName?: string }, locale: Locale): SkillSuggestion {
  const p = person(ctx, userId)
  const r = forReview(ctx, p, id, locale)
  if (isFolder(r)) return approveFolder(ctx, p, r, b, locale)
  // a suggestion without a folder keeps its limits (the body's are a skill folder's)
  if (b.name.trim().length > 60) fail('validation', undefined, { fields: { 'body.name': 'at most 60 characters' } })
  if (b.description.length > 300) fail('validation', undefined, { fields: { 'body.description': 'at most 300 characters' } })
  if (b.content.length > SKILL_CONTENT_MAX) fail('validation', undefined, { fields: { 'body.content': `at most ${SKILL_CONTENT_MAX} characters` } })
  const target = targetFolder(ctx, p, b.targetFolder, locale)
  if (!managesSkillFolder(ctx, p, target)) fail('forbidden', st('notManager', locale))
  const file = `${skillFileName(b.fileName?.replace(/\.md$/i, '') ?? b.name)}.md`
  if (badSegment(file)) fail('validation', undefined, { fields: { 'body.fileName': badSegment(file)! } })
  const rel = `${target}/${file}`
  let exists = false
  try { exists = authorize(ctx.files.fx, ctx.files.rules(), p, rel, 'write', { createDirs: true }).exists } catch (e) {
    if (e instanceof Denied || e instanceof ToolError) fail('forbidden', st('notManager', locale))
    throw e
  }
  if (exists) fail('conflict', st('fileExists', locale, { path: rel }))
  const written = registeredSkillText(rel, b.name, b.description, b.content)
  if (!written.ok) return fail('validation', st('notLoadable', locale, { problem: written.problem }), { fields: { [written.field]: written.problem } })
  // the manager's own save (folder rules decide; version history, audit and the owner / admin notice follow from it)
  let saved: string
  try {
    ctx.files.humanSave(userId, rel, Buffer.from(written.text, 'utf8'), null)
    saved = authorize(ctx.files.fx, ctx.files.rules(), p, rel, 'read').rel
  } catch (e) {
    if (e instanceof Denied) fail('forbidden', st('notManager', locale))
    if (e instanceof ToolError) fail('conflict', e.message)
    throw e
  }
  const now = new Date().toISOString()
  const done = ctx.db.query(`UPDATE skill_suggestions SET status = 'approved', reviewer_id = ?, reviewed_at = ?, result_path = ?, target_folder = ?, name = ?, description = ?, content = ?
    WHERE id = ? AND status = 'pending'`).run(userId, now, saved!, target, b.name.trim(), b.description.replace(/\s+/g, ' ').trim(), b.content, r.id)
  if (!done.changes) fail('conflict', st('alreadyReviewed', locale))
  audit(ctx.db, { actor: userId, action: 'skills.suggestion_approved', target: saved!, detail: { suggestionId: r.id, suggester: r.suggester_id } })
  if (r.suggester_id !== userId) notify(ctx, r.suggester_id, 'skill_suggestion_reviewed', st('approved', localeOf(ctx, r.suggester_id), { name: b.name.trim(), path: saved! }), `/skills?mine=${r.id}`, r.id)
  return toSuggestion(ctx, getRow(ctx.db, r.id)!, p, RuleSet.load(ctx.db))
}

export function rejectSuggestion(ctx: AppContext, userId: string, id: string, note: string | undefined, locale: Locale): SkillSuggestion {
  const p = person(ctx, userId)
  const r = forReview(ctx, p, id, locale)
  const now = new Date().toISOString()
  const done = ctx.db.query("UPDATE skill_suggestions SET status = 'rejected', reviewer_id = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'").run(userId, now, note?.trim() || null, r.id)
  if (!done.changes) fail('conflict', st('alreadyReviewed', locale))
  // a skill folder's files go: turned down, it never reaches the team
  ctx.db.query('DELETE FROM skill_suggestion_files WHERE suggestion_id = ?').run(r.id)
  audit(ctx.db, { actor: userId, action: 'skills.suggestion_rejected', target: r.target_folder, detail: { suggestionId: r.id, suggester: r.suggester_id, ...(isFolder(r) ? { kind: 'folder' } : {}) } })
  if (r.suggester_id !== userId) {
    const L = localeOf(ctx, r.suggester_id)
    notify(ctx, r.suggester_id, 'skill_suggestion_reviewed', st('rejected', L, { name: r.name, note: note?.trim() ? ` (${note.trim()})` : '' }), `/skills?mine=${r.id}`, r.id)
  }
  return toSuggestion(ctx, getRow(ctx.db, r.id)!, p, RuleSet.load(ctx.db))
}

// ---------------------------------------------------------------- members contribute (docs/DECISIONS.md "MC")

/** The body limit of POST /api/skills/suggestions/batch: CONTRIBUTE_LIMITS.batch skill folders of up to a skill's
 * size each, images as base64. */
export const CONTRIBUTE_BODY_MAX = 16 * 1024 * 1024

/**
 * A member's skill folders, as one batch: each checked again (share-check.ts checkShare, the checks of 내 스킬
 * 가져오기), each that passes one suggestion with its files kept outside the team files; refused with its reason:
 * a key or a key file, scripts the skill needs, a plugin's skill, too big, not a skill, or a folder of that name of
 * theirs still waiting. Members only (owners and admins bring theirs with 내 스킬 가져오기). At most
 * CONTRIBUTE_LIMITS.batch folders (the body) and CONTRIBUTE_LIMITS.open of their suggestions waiting (409, nothing
 * stored). The owners and admins get one Inbox line and one live notice for the batch.
 */
export function contributeSkills(ctx: AppContext, userId: string, body: ContributeSkillsBody, locale: Locale): ContributedSkills {
  const p = person(ctx, userId)
  if (p.role !== 'member') fail('forbidden', st('contributeMembers', locale))
  const team = listTeamSkills(ctx.files, p).map((s) => ({ name: s.name, path: s.path, title: skillTitle(s) }))
  const checked = checkShare({ source: 'browser', skills: body.skills }, team)
  const app: ShareApp = body.app ?? 'claude'
  const waiting = new Set((ctx.db.query("SELECT name FROM skill_suggestions WHERE suggester_id = ? AND status = 'pending' AND source_detail = 'folder'").all(userId) as { name: string }[]).map((x) => x.name))
  const refused: ContributeRefusal[] = []
  const kept: ShareCandidate[] = []
  for (const c of checked.candidates) {
    if (c.group === 'excluded') refused.push({ name: c.name, reason: c.reason as ContributeRefusal['reason'], detail: c.detail })
    else if (waiting.has(c.name)) refused.push({ name: c.name, reason: 'pending', detail: null })
    else if ((checked.files.get(c.name) ?? []).some((f) => f.path !== 'SKILL.md' && !IMAGE_FILE.test(f.path) && runsSomething(f.path, f.data.toString('utf8')))) {
      // nothing of it is stored
      checked.files.delete(c.name)
      refused.push({ name: c.name, reason: 'scripts', detail: null })
    } else kept.push(c)
  }
  if (!kept.length) {
    audit(ctx.db, { actor: userId, action: 'skills.contribute', target: SKILLS_DIR, detail: { batchId: null, app, kept: 0, refused: refused.length } })
    return { batchId: null, items: [], refused }
  }
  openLimit(ctx, userId, kept.length, locale)
  const batchId = newId()
  const now = new Date().toISOString()
  const rows: Row[] = []
  ctx.db.transaction(() => {
    for (const c of kept) {
      const files = checked.files.get(c.name) ?? []
      const header = files[0] ? readHeader(files[0].data.toString('utf8')) : null
      const info: FolderInfo = {
        app, title: readSkillTitle(header?.metadata.find(([k]) => k === 'title')?.[1]), files: c.files, scriptsDropped: c.scriptsDropped,
        personalPath: c.personalPath, sameName: c.sameName,
      }
      const row: Row = {
        id: newId(), suggester_id: userId, target_folder: SKILLS_DIR, name: c.name, description: c.description, content: header?.body ?? '',
        source_kind: 'file', source_ref: null, status: 'pending', reviewer_id: null, review_note: null, result_path: null, created_at: now, reviewed_at: null,
        source_detail: 'folder', batch_id: batchId, folder_info: JSON.stringify(info),
      }
      ctx.db.query(`INSERT INTO skill_suggestions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,?,?)`).run(row.id, row.suggester_id, row.target_folder, row.name,
        row.description, row.content, row.source_kind, null, row.status, row.created_at, row.source_detail, row.batch_id, row.folder_info)
      for (const f of files) ctx.db.query('INSERT INTO skill_suggestion_files (suggestion_id, path, data) VALUES (?, ?, ?)').run(row.id, f.path, f.data)
      rows.push(row)
    }
  })()
  audit(ctx.db, { actor: userId, action: 'skills.contribute', target: SKILLS_DIR, detail: { batchId, app, kept: rows.length, refused: refused.length, names: rows.map((x) => x.name) } })
  for (const m of staffOf(ctx)) {
    if (m.id === userId) continue
    notify(ctx, m.id, 'skill_suggested', st('contributed', m.locale, { who: p.name, n: String(rows.length) }), `/skills?batch=${batchId}`, batchId)
  }
  const rules = RuleSet.load(ctx.db)
  return { batchId, items: rows.map((r) => toSuggestion(ctx, r, p, rules)), refused }
}

/** For the Inbox line of a batch (notifications/service.ts): who sent it, while their account is there, and how many
 * skills it held; null when `id` is not a batch (a suggestion sent alone). */
export function contributionOf(db: Database, id: string): { name: string | null; n: number } | null {
  const r = db.query(`SELECT s.suggester_id AS id, COUNT(*) AS n, MAX(CASE WHEN u.deleted_at IS NULL THEN u.name END) AS name
    FROM skill_suggestions s LEFT JOIN users u ON u.id = s.suggester_id WHERE s.batch_id = ? GROUP BY s.suggester_id`).get(id) as { id: string; n: number; name: string | null } | null
  return r && r.n > 0 ? { name: r.name?.trim() || null, n: r.n } : null
}

/** Register a skill folder: skills/<name>/ (or under the folder picked) with its files, SKILL.md last, as the owner or
 * admin who approves (their own save: folder rules, versions, the skills/ change log); anything written is moved back
 * to the trash when a later file fails. The reviewer may change the name (a valid folder name), the description and
 * the SKILL.md body; the rest of its header stays as the server kept it. */
function approveFolder(ctx: AppContext, p: Principal, r: Row, b: { targetFolder: string; name: string; description: string; content: string }, locale: Locale): SkillSuggestion {
  if (!staff(p)) fail('forbidden', st('notManager', locale))
  const target = targetFolder(ctx, p, b.targetFolder, locale)
  if (!managesSkillFolder(ctx, p, target)) fail('forbidden', st('notManager', locale))
  const name = b.name.trim()
  if (!VALID_NAME(name)) fail('validation', st('folderName', locale), { fields: { 'body.name': 'lowercase letters, digits and hyphens, at most 64' } })
  // a skill goes into a folder of skills, never inside another skill's folder
  const segs = target.split('/')
  for (let i = 2; i <= segs.length; i++) {
    let inSkill = false
    try { inSkill = authorize(ctx.files.fx, ctx.files.rules(), p, `${segs.slice(0, i).join('/')}/SKILL.md`, 'read', { mustExist: false }).exists } catch { inSkill = false }
    if (inSkill) fail('validation', st('folderNotSkills', locale), { fields: { 'body.targetFolder': 'inside a skill folder' } })
  }
  const files = ctx.db.query('SELECT path, data FROM skill_suggestion_files WHERE suggestion_id = ? ORDER BY path').all(r.id) as { path: string; data: Uint8Array }[]
  const manifest = files.find((f) => f.path === 'SKILL.md')
  const header = manifest ? readHeader(Buffer.from(manifest.data).toString('utf8')) : null
  if (!header) return fail('conflict', st('folderGone', locale))
  const folder = `${target}/${name}`
  const rel = `${folder}/SKILL.md`
  const text = writeSkillMd({ ...header, body: b.content }, { name, description: b.description.replace(/\s+/g, ' ').trim() })
  const check = checkSkill(text, rel)
  if (!check.ok) {
    const field = check.problem === 'name' || check.problem === 'name_folder' ? 'body.name' : check.problem === 'description' ? 'body.description' : 'body.content'
    return fail('validation', st('notLoadable', locale, { problem: check.problem }), { fields: { [field]: check.problem } })
  }
  let there: { exists: boolean; segs: string[] } | null = null
  try { const a = authorize(ctx.files.fx, ctx.files.rules(), p, folder, 'read', { mustExist: false }); there = { exists: a.exists, segs: a.segs } } catch (e) {
    if (e instanceof Denied) fail('forbidden', st('notManager', locale))
    // a name the team folder does not take (CON, NUL …): the name is the problem, not a folder that is there
    if (e instanceof ToolError) fail('validation', st('folderName', locale), { fields: { 'body.name': e.message } })
    throw e
  }
  if (there!.exists) fail('conflict', st('fileExists', locale, { path: `${folder}/` }))
  const written: string[] = []
  let at = folder
  try {
    for (const f of [...files.filter((x) => x !== manifest), { path: 'SKILL.md', data: Buffer.from(text, 'utf8') }]) {
      at = `${folder}/${f.path}`
      // no "last seen" hash: a file that appeared meanwhile is refused, never replaced
      ctx.files.humanSave(p.id, at, Buffer.from(f.data), null)
      written.push(at)
    }
  } catch (e) {
    // back as before: the files written go to the trash, and the folders this approval made (empty now) go, so a
    // retry does not find a half folder that is "already there"
    for (const w of written.reverse()) { try { ctx.files.deleteFile(p.id, w) } catch { /* best effort */ } }
    removeEmptyDirs(path.join(ctx.files.fx.root, ...there!.segs))
    if (e instanceof Denied) fail('forbidden', st('notManager', locale))
    if (e instanceof ToolError) fail('conflict', st('folderNotSaved', locale, { path: at }))
    throw e
  }
  let saved = rel
  try { saved = authorize(ctx.files.fx, ctx.files.rules(), p, rel, 'read').rel } catch { /* written above */ }
  const now = new Date().toISOString()
  const done = ctx.db.query(`UPDATE skill_suggestions SET status = 'approved', reviewer_id = ?, reviewed_at = ?, result_path = ?, target_folder = ?, name = ?, description = ?, content = ?
    WHERE id = ? AND status = 'pending'`).run(p.id, now, saved, target, name, b.description.replace(/\s+/g, ' ').trim(), b.content, r.id)
  if (!done.changes) fail('conflict', st('alreadyReviewed', locale))
  // its files are team files now: the copy kept for the review goes
  ctx.db.query('DELETE FROM skill_suggestion_files WHERE suggestion_id = ?').run(r.id)
  audit(ctx.db, { actor: p.id, action: 'skills.suggestion_approved', target: saved, detail: { suggestionId: r.id, suggester: r.suggester_id, kind: 'folder', files: written.length } })
  if (r.suggester_id !== p.id) {
    const title = folderOf(r)?.title
    notify(ctx, r.suggester_id, 'skill_suggestion_reviewed', st('approved', localeOf(ctx, r.suggester_id), { name: title || name, path: saved }), `/skills?mine=${r.id}`, r.id)
  }
  return toSuggestion(ctx, getRow(ctx.db, r.id)!, p, RuleSet.load(ctx.db))
}

/** Remove `dir` and the folders under it while they hold nothing (deepest first); anything with a file stays. */
function removeEmptyDirs(dir: string): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) removeEmptyDirs(path.join(dir, e.name))
  try { fs.rmdirSync(dir) } catch { /* not empty, or gone */ }
}
