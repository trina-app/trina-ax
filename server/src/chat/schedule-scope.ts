// What a scheduled task's card lets its runs save and send without a card (docs/DECISIONS.md "Scheduled tasks: saving
// and sending allowed on the card"). A run has nobody to answer a card (chat/turn.ts waitForPerson), so the person says
// yes once, on the schedule card they answer when the task is made (tools/schedules.ts schedule_create), changed
// (chat/schedule-edit.ts) or checked again (chat/schedule-review.ts):
//   - one save folder (save_folder): new files there and in its sub-folders without folder rules of their own, also
//     when more people can read it than what the run read, as long as all of that is on the card (save_sources);
//   - places whose content may go there although fewer people see them (save_sources: the person's own folder, team
//     folders by their ruled folder, rooms); rooms also let a connection write after a room read skip the room card;
//   - the person's own connections a run may send to, only at the recipients the card pinned (personal_sends, Q2 a).
// This module checks a folder and the places before the card, keeps the facts the card showed (the folder on disk, a
// fingerprint of the folder rules on the way to it, how many could read it, the places), and finds a lapse: the folder
// moved, renamed or deleted, its rules changed (Q1 a: who is in a group does not count), or the person's write access
// gone. A lapse is kept (save_lapsed_at) until the card is answered again; the runtime side is chat/schedule-cover.ts.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { ROOM_REF_RE } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { atLeast, loadPrincipal, type RuleSet } from '../policy/access'
import { authorize, type FsCtx } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { refusal } from '../policy/refusal'
import { inSkills } from '../skills/guard'
import { readersOf } from '../rooms/ai-grants'
import { memberRow, roomRow } from '../rooms/store'
import { missingReaders, roomName, sourceOf } from './read-scope'
import { notificationsOf } from '../notifications/service'
import type { ScheduleRow } from './schedules'

/** A place whose content a run may put in the save folder although fewer people see it. */
export type ScopeSource = { type: 'user'; id: string } | { type: 'room'; id: string } | { type: 'folder'; id: string; rule?: string } | { type: 'root'; rule?: string }
export const scopeKey = (s: ScopeSource): string => (s.type === 'root' ? 'root' : `${s.type}:${s.id}`)
/** A personal connection a run may send to, and only to these recipients. */
export interface PersonalSend { connectionId: string; pins: string[] }
/** What the card showed about the save folder. */
export interface SaveFolder { folder: string; folderId: string; rule: string; readers: number }
/** Why a save permission stopped: the folder is not the one on the card (moved, renamed, deleted), the folder rules on
 * the way to it changed, or the person may no longer write there. */
export type SaveLapse = 'folder' | 'rules' | 'access'

/** at most this many new files one run saves under the card's yes */
export const MAX_COVERED_FILES = 20
/** at most this many recipients per connection, and places per task */
export const MAX_PINS = 10
export const MAX_SOURCES = 20

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
// no control, direction-changing or invisible characters: a member-set room name cannot reorder or hide card text
const oneLine = (s: string, n = 200) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, n)

/** How the save folder's identity reads a folder (a test replaces it to play a disk without creation times). */
export const folderStat: { lstat(p: string): { isDirectory(): boolean; dev: bigint; ino: bigint; birthtimeNs: bigint } } = {
  lstat: (p) => fs.lstatSync(p, { bigint: true }),
}

/** Which folder on disk `segs` (actual names) is: its device, inode and birth time (nanoseconds). The inode alone is
 * not enough: Linux (ext4, overlay) gives a folder made right after another was deleted the same inode number, so a
 * folder deleted and made again with its name would look like the one the card showed. A disk that keeps no birth time
 * (0) cannot tell them apart: null, as for something that is not a folder (fails closed: refused on the card, an
 * existing save folder lapses). */
export function saveFolderId(fx: FsCtx, segs: readonly string[]): string | null {
  try {
    const st = folderStat.lstat(path.join(fx.root, ...segs))
    return st.isDirectory() && st.birthtimeNs !== 0n ? `${st.dev}:${st.ino}:${st.birthtimeNs}` : null
  } catch { return null }
}

