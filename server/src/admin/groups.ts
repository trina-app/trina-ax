// Groups (tab 1 `groups`, tab 2): creating a group also creates groups/<name>/, its folders row and the rule
// "this group writes" in one go. Membership changes can narrow access, so they go through afterAccessChange (H7).
import type { Context } from 'hono'
import type { z } from 'zod'
import type { Group, GroupBody, Locale, UpdateGroupBody } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { badSegment } from '../policy/names'
import { msg } from '../auth/messages'
import { audit } from './audit'
import { afterAccessChange, captureState, ensureFolderRow, resolveFolderPath } from './folders'

type In<T extends z.ZodType> = z.output<T>

interface GroupRow { id: string; name: string; description: string | null }

function members(ctx: AppContext, id: string): string[] {
  return (ctx.db.query('SELECT m.user_id FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.deleted_at IS NULL ORDER BY m.user_id').all(id) as { user_id: string }[]).map((r) => r.user_id)
}
const toGroup = (ctx: AppContext, g: GroupRow): Group => ({ id: g.id, name: g.name, description: g.description, memberIds: members(ctx, g.id) })

export function listGroups(ctx: AppContext): Group[] {
  return (ctx.db.query('SELECT id, name, description FROM groups ORDER BY name').all() as GroupRow[]).map((g) => toGroup(ctx, g))
}

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

/** Folder name for a group: the group name itself when it is a valid name, else "group-<short id>". */
function folderNameFor(name: string, id: string): string {
  const n = name.normalize('NFC').trim()
  return n && !badSegment(n) && !n.includes('/') ? n : `group-${id.slice(-8)}`
}

export function createGroup(c: Context<AppEnv>, ctx: AppContext, b: In<typeof GroupBody>): Group {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (nameTaken(ctx, b.name)) fail('conflict', msg('groupNameTaken', locale), { fields: { 'body.name': 'taken' } })
  const memberIds = checkMembers(ctx, b.memberIds, locale)
  const id = newId()
  const before = captureState(ctx.db)
  const folder = resolveFolderPath(ctx, `groups/${folderNameFor(b.name, id)}`, { create: true, locale })
  ctx.db.transaction(() => {
    const f = ensureFolderRow(ctx.db, folder.path)
    ctx.db.query('INSERT INTO groups (id, name, description, folder_id) VALUES (?, ?, ?, ?)').run(id, b.name, b.description ?? null, f.id)
    const add = ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)')
    for (const u of memberIds) add.run(id, u)
    ctx.db.query(`INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by, updated_at) VALUES (?, ?, 'group', ?, 'write', ?, ?)
      ON CONFLICT(folder_id, subject_type, subject_id) DO UPDATE SET access = 'write', updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(newId(), f.id, id, auth.user.id, new Date().toISOString())
    audit(ctx.db, { actor: auth.user.id, action: 'group.create', target: id, detail: { name: b.name, folder: folder.path, memberIds } })
  })()
  afterAccessChange(ctx, before)
  return toGroup(ctx, ctx.db.query('SELECT id, name, description FROM groups WHERE id = ?').get(id) as GroupRow)
}

export function updateGroup(c: Context<AppEnv>, ctx: AppContext, id: string, b: In<typeof UpdateGroupBody>): Group {
  const auth = c.get('auth')!
  const locale = c.get('locale')
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
    audit(ctx.db, { actor: auth.user.id, action: 'group.update', target: id, detail: { name: b.name, description: b.description, memberIds } })
  })()
  if (memberIds) afterAccessChange(ctx, before)
  return toGroup(ctx, ctx.db.query('SELECT id, name, description FROM groups WHERE id = ?').get(id) as GroupRow)
}

/** Delete a group and every rule that names it; its folder stays on disk (then only admins see it until new rules). */
export function deleteGroup(c: Context<AppEnv>, ctx: AppContext, id: string): void {
  const auth = c.get('auth')!
  const g = ctx.db.query('SELECT id, name FROM groups WHERE id = ?').get(id) as { id: string; name: string } | null
  if (!g) fail('not_found')
  const before = captureState(ctx.db)
  ctx.db.transaction(() => {
    ctx.db.query("DELETE FROM folder_rules WHERE subject_type = 'group' AND subject_id = ?").run(id)
    ctx.db.query('DELETE FROM groups WHERE id = ?').run(id)
    ctx.db.query("DELETE FROM budgets WHERE subject_type = 'group' AND subject_id = ?").run(id)
    audit(ctx.db, { actor: auth.user.id, action: 'group.delete', target: id, detail: { name: g!.name } })
  })()
  afterAccessChange(ctx, before)
}
