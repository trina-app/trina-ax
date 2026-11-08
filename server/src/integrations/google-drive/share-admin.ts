// What an admin does with a Drive shared with the team (Admin › Connectors › Google Drive; shares.ts says how it
// works): list the shares, pick folders from the share's account, change its name, folders and rule, stop sharing,
// and the switch that lets members connect their own Drive. Every call checks the caller is an active admin again
// (the route does too). Folders are checked with Google and their names come from Google, never from the request.
// The audit log gets who did what to which share (created, folders changed, rule changed, renamed, stopped, the
// members' switch): never a token, an email or a file.
import { z } from 'zod'
import type { DriveShare, DriveShareFolder, IntegrationAccess } from '@mycel/shared/api'
import { DriveId } from '@mycel/shared'
import type { AppContext } from '../../context'
import { audit } from '../../admin/audit'
import { setSetting } from '../../admin/settings'
import { googleDriveOf, type DriveConn } from './oauth'
import { DriveError } from './store'
import { notifyDriveShareReconnect } from '../../notifications/service'
import { DRIVE_MEMBERS, foldersOf, membersCanConnect, shareByName, shareRow, shareRows, setShareAccess, shareAccess, shareView, shareWorks } from './shares'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const escapeQ = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)
function parse<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(new TextDecoder().decode(bytes))) } catch { throw new DriveError('invalid_provider_response', 502) }
}
const Folder = z.object({ id: DriveId, name: z.string().max(4096), mimeType: z.string().max(256), driveId: DriveId.optional() })
const Drive = z.object({ id: DriveId, name: z.string().max(4096) })

function admin(ctx: AppContext, actor: string) { googleDriveOf(ctx).store.admin(actor) }
function row(ctx: AppContext, id: string) {
  const r = shareRow(ctx.db, id)
  if (!r) throw new DriveError('not_found', 404)
  return r
}
function conn(ctx: AppContext, id: string): DriveConn {
  const svc = googleDriveOf(ctx), r = row(ctx, id)
  svc.checkShareOwners()
  return svc.shareConn(shareRow(ctx.db, id) ?? r)
}

export function setMembersCanConnect(ctx: AppContext, actor: string, on: boolean) {
  admin(ctx, actor)
  const before = membersCanConnect(ctx.db)
  setSetting(ctx.db, DRIVE_MEMBERS, on)
  if (before !== on) audit(ctx.db, { actor, action: 'drive.members_switch', detail: { on } })
}

export function listShares(ctx: AppContext, actor: string): DriveShare[] {
  admin(ctx, actor)
  const svc = googleDriveOf(ctx)
  svc.checkShareOwners()
  return shareRows(ctx.db).map((r) => shareView(ctx.db, r, svc.key))
}

/** The share account's top-level folders and shared drives, or (q) folders and shared drives whose name has q. */
export async function shareFolders(ctx: AppContext, actor: string, id: string, q?: string): Promise<DriveShareFolder[]> {
  admin(ctx, actor)
  const c = conn(ctx, id), query = (q ?? '').trim()
  const files = await c.api('files', {
    q: query ? `mimeType='${FOLDER_MIME}' and trashed=false and name contains '${escapeQ(query)}'` : `mimeType='${FOLDER_MIME}' and trashed=false and 'root' in parents`,
    corpora: query ? 'allDrives' : 'user', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', spaces: 'drive',
    orderBy: 'name', pageSize: '100', fields: 'files(id,name,mimeType,driveId)',
  }, 1_048_576)
  const drives = await c.api('drives', { pageSize: '100', fields: 'drives(id,name)', ...(query ? { q: `name contains '${escapeQ(query)}'` } : {}) }, 262_144)
  const f = parse(files.bytes, z.object({ files: z.array(Folder).max(100).default([]) })).files
  const d = parse(drives.bytes, z.object({ drives: z.array(Drive).max(100).default([]) })).drives
  files.assertCurrent(); drives.assertCurrent()
  return [
    ...d.map((x) => ({ id: x.id, name: clean(x.name), kind: 'drive' as const })),
    ...f.filter((x) => x.mimeType === FOLDER_MIME).map((x) => ({ id: x.id, name: clean(x.name), kind: 'folder' as const })),
  ]
}

/** One chosen id, checked with the share's account: a folder it can read, or a shared drive. */
async function folderOf(c: DriveConn, id: string): Promise<DriveShareFolder> {
  try {
    const r = await c.api(`files/${id}`, { supportsAllDrives: 'true', fields: 'id,name,mimeType,driveId' }, 32_768)
    const f = parse(r.bytes, Folder)
    if (f.id !== id) throw new DriveError('invalid_provider_response', 502)
    if (f.mimeType !== FOLDER_MIME) throw new DriveError('folder_invalid')
    if (f.driveId !== id) return { id, name: clean(f.name), kind: 'folder' }
  } catch (e) { if (!(e instanceof DriveError) || e.reason !== 'not_found') throw e }
  // a shared drive's root (its files.get may not answer for it): the drive itself
  try {
    const d = parse((await c.api(`drives/${id}`, { fields: 'id,name' }, 32_768)).bytes, Drive)
    if (d.id !== id) throw new DriveError('invalid_provider_response', 502)
    return { id, name: clean(d.name), kind: 'drive' }
  } catch (e) { throw e instanceof DriveError && e.reason === 'not_found' ? new DriveError('folder_invalid') : e }
}

