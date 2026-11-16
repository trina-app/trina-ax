// Undo of a removal on a shared file or folder (docs/decisions/20261116-folder-share-server.md; migration 359,
// file_share_undos).
//
// Taking people off a share, or stopping it, narrows access, so it needs no confirmation; the mistake it can be is
// repaired by an Undo. The removal stores what it took (every grant with who gave it, when and how: at most 50), and
// answers with the snapshot's id. POST /api/files/shares/undo puts back, from that snapshot:
//   - only for the person who removed them, once, within SHARE_UNDO_MS (10 minutes);
//   - only while they may still take people off that share (its owner; the team owner and admins for a team file), the
//     row is live and, for a folder, not paused. The team switch is not asked: this puts back what was there minutes ago;
//   - each grant that is still valid now (an active member who is not a guest; a group that exists and that the person
//     may share with; everyone on the team) with its OLD granted_by, granted_at and via. The others are skipped and
//     counted. Nothing beyond the snapshot is ever added, and never more than the share's 50;
//   - quietly: no notice, no push, no sending budget.
// The team owner's "Remove all file shares" closes every snapshot made before it. A snapshot of someone else, a used,
// expired or unknown one all answer 404 (nothing about whose it is).
import { randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { HttpError } from '../http/errors'
import { isStaff, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { checkRegular } from '../team-files/place'
import { FILE_SHARE_EVERYONE, FILE_SHARE_MAX, SHARE_UNDO_MS, type Locale, type ShareUndoResult } from '@mycel/shared/api'
import { fileSharesOf, type ShareRow, type Subject } from './shares'
import { folderSharesOf } from './folder-shares'

interface UndoGrant { subjectType: 'user' | 'group'; subjectId: string; grantedBy: string; grantedAt: string; via: string }
const DAY = 24 * 3600_000

/** Inside a removal's transaction, BEFORE its deletes: keep the grants it takes (`gone`, read from the table now).
 * Returns what the removal answers with, or null when it takes nothing. Old snapshots (a day past their end) go here. */
export function saveUndo(db: Database, userId: string, shareId: string, gone: readonly Subject[], stepId: string | null = null): { id: string; until: string } | null {
  const grants: UndoGrant[] = []
  for (const s of gone.slice(0, FILE_SHARE_MAX)) {
    const g = db.query('SELECT granted_by gb, granted_at at, via FROM file_share_grants WHERE share_id = ? AND subject_type = ? AND subject_id = ?').get(shareId, s.subjectType, s.subjectId) as { gb: string; at: string; via: string } | null
    if (g) grants.push({ subjectType: s.subjectType, subjectId: s.subjectId, grantedBy: g.gb, grantedAt: g.at, via: g.via })
  }
  if (!grants.length) return null
  const t = Date.now()
  db.query('DELETE FROM file_share_undos WHERE expires_at < ?').run(new Date(t - DAY).toISOString())
  const id = randomBytes(16).toString('base64url')
  const until = new Date(t + SHARE_UNDO_MS).toISOString()
  db.query('INSERT INTO file_share_undos (id, user_id, share_id, step_id, grants, created_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(id, userId, shareId, stepId, JSON.stringify(grants), new Date(t).toISOString(), until)
  return { id, until }
}

/** "Remove all file shares": no removal made before it can be undone. */
export function undosClosed(db: Database): void {
  db.query('UPDATE file_share_undos SET used_at = ? WHERE used_at IS NULL').run(new Date().toISOString())
}

/** May `me` still take people off `s` (the right the removal needed)? Returns the path to show, or null. */
function stillTheirs(ctx: AppContext, me: Principal, s: ShareRow): string | null {
  if (s.state !== 'live') return null
  const shares = fileSharesOf(ctx)
  if (s.kind === 'folder') return !s.paused_at && folderSharesOf(ctx).ownedBy(me, s) ? s.path : null
  try {
    const rules = shares.rules()
    const r = authorize(ctx.files.fx, rules, me, s.path, 'read')
    if (!r.st || r.st.isDirectory()) return null
    checkRegular(r.abs)
    return shares.shareRight(me, rules, r.segs).mayRemove ? r.rel : null
  } catch { return null }
}

/** POST /api/files/shares/undo */
export function undoShares(ctx: AppContext, userId: string, id: string, L: Locale): ShareUndoResult {
  const db = ctx.db
  const shares = fileSharesOf(ctx)
  const gone = () => new HttpError('not_found')
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw gone()
  const me = shares.principal(userId)
  if (!me || me.role === 'guest') throw gone()
  const u = db.query('SELECT share_id, grants FROM file_share_undos WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?').get(id, userId, new Date().toISOString()) as { share_id: string; grants: string } | null
  const s = u ? shares.row(u.share_id) : null
  const rel = s ? stillTheirs(ctx, me, s) : null
  if (!u || !s || !rel) throw gone()
  let grants: UndoGrant[]
  try { grants = (JSON.parse(u.grants) as UndoGrant[]).slice(0, FILE_SHARE_MAX) } catch { throw gone() }
  const valid = (g: UndoGrant) => g.subjectType === 'user'
    ? g.subjectId !== me.id && !!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL AND guest = 0").get(g.subjectId)
    : g.subjectType === 'group' && (g.subjectId === FILE_SHARE_EVERYONE || (!!db.query('SELECT 1 FROM groups WHERE id = ?').get(g.subjectId) && (isStaff(me) || me.groups.includes(g.subjectId))))
  let restored = 0
  db.transaction(() => {
    // one use: a second press (or a second window) finds it used
    if (db.query('UPDATE file_share_undos SET used_at = ? WHERE id = ? AND used_at IS NULL').run(new Date().toISOString(), id).changes !== 1) throw gone()
    let have = (db.query('SELECT COUNT(*) n FROM file_share_grants WHERE share_id = ?').get(s.id) as { n: number }).n
    for (const g of grants) {
      if (have >= FILE_SHARE_MAX || !valid(g) || !['dialog', 'ai', 'request'].includes(g.via)) continue
      const n = db.query('INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
        .run(s.id, g.subjectType, g.subjectId, 'view', g.grantedBy, g.grantedAt, g.via).changes
      if (n) { restored++; have++ }
    }
  })()
  const skipped = grants.length - restored
  const personal = s.path.startsWith('users/')
  audit(db, s.kind === 'folder'
    ? { actor: userId, action: 'folder_share.undo', target: `file-share:${s.id}`, detail: { personal: true, restored, skipped } }
    : { actor: userId, action: 'file.share', target: `file-share:${s.id}`, detail: { ...(personal ? { personal: true } : { path: s.path }), undo: true, restored, skipped } })
  if (restored) shares.changedSoon()
  return { ...shares.view(userId, rel, L), restored, skipped }
}
