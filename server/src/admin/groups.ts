// Groups (tab 1 `groups`, tab 2): creating a group also creates groups/<name>/, its folders row and the rule
// "this group writes" in one go. Membership changes can narrow access, so they go through afterAccessChange (H7).
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from 'hono'
import type { z } from 'zod'
import type { Group, GroupBody, Locale, UpdateGroupBody } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { badSegment, foldKey } from '../policy/names'
import { msg } from '../auth/messages'
import { audit } from './audit'
import { afterAccessChange, captureState, ensureFolderRow, foldersWithRuleOf, keepProjectFloors, resolveFolderPath, type SeenStates } from './folders'
import { notifyTemplateOffers } from '../notifications/service'
import { noTeamRoom } from '../rooms/service'
import { afterPrune, pruneAssignments, type Pruned } from '../credentials/assignees'

type In<T extends z.ZodType> = z.output<T>

interface GroupRow { id: string; name: string; description: string | null }

function members(ctx: AppContext, id: string): string[] {
  return (ctx.db.query('SELECT m.user_id FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.deleted_at IS NULL ORDER BY m.user_id').all(id) as { user_id: string }[]).map((r) => r.user_id)
}
const toGroup = (ctx: AppContext, g: GroupRow): Group => ({ id: g.id, name: g.name, description: g.description, memberIds: members(ctx, g.id) })

export function listGroups(ctx: AppContext): Group[] {
  return (ctx.db.query('SELECT id, name, description FROM groups ORDER BY name').all() as GroupRow[]).map((g) => toGroup(ctx, g))
}

/** One group, or null. */
export function getGroup(ctx: AppContext, id: string): Group | null {
  const g = ctx.db.query('SELECT id, name, description FROM groups WHERE id = ?').get(id) as GroupRow | null
  return g ? toGroup(ctx, g) : null
}

/** Where a change came from when not the web screens: the remote MCP connector's group tools pass 'connector', and the
 * audit lines of the change (group.*, folder.access_lost) say so. `seen`: filled with the access states before and
 * after when the change ran afterAccessChange (the connector says what changed from them). Nothing else differs. */
export interface ChangeFrom { via?: 'connector'; seen?: SeenStates }
const viaOf = (o: ChangeFrom) => (o.via ? { via: o.via } : {})
const byOf = (actor: string, target: string, o: ChangeFrom) => ({ actor, target, ...viaOf(o), ...(o.seen ? { seen: o.seen } : {}) })

function checkMembers(ctx: AppContext, ids: readonly string[], locale: Locale): string[] {
  const uniq = [...new Set(ids)]
  if (!uniq.length) return []
  const found = (ctx.db.query(`SELECT id FROM users WHERE deleted_at IS NULL AND id IN (${uniq.map(() => '?').join(',')})`).all(...uniq) as { id: string }[]).length
  if (found !== uniq.length) fail('validation', msg('unknownUsers', locale), { fields: { 'body.memberIds': 'unknown person' } })
  return uniq
}

function nameTaken(ctx: AppContext, name: string, except?: string): boolean {
  return !!ctx.db.query('SELECT 1 FROM groups WHERE lower(name) = lower(?) AND id IS NOT ?').get(name, except ?? null)
}

/**
 * Folder name for a new group: the group name itself when it is a valid name, else "group-<short id>". Never an
 * existing folder (on disk or in `folders`, compared like the file tools compare names): a new group must not
 * inherit the files of an old one (e.g. a group renamed or deleted earlier kept its groups/<name>/ folder).
 */
function folderNameFor(ctx: AppContext, name: string, id: string): string {
  const n = name.normalize('NFC').trim()
  const base = n && !badSegment(n) && !n.includes('/') ? n : `group-${id.slice(-8)}`
  const taken = new Set<string>()
  try { for (const e of fs.readdirSync(path.join(ctx.files.fx.root, 'groups'))) taken.add(foldKey(e)) } catch {}
  for (const r of ctx.db.query("SELECT path FROM folders WHERE path LIKE 'groups/%'").all() as { path: string }[]) taken.add(foldKey(r.path.split('/')[1] ?? ''))
  let out = base
  for (let i = 2; taken.has(foldKey(out)); i++) out = `${base}-${i}`
  return out
}