/** The folder rules that decide who reads and writes `segs` (actual names): those of every ruled folder from the team
 * root down to it, as one hash. Subjects are groups, people and roles, never who is in a group: a member joining or
 * leaving a group changes nothing here (Q1 a), a rule added, changed or removed on the way does. */
export function ruleFingerprint(rules: RuleSet, segs: readonly string[]): string {
  const levels: [string, string[]][] = []
  for (let n = 0; n <= segs.length; n++) {
    const p = segs.slice(0, n).join('/')
    const at = rules.rulesAt(p)
    if (at.length) levels.push([p, at.map((r) => `${r.subjectType}\u0000${r.subjectId ?? ''}\u0000${r.access}`).sort()])
  }
  return sha(JSON.stringify(levels))
}

/** Why `segs` (a folder, actual names) cannot be a save folder, or null: the team root, a top folder, a group's or a
 * person's own folder itself (rooms' grants refuse the same, chat/turn.ts roomGrantTarget), the person's own folder
 * (always allowed, no card needed), a hidden folder, a skills folder, a plugin's folder. */
export function saveFolderBlock(fx: FsCtx, segs: readonly string[]): 'top' | 'own' | 'hidden' | 'skills' | 'managed' | null {
  if (segs[0] === 'users') return 'own'
  if (segs.length < 2 || (segs[0] === 'groups' && segs.length < 3)) return 'top'
  if (segs.some((x) => x.startsWith('.'))) return 'hidden'
  const rel = segs.join('/')
  if (inSkills(rel)) return 'skills'
  if (fx.managed?.managerOf(segs)) return 'managed'
  return null
}

const BLOCK_TEXT: Record<NonNullable<ReturnType<typeof saveFolderBlock>>, string> = {
  own: 'it is in the user\'s own folder, where runs always may save new files without a card: leave save_to out',
  top: 'it is the team folder\'s top, a top folder (shared/, projects/, …) or a group\'s own folder itself: name a folder inside it',
  hidden: 'it is a hidden folder',
  skills: 'it is a skills folder (skills change only with the user\'s yes in a chat)',
  managed: 'it belongs to a plugin',
}

/** The save folder as the card will show it, or a ToolError that says why not (before the card). */
export function resolveSaveFolder(ctx: AppContext, userId: string, input: string): SaveFolder {
  const fx = ctx.files.fx, rules = ctx.files.rules()
  const me = ctx.files.principal(userId)
  let r
  try { r = authorize(fx, rules, me, input, 'write', { mustExist: true }) } catch (e) {
    throw new ToolError(`save_to '${oneLine(input, 200)}': ${e instanceof Error ? e.message : 'not found or no access'}. Runs can save only in an existing folder the user may write; nothing was created`)
  }
  if (!r.st?.isDirectory()) throw new ToolError(`save_to '${r.rel}' is a file, not a folder; nothing was created`)
  const why = saveFolderBlock(fx, r.segs)
  if (why) throw new ToolError(`save_to '${r.rel}' cannot be a scheduled task's save folder: ${BLOCK_TEXT[why]}. Nothing was created`)
  const id = saveFolderId(fx, r.segs)
  if (!id) {
    // a folder on a disk that keeps no creation time: a folder deleted and made again under its name would pass as it
    throw new ToolError(refusal({
      done: 'Nothing was created.',
      why: { kind: 'mode', mode: "a scheduled task's save folder", why: `the disk that holds '${r.rel}' keeps no creation time for folders, so the server could not tell this folder from one made later under its name, and runs could save into a folder the user never chose` },
      next: "leave save_to out (runs save in the user's own folder) and tell the user why; an admin can move the team folder to a disk that keeps creation times",
      names: [r.rel],
    }))
  }
  return { folder: r.rel, folderId: id, rule: ruleFingerprint(rules, r.segs), readers: readersOf(ctx.db, rules, r.segs).length }
}

/** A listed folder (or the team root) with the fingerprint of its rules now (a folder whose row is gone: dropped). A
 * change of them later lapses the save permission (lapseOf): content that became more private may not go on to the
 * save folder under the old yes. */
