// "스킬로 제안" → [등록] / [거절] (docs/DECISIONS.md "팀 스킬 관리"). Anyone can turn an answer from their own chat or a
// file in their own folder into a suggested skill. It is stored here on the server, never in skills/, and only two
// kinds of people ever see it: the person who suggested it, and the people who manage its target folder (WRITE on
// it, computed from the folder rules when asked). A manager reviews it (preview, edit name / description / content)
// and registers it (the file is written under skills/ with the manager's own rights: audited, version history, the
// owner and admins are told) or turns it down. The suggester sees the status and hears the result.
import type { Database } from 'bun:sqlite'
import { Locale, type SkillSuggestion, type SkillsOverview } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { loadPrincipal, RuleSet, atLeast, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { isSkillFolder, managedSkillFolders, managesSkillFolder, skillFolders } from './managers'
import { st } from './text'

interface Row {
  id: string; suggester_id: string; target_folder: string; name: string; description: string; content: string
  source_kind: 'message' | 'file'; source_ref: string | null; status: SkillSuggestion['status']; reviewer_id: string | null
  review_note: string | null; result_path: string | null; created_at: string; reviewed_at: string | null
}
const COLS = 'id, suggester_id, target_folder, name, description, content, source_kind, source_ref, status, reviewer_id, review_note, result_path, created_at, reviewed_at'
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))

function person(ctx: AppContext, id: string): Principal {
  const p = loadPrincipal(ctx.db, id)
  if (!p) fail('forbidden')
  return p!
}
const nameOf = (db: Database, id: string | null) => (id ? { id, name: (db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | null)?.name ?? id } : null)

function toSuggestion(ctx: AppContext, r: Row, viewer: Principal, rules: RuleSet): SkillSuggestion {
  return {
    id: r.id, status: r.status, targetFolder: r.target_folder, name: r.name, description: r.description, content: r.content,
    source: { kind: r.source_kind, path: r.source_kind === 'file' ? r.source_ref : null },
    suggester: nameOf(ctx.db, r.suggester_id)!, reviewer: nameOf(ctx.db, r.reviewer_id), reviewNote: r.review_note, resultPath: r.result_path,
    createdAt: r.created_at, reviewedAt: r.reviewed_at, canReview: managesSkillFolder(ctx, viewer, r.target_folder, rules),
  }
}

/** Who may see one suggestion: its suggester and the managers of its target folder. */
function visible(ctx: AppContext, r: Row, viewer: Principal, rules: RuleSet): boolean {
  return r.suggester_id === viewer.id || managesSkillFolder(ctx, viewer, r.target_folder, rules)
}

function getRow(db: Database, id: string): Row | null {
  return db.query(`SELECT ${COLS} FROM skill_suggestions WHERE id = ?`).get(id) as Row | null
}