export function createGroup(c: Context<AppEnv>, ctx: AppContext, b: In<typeof GroupBody>): Group {
  return createGroupAs(ctx, c.get('auth')!.user.id, b, c.get('locale'))
}

/** The id of the group named `name` (any case), or null. */
export function groupIdByName(ctx: AppContext, name: string): string | null {
  return (ctx.db.query('SELECT id FROM groups WHERE lower(name) = lower(?)').get(name) as { id: string } | null)?.id ?? null
}

/** The folder of a group (its folders row's path), or null when it has none. */
export function groupFolder(ctx: AppContext, id: string): string | null {
  return (ctx.db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(id) as { path: string } | null)?.path ?? null
}

/** Make a group as `actorId` (Admin › Groups, and the welcome steps' team group): the group, its folder groups/<name>/
 * with its folders row and the rule "this group writes", audited as group.create. */
/** Make a group as `actorId`. `room: false` (the welcome steps' team group): the group gets no team room — its room row
 * is written archived with the group, so rooms/service.ts sync (run at the end, afterAccessChange) never makes one
 * (docs/DECISIONS.md "One room for the whole team"). */
export function createGroupAs(ctx: AppContext, actorId: string, b: { name: string; description?: string | null; memberIds: readonly string[]; room?: false }, locale: Locale, from: ChangeFrom = {}): Group {
  const auth = { user: { id: actorId } }
  if (nameTaken(ctx, b.name)) fail('conflict', msg('groupNameTaken', locale), { fields: { 'body.name': 'taken' } })
  const memberIds = checkMembers(ctx, b.memberIds, locale)
  const id = newId()
  const before = captureState(ctx.db)
  const folder = resolveFolderPath(ctx, `groups/${folderNameFor(ctx, b.name, id)}`, { create: true, locale })
  ctx.db.transaction(() => {
    const f = ensureFolderRow(ctx.db, folder.path)
    ctx.db.query('INSERT INTO groups (id, name, description, folder_id) VALUES (?, ?, ?, ?)').run(id, b.name, b.description ?? null, f.id)
    const add = ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)')
    for (const u of memberIds) add.run(id, u)
    ctx.db.query(`INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by, updated_at) VALUES (?, ?, 'group', ?, 'write', ?, ?)
      ON CONFLICT(folder_id, subject_type, subject_id) DO UPDATE SET access = 'write', updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(newId(), f.id, id, auth.user.id, new Date().toISOString())
    audit(ctx.db, { actor: auth.user.id, action: 'group.create', target: id, detail: { name: b.name, folder: folder.path, memberIds, ...viaOf(from) } })
    if (b.room === false) noTeamRoom(ctx.db, id)
  })()
  afterAccessChange(ctx, before, byOf(auth.user.id, id, from))
  // templates for this group reach its members now (security review 2, #1)
  notifyTemplateOffers(ctx)
  return toGroup(ctx, ctx.db.query('SELECT id, name, description FROM groups WHERE id = ?').get(id) as GroupRow)
}

export function updateGroup(c: Context<AppEnv>, ctx: AppContext, id: string, b: In<typeof UpdateGroupBody>): Group {
  return updateGroupAs(ctx, c.get('auth')!.user.id, id, b, c.get('locale'))
}

/** Rename a group, change its description or replace its members, as `actorId` (Admin › Groups, the connector). */
export function updateGroupAs(ctx: AppContext, actorId: string, id: string, b: { name?: string; description?: string | null; memberIds?: readonly string[] }, locale: Locale, from: ChangeFrom = {}): Group {
  const auth = { user: { id: actorId } }
  const g = ctx.db.query('SELECT id, name, description FROM groups WHERE id = ?').get(id) as GroupRow | null
  if (!g) fail('not_found')
  if (b.name !== undefined && nameTaken(ctx, b.name, id)) fail('conflict', msg('groupNameTaken', locale), { fields: { 'body.name': 'taken' } })
  const memberIds = b.memberIds ? checkMembers(ctx, b.memberIds, locale) : undefined
  const before = captureState(ctx.db)
  ctx.db.transaction(() => {
    if (b.name !== undefined) ctx.db.query('UPDATE groups SET name = ? WHERE id = ?').run(b.name, id)
    if (b.description !== undefined) ctx.db.query('UPDATE groups SET description = ? WHERE id = ?').run(b.description, id)
    if (memberIds) {
      ctx.db.query('DELETE FROM group_members WHERE group_id = ?').run(id)
      const add = ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)')
      for (const u of memberIds) add.run(id, u)
    }
    audit(ctx.db, { actor: auth.user.id, action: 'group.update', target: id, detail: { name: b.name, description: b.description, memberIds, ...viaOf(from) } })
  })()
  if (memberIds) { afterAccessChange(ctx, before, byOf(auth.user.id, id, from)); notifyTemplateOffers(ctx) }
  return toGroup(ctx, ctx.db.query('SELECT id, name, description FROM groups WHERE id = ?').get(id) as GroupRow)
}

/** Delete a group and every rule that names it; its folder stays on disk (then only admins see it until new rules). */
export function deleteGroup(c: Context<AppEnv>, ctx: AppContext, id: string): void {
  deleteGroupAs(ctx, c.get('auth')!.user.id, id)
}

/** deleteGroup as `actorId` (Admin › Groups, the connector). Returns the team AI connections that named the group: one
 * it was the last group or person of is switched off (credentials/assignees.ts), never left to serve the whole team. */
export function deleteGroupAs(ctx: AppContext, actorId: string, id: string, from: ChangeFrom = {}): Pruned[] {
  const auth = { user: { id: actorId } }
  const g = ctx.db.query('SELECT id, name FROM groups WHERE id = ?').get(id) as { id: string; name: string } | null
  if (!g) fail('not_found')
  const before = captureState(ctx.db)
  let pruned: Pruned[] = []
  ctx.db.transaction(() => {
    const ruled = foldersWithRuleOf(ctx.db, 'group', id)
    ctx.db.query("DELETE FROM folder_rules WHERE subject_type = 'group' AND subject_id = ?").run(id)
    // a project folder in projects/ never ends with no rules (admin/folders.ts keepProjectFloors)
    keepProjectFloors(ctx.db, ruled, actorId)
    ctx.db.query('DELETE FROM groups WHERE id = ?').run(id)
    ctx.db.query("DELETE FROM budgets WHERE subject_type = 'group' AND subject_id = ?").run(id)
    // team connections' and templates' rules: a group nobody can see any more would block every later change of them
    ctx.db.query("DELETE FROM integration_access WHERE subject_type = 'group' AND subject_id = ?").run(id)
    ctx.db.query("DELETE FROM integration_template_access WHERE subject_type = 'group' AND subject_id = ?").run(id)
    ctx.db.query("DELETE FROM drive_team_share_access WHERE subject_type = 'group' AND subject_id = ?").run(id)
    // AI connections assigned to it: the rows go; one left with no group or person is switched off, not team-wide
    pruned = pruneAssignments(ctx.db, auth.user.id, new Date().toISOString())
    const off = pruned.filter((p) => p.switchedOff).map((p) => ({ id: p.id, label: p.label }))
    audit(ctx.db, { actor: auth.user.id, action: 'group.delete', target: id, detail: { name: g!.name, ...(off.length ? { aiConnectionsOff: off } : {}), ...viaOf(from) } })
  })()
  afterPrune(ctx, auth.user.id, pruned)
  afterAccessChange(ctx, before, byOf(auth.user.id, id, from))
  return pruned
}