export function withRules(db: Database, rules: RuleSet, sources: readonly ScopeSource[]): ScopeSource[] {
  return sources.flatMap((s): ScopeSource[] => {
    if (s.type === 'root') return [{ type: 'root', rule: ruleFingerprint(rules, []) }]
    if (s.type !== 'folder') return [s]
    const row = db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null
    return row ? [{ type: 'folder', id: s.id, rule: ruleFingerprint(rules, row.path ? row.path.split('/') : []) }] : []
  })
}

/** The places `reads` names (before the card): "my folder" (or users/<me>), team folders the person may read (by the
 * ruled folder above them, read-scope.ts sourceOf), and rooms the person is in, as #[name](room:<id>), room:<id> or
 * the bare id. `unknown`: the ones that are none of them (refused before the card). */
export function resolveSources(ctx: AppContext, userId: string, reads: readonly string[]): { sources: ScopeSource[]; unknown: string[] } {
  const db = ctx.db, fx = ctx.files.fx, rules = ctx.files.rules()
  const me = ctx.files.principal(userId)
  const out = new Map<string, ScopeSource>()
  const unknown: string[] = []
  const add = (s: ScopeSource) => { out.set(scopeKey(s), s) }
  for (const raw of reads) {
    const v = raw.trim()
    if (!v) continue
    if (/^(my folder|my own folder|my personal folder|mine)$/i.test(v)) { add({ type: 'user', id: userId }); continue }
    const ref = [...v.matchAll(new RegExp(ROOM_REF_RE.source, 'g'))][0]?.[2] ?? /^(?:room:)?([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(v)?.[1]?.toLowerCase()
    if (ref) {
      const room = roomRow(db, ref)
      if (room && !room.archived_at && memberRow(db, ref, userId)) add({ type: 'room', id: ref })
      else unknown.push(oneLine(v, 120))
      continue
    }
    try {
      const r = authorize(fx, rules, me, v, 'read', { mustExist: true })
      const s = sourceOf(db, rules, r.rel)
      if (s.type === 'user') { if (s.id === userId) add({ type: 'user', id: userId }); else unknown.push(oneLine(v, 120)) }
      else if (s.type === 'folder' || s.type === 'root') add(s)
      else unknown.push(oneLine(v, 120))
    } catch { unknown.push(oneLine(v, 120)) }
  }
  return { sources: withRules(db, rules, [...out.values()].slice(0, MAX_SOURCES)), unknown }
}

/** The places of `sources` that matter for this task: rooms always (they also let a connection write after a room read
 * skip the room card), the rest only when fewer people may see them than may read the save folder (the others need no
 * yes). Without a save folder, rooms only. */
export function cardSources(db: Database, rules: RuleSet, sources: readonly ScopeSource[], folder: string | null, userId: string): ScopeSource[] {
  if (!folder) return sources.filter((s) => s.type === 'room')
  const readers = readersOf(db, rules, folder.split('/'))
  const narrower = new Set(missingReaders(db, rules, sources.filter((s) => s.type !== 'room'), readers, userId).map((m) => scopeKey(m.source as ScopeSource)))
  return sources.filter((s) => s.type === 'room' || narrower.has(scopeKey(s)))
}

/** A place as the card names it to the person (their language): the own folder, a room by the name its members gave it
 * (one line), a folder by its path. */
export function sourceText(db: Database, s: ScopeSource, userId: string, words: { mine: string; root: string; room: string }): string {
  if (s.type === 'user') return s.id === userId ? words.mine : `users/${s.id}/`
  if (s.type === 'root') return words.root
  if (s.type === 'room') return words.room.replace('{name}', oneLine(roomName(db, s.id, true), 80) || '?')
  const row = db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null
  return row ? (row.path ? `${row.path}/` : words.root) : '?'
}

/** The same place for the AI (a room by the server's name only: any member of a group chat may set its own name). */
export function sourceForAi(db: Database, s: ScopeSource, userId: string): string {
  if (s.type === 'user') return s.id === userId ? `the user's own folder (users/${userId})` : `users/${s.id}/`
  if (s.type === 'root') return 'the top of the team folder'
  if (s.type === 'room') return `the room ${roomName(db, s.id, false)} (room:${s.id})`
  const row = db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null
  return row ? `${row.path || '(team root)'}/` : 'a folder that is gone'
}

/** Recipients as the card shows them and as runs compare them: one line each, no duplicates, at most MAX_PINS. */
export function cleanPins(pins: readonly string[]): string[] {
  // no invisible or direction-changing characters: a pin on the card reads as what is compared
  return [...new Set(pins.map((p) => oneLine(p.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, ''), 500)).filter(Boolean))].slice(0, MAX_PINS)
}

/** One recipient value in the form pins are compared in: trimmed, without case, a channel's leading '#', an address's
 * trailing '/', and the dashes of an id written as 32 hex digits (a Notion page id with or without them). */
export function pinForm(v: string): string {
  const t = v.trim()
  // a web address: its scheme and host without case, its path, query and fragment as written (they may differ by case)
  const u = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(t)
  if (u) return (u[1]!.toLowerCase() + u[2]!).replace(/\/+$/, '')
  let s = t.toLowerCase()
  if (s.startsWith('#')) s = s.slice(1)
  if (/^[0-9a-f-]{32,36}$/.test(s) && s.replace(/-/g, '').length === 32) s = s.replace(/-/g, '')
  return s
}

// ---------------- the row ----------------
const json = <T>(v: string | null | undefined, ok: (x: unknown) => x is T): T[] => {
  if (!v) return []
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(ok) : [] } catch { return [] }
}
const isSource = (x: unknown): x is ScopeSource => {
  const s = x as ScopeSource | null
  if (!s || typeof s !== 'object') return false
  const rule = (s as { rule?: unknown }).rule
  if (rule !== undefined && typeof rule !== 'string') return false
  return s.type === 'root' || ((s.type === 'user' || s.type === 'room' || s.type === 'folder') && typeof (s as { id?: unknown }).id === 'string')
}
const isSend = (x: unknown): x is PersonalSend => {
  const s = x as PersonalSend | null
  return !!s && typeof s === 'object' && typeof s.connectionId === 'string' && Array.isArray(s.pins) && s.pins.every((p) => typeof p === 'string')
}
export const rowSources = (s: Pick<ScheduleRow, 'save_sources'>): ScopeSource[] => json(s.save_sources, isSource)
export const rowSends = (s: Pick<ScheduleRow, 'personal_sends'>): PersonalSend[] => json(s.personal_sends, isSend)
export const rowFolder = (s: Pick<ScheduleRow, 'save_folder' | 'save_folder_id' | 'save_rule' | 'save_readers'>): SaveFolder | null =>
  s.save_folder && s.save_folder_id && s.save_rule ? { folder: s.save_folder, folderId: s.save_folder_id, rule: s.save_rule, readers: s.save_readers ?? 0 } : null

