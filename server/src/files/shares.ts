// A member shares a file they own with chosen people or groups, Drive style (QA TC-3093, docs/DECISIONS.md "A member
// shares their own files", plan docs/AGENTS/plan/20261115-1407-file-share-links.md; migration 355).
//
// A file gets a link /f/<id> the first time someone shares it or copies its link (file_shares). The link opens for:
//   - whoever the folder rules let read the file (RuleSet.access, unchanged), and
//   - the people and groups on it (file_share_grants, view only), while its owner can still edit the file.
// Everyone else gets "Ask for access" (file_access_requests), answered by the file's owner, or, for a team file with no
// owner known, by the team owner and admins. Guests never get anything through a link (their one place is a room or a
// project). RuleSet.decide is not changed: a grant is read only by the id endpoints here, which serve the current bytes
// (no versions, history, extracted text, path or folder). Search, the AI's read tools and the file list stay on RuleSet.
//
// Who owns a file: its person for a file under users/<id>/; for a team file, whoever added it (creatorOf: the event
// walk below). Never who made the link, never who moved it. Who may share: the owner with edit access now (members only
// while the team's "Members can share files they own" is on), and the team owner and admins for any team file.
//
// The row follows the file: moves rewrite its path in the move's transaction (relocate), the trash parks it
// (state 'trashed', trash_id) and a restore brings it back, a purge deletes it. ino / dev / sha256 pin it to the file
// (like team_file_refs): every in-app change refreshes them (onFileEvent); a different file at the same path (put
// there on the disk outside the app) matches neither and the link answers no access. A move by someone other than the
// owner to where fewer people can read it removes the grants (audit + a notice to the owner); the owner's own move
// keeps them (the move confirm says how many people have it by its link).
import fs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { HttpError } from '../http/errors'
import { atLeast, isStaff, loadPrincipal, RuleSet, SYSTEM_PRINCIPAL, type Principal } from '../policy/access'
import { authorize, type Authorized } from '../policy/authorize'
import { checkRegular } from '../team-files/place'
import { mimeOf } from '../team-files/service'
import { newId } from '../db'
import { onFileEvent } from './store'
import { registerAccountCleanup } from '../auth/account-removal'
import { notificationsOf } from '../notifications/service'
import { roomsOf } from '../rooms/service'
import { FILE_REQUESTS_PER_HOUR, FILE_REQUESTS_PER_OWNER_DAY, FILE_SHARE_MAX, fileLinkUrl, plainLabel, type FileLink, type FileShareRow, type FileShares as FileSharesView, type InboxNotification, type Locale, type SharedFileView } from '@mycel/shared/api'

export interface ShareRow { id: string; path: string; ino: number | null; dev: number | null; sha256: string | null; size: number | null; mtime_ms: number | null; owner_id: string | null; state: 'live' | 'trashed' | 'dead'; trash_id: string | null; created_by: string; created_at: string }
const COLS = 'id, path, ino, dev, sha256, size, mtime_ms, owner_id, state, trash_id, created_by, created_at'
type Subject = { subjectType: 'user' | 'group'; subjectId: string }
type Via = 'dialog' | 'ai' | 'request'

const now = () => new Date().toISOString()
const segsOf = (p: string) => (p ? p.split('/') : [])
const baseName = (p: string) => p.split('/').pop() ?? p
const personalOwner = (segs: readonly string[]): string | null => (segs[0] === 'users' && segs.length >= 3 ? segs[1]! : null)
/** The sha256 of a file, read in pieces (a big file is never held whole). */
const HASH_MAX = 32 * 1024 * 1024
function sha256File(abs: string): string {
  // (a bigger file is pinned by its inode alone: hashing it here would hold the server's thread)
  if (fs.lstatSync(abs).size > HASH_MAX) throw new Error('too big to hash here')
  const h = createHash('sha256')
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)) }
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}
/** 16 random bytes, base64url: 22 characters, never guessed */
export const newLinkId = () => randomBytes(16).toString('base64url')

const MSG: Record<string, Record<Locale, string>> = {
  notOwner: { en: 'Only the file\'s owner can share it.', ko: '파일 소유자만 공유할 수 있어요.', id: 'Hanya pemilik file yang bisa membagikannya.', ja: 'ファイルの所有者だけが共有できます。', es: 'Solo el propietario del archivo puede compartirlo.', zh: '只有文件的所有者可以共享它。' },
  off: { en: 'Your team turned off sharing files one by one for members.', ko: '팀에서 멤버의 파일 공유를 꺼 두었어요.', id: 'Tim Anda menonaktifkan berbagi file untuk anggota.', ja: 'チームがメンバーのファイル共有をオフにしています。', es: 'Su equipo desactivó que los miembros compartan archivos.', zh: '你的团队已关闭成员共享文件。' },
  folder: { en: 'Folders aren\'t shared this way. An admin changes who can open a folder in its Share dialog.', ko: '폴더는 이렇게 공유하지 않아요. 폴더는 관리자가 폴더의 공유 창에서 바꿔요.', id: 'Folder tidak dibagikan dengan cara ini. Admin mengubah akses folder di dialog Bagikan folder.', ja: 'フォルダーはこの方法では共有しません。フォルダーは管理者が共有ダイアログで変更します。', es: 'Las carpetas no se comparten así. Un administrador cambia quién abre una carpeta en su diálogo Compartir.', zh: '文件夹不能这样共享。管理员在文件夹的共享对话框中更改访问权限。' },
  unknownSubject: { en: 'That person or group can\'t be added.', ko: '그 사람이나 그룹은 추가할 수 없어요.', id: 'Orang atau grup itu tidak bisa ditambahkan.', ja: 'その人やグループは追加できません。', es: 'No se puede añadir a esa persona o grupo.', zh: '无法添加该用户或群组。' },
  full: { en: `A file can be shared with at most ${FILE_SHARE_MAX} people and groups.`, ko: `파일 하나는 최대 ${FILE_SHARE_MAX}명·그룹까지 공유할 수 있어요.`, id: `Satu file bisa dibagikan ke paling banyak ${FILE_SHARE_MAX} orang dan grup.`, ja: `1つのファイルを共有できるのは最大${FILE_SHARE_MAX}人・グループです。`, es: `Un archivo se puede compartir con ${FILE_SHARE_MAX} personas y grupos como máximo.`, zh: `一个文件最多可共享给 ${FILE_SHARE_MAX} 个用户和群组。` },
  requestOff: { en: 'You can\'t ask for access to this file. Ask the person who sent the link.', ko: '이 파일은 액세스를 요청할 수 없어요. 링크를 보낸 사람에게 물어보세요.', id: 'Anda tidak bisa meminta akses ke file ini. Tanyakan kepada pengirim tautan.', ja: 'このファイルへのアクセスはリクエストできません。リンクを送った人に聞いてください。', es: 'No puede pedir acceso a este archivo. Pregunte a quien le envió el enlace.', zh: '无法请求访问此文件。请询问发送链接的人。' },
  tooMany: { en: 'You\'ve asked for access many times. Try again later.', ko: '액세스를 너무 많이 요청했어요. 나중에 다시 해 주세요.', id: 'Anda sudah terlalu sering meminta akses. Coba lagi nanti.', ja: 'アクセスのリクエストが多すぎます。後でもう一度お試しください。', es: 'Ha pedido acceso muchas veces. Inténtelo más tarde.', zh: '你请求访问的次数太多了。请稍后再试。' },
  ownerOnly: { en: 'Only the team owner can remove every file share.', ko: '모든 파일 공유는 팀장만 없앨 수 있어요.', id: 'Hanya pemilik tim yang bisa menghapus semua berbagi file.', ja: 'すべてのファイル共有を削除できるのはチームのオーナーだけです。', es: 'Solo el propietario del equipo puede quitar todos los archivos compartidos.', zh: '只有团队所有者可以移除所有文件共享。' },
}
const msg = (k: keyof typeof MSG, L: Locale) => MSG[k]![L] ?? MSG[k]!.en

