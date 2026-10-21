// "Who may manage team skills" (docs/DECISIONS.md "팀 스킬 관리"): a skill manager is anyone with WRITE on skills/ or
// one of its folders. The owner and admins always are (they write everywhere); Admin > 멤버 / 그룹 "팀 스킬 관리" adds or
// removes a person's or a group's own write rule on skills/ (or skills/재무/ …) through the folder-rule machinery
// (admin/folders.ts: same rows Admin > 폴더 권한 shows, same audit, same "access changed" handling). There is no
// separate permission table: what the folder rules say is what the server enforces, for people and their AI alike.
import fs from 'node:fs'
import path from 'node:path'
import type { Locale, SkillManagersResponse } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { msg } from '../auth/messages'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { badSegment } from '../policy/names'
import { audit } from '../admin/audit'
import {
  afterAccessChange, captureState, dropFolderRow, ensureFolderRow, getFolderByPath, replaceRules, resolveFolderPath, rulesOf,
} from '../admin/folders'
import { SKILLS_DIR } from './guard'
import { st } from './text'

const MAX_DEPTH = 3 // skills/a/b
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
export const isSkillFolder = (p: string) => { const s = segsOf(p); return s[0] === SKILLS_DIR && s.length <= MAX_DEPTH }

/** skills/ and its folders on disk (two levels below). */
export function skillFolders(ctx: AppContext): string[] {
  const root = ctx.files.fx.root
  const out = new Set<string>()
  const walk = (segs: string[]) => {
    let st: fs.Stats
    try { st = fs.lstatSync(path.join(root, ...segs)) } catch { return }
    if (!st.isDirectory()) return
    out.add(segs.join('/'))
    if (segs.length >= MAX_DEPTH) return
    let names: string[] = []
    try { names = fs.readdirSync(path.join(root, ...segs)).sort() } catch {}
    for (const n of names) if (!n.startsWith('.') && badSegment(n) === null) walk([...segs, n])
  }
  walk([SKILLS_DIR])
  return [...out].sort()
}

/** The skills folders `p` may change, top-most only (write on skills/ covers its folders). */
export function managedSkillFolders(ctx: AppContext, p: Principal, rules = RuleSet.load(ctx.db)): string[] {
  const can = skillFolders(ctx).filter((f) => atLeast(rules.access(p, segsOf(f)), 'write'))
  return can.filter((f) => !can.some((g) => g !== f && f.startsWith(g + '/')))
}

/** Does `p` manage (may write) the skills folder `folder`? */
export function managesSkillFolder(ctx: AppContext, p: Principal, folder: string, rules = RuleSet.load(ctx.db)): boolean {
  return isSkillFolder(folder) && atLeast(rules.access(p, segsOf(folder)), 'write')
}

export function listSkillManagers(ctx: AppContext): SkillManagersResponse {
  const rows = ctx.db.query(`SELECT f.path, r.subject_type, r.subject_id FROM folder_rules r JOIN folders f ON f.id = r.folder_id
    WHERE r.access = 'write' AND r.subject_type IN ('user', 'group') AND (f.path = ? OR f.path LIKE ?) ORDER BY f.path, r.subject_type, r.subject_id`)
    .all(SKILLS_DIR, `${SKILLS_DIR}/%`) as { path: string; subject_type: 'user' | 'group'; subject_id: string }[]
  return { folders: skillFolders(ctx), items: rows.map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, path: r.path })) }
}

/**
 * Turn "팀 스킬 관리" on or off for one person or group on one skills folder: their own write rule there is added or
 * removed (other rules of the folder stay). A new folder is created on disk. A folder row left without any rule by
 * this (a subfolder made only for this) is removed again, so it falls back to the rules of skills/.
 */
export function setSkillManager(ctx: AppContext, actor: string, b: { subjectType: 'user' | 'group'; subjectId: string; path: string; enabled: boolean }, locale: Locale): SkillManagersResponse {
  const db = ctx.db
  if (b.subjectType === 'user') {
    const u = db.query("SELECT role FROM users WHERE id = ? AND deleted_at IS NULL").get(b.subjectId) as { role: string } | null
    if (!u) fail('validation', msg('unknownUsers', locale), { fields: { 'body.subjectId': 'unknown person' } })
    if (u!.role === 'owner' || u!.role === 'admin') fail('validation', st('managerNotSubject', locale), { fields: { 'body.subjectId': 'owner and admins always manage skills' } })
  } else if (!db.query('SELECT 1 FROM groups WHERE id = ?').get(b.subjectId)) {
    fail('validation', msg('unknownGroups', locale), { fields: { 'body.subjectId': 'unknown group' } })
  }
  if (!isSkillFolder(b.path)) fail('validation', st('folderNotSkills', locale), { fields: { 'body.path': 'not a skills folder' } })
  let p: string
  let created = false
  if (b.enabled) {
    const r = resolveFolderPath(ctx, b.path, { create: true, locale })
    p = r.path
    created = r.created
    if (!isSkillFolder(p)) fail('validation', st('folderNotSkills', locale), { fields: { 'body.path': 'not a skills folder' } })
  } else {
    p = b.path
    if (!getFolderByPath(db, p)) {
      // the actual on-disk spelling of a folder typed in another form
      try { p = resolveFolderPath(ctx, b.path, { create: false, locale }).path } catch { return listSkillManagers(ctx) }
    }
  }
  const before = captureState(db)
  const changed = db.transaction(() => {
    const existing = getFolderByPath(db, p)
    if (!b.enabled && !existing) return false
    const row = existing ?? ensureFolderRow(db, p)
    const old = rulesOf(db, row.id)
    const mine = (r: { subjectType: string; subjectId: string | null }) => r.subjectType === b.subjectType && r.subjectId === b.subjectId
    const next = old.filter((r) => !mine(r))
    if (b.enabled) next.push({ subjectType: b.subjectType, subjectId: b.subjectId, access: 'write' } as never)
    const had = old.find(mine)
    if (b.enabled ? had?.access === 'write' : !had) return false
    replaceRules(db, row.id, next, actor)
    audit(db, { actor, action: 'folder.rules', target: p, detail: { before: old, after: next, via: 'skill_managers' } })
    audit(db, { actor, action: 'skills.manager', target: p, detail: { subjectType: b.subjectType, subjectId: b.subjectId, enabled: b.enabled } })
    if (!next.length && p !== SKILLS_DIR && !db.query('SELECT 1 FROM groups WHERE folder_id = ?').get(row.id) && !db.query('SELECT 1 FROM projects WHERE folder_path = ?').get(p)) dropFolderRow(db, row.id)
    return true
  })()
  if (changed) afterAccessChange(ctx, before, { actor, target: p, created: created ? [p] : [] })
  return listSkillManagers(ctx)
}