/** The columns for what a card showed (NULL for nothing). */
export function scopeColumns(save: SaveFolder | null, sources: readonly ScopeSource[], sends: readonly PersonalSend[]) {
  return {
    save_folder: save?.folder ?? null, save_folder_id: save?.folderId ?? null, save_rule: save?.rule ?? null, save_readers: save ? save.readers : null,
    save_sources: sources.length ? JSON.stringify(sources) : null, personal_sends: sends.length ? JSON.stringify(sends) : null,
  }
}

/** Why the card's save permission no longer holds now, or null: the folder on disk is not the one the card showed (moved,
 * renamed, deleted, replaced), the folder rules on the way to it (or those of a listed folder: its content may have
 * become more private) changed, or its owner may not write there. Any error is 'folder' (fails closed). */
export function lapseOf(ctx: AppContext, s: Pick<ScheduleRow, 'user_id' | 'save_folder' | 'save_folder_id' | 'save_rule' | 'save_readers'> & { save_sources?: string | null }): SaveLapse | null {
  const save = rowFolder(s)
  if (!save) return null
  try {
    const fx = ctx.files.fx, rules = ctx.files.rules()
    const segs = save.folder.split('/')
    if (saveFolderId(fx, segs) !== save.folderId) return 'folder'
    if (ruleFingerprint(rules, segs) !== save.rule) return 'rules'
    const listed = rowSources({ save_sources: s.save_sources ?? null }).filter((x) => x.type === 'folder' || x.type === 'root')
    // a listed folder kept without its rules (a row from before they were kept): asked again, never assumed unchanged
    if (listed.some((x) => !(x as { rule?: string }).rule)) return 'rules'
    if (listed.length) {
      const now = new Map(withRules(ctx.db, rules, listed).map((x) => [scopeKey(x), (x as { rule?: string }).rule]))
      if (listed.some((x) => now.get(scopeKey(x)) !== (x as { rule?: string }).rule)) return 'rules'
    }
    const me = loadPrincipal(ctx.db, s.user_id)
    if (!me || !atLeast(rules.access(me, segs), 'write')) return 'access'
    const r = authorize(fx, rules, me, save.folder, 'write', { mustExist: true })
    if (!r.st?.isDirectory() || r.rel !== save.folder) return 'folder'
    return null
  } catch { return 'folder' }
}

