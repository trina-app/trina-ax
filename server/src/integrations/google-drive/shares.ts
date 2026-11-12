// A Google Drive an admin shares with the team (docs/GOOGLE-DRIVE.md "Sharing a Drive with the team").
//  - An admin signs in with Google (the server's own client, drive.readonly) from Admin › Connectors › Google Drive,
//    then picks folders or shared drives (or, with a warning, the whole Drive) and who may use it, like a team
//    connection's rule. The tokens are sealed in their own key context and never leave the server.
//  - Members the rule includes use it through drive_search / drive_list / drive_read (tools/drive.ts, source
//    "team:<name>"), limited on the server to the chosen folders and everything below them (read.ts FolderScope): a
//    listing only of a folder inside, search results filtered by each file's parents, a read only of a file inside
//    (a shortcut is judged by its target). The rule, the share and its admin are checked again on every call.
//  - When the admin whose Google account it is leaves, is disabled or is no longer an admin, the share stops: its
//    tokens are deleted (Google revocation is attempted) and every admin gets an Inbox notice to sign in again.
//  - Members may connect their own Drive only while the team allows it (DRIVE_MEMBERS: on for a team made since
//    migration 341, which wrote the explicit value for every team that existed then, so theirs stayed as it was).
import type { Database } from 'bun:sqlite'
import type { DriveShare, DriveShareFolder, DriveTeamShare, IntegrationAccess } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { getSetting } from '../../admin/settings'

/** settings key: members may connect their own Google Drive (absent: yes, a team made since migration 341; that
 * migration wrote "false" for every team that existed then and had no value, and 337 "true" for teams whose members had
 * connected) */
export const DRIVE_MEMBERS = 'integrations.driveMembers'
/** the vault context of a share's tokens ("drive-share:<id>"), apart from people's own ("<user>:<id>") */
export const SHARE_CONTEXT = 'drive-share'

export interface ShareRow {
  id: string; name: string; owner_user_id: string | null; config_key: string; account: string; scopes: string
  secret_enc: string | null; key_version: number; folders: string; whole_drive: number
  status: 'connected' | 'needs_reconnect'; reason: DriveShare['reason']; version: number; expires_at: string; created_at: string; updated_at: string
}

export const membersCanConnect = (db: Database) => getSetting<boolean>(db, DRIVE_MEMBERS) !== false
export const shareRow = (db: Database, id: string) => db.query('SELECT * FROM drive_team_shares WHERE id=?').get(id) as ShareRow | null
export const shareRows = (db: Database) => db.query('SELECT * FROM drive_team_shares ORDER BY lower(name), id').all() as ShareRow[]
export const shareByName = (db: Database, name: string) => db.query('SELECT * FROM drive_team_shares WHERE lower(name)=lower(?)').get(name) as ShareRow | null

export function foldersOf(row: Pick<ShareRow, 'folders'>): DriveShareFolder[] {
  try {
    const v = JSON.parse(row.folders) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((f): f is DriveShareFolder => !!f && typeof f.id === 'string' && typeof f.name === 'string' && (f.kind === 'folder' || f.kind === 'drive'))
  } catch { return [] }
}

export function shareAccess(db: Database, id: string): IntegrationAccess {
  const rows = db.query('SELECT subject_type, subject_id FROM drive_team_share_access WHERE share_id=? ORDER BY subject_type, subject_id').all(id) as { subject_type: string; subject_id: string }[]
  return { everyone: rows.some((r) => r.subject_type === 'everyone'), groups: rows.filter((r) => r.subject_type === 'group').map((r) => r.subject_id), users: rows.filter((r) => r.subject_type === 'user').map((r) => r.subject_id) }
}

export function setShareAccess(db: Database, id: string, a: IntegrationAccess) {
  db.query('DELETE FROM drive_team_share_access WHERE share_id=?').run(id)
  const ins = db.query('INSERT OR IGNORE INTO drive_team_share_access(share_id, subject_type, subject_id) VALUES (?,?,?)')
  if (a.everyone) ins.run(id, 'everyone', '')
  for (const g of new Set(a.groups)) ins.run(id, 'group', g)
  for (const u of new Set(a.users)) ins.run(id, 'user', u)
}