// ---------------- who owns a file: the event walk ----------------

interface Ev { id: number; user_id: string; path: string; action: string; detail: Record<string, unknown> }
const evDetail = (s: string | null): Record<string, unknown> => { try { const v = s ? JSON.parse(s) : null; return v && typeof v === 'object' ? v : {} } catch { return {} } }
const ancestors = (p: string): string[] => { const s = segsOf(p); const out: string[] = []; for (let i = s.length - 1; i >= 1; i--) out.push(s.slice(0, i).join('/')); return out }

/**
 * Who added the file now at `path` (a team file), or null when nobody is known. Walks back from the current path,
 * newest event first:
 * - update / an upload over it (detail.replaced) / a conflict / a version restore: the same file, keep going back;
 * - a plain create or upload: that event's person;
 * - a copy (copiedFrom, sourcePaths, conflictCopyOf): the copier (a copy is a new file);
 * - a move's create (movedFrom, service.ts relocate): never an authorship; continue at the source path before it,
 *   skipping that move's own delete there. A folder's move (an ancestor's create with movedFrom) the same, the rest of
 *   the path kept;
 * - a trash restore (restore with originalPath): continue at the original path before it, skipping the delete that put
 *   it in the trash;
 * - any other delete first (the path was reused, the walk found no creation of this file): null.
 */
type Seek = { movedTo: string } | { trashId: string } | null
export function creatorOf(db: Database, path: string): string | null {
  let cur = path
  let before = Number.MAX_SAFE_INTEGER
  /** after a hop at the file's own path: the delete that took it from there (a move's movedTo, the trash's trashId);
   * events of other files that had the path in between are passed over until it */
  let seek = null as Seek
  for (let hops = 0; hops < 64; hops++) {
    const anc = ancestors(cur)
    const marks = anc.map(() => '?').join(',')
    // the file's own events, and its folders' moves and restores (a folder's move records the folder alone)
    const rows = db.query(`SELECT id, user_id, path, action, detail FROM file_events WHERE id < ? AND (path = ?${anc.length ? ` OR (path IN (${marks}) AND action IN ('create','restore'))` : ''}) ORDER BY id DESC LIMIT 2000`)
      .all(before, cur, ...anc) as { id: number; user_id: string; path: string; action: string; detail: string | null }[]
    let next: { path: string; before: number; seek: Seek } | null = null
    for (const r of rows) {
      const d = evDetail(r.detail)
      if (seek) {
        // only the file's own delete ends the search ('trashId' or 'movedTo' of this hop)
        if (r.path === cur && r.action === 'delete' && (('trashId' in seek && d.trashId === seek.trashId) || ('movedTo' in seek && d.movedTo === seek.movedTo))) seek = null
        continue
      }
      if (r.path !== cur) {
        // a folder above: only its move or its trash restore changes where the file was
        const suffix = cur.slice(r.path.length)
        if (r.action === 'create' && typeof d.movedFrom === 'string') { next = { path: d.movedFrom + suffix, before: r.id, seek: null }; break }
        if (r.action === 'restore' && typeof d.originalPath === 'string') { next = { path: d.originalPath + suffix, before: r.id, seek: null }; break }
        continue
      }
      // a delete before any creation of this file: the path was reused, nobody known
      if (r.action === 'delete') return null
      if (r.action === 'create') {
        if (typeof d.movedFrom === 'string') { next = { path: d.movedFrom, before: r.id, seek: { movedTo: cur } }; break }
        if (d.folder === true) return null
        return r.user_id
      }
      if (r.action === 'upload') {
        if (d.replaced === true) continue
        return r.user_id
      }
      if (r.action === 'restore') {
        if (typeof d.originalPath === 'string') { next = { path: d.originalPath, before: r.id, seek: typeof d.trashId === 'string' ? { trashId: d.trashId } : null }; break }
        continue
      }
      // update, conflict, rejected: the same file
    }
    if (!next) return null
    cur = next.path
    before = next.before
    seek = next.seek
  }
  return null
}

/** The owner of the file at `path`: a personal file's person, else creatorOf. */
export function ownerOf(db: Database, path: string): string | null {
  const segs = segsOf(path)
  const own = personalOwner(segs)
  if (own) return own
  if (segs[0] === 'users') return null
  return creatorOf(db, path)
}

// ---------------- the rows' life with the file (called by team-files/service.ts) ----------------

