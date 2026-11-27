// Take back what one AI share added (docs/decisions/20261123-do-then-undo.md, the gap found in the review of #426).
//
// A share that went through records, on the server, exactly the grants it wrote (FileShares.change `inserted`: never a
// grant that was there before), and, for share_folder on a folder it made from files that were only in the chat, that
// folder and the copies it put there. Its card's Undo sends the record's id (POST /api/files/shares/take-back):
//   - only for the person who shared, once, within SHARE_UNDO_MS (the same table and window as a removal's undo,
//     file_share_undos, with a JSON object in `grants` instead of a list, so undoShares never reads one);
//   - each recorded grant is taken off only while it is still the one this share wrote (the same person gave it at
//     the same time); a person who could open file A before a share of A and B keeps A;
//   - every removal goes through FileShares.change / put (the owner's right to take people off, quietly);
//   - a folder the share made: the grants it wrote go, each copy still byte for byte what was copied goes to the trash,
//     and the folders it made go while empty; its sharing stops whole only when the folder went. A file saved there
//     since stays, and so do its folder and anyone added to it by hand.
// A record of someone else, a used, expired or unknown one all answer 404.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { componentC } from '../team-files/component'
import { SHARE_UNDO_MS, type Locale, type ShareTakeBackResult } from '@mycel/shared/api'
import { fileSharesOf, type Subject } from './shares'
import { sha256RegularAsync } from './store'
import { sameFile } from '../team-files/place'

export interface TakeBackGrant { shareId: string; subjectType: 'user' | 'group'; subjectId: string; at: string }
export interface TakeBackFolder { path: string; made: string[]; files: { path: string; sha256: string }[] }
interface Rec { takeBack: TakeBackGrant[]; folder?: TakeBackFolder }
const DAY = 24 * 3600_000
const MAX = 500

/** Keep what one share added. Null when it added nothing (and made no folder). */
export function saveTakeBack(db: Database, userId: string, grants: readonly TakeBackGrant[], folder: TakeBackFolder | null = null, stepId: string | null = null): { id: string; until: string } | null {
  const g = grants.slice(0, MAX)
  if (!g.length && !folder) return null
  const shareId = g[0]?.shareId
  if (!shareId) return null
  const t = Date.now()
  db.query('DELETE FROM file_share_undos WHERE expires_at < ?').run(new Date(t - DAY).toISOString())
  const id = randomBytes(16).toString('base64url')
  const until = new Date(t + SHARE_UNDO_MS).toISOString()
  const rec: Rec = { takeBack: g, ...(folder ? { folder } : {}) }
  db.query('INSERT INTO file_share_undos (id, user_id, share_id, step_id, grants, created_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(id, userId, shareId, stepId, JSON.stringify(rec), new Date(t).toISOString(), until)
  return { id, until }
}

/** POST /api/files/shares/take-back */
export async function takeBackShares(ctx: AppContext, userId: string, id: string, L: Locale): Promise<ShareTakeBackResult> {
  const db = ctx.db
  const shares = fileSharesOf(ctx)
  const gone = () => new HttpError('not_found')
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw gone()
  const me = shares.principal(userId)
  if (!me || me.role === 'guest') throw gone()
  const u = db.query('SELECT grants FROM file_share_undos WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?').get(id, userId, new Date().toISOString()) as { grants: string } | null
  if (!u) throw gone()
  let rec: Rec
  try { rec = JSON.parse(u.grants) as Rec } catch { throw gone() }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !Array.isArray(rec.takeBack)) throw gone()
  // one use: a second press (or a second window) finds it used
  if (db.query('UPDATE file_share_undos SET used_at = ? WHERE id = ? AND used_at IS NULL').run(new Date().toISOString(), id).changes !== 1) throw gone()

  let removed = 0, skipped = 0
  const byShare = new Map<string, TakeBackGrant[]>()
  for (const g of rec.takeBack.slice(0, MAX)) byShare.set(g.shareId, [...(byShare.get(g.shareId) ?? []), g])
  const folderShare = rec.folder ? rec.takeBack[0]?.shareId : undefined
  for (const [shareId, gs] of byShare) {
    const s = shares.row(shareId)
    if (!s || s.state !== 'live') { skipped += gs.length; continue }
    // only a grant still exactly the one this share wrote: the same giver, the same time (a grant made again since,
    // by anyone, is not this share's to take)
    const ours: Subject[] = gs.filter((g) => !!db.query('SELECT 1 FROM file_share_grants WHERE share_id = ? AND subject_type = ? AND subject_id = ? AND granted_by = ? AND granted_at = ?').get(shareId, g.subjectType, g.subjectId, userId, g.at))
      .map((g) => ({ subjectType: g.subjectType, subjectId: g.subjectId }))
    skipped += gs.length - ours.length
    if (!ours.length) continue
    try {
      // only the grants this share wrote, also on a folder it made: someone added by hand since keeps theirs while the
      // folder stays (a file saved there since keeps it); the share stops whole below only when the folder is gone
      // (a folder goes through put: change takes files only)
      if (shareId === folderShare) shares.put(userId, s.path, [], ours, L, 'ai')
      else shares.change(userId, s.path, [], ours, L, 'ai', { quiet: true })
      removed += ours.length
    } catch (e) {
      // the folder's sharing could not be stopped: nothing of it is deleted and the record can be pressed again (the
      // card says it failed), never "taken back" while the folder stays shared (security review P3)
      if (shareId === folderShare) { db.query('UPDATE file_share_undos SET used_at = NULL WHERE id = ?').run(id); throw e instanceof HttpError ? e : new HttpError('conflict') }
      skipped += ours.length
    }
  }

  // a folder this share made from the chat's files: the copies it made (unchanged), then its folders while empty
  let folderGone = false
  if (rec.folder) {
    const f = rec.folder
    const svc = componentC(ctx).files
    const mine = (p: string) => typeof p === 'string' && p.startsWith(`users/${userId}/`) && p.split('/').length >= 3
    for (const c of (f.files ?? []).slice(0, MAX)) {
      if (!mine(c.path)) continue
      try {
        const r = authorize(ctx.files.fx, shares.rules(), me, c.path, 'write', { mustExist: true })
        if (!r.st?.isFile()) continue
        // hashed off the event loop (up to MAX copies of any size); removed only when it is still the file hashed
        const st = fs.lstatSync(r.abs)
        if (await sha256RegularAsync(r.abs) !== c.sha256 || !sameFile(st, fs.lstatSync(r.abs))) continue
        svc.remove(userId, c.path, null)
      } catch { /* moved, changed or gone: left */ }
    }
    for (const d of [...(f.made ?? [])].filter(mine).reverse()) svc.removeEmptyFolder(userId, d)
    folderGone = !!f.path && mine(f.path) && !fs.existsSync(path.join(ctx.files.fx.root, ...f.path.split('/')))
    // the folder went: its sharing stops whole (nothing is left to open; a folder made again there later is not shared)
    // (the folder is no longer on disk, so FileShares.put cannot stop it: the row ends here, as a folder deleted with
    // its sharing ends; a folder made again at that path later is a new one, never this share paused)
    if (folderGone && folderShare) db.query("UPDATE file_shares SET state = 'dead' WHERE id = ? AND state = 'live'").run(folderShare)
  }
  audit(db, { actor: userId, action: 'file.share', target: rec.takeBack[0] ? `file-share:${rec.takeBack[0].shareId}` : null, detail: { personal: true, takeBack: true, removed, skipped, ...(rec.folder ? { folderRemoved: folderGone } : {}) } })
  if (removed) shares.changedSoon()
  return { removed, skipped }
}