/** Active people who manage `folder` (owner and admins included), with their language. */
function managersOf(ctx: AppContext, folder: string): { id: string; locale: Locale }[] {
  const rules = RuleSet.load(ctx.db)
  const def = teamDefaultLocale(ctx.db)
  const users = ctx.db.query("SELECT id, locale FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string; locale: string }[]
  const out: { id: string; locale: Locale }[] = []
  for (const u of users) {
    const p = loadPrincipal(ctx.db, u.id)
    if (p && atLeast(rules.access(p, segsOf(folder)), 'write')) out.push({ id: u.id, locale: Locale.safeParse(u.locale).success ? (u.locale as Locale) : def })
  }
  return out
}
function localeOf(ctx: AppContext, id: string): Locale {
  const v = Locale.safeParse((ctx.db.query('SELECT locale FROM users WHERE id = ?').get(id) as { locale: string } | null)?.locale)
  return v.success ? v.data : teamDefaultLocale(ctx.db)
}
function notify(ctx: AppContext, userId: string, code: string, message: string, link: string) {
  try { ctx.services.realtime.publish(userId, { type: 'notice', data: { level: 'info', code, message, link } }) } catch (err) { ctx.log.warn('skill notice failed', { err }) }
}

/** The actual on-disk spelling of a skills folder the person can see, or a validation error (same for hidden and missing). */
function targetFolder(ctx: AppContext, p: Principal, typed: string, locale: Locale): string {
  try {
    const r = authorize(ctx.files.fx, ctx.files.rules(), p, typed, 'read')
    if (r.st!.isDirectory() && isSkillFolder(r.rel)) return r.rel
  } catch (e) { if (!(e instanceof Denied || e instanceof ToolError)) throw e }
  return fail('validation', st('folderNotSkills', locale), { fields: { 'body.targetFolder': 'not a skills folder you can see' } })
}

export function skillsOverview(ctx: AppContext, userId: string): SkillsOverview {
  const p = person(ctx, userId)
  const rules = RuleSet.load(ctx.db)
  const managed = managedSkillFolders(ctx, p, rules)
  const suggest = skillFolders(ctx).filter((f) => atLeast(rules.access(p, segsOf(f)), 'read'))
  const pending = ctx.db.query(`SELECT ${COLS} FROM skill_suggestions WHERE status = 'pending'`).all() as Row[]
  return {
    managedFolders: managed,
    suggestFolders: suggest,
    pendingReview: pending.filter((r) => managesSkillFolder(ctx, p, r.target_folder, rules)).length,
    myPending: pending.filter((r) => r.suggester_id === userId).length,
  }
}

export function createSuggestion(ctx: AppContext, userId: string, b: { source: { kind: 'message'; chatId: string; messageId: string } | { kind: 'file'; path: string }; targetFolder: string; name: string; description: string; content: string }, locale: Locale): SkillSuggestion {
  const p = person(ctx, userId)
  let ref: string
  if (b.source.kind === 'message') {
    // an answer in one of the caller's own chats (not deleted): nobody suggests from someone else's conversation
    const m = ctx.db.query('SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND c.id = ? AND c.user_id = ? AND c.deleted_at IS NULL')
      .get(b.source.messageId, b.source.chatId, userId) as { id: string } | null
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
  }
  ctx.db.query(`INSERT INTO skill_suggestions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.suggester_id, row.target_folder, row.name, row.description, row.content,
    row.source_kind, row.source_ref, row.status, null, null, null, row.created_at, null)
  audit(ctx.db, { actor: userId, action: 'skills.suggest', target: target, detail: { suggestionId: row.id, name: row.name, source: row.source_kind } })
  for (const m of managersOf(ctx, target)) {
    if (m.id === userId) continue
    notify(ctx, m.id, 'skill_suggested', st('suggested', m.locale, { who: p.name, name: row.name, folder: target + '/' }), `/skills?review=${row.id}`)
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
    .filter((r) => (q.scope === 'mine' ? r.suggester_id === userId : managesSkillFolder(ctx, p, r.target_folder, rules)))
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return { items: page.map((r) => toSuggestion(ctx, r, p, rules)), nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null }
}

export function getSuggestion(ctx: AppContext, userId: string, id: string): SkillSuggestion {
  const p = person(ctx, userId)
  const rules = RuleSet.load(ctx.db)
  const r = getRow(ctx.db, id)
  if (!r || !visible(ctx, r, p, rules)) return fail('not_found')
  return toSuggestion(ctx, r, p, rules)
}

/** The row a reviewer acts on: 404 when the caller cannot see it at all, 403 for the suggester who does not manage it. */
function forReview(ctx: AppContext, p: Principal, id: string, locale: Locale): Row {
  const rules = RuleSet.load(ctx.db)
  const r = getRow(ctx.db, id)
  if (!r || !visible(ctx, r, p, rules)) return fail('not_found')
  if (!managesSkillFolder(ctx, p, r.target_folder, rules)) fail('forbidden', st('notManager', locale))
  if (r.status !== 'pending') fail('conflict', st('alreadyReviewed', locale))
  return r
}

/** "주간 보고서" -> "주간-보고서" (a file name the team folder accepts). */
export function skillFileName(name: string): string {
  const s = name.normalize('NFC').replace(/[<>:"|?*\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)
  return s || 'skill'
}

/** The skill file: the header the server reads (skills.ts parseSkill), then the steps. */
export function skillFileText(name: string, description: string, content: string): string {
  const one = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()
  return `---\nname: ${one(name)}\ndescription: ${one(description)}\n---\n${content.replace(/^\s*\n/, '')}${content.endsWith('\n') ? '' : '\n'}`
}

export function approveSuggestion(ctx: AppContext, userId: string, id: string, b: { targetFolder: string; name: string; description: string; content: string; fileName?: string }, locale: Locale): SkillSuggestion {
  const p = person(ctx, userId)
  const r = forReview(ctx, p, id, locale)
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
  // the manager's own save (folder rules decide; version history, audit and the owner / admin notice follow from it)
  let saved: string
  try {
    ctx.files.humanSave(userId, rel, Buffer.from(skillFileText(b.name, b.description, b.content), 'utf8'), null)
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
  if (r.suggester_id !== userId) notify(ctx, r.suggester_id, 'skill_suggestion_reviewed', st('approved', localeOf(ctx, r.suggester_id), { name: b.name.trim(), path: saved! }), `/skills?mine=${r.id}`)
  return toSuggestion(ctx, getRow(ctx.db, r.id)!, p, RuleSet.load(ctx.db))
}

export function rejectSuggestion(ctx: AppContext, userId: string, id: string, note: string | undefined, locale: Locale): SkillSuggestion {
  const p = person(ctx, userId)
  const r = forReview(ctx, p, id, locale)
  const now = new Date().toISOString()
  const done = ctx.db.query("UPDATE skill_suggestions SET status = 'rejected', reviewer_id = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'").run(userId, now, note?.trim() || null, r.id)
  if (!done.changes) fail('conflict', st('alreadyReviewed', locale))
  audit(ctx.db, { actor: userId, action: 'skills.suggestion_rejected', target: r.target_folder, detail: { suggestionId: r.id, suggester: r.suggester_id } })
  if (r.suggester_id !== userId) {
    const L = localeOf(ctx, r.suggester_id)
    notify(ctx, r.suggester_id, 'skill_suggestion_reviewed', st('rejected', L, { name: r.name, note: note?.trim() ? ` (${note.trim()})` : '' }), `/skills?mine=${r.id}`)
  }
  return toSuggestion(ctx, getRow(ctx.db, r.id)!, p, RuleSet.load(ctx.db))
}