const UNDER = (col: string) => `(${col} = ? OR substr(${col}, 1, length(?) + 1) = ? || '/')`
/** Inside a move's transaction: the shares at or under `from` follow to `to`. */
export function sharesMoved(db: Database, from: string, to: string): void {
  // a live row already at the target (its file went on the disk outside the app) is another file's: it dies first
  db.query(`UPDATE file_shares SET state = 'dead' WHERE state = 'live' AND ${UNDER('path')} AND NOT ${UNDER('path')}`).run(to, to, to, from, from, from)
  db.query(`UPDATE file_shares SET path = ? || substr(path, length(?) + 1) WHERE state = 'live' AND ${UNDER('path')}`).run(to, from, from, from, from)
}
/** Inside the trash's step: the shares at or under `rel` are parked with the trash item. */
export function sharesTrashed(db: Database, rel: string, trashId: string): void {
  db.query(`UPDATE file_shares SET state = 'trashed', trash_id = ? WHERE state = 'live' AND ${UNDER('path')}`).run(trashId, rel, rel, rel)
}
/** A trash item restored from `from` to `to`: its shares come back at the new place. One already live there (a new file
 * shared meanwhile at that path) wins; the parked one goes. */
export function sharesRestored(db: Database, trashId: string, from: string, to: string): void {
  const rows = db.query("SELECT id, path FROM file_shares WHERE state = 'trashed' AND trash_id = ?").all(trashId) as { id: string; path: string }[]
  for (const r of rows) {
    const at = to + r.path.slice(from.length)
    // a live row there is another file's (the restore puts this one where that one's file is gone): it dies
    db.query("UPDATE file_shares SET state = 'dead' WHERE state = 'live' AND path = ?").run(at)
    db.query("UPDATE file_shares SET state = 'live', trash_id = NULL, path = ? WHERE id = ?").run(at, r.id)
    restoredOf(db).add(r.id)
  }
}
export interface UnsharedByMove { owner: string | null; auditId: number }
/** Inside a move's step (TeamFiles.relocate), when the moved files' new place is read by fewer people: the grants of
 * every live shared file at or under `to` that the mover does not own go, with their waiting requests, each audited
 * (`file.unshare`, reason moved_narrower). Throws with the move (never logged and passed over). The owner's own move
 * keeps them: its confirm said how many people have them by their link. */
export function sharesNarrowedByMove(db: Database, mover: string, to: string): UnsharedByMove[] {
  const out: UnsharedByMove[] = []
  const rows = db.query(`SELECT id, path, owner_id FROM file_shares WHERE state = 'live' AND ${UNDER('path')}`).all(to, to, to) as { id: string; path: string; owner_id: string | null }[]
  for (const s of rows) {
    if (s.owner_id === mover) continue
    const n = db.query('DELETE FROM file_share_grants WHERE share_id = ?').run(s.id).changes
    if (!n) continue
    db.query("UPDATE file_access_requests SET state = 'closed', decided_at = ? WHERE share_id = ? AND state = 'pending'").run(now(), s.id)
    const auditId = audit(db, { actor: mover, action: 'file.unshare', target: `file-share:${s.id}`, detail: { ...(s.path.startsWith('users/') ? { personal: true } : { path: s.path }), removed: n, reason: 'moved_narrower' } })
    out.push({ owner: s.owner_id, auditId })
  }
  return out
}

/** The people (by name or through a group) who have files at or under `rel` by their links: a folder's Share dialog
 * says how many when a save narrows who can open it, and offers to remove those links too. */
export function linkPeopleIn(db: Database, rel: string): number {
  const ids = rel ? [rel, rel, rel] : []
  const where = rel ? `AND ${UNDER('s.path')}` : ''
  return (db.query(`SELECT COUNT(*) n FROM (
      SELECT g.subject_id id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live' AND g.subject_type = 'user' ${where}
      UNION SELECT m.user_id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id JOIN group_members m ON m.group_id = g.subject_id WHERE s.state = 'live' AND g.subject_type = 'group' ${where}
    ) x JOIN users u ON u.id = x.id WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0`).get(...ids, ...ids) as { n: number }).n
}
/** Inside a folder save's step, after the new rules are written: does the save take `rel` away from someone who could
 * read it before (`before`: the rules as they were) while files there are shared by link? Then the save must say what
 * to do with those links (removeFileLinks true or false); saying nothing is refused (review of #979). */
export function narrowsWithLinks(db: Database, before: RuleSet, rel: string): boolean {
  if (linkPeopleIn(db, rel) === 0) return false
  const after = RuleSet.load(db)
  const segs = segsOf(rel)
  return (db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).some((u) => {
    const p = loadPrincipal(db, u.id)
    return !!p && atLeast(before.access(p, segs), 'read') && !atLeast(after.access(p, segs), 'read')
  })
}
/** A folder save's "Remove those links too" (admin/access save, inside its step): every grant of a shared file at or
 * under `rel` goes, with the waiting requests, audited once (`file.unshare`, reason folder_narrowed). */
export function removeLinksIn(db: Database, actor: string, rel: string): number {
  const ids = (db.query(`SELECT DISTINCT s.id FROM file_shares s JOIN file_share_grants g ON g.share_id = s.id WHERE s.state = 'live' AND ${UNDER('s.path')}`).all(rel, rel, rel) as { id: string }[]).map((r) => r.id)
  let n = 0
  for (const id of ids) {
    n += db.query('DELETE FROM file_share_grants WHERE share_id = ?').run(id).changes
    db.query("UPDATE file_access_requests SET state = 'closed', decided_at = ? WHERE share_id = ? AND state = 'pending'").run(now(), id)
  }
  if (ids.length) audit(db, { actor, action: 'file.unshare', target: rel.startsWith('users/') ? null : rel, detail: { files: ids.length, removed: n, reason: 'folder_narrowed' } })
  return ids.length
}

/** rows a trash restore brought back, until its restore event re-pins them (the only rows that event may re-pin) */
const restored = new WeakMap<Database, Set<string>>()
const restoredOf = (db: Database) => { let s = restored.get(db); if (!s) restored.set(db, (s = new Set())); return s }
/** A trash item deleted for good: its shares, grants, requests and notices go. */
export function sharesPurged(db: Database, trashId: string): void {
  const ids = (db.query('SELECT id FROM file_shares WHERE trash_id = ?').all(trashId) as { id: string }[]).map((r) => r.id)
  for (const id of ids) dropShare(db, id)
}
/** A personal folder's records forgotten (an account removed): its shares go. */
export function sharesForgotten(db: Database, prefix: string): void {
  const ids = (db.query(`SELECT id FROM file_shares WHERE ${UNDER('path')}`).all(prefix, prefix, prefix) as { id: string }[]).map((r) => r.id)
  for (const id of ids) dropShare(db, id)
}
/** The row's file is gone (another file took its path, or the file changed outside the app): its link answers no
 * access from now on, and its grants and waiting requests go. */