/** Is this active person in the share's rule? Being an admin is not a rule. */
export function shareCovers(db: Database, id: string, user: string): boolean {
  if (!db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL AND must_change_password=0").get(user)) return false
  return !!db.query(`SELECT 1 FROM drive_team_share_access a WHERE a.share_id = ? AND (a.subject_type = 'everyone'
    OR (a.subject_type = 'user' AND a.subject_id = ?)
    OR (a.subject_type = 'group' AND a.subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) LIMIT 1`).get(id, user, user)
}

/** The admin whose Google account it is is still an active admin (or owner). */
export const ownerOk = (db: Database, row: Pick<ShareRow, 'owner_user_id'>) =>
  !!row.owner_user_id && !!db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL AND role IN ('owner','admin')").get(row.owner_user_id)

/** The share works now: signed in, with this server's client, and its admin still an admin. Not who may use it. */
export const shareWorks = (db: Database, row: ShareRow, key: string) =>
  row.status === 'connected' && !!row.secret_enc && !!key && row.config_key === key && ownerOk(db, row)

/** May this person use the share now (it works and its rule includes them)? Checked again on every tool call. */
export const usableShare = (db: Database, row: ShareRow | null, user: string, key: string): row is ShareRow =>
  !!row && shareWorks(db, row, key) && shareCovers(db, row.id, user)

export const usableShares = (db: Database, user: string, key: string) => shareRows(db).filter((r) => usableShare(db, r, user, key))

/** What a member sees of the shares they may use: names and folders, never the account or a token. */
export const teamSharesFor = (db: Database, user: string, key: string): DriveTeamShare[] =>
  usableShares(db, user, key).map((r) => ({ id: r.id, name: r.name, folders: foldersOf(r), wholeDrive: !!r.whole_drive }))

/** The active people the share's rule reaches today (its "used by"; and the viewers of what it returned, read-scope). */
export function shareUsers(db: Database, id: string): Set<string> {
  const ids = db.query("SELECT id FROM users WHERE status='active' AND deleted_at IS NULL").all() as { id: string }[]
  return new Set(ids.map((u) => u.id).filter((u) => shareCovers(db, id, u)))
}

export function shareView(db: Database, row: ShareRow, key: string): DriveShare {
  const a = JSON.parse(row.account) as { name: string | null; email: string | null }
  const owner = row.owner_user_id ? db.query('SELECT id, name FROM users WHERE id=? AND deleted_at IS NULL').get(row.owner_user_id) as { id: string; name: string } | null : null
  const works = shareWorks(db, row, key)
  const reason: DriveShare['reason'] = works ? null : !ownerOk(db, row) ? 'owner_gone' : row.config_key !== key ? 'client_changed' : row.reason ?? 'signed_out'
  return {
    id: row.id, name: row.name, account: { name: a.name ?? null, email: a.email ?? null }, owner,
    folders: foldersOf(row), wholeDrive: !!row.whole_drive, access: shareAccess(db, row.id),
    status: works ? 'connected' : 'needs_reconnect', reason, usedBy: shareUsers(db, row.id).size, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

const ownerChecks = new WeakMap<AppContext, () => void>()
/** The Drive service registers its owner check here (oauth.ts), so a change of people need not load it. */
export function onShareOwnerCheck(ctx: AppContext, fn: () => void) { ownerChecks.set(ctx, fn) }
/** After a change of people (admin/folders.ts afterAccessChange: disabled, deleted, role changed): a share whose admin
 * is gone stops now, and the admins are told. Never throws. */
export function checkDriveShareOwners(ctx: AppContext) {
  try {
    if (!ctx.db.query('SELECT 1 FROM drive_team_shares WHERE secret_enc IS NOT NULL LIMIT 1').get()) return
    const fn = ownerChecks.get(ctx)
    if (fn) fn()
    else void import('./oauth').then((m) => m.googleDriveOf(ctx).checkShareOwners()).catch(() => {})
  } catch { ctx.log.warn('Drive share check deferred') }
}
