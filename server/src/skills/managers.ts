// "Who may manage team skills" (docs/DECISIONS.md "팀 스킬 관리"): a skill manager is anyone with WRITE on skills/ or
// one of its folders. The owner and admins always are (they write everywhere); the Team skills page's "who can edit"
// dialog (web/src/pages/admin/SkillManagers.tsx) adds a person's or a group's own write rule on skills/ and removes one
// on skills/ (or skills/재무/ …) through the folder-rule machinery (admin/folders.ts: same rows Admin > 폴더 권한
// shows, same audit, same "access changed" handling). There is no separate permission table: what the folder rules say
// is what the server enforces, for people and their AI alike. A group's skills (groups/<folder>/skills/,
// docs/DECISIONS.md "Group skills") are managed by the members of that group who may write the folder (every member by
// default: the group writes its own folder); the dialog stays team-only.
import fs from 'node:fs'
import path from 'node:path'
import type { Locale, SkillManagersResponse } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { msg } from '../auth/messages'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { badSegment } from '../policy/names'
import { audit } from '../admin/audit'
import { isTeamDefaultFolder } from '../admin/folder-keep'
import {
  afterAccessChange, captureState, dropFolderRow, ensureFolderRow, getFolderByPath, replaceRules, resolveFolderPath, rulesOf,
} from '../admin/folders'
import { groupOfFolder, groupSkillRoots, type GroupSkillRoot } from '../chat/skills'
import { SKILLS_DIR } from './guard'
import { st } from './text'

const MAX_DEPTH = 3 // skills/a/b
const GROUP_DEPTH = 5 // groups/<folder>/skills/a/b
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
/** skills/ or one of its folders (two levels below): the team's skills folders (the "who can edit" dialog's rules). */
export const isSkillFolder = (p: string) => { const s = segsOf(p); return s[0] === SKILLS_DIR && s.length <= MAX_DEPTH }
/** groups/<folder>/skills or one of its folders (two levels below): a group's skills folders (docs/DECISIONS.md
 * "Group skills"). */
export const isGroupSkillFolder = (p: string) => { const s = segsOf(p); return s[0] === 'groups' && !!s[1] && s[2] === SKILLS_DIR && s.length >= 3 && s.length <= GROUP_DEPTH }
/** The group skills root (groups/<folder>/skills) of a group skills folder. */
const groupRootOfFolder = (p: string) => segsOf(p).slice(0, 3).join('/')

/** The skills roots of `p`'s groups (whether or not the folder is there yet), with the group: `p` manages one when
 * they may write it (every member by default). Only members: the owner and admins write every group folder, but a
 * group's skills are its members' (managesSkillFolder). */
export function groupSkillFolders(ctx: AppContext, p: Principal): GroupSkillRoot[] {
  return groupSkillRoots(ctx.db, p)
}
/** The group skills folders of `p`'s groups on disk (the root always, then two levels below it). */
function groupSkillFoldersOnDisk(ctx: AppContext, p: Principal): string[] {
  const out: string[] = []
  for (const g of groupSkillFolders(ctx, p)) {
    out.push(g.root)
    const walk = (segs: string[]) => {
      let names: string[] = []
      try { names = fs.readdirSync(path.join(ctx.files.fx.root, ...segs)).sort() } catch { return }
      for (const n of names) {
        if (n.startsWith('.') || badSegment(n) !== null) continue
        let st: fs.Stats
        try { st = fs.lstatSync(path.join(ctx.files.fx.root, ...segs, n)) } catch { continue }
        if (!st.isDirectory()) continue
        out.push([...segs, n].join('/'))
        if (segs.length + 1 < GROUP_DEPTH) walk([...segs, n])
      }
    }
    walk(g.root.split('/'))
  }
  return out
}

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

/** The skills folders `p` may change, top-most only (write on skills/ covers its folders): the team's, then their
 * groups' (a group's skills root even before it is on disk). */