function markDead(db: Database, id: string) {
  db.query("UPDATE file_shares SET state = 'dead' WHERE id = ?").run(id)
  db.query('DELETE FROM file_share_grants WHERE share_id = ?').run(id)
  db.query("UPDATE file_access_requests SET state = 'closed', decided_at = ? WHERE share_id = ? AND state = 'pending'").run(now(), id)
}
function dropShare(db: Database, id: string) {
  const reqs = (db.query('SELECT id FROM file_access_requests WHERE share_id = ?').all(id) as { id: string }[]).map((r) => r.id)
  db.query('DELETE FROM file_share_notices WHERE source_id = ? OR source_id LIKE ?').run(id, `${id}:%`)
  for (const r of reqs) db.query('DELETE FROM file_share_notices WHERE source_id = ?').run(r)
  db.query('DELETE FROM file_shares WHERE id = ?').run(id)
}

/** A deleted account's part (auth/account-removal.ts): their notices and requests, and every grant naming them. Their
 * personal files' links go with the folder's records (sharesForgotten); a team file they owned stops opening by its
 * grants (its owner can no longer edit it: ownerStillEdits). */
export function registerFileShareCleanup(ctx: AppContext): void {
  registerAccountCleanup(ctx, {
    name: 'file-shares',
    rows: ['file_share_notices.user_id', 'file_access_requests.requester_id'],
    after: (c, userId) => { c.db.query("DELETE FROM file_share_grants WHERE subject_type = 'user' AND subject_id = ?").run(userId) },
  })
}

// ---------------- the service ----------------

const instances = new WeakMap<AppContext, FileShares>()
export function fileSharesOf(ctx: AppContext): FileShares {
  let s = instances.get(ctx)
  if (!s) { s = new FileShares(ctx); instances.set(ctx, s) }
  return s
}

export type OpenResult =
  | { kind: 'open'; share: ShareRow; abs: string; name: string; size: number; by: 'rules' | 'grant' | 'owner' }
  | { kind: 'no_access'; share: ShareRow | null }
  | { kind: 'trashed'; share: ShareRow }
  | { kind: 'unknown' }

export class FileShares {
  constructor(readonly ctx: AppContext) {
    // The link follows its file through the app's own changes (onFileEvent). Only an event that keeps the SAME file
    // re-pins the row to what is at the path now: a save (update), an upload over it (upload, replaced), a version
    // restore, a conflict, and a trash restore of the row that restore brought back. Anything that puts a NEW file at
    // the path (a plain create or upload, a copy, a conflict copy, a trash restore of another item) makes a live row
    // there dead: its link answers no access, and the new file starts unshared (review of #979: a file uploaded where a
    // shared one had been deleted outside the app inherited its link). A move's own create is the moved row (sharesMoved).
    onFileEvent(ctx.db, (e) => {
      const d = (e.detail ?? {}) as Record<string, unknown>
      if (d.folder === true || typeof d.movedFrom === 'string') return
      const same = e.action === 'update' || e.action === 'conflict' || (e.action === 'upload' && d.replaced === true)
        || (e.action === 'restore' && typeof d.versionId === 'string')
      const trashBack = e.action === 'restore' && typeof d.trashId === 'string'
      const fresh = e.action === 'create' || (e.action === 'upload' && d.replaced !== true)
      if (!same && !trashBack && !fresh) return
      const row = this.db.query("SELECT id FROM file_shares WHERE state = 'live' AND path = ?").get(e.path) as { id: string } | null
      if (!row) return
      const back = trashBack && restoredOf(this.db).delete(row.id)
      if (same || back) this.repin(row.id, e.path, e.sha256 ?? null)
      else markDead(this.db, row.id)
    })
  }
  private get db() { return this.ctx.db }
  rules() { return RuleSet.load(this.db) }
  private principal(id: string): Principal | null { return loadPrincipal(this.db, id) }
  private teamOn() { return getTeamSettings(this.db).memberFileShares !== false }

  /** The file at `rel` resolved on disk without anyone's access (a personal file as its person, a team file as the
   * system): symlinks, temp names, .system/ and missing paths refused as everywhere. */
  private resolve(rel: string): Authorized | null {
    const segs = segsOf(rel)
    const own = personalOwner(segs)
    const as = own ? this.principal(own) : segs[0] === 'users' ? null : SYSTEM_PRINCIPAL
    if (!as) return null
    try {
      const r = authorize(this.ctx.files.fx, this.rules(), as, rel, 'read')
      if (!r.st || r.st.isDirectory()) return null
      checkRegular(r.abs)
      return r
    } catch { return null }
  }

  /** The row is this file again: what is at the path now (the same file, written by the app). */
  private repin(id: string, rel: string, sha: string | null) {
    const set = () => {
      let st: fs.Stats
      try { st = fs.lstatSync(this.absOf(rel)) } catch { return }
      if (!st.isFile()) return
      this.db.query("UPDATE file_shares SET ino = ?, dev = ?, size = ?, mtime_ms = ?, sha256 = COALESCE(?, sha256) WHERE id = ? AND state = 'live'").run(st.ino, st.dev, st.size, st.mtimeMs, sha, id)
    }
    set()
    // a file event recorded just before its file lands (the rename is the step's last): once more after it
    queueMicrotask(set)
  }
  private absOf(rel: string) { return [this.ctx.files.fx.root, ...segsOf(rel)].join('/') }