/** Keep a lapse found now (once: a task already lapsed stays as it was), audited `schedule.save_lapsed`, with one inbox
 * notice for its owner (notifications/service.ts reconcile). True when this call recorded it. */
export function markLapsed(ctx: AppContext, s: Pick<ScheduleRow, 'id' | 'user_id' | 'save_folder'>, why: SaveLapse, now = new Date()): boolean {
  const r = ctx.db.query('UPDATE schedules SET save_lapsed_at = ?, save_lapse_reason = ? WHERE id = ? AND save_folder IS NOT NULL AND save_lapsed_at IS NULL').run(now.toISOString(), why, s.id)
  if (!r.changes) return false
  audit(ctx.db, { actor: null, action: 'schedule.save_lapsed', target: s.id, detail: { userId: s.user_id, reason: why } })
  try { notificationsOf(ctx).reconcile(s.user_id) } catch { ctx.log.warn('schedule save lapse notice deferred') }
  return true
}

/** The lapse of this task now (kept one first, else a new one found and kept), or null while its save folder holds. */
export function checkLapse(ctx: AppContext, s: ScheduleRow, now = new Date()): SaveLapse | null {
  if (!s.save_folder) return null
  if (s.save_lapsed_at) return (s.save_lapse_reason as SaveLapse | null) ?? 'folder'
  const why = lapseOf(ctx, s)
  if (why) markLapsed(ctx, s, why, now)
  return why
}

/** The task's save folder, places, pinned own connections and lapse for the Scheduled pages (shared/src/api/schedules.ts
 * Schedule): a room by the name its members gave it, a folder by its path, a connection by its name now. */
export function scopeOut(ctx: AppContext, s: ScheduleRow) {
  const db = ctx.db
  const sources = rowSources(s).map((x) => {
    if (x.type === 'user') return { key: scopeKey(x), kind: x.id === s.user_id ? 'mine' as const : 'folder' as const, name: x.id === s.user_id ? null : `users/${x.id}` }
    if (x.type === 'root') return { key: scopeKey(x), kind: 'root' as const, name: null }
    if (x.type === 'room') return { key: scopeKey(x), kind: 'room' as const, name: oneLine(roomName(db, x.id, true), 80) || null }
    const row = db.query('SELECT path FROM folders WHERE id = ?').get(x.id) as { path: string } | null
    return { key: scopeKey(x), kind: 'folder' as const, name: row?.path ?? null }
  })
  const sends = rowSends(s).flatMap((x) => {
    const r = db.query('SELECT name FROM integrations WHERE id = ?').get(x.connectionId) as { name: string } | null
    return r ? [{ name: oneLine(r.name, 120), pins: x.pins }] : []
  })
  return {
    saveFolder: s.save_folder ?? null, saveReaders: s.save_folder ? s.save_readers ?? null : null, saveSources: sources, personalSends: sends,
    saveLapsed: s.save_folder && s.save_lapsed_at ? ((s.save_lapse_reason as SaveLapse | null) ?? 'folder') : null,
  }
}

/** The words a card or the AI uses for a lapse. */
export const LAPSE_FOR_AI: Record<SaveLapse, string> = {
  folder: 'the save folder was moved, renamed or deleted since the user allowed it',
  rules: 'the folder permissions on the way to the save folder changed since the user allowed it',
  access: 'the user can no longer write in the save folder',
}