function checkAccess(ctx: AppContext, a: IntegrationAccess) {
  const groups = new Set((ctx.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
  const users = new Set((ctx.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
  if (a.groups.some((g) => !groups.has(g)) || a.users.some((u) => !users.has(u))) throw new DriveError('access_invalid')
}
const sameAccess = (a: IntegrationAccess, b: IntegrationAccess) =>
  a.everyone === b.everyone && [...new Set(a.groups)].sort().join() === [...b.groups].sort().join() && [...new Set(a.users)].sort().join() === [...b.users].sort().join()

export async function updateShare(ctx: AppContext, actor: string, id: string, body: { name?: string; folders?: string[]; wholeDrive?: boolean; access?: IntegrationAccess }): Promise<DriveShare> {
  admin(ctx, actor)
  const db = ctx.db, svc = googleDriveOf(ctx), before = row(ctx, id)
  const name = body.name?.trim()
  if (name !== undefined && name !== before.name) {
    const other = shareByName(db, name)
    if (other && other.id !== id) throw new DriveError('name_taken', 409)
  }
  if (body.access) checkAccess(ctx, body.access)
  const whole = body.wholeDrive ?? !!before.whole_drive
  const ids = whole ? [] : body.folders ? [...new Set(body.folders)] : null
  let folders: DriveShareFolder[] | null = null
  if (ids) {
    const old = foldersOf(before)
    if (ids.length && (ids.length !== old.length || ids.some((x, i) => x !== old[i]?.id))) {
      if (!shareWorks(db, before, svc.key)) throw new DriveError('needs_reconnect', 409)
      const c = conn(ctx, id)
      folders = []
      for (const f of ids) folders.push(await folderOf(c, f))
    } else folders = ids.length ? old : []
  }
  const foldersChanged = (folders !== null && JSON.stringify(folders) !== JSON.stringify(foldersOf(before))) || whole !== !!before.whole_drive
  const accessChanged = !!body.access && !sameAccess(body.access, shareAccess(db, id))
  const renamed = name !== undefined && name !== before.name
  db.transaction(() => {
    const now = new Date(svc.now()).toISOString()
    if (renamed) db.query('UPDATE drive_team_shares SET name=?,updated_at=? WHERE id=?').run(name, now, id)
    // a change of folders fences calls under way (version): none delivers a file from the old folders
    if (foldersChanged) db.query('UPDATE drive_team_shares SET folders=?,whole_drive=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(folders ?? foldersOf(before)), whole ? 1 : 0, now, id)
    if (accessChanged) setShareAccess(db, id, body.access!)
  })()
  if (foldersChanged) svc.abort(`share:${id}`)
  if (renamed) audit(db, { actor, action: 'drive.share_renamed', target: id, detail: { name } })
  if (foldersChanged) audit(db, { actor, action: 'drive.share_folders_changed', target: id, detail: { folders: (folders ?? []).length, wholeDrive: whole } })
  if (accessChanged) audit(db, { actor, action: 'drive.share_audience_changed', target: id, detail: { everyone: body.access!.everyone, groups: body.access!.groups.length, users: body.access!.users.length } })
  return shareView(db, row(ctx, id), svc.key)
}

/** Stop sharing: the share, its rule, its tokens and its sign-ins are deleted at once; then Google revocation. */
export async function stopShare(ctx: AppContext, actor: string, id: string) {
  admin(ctx, actor)
  const svc = googleDriveOf(ctx), r = row(ctx, id)
  const token = svc.shareToken(r)
  ctx.db.transaction(() => {
    ctx.db.query('DELETE FROM drive_team_shares WHERE id=?').run(id)
    ctx.db.query("UPDATE drive_oauth_flows SET state='failed',reason='cancelled',secret_enc=NULL,account=NULL WHERE share_id=? AND state NOT IN ('completed','failed','expired')").run(id)
  })()
  svc.abort(`share:${id}`)
  audit(ctx.db, { actor, action: 'drive.share_stopped', target: id })
  return { stopped: true as const, revocation: await svc.revoke(token) }
}

/**
 * 팀장 넘기기 (admin/handover.ts): the owner handing the team over ends the sign-in of a share made with their own
 * Google account. The share keeps its name, folders and rule; its tokens are deleted, calls under way stop, every admin
 * is told to sign in again (as when its admin leaves), and then Google is asked to revoke the token (twice at most).
 * Only a share whose sign-in is `actor`'s own and still there; null otherwise (nothing changed). Never throws for
 * Google: what it said comes back ('revoked', 'unavailable' or 'not_needed').
 */
export async function endShareSignIn(ctx: AppContext, actor: string, id: string): Promise<'revoked' | 'unavailable' | 'not_needed' | null> {
  const svc = googleDriveOf(ctx), r = shareRow(ctx.db, id)
  if (!r || r.owner_user_id !== actor || !r.secret_enc) return null
  const token = svc.shareToken(r)
  const changed = ctx.db.query("UPDATE drive_team_shares SET secret_enc=NULL,status='needs_reconnect',reason='signed_out',version=version+1,updated_at=? WHERE id=? AND version=? AND secret_enc IS NOT NULL")
    .run(new Date(svc.now()).toISOString(), id, r.version).changes
  if (!changed) return null
  svc.abort(`share:${id}`)
  notifyDriveShareReconnect(ctx, id, `${id}.v${r.version + 1}`)
  const first = await svc.revoke(token).catch(() => 'unavailable' as const)
  return first === 'unavailable' ? await svc.revoke(token).catch(() => 'unavailable' as const) : first
}