  row(id: string): ShareRow | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null
    return this.db.query(`SELECT ${COLS} FROM file_shares WHERE id = ?`).get(id) as ShareRow | null
  }
  private liveAt(rel: string): ShareRow | null {
    return this.db.query(`SELECT ${COLS} FROM file_shares WHERE state = 'live' AND path = ?`).get(rel) as ShareRow | null
  }

  /** Is the file at the share's path still the one it was made for (decision 9)? The inode, else the last content
   * recorded through the app. A match by content records the new inode. */
  private same(s: ShareRow, st: fs.Stats, abs: string): boolean {
    if (s.ino === null || s.dev === null) return true
    if (st.ino === s.ino && st.dev === s.dev) return true
    // another inode: a different size is another file; else the hash (files up to 32 MB), at most once per row (a match
    // re-pins the new inode, so it is not hashed again; a mismatch makes it dead: the next open answers at once)
    const repin = () => { this.db.query('UPDATE file_shares SET ino = ?, dev = ?, size = ?, mtime_ms = ? WHERE id = ?').run(st.ino, st.dev, st.size, st.mtimeMs, s.id); return true }
    const dead = () => { markDead(this.db, s.id); return false }
    // (equal size and time on another inode prove nothing: another file can have both; review of #979)
    if (s.size !== null && st.size !== s.size) return dead()
    if (!s.sha256 || st.size > HASH_MAX) return dead()
    let h: string
    try { h = sha256File(abs) } catch { return dead() }
    return h === s.sha256 ? repin() : dead()
  }

  /** The file's link, made on first use by anyone who can open it (never sets who owns it: creatorOf does). */
  linkFor(userId: string, rel0: string): FileLink {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('not_found')
    const rules = this.rules()
    const r = authorize(this.ctx.files.fx, rules, me, rel0, 'read')
    if (r.st?.isDirectory()) throw new HttpError('validation', msg('folder', 'en'), { params: { reason: 'is_folder' } })
    checkRegular(r.abs)
    const s = this.ensure(r.rel, userId, r.st!)
    return { id: s.id, url: fileLinkUrl(s.id) }
  }
  private ensure(rel: string, by: string, st: fs.Stats): ShareRow {
    const have = this.liveAt(rel)
    if (have) {
      // a row whose file was replaced on the disk outside the app is not this file's: it starts again
      if (have.ino !== null && have.dev !== null && (have.ino !== st.ino || have.dev !== st.dev) && !this.same(have, st, this.absOf(rel))) markDead(this.db, have.id)
      else return have
    }
    const id = newLinkId()
    let sha: string | null = null
    try { sha = sha256File(this.absOf(rel)) } catch {}
    this.db.query('INSERT INTO file_shares (id, path, ino, dev, sha256, size, mtime_ms, owner_id, state, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, rel, st.ino, st.dev, sha, st.size, st.mtimeMs, ownerOf(this.db, rel), 'live', by, now())
    return this.row(id)!
  }

  /** May `me` add and remove people on the file at `rel` (a regular file they can read)? */
  private shareRight(me: Principal, rules: RuleSet, segs: string[]): { may: boolean; owner: string | null; off: boolean } {
    const rel = segs.join('/')
    const owner = this.liveAt(rel)?.owner_id ?? ownerOf(this.db, rel)
    const team = segs[0] !== 'users'
    const edits = atLeast(rules.access(me, segs), 'write')
    if (me.role === 'guest' || !edits) return { may: false, owner, off: false }
    if (team && isStaff(me)) return { may: true, owner, off: false }
    if (owner !== me.id) return { may: false, owner, off: false }
    const off = !this.teamOn()
    return { may: !off, owner, off }
  }

  /** The dialog's state for a file the caller can open. */
  view(userId: string, rel0: string, L: Locale = 'en'): FileSharesView {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('not_found')
    const rules = this.rules()
    const r = authorize(this.ctx.files.fx, rules, me, rel0, 'read')
    if (r.st?.isDirectory()) throw new HttpError('validation', msg('folder', L), { params: { reason: 'is_folder' } })
    const right = this.shareRight(me, rules, r.segs)
    const s = this.liveAt(r.rel)
    const ownerName = right.owner ? (this.db.query("SELECT name FROM users WHERE id = ? AND deleted_at IS NULL").get(right.owner) as { name: string } | null)?.name ?? null : null
    const people = s ? this.rows(s.id) : []
    // the rows: for whoever may share, and for someone on the list (they see who else has it)
    const listed = right.may || right.owner === me.id || people.some((p) => (p.subjectType === 'user' && p.subjectId === me.id) || (p.subjectType === 'group' && me.groups.includes(p.subjectId)))
    return {
      path: r.rel, link: s ? { id: s.id, url: fileLinkUrl(s.id) } : null, canShare: right.may,
      owner: right.owner && ownerName ? { id: right.owner, name: ownerName } : null, mine: right.owner === me.id,
      teamFile: r.segs[0] !== 'users', ...(right.off ? { off: true as const } : {}), people: listed ? people : [],
    }
  }
  private rows(shareId: string): FileShareRow[] {
    const out: FileShareRow[] = []
    for (const g of this.db.query('SELECT subject_type, subject_id FROM file_share_grants WHERE share_id = ? ORDER BY granted_at, subject_id').all(shareId) as { subject_type: 'user' | 'group'; subject_id: string }[]) {
      if (g.subject_type === 'user') {
        const u = this.db.query('SELECT u.name, p.title, p.avatar_version, u.status FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.deleted_at IS NULL').get(g.subject_id) as { name: string; title: string | null; avatar_version: number | null; status: string } | null
        if (!u) continue
        out.push({ subjectType: 'user', subjectId: g.subject_id, name: u.name, ...(u.title ? { title: u.title } : {}), ...(u.avatar_version ? { avatarVersion: u.avatar_version } : {}), ...(u.status !== 'active' ? { inactive: true as const } : {}) })
      } else {
        const gr = this.db.query('SELECT name FROM groups WHERE id = ?').get(g.subject_id) as { name: string } | null
        if (gr) out.push({ subjectType: 'group', subjectId: g.subject_id, name: gr.name })
      }
    }
    return out
  }

  /** Add and remove people and groups (the dialog, the AI tool). `via` for the audit. Returns the people newly given
   * access (by name or through a group). */
  change(userId: string, rel0: string, add: readonly Subject[], remove: readonly Subject[], L: Locale, via: Via = 'dialog'): { view: FileSharesView; added: string[]; share: ShareRow } {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('not_found')
    const rules = this.rules()
    const r = authorize(this.ctx.files.fx, rules, me, rel0, 'read')
    if (r.st?.isDirectory()) throw new HttpError('validation', msg('folder', L), { params: { reason: 'is_folder' } })
    checkRegular(r.abs)
    const right = this.shareRight(me, rules, r.segs)
    if (!right.may) throw new HttpError('forbidden', msg(right.off ? 'off' : 'notOwner', L), { params: { reason: right.off ? 'file_shares_off' : 'file_share_not_owner' } })
    // every subject checked before anything is written: an active member (never a guest, never me), a group that exists
    // and, for a member, one of their own (admins any)
    for (const s of add) {
      const ok = s.subjectType === 'user'
        ? s.subjectId !== me.id && !!this.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL AND guest = 0").get(s.subjectId)
        : !!this.db.query('SELECT 1 FROM groups WHERE id = ?').get(s.subjectId) && (isStaff(me) || me.groups.includes(s.subjectId))
      if (!ok) throw new HttpError('validation', msg('unknownSubject', L), { params: { reason: 'unknown_subject' } })
    }
    const share = this.ensure(r.rel, userId, r.st!)
    const have = new Set((this.db.query('SELECT subject_type, subject_id FROM file_share_grants WHERE share_id = ?').all(share.id) as { subject_type: string; subject_id: string }[]).map((g) => `${g.subject_type}:${g.subject_id}`))
    const fresh = add.filter((s) => !have.has(`${s.subjectType}:${s.subjectId}`))
    const gone = remove.filter((s) => have.has(`${s.subjectType}:${s.subjectId}`))
    if (have.size + fresh.length - gone.length > FILE_SHARE_MAX) throw new HttpError('validation', msg('full', L), { params: { reason: 'file_share_full' } })
    // the room sending budget (chat sharing's rule): a share is no free probe of who exists
    if (fresh.length) this.takeToken(userId)
    const before = this.openers(share, r.segs)
    const at = now()
    this.db.transaction(() => {
      for (const s of fresh) this.db.query('INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(share.id, s.subjectType, s.subjectId, 'view', userId, at, via)
      for (const s of gone) this.db.query('DELETE FROM file_share_grants WHERE share_id = ? AND subject_type = ? AND subject_id = ?').run(share.id, s.subjectType, s.subjectId)
      // a waiting request of someone now added is answered by the add
      if (fresh.length) for (const req of this.db.query("SELECT id, requester_id FROM file_access_requests WHERE share_id = ? AND state = 'pending'").all(share.id) as { id: string; requester_id: string }[]) {
        if (this.grantedTo(share.id, req.requester_id)) this.db.query("UPDATE file_access_requests SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(userId, at, req.id)
      }
    })()
    const after = this.openers(share, r.segs)
    const added = [...after].filter((id) => !before.has(id) && id !== userId)
    if (fresh.length || gone.length) {
      audit(this.db, { actor: userId, action: fresh.length ? 'file.share' : 'file.unshare', target: this.auditTarget(share), detail: { ...this.auditPath(share), people: fresh.filter((s) => s.subjectType === 'user').length, groups: fresh.filter((s) => s.subjectType === 'group').length, removed: gone.length, via, ...(gone.length ? { reason: 'removed' } : {}) } })
    }
    for (const id of added) this.notify(id, 'file.shared', share.id, true)
    return { view: this.view(userId, r.rel, L), added, share: this.row(share.id)! }
  }
  private takeToken(userId: string) {
    roomsOf(this.ctx).takeSendToken(userId)
  }
  /** The ids of the active people a grant lets in (people by name, a group's people), not counting folder rules. */
  private grantees(shareId: string): Set<string> {
    const out = new Set<string>()
    for (const r of this.db.query(`SELECT u.id FROM file_share_grants g JOIN users u ON u.id = g.subject_id WHERE g.share_id = ? AND g.subject_type = 'user' AND u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0
        UNION SELECT u.id FROM file_share_grants g JOIN group_members m ON m.group_id = g.subject_id JOIN users u ON u.id = m.user_id WHERE g.share_id = ? AND g.subject_type = 'group' AND u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0`).all(shareId, shareId) as { id: string }[]) out.add(r.id)
    return out
  }
  private grantedTo(shareId: string, userId: string): boolean {
    return !!this.db.query(`SELECT 1 FROM file_share_grants g WHERE g.share_id = ? AND ((g.subject_type = 'user' AND g.subject_id = ?) OR (g.subject_type = 'group' AND g.subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) LIMIT 1`).get(shareId, userId, userId)
  }
  /** Everyone who may open it now (rules and grants), for "who was newly added" */
  private openers(share: ShareRow, segs: string[]): Set<string> {
    const rules = this.rules()
    const out = new Set<string>()
    const ok = this.ownerStillEdits(share, rules, segs)
    const g = ok ? this.grantees(share.id) : new Set<string>()
    for (const u of this.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL AND guest = 0").all() as { id: string }[]) {
      const p = this.principal(u.id)
      if (!p) continue
      if (atLeast(rules.access(p, segs), 'read') || g.has(u.id)) out.add(u.id)
    }
    return out
  }
  /** Grants count while the file's owner (when one is known) can still edit it: an owner who lost access stops sharing. */
  private ownerStillEdits(share: ShareRow, rules: RuleSet, segs: string[]): boolean {
    if (!share.owner_id) return true
    const o = this.principal(share.owner_id)
    return !!o && o.role !== 'guest' && atLeast(rules.access(o, segs), 'write')
  }
  private auditTarget(s: ShareRow) { return `file-share:${s.id}` }
  /** a team file by its path; a personal file never (admins read the audit) */
  private auditPath(s: ShareRow): Record<string, unknown> { return s.path.startsWith('users/') ? { personal: true } : { path: s.path } }

  /** What the link page shows `userId`, and the file to serve when it opens. */
  open(userId: string, id: string): OpenResult {
    const s = this.row(id)
    if (!s) return { kind: 'unknown' }
    const me = this.principal(userId)
    // a guest gets nothing through a link (P1), the same answer as no access
    if (!me || me.role === 'guest') return { kind: 'no_access', share: null }
    if (s.state === 'dead') return { kind: 'no_access', share: s }
    if (s.state === 'trashed') return s.owner_id === me.id ? { kind: 'trashed', share: s } : { kind: 'no_access', share: s }
    const r = this.resolve(s.path)
    if (!r || !this.same(s, r.st!, r.abs)) return { kind: 'no_access', share: s }
    const rules = this.rules()
    const name = baseName(r.rel)
    if (atLeast(rules.access(me, r.segs), 'read')) return { kind: 'open', share: s, abs: r.abs, name, size: r.st!.size, by: s.owner_id === me.id ? 'owner' : 'rules' }
    if (this.grantedTo(s.id, me.id) && this.ownerStillEdits(s, rules, r.segs)) return { kind: 'open', share: s, abs: r.abs, name, size: r.st!.size, by: 'grant' }
    return { kind: 'no_access', share: s }
  }
  /** GET /api/files/shared/:id */
  page(userId: string, id: string): SharedFileView {
    const o = this.open(userId, id)
    if (o.kind === 'unknown') return { status: 'unknown' }
    if (o.kind === 'trashed') return { status: 'trashed' }
    if (o.kind === 'open') {
      const g = o.by === 'grant' ? this.db.query(`SELECT u.name FROM file_share_grants g JOIN users u ON u.id = g.granted_by WHERE g.share_id = ? AND u.deleted_at IS NULL AND ((g.subject_type = 'user' AND g.subject_id = ?) OR (g.subject_type = 'group' AND g.subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) ORDER BY g.granted_at LIMIT 1`).get(o.share.id, userId, userId) as { name: string } | null : null
      return { status: 'open', name: o.name, size: o.size, mime: mimeOf(o.name), sharedBy: g?.name ?? null, mine: o.share.owner_id === userId }
    }
    const me = this.principal(userId)
    const asked = o.share ? this.db.query("SELECT created_at FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(o.share.id, userId) as { created_at: string } | null : null
    return { status: 'no_access', canAsk: !!me && me.role !== 'guest' && !!o.share && this.requestTargets(o.share).length > 0, askedAt: asked?.created_at ?? null }
  }

  /** Who answers a request on this share: its owner while they can still edit the file and are active (a member only
   * while the team switch is on), else the team owner and admins for a team file. Never for a personal file whose
   * person cannot be asked. */
  private requestTargets(s: ShareRow): string[] {
    const rules = this.rules()
    const segs = segsOf(s.path)
    if (s.owner_id) {
      const o = this.principal(s.owner_id)
      if (o && o.role !== 'guest' && atLeast(rules.access(o, segs), 'write')) {
        if (isStaff(o) || this.teamOn()) return [o.id]
        if (segs[0] === 'users') return []
      } else if (segs[0] === 'users') return []
    }
    if (segs[0] === 'users') return []
    // (the role as the policy reads it: loadPrincipal, a guest never staff)
    return (this.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id).filter((id) => { const p = this.principal(id); return !!p && isStaff(p) })
  }

  /** POST /api/files/shared/:id/request */
  request(userId: string, id: string, message: string | undefined, L: Locale): { status: 'sent' | 'already'; askedAt: string } {
    const o = this.open(userId, id)
    if (o.kind === 'unknown') throw new HttpError('not_found')
    const me = this.principal(userId)
    if (!me || me.role === 'guest' || o.kind !== 'no_access' || !o.share) throw new HttpError('forbidden', msg('requestOff', L), { params: { reason: 'file_request_off' } })
    const s = o.share
    const targets = this.requestTargets(s)
    if (!targets.length) throw new HttpError('forbidden', msg('requestOff', L), { params: { reason: 'file_request_off' } })
    const waiting = this.db.query("SELECT created_at FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(s.id, userId) as { created_at: string } | null
    if (waiting) return { status: 'already', askedAt: waiting.created_at }
    const t = Date.now()
    const hour = (this.db.query('SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND created_at > ?').get(userId, new Date(t - 3600_000).toISOString()) as { n: number }).n
    const ownerKey = s.owner_id ?? ''
    const day = (this.db.query('SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND owner_id = ? AND created_at > ?').get(userId, ownerKey, new Date(t - 86400_000).toISOString()) as { n: number }).n
    if (hour >= FILE_REQUESTS_PER_HOUR || day >= FILE_REQUESTS_PER_OWNER_DAY) throw new HttpError('rate_limited', msg('tooMany', L), { retryAfter: 3600 })
    const note = message?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500) || null
    const rid = newId()
    const at = now()
    this.db.query('INSERT INTO file_access_requests (id, share_id, requester_id, owner_id, message, state, created_at) VALUES (?,?,?,?,?,?,?)').run(rid, s.id, userId, ownerKey, note, 'pending', at)
    audit(this.db, { actor: userId, action: 'file.access_request', target: this.auditTarget(s), detail: { ...this.auditPath(s) } })
    // one Activity row per person and file, brought back up by each new request
    for (const to of targets) this.notify(to, 'file.access_requested', `${s.id}:${userId}`, true)
    return { status: 'sent', askedAt: at }
  }

  /** POST /api/files/requests/:id: Share or Decline by whoever may share the file now. */
  answer(userId: string, requestId: string, answer: 'approve' | 'decline', L: Locale): { state: 'approved' | 'declined' | 'closed' } {
    const q = this.db.query('SELECT id, share_id, requester_id, state FROM file_access_requests WHERE id = ?').get(requestId) as { id: string; share_id: string; requester_id: string; state: 'pending' | 'approved' | 'declined' | 'closed' } | null
    if (!q) throw new HttpError('not_found')
    const s = this.row(q.share_id)
    const me = this.principal(userId)
    if (!s || !me) throw new HttpError('not_found')
    // only someone the request went to (or who may share the file now) learns anything about it
    const rules = this.rules()
    const segs = segsOf(s.path)
    const r = s.state === 'live' ? this.resolve(s.path) : null
    const may = !!r && this.shareRight(me, rules, segs).may
    const told = !!this.db.query("SELECT 1 FROM file_share_notices WHERE user_id = ? AND event_type = 'file.access_requested' AND source_id = ?").get(userId, `${s.id}:${q.requester_id}`)
    if (!may && !told) throw new HttpError('not_found')
    if (q.state !== 'pending') return { state: q.state }
    // the file gone: the request closes. Someone it went to who may not share the file now (an admin without edit
    // access there) changes nothing: the owner, or whoever may, answers it (review of #979)
    if (!r) {
      this.db.query("UPDATE file_access_requests SET state = 'closed', decided_at = ? WHERE id = ?").run(now(), q.id)
      return { state: 'closed' }
    }
    if (!may) throw new HttpError('forbidden', msg('notOwner', L), { params: { reason: 'file_share_not_owner' } })
    if (answer === 'approve') {
      this.change(userId, s.path, [{ subjectType: 'user', subjectId: q.requester_id }], [], L, 'request')
      this.db.query("UPDATE file_access_requests SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(userId, now(), q.id)
      audit(this.db, { actor: userId, action: 'file.access_approved', target: this.auditTarget(s), detail: { ...this.auditPath(s) } })
      return { state: 'approved' }
    }
    this.db.query("UPDATE file_access_requests SET state = 'declined', decided_by = ?, decided_at = ? WHERE id = ?").run(userId, now(), q.id)
    audit(this.db, { actor: userId, action: 'file.access_declined', target: this.auditTarget(s), detail: { ...this.auditPath(s) } })
    this.notify(q.requester_id, 'file.access_answered', q.id, false)
    return { state: 'declined' }
  }

  /** The owners of shared files whose grants a move removed (sharesNarrowedByMove, inside the move) are told. */
  tellUnshared(list: readonly UnsharedByMove[]): void {
    for (const u of list) if (u.owner) this.notify(u.owner, 'file.unshared_by_move', String(u.auditId), true)
  }

  /** Admin › Team settings: the counts, and the team owner's Remove all. */
  counts(): { files: number; people: number } {
    const files = (this.db.query("SELECT COUNT(DISTINCT g.share_id) n FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live'").get() as { n: number }).n
    let people = 0
    for (const r of this.db.query("SELECT DISTINCT g.share_id id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live'").all() as { id: string }[]) people += this.grantees(r.id).size
    return { files, people }
  }
  removeAll(userId: string, L: Locale): { files: number; people: number } {
    const me = this.principal(userId)
    if (!me || me.role !== 'owner') throw new HttpError('forbidden', msg('ownerOnly', L), { params: { reason: 'owner_only' } })
    const c = this.counts()
    this.db.transaction(() => {
      this.db.query('DELETE FROM file_share_grants').run()
      this.db.query("UPDATE file_access_requests SET state = 'closed', decided_by = ?, decided_at = ? WHERE state = 'pending'").run(userId, now())
    })()
    audit(this.db, { actor: userId, action: 'file.shares_removed_all', target: null, detail: { files: c.files, people: c.people } })
    return c
  }

  // ---------------- Activity ----------------
  private notify(to: string, event: 'file.shared' | 'file.access_requested' | 'file.access_answered' | 'file.unshared_by_move', source: string, rearm: boolean) {
    try {
      notificationsOf(this.ctx).fileShareNotice(to, event, source, rearm)
    } catch (err) { this.ctx.log.warn('file share notice failed', { err }) }
  }

  /** An Activity row's details for its viewer (notifications/service.ts out). Names read now; nothing about the file
   * once it is gone or the viewer may no longer see it. */
  noticeOut(row: { id: string; user_id: string; event_type: string; source_id: string; created_at: string; read_at: string | null }): InboxNotification {
    const base = { id: row.id, eventType: row.event_type as InboxNotification['eventType'], sourceId: row.source_id, code: row.event_type as InboxNotification['code'], createdAt: row.created_at, readAt: row.read_at, chatId: null, outcome: null }
    const name = (id: string | null) => id ? (this.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { name: string } | null)?.name ?? null : null
    const gone = { ...base, link: null, fileShare: { by: null, name: null, linkId: null, gone: true as const } }
    if (row.event_type === 'file.access_answered') return { ...base, link: null, fileShare: { by: null, name: null, linkId: null, state: 'declined' } }
    if (row.event_type === 'file.shared') {
      const s = this.row(row.source_id)
      const o = s ? this.open(row.user_id, s.id) : null
      if (!s || o?.kind !== 'open') return gone
      // who gave THIS person access: their own grant, or the one of a group they are in (the earliest)
      const g = this.db.query(`SELECT granted_by FROM file_share_grants WHERE share_id = ? AND ((subject_type = 'user' AND subject_id = ?) OR (subject_type = 'group' AND subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) ORDER BY granted_at LIMIT 1`).get(s.id, row.user_id, row.user_id) as { granted_by: string } | null
      return { ...base, link: 'file', fileShare: { by: name(g?.granted_by ?? null), name: plainLabel(o.name, 120), linkId: s.id } }
    }
    if (row.event_type === 'file.access_requested') {
      const [shareId, requester] = row.source_id.split(':')
      const s = shareId ? this.row(shareId) : null
      const q = s && requester ? this.db.query('SELECT id, message, state FROM file_access_requests WHERE share_id = ? AND requester_id = ? ORDER BY created_at DESC LIMIT 1').get(s.id, requester) as { id: string; message: string | null; state: 'pending' | 'approved' | 'declined' | 'closed' } | null : null
      const me = this.principal(row.user_id)
      if (!s || !q || !me || s.state !== 'live') return gone
      const r = this.resolve(s.path)
      if (!r) return gone
      const may = this.shareRight(me, this.rules(), r.segs).may
      if (!may && s.owner_id !== me.id) return gone
      return { ...base, link: 'file', fileShare: { by: name(requester ?? null), name: plainLabel(baseName(s.path), 120), linkId: s.id, ...(q.message ? { note: q.message } : {}), requestId: q.id, state: q.state, ...(may && q.state === 'pending' ? { canAnswer: true as const } : {}) } }
    }
    if (row.event_type === 'file.unshared_by_move') {
      const a = this.db.query('SELECT actor_id, target FROM audit_log WHERE id = ?').get(Number(row.source_id)) as { actor_id: string | null; target: string | null } | null
      const s = a?.target?.startsWith('file-share:') ? this.row(a.target.slice('file-share:'.length)) : null
      const o = s ? this.open(row.user_id, s.id) : null
      if (!a || !s || o?.kind !== 'open') return { ...gone, fileShare: { ...gone.fileShare, by: name(a?.actor_id ?? null) } }
      return { ...base, link: 'file', fileShare: { by: name(a.actor_id), name: plainLabel(o.name, 120), linkId: s.id } }
    }
    return gone
  }
}