export function managedSkillFolders(ctx: AppContext, p: Principal, rules = RuleSet.load(ctx.db)): string[] {
  const can = [...skillFolders(ctx), ...groupSkillFoldersOnDisk(ctx, p)].filter((f) => atLeast(rules.access(p, segsOf(f)), 'write'))
  return can.filter((f) => !can.some((g) => g !== f && f.startsWith(g + '/')))
}

/** The skills folders `p` can see, to suggest into: the team's they may read and their groups' (docs/DECISIONS.md
 * "Group skills"). */
export function visibleSkillFolders(ctx: AppContext, p: Principal, rules = RuleSet.load(ctx.db)): string[] {
  return [...skillFolders(ctx), ...groupSkillFoldersOnDisk(ctx, p)].filter((f) => atLeast(rules.access(p, segsOf(f)), 'read'))
}

/** Does `p` manage (may write) the skills folder `folder`? A group's skills folder only for a member of that group
 * (the owner and admins outside it write the folder, but do not manage the group's skills). */
export function managesSkillFolder(ctx: AppContext, p: Principal, folder: string, rules = RuleSet.load(ctx.db)): boolean {
  if (isGroupSkillFolder(folder)) {
    const root = groupRootOfFolder(folder).normalize('NFC')
    return groupSkillFolders(ctx, p).some((g) => g.root === root) && atLeast(rules.access(p, segsOf(folder)), 'write')
  }
  return isSkillFolder(folder) && atLeast(rules.access(p, segsOf(folder)), 'write')
}

/** The group whose skills root holds `folder`, or null (a team folder, or a folder no group has). */
export function groupOfSkillFolder(ctx: AppContext, folder: string): { id: string; name: string } | null {
  return isGroupSkillFolder(folder) ? groupOfFolder(ctx.db, segsOf(folder).slice(0, 2).join('/')) : null
}

export function listSkillManagers(ctx: AppContext): SkillManagersResponse {
  const rows = ctx.db.query(`SELECT f.path, r.subject_type, r.subject_id FROM folder_rules r JOIN folders f ON f.id = r.folder_id
    WHERE r.access = 'write' AND r.subject_type IN ('user', 'group') AND (f.path = ? OR f.path LIKE ?) ORDER BY f.path, r.subject_type, r.subject_id`)
    .all(SKILLS_DIR, `${SKILLS_DIR}/%`) as { path: string; subject_type: 'user' | 'group'; subject_id: string }[]
  return { folders: skillFolders(ctx), items: rows.map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, path: r.path })) }
}

/**
 * Turn "팀 스킬 관리" on or off for one person or group on one skills folder (the Team skills page's dialog turns it on
 * for skills/ only; Folder permissions hands over a subfolder): their own write rule there is added or
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
    // skills/ keeps at least one rule (stage 1, as PUT .../rules refuses none): the last one going leaves "admins: write"
    // in its place, which changes nobody's access (the owner and admins write everywhere before any rule; no member is
    // named by it, so members fall through to the folder above exactly as with no rules)
    if (!next.length && isTeamDefaultFolder(p, ctx.files.fx.caseInsensitive)) next.push({ subjectType: 'role', subjectId: 'admin', access: 'write' } as never)
    replaceRules(db, row.id, next, actor)
    audit(db, { actor, action: 'folder.rules', target: p, detail: { before: old, after: next, via: 'skill_managers' } })
    audit(db, { actor, action: 'skills.manager', target: p, detail: { subjectType: b.subjectType, subjectId: b.subjectId, enabled: b.enabled } })
    if (!next.length && p !== SKILLS_DIR && !db.query('SELECT 1 FROM groups WHERE folder_id = ?').get(row.id) && !db.query('SELECT 1 FROM projects WHERE folder_path = ?').get(p)) dropFolderRow(db, row.id)
    return true
  })()
  if (changed) afterAccessChange(ctx, before, { actor, target: p, created: created ? [p] : [] })
  return listSkillManagers(ctx)
}
