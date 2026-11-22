// "Share" for a chat outside projects (docs/DECISIONS.md "Chats shared with people and groups", QA TC-1405; plan
// docs/AGENTS/plan/20261114-shared-chats-everywhere.md phase 3). Its creator picks people and groups (no whole-team
// option); then it works like a shared project chat: each turn is its sender's (SHARED_TOOLS only, the read card, no
// memories), everyone in it sees the whole chat and may continue it. Who sees it is read per request
// (chat/chat-audience.ts); this file holds the routes' logic:
//
//   GET  /api/chats/:id/audience   who it is shared with (names; a group's size and the count only for the creator and
//                                  admins: S8)
//   PUT  /api/chats/:id/audience   the creator saves the whole list (Drive's save model). Adds that bring in new people
//                                  run the check of an existing chat shared (chat/share-chat.ts: every branch's files,
//                                  the scope, memories, dev environment runs, what is not known) for those people only,
//                                  plus the answers whose recorded places they cannot open, and answer "confirm" with a
//                                  key when anything applies. Removals need no check; the removed people's running and
//                                  queued turns stop first (S7). Removing everyone makes it its creator's again.
//   POST/DELETE /api/chats/:id/hide  "Hide from my list" for the people it is shared with
//
// First share of a private chat: people_shared_at set, the engine session forgotten (its instructions held the
// memories), the earlier turns marked as before the share (their steps are their runner's: chat/store.ts viewSteps;
// the rollback guard passes them: chat/people-guard.ts), every earlier answer recorded with the people who see it now
// (chat/shared-answers.ts), and the creator's computer uploads in it copied to the chat's own files (chat/chat-files.ts
// copyEarlier), which everyone in it sees; later computer uploads go there directly (Chat.shared.canUpload).
//
// "Share the files from this chat too?" (docs/decisions/20261121-share-chat-files.md): the files the chat made in its
// creator's own folder (chat/chat-files-share.ts madeFilesOf) are listed to the creator in the check (madeFiles) and,
// for a chat already shared, in the audience view. The key binds each (path, sha256). A save with `withFiles` reads
// them again at the press, hashes the bytes it read, and copies them into the chat attached to the answers that made
// them; anything changed answers "confirm" again and copies nothing.
import fs from 'node:fs'
import path from 'node:path'
import type { ChatAudience, ChatAudiencePreview, ChatMadeFile, Locale, PutChatAudienceResult, ShareCheck } from '@mycel/shared/api'
import { CHAT_AUDIENCE_MAX } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { atLeast, loadPrincipal, type Principal } from '../policy/access'
import { confidentialChat } from '../safe-ops/confidential'
import { safeOpsEnabled } from '../safe-ops/runner'
import { roomsOf } from '../rooms/service'
import type { ChatRuntime } from './runtime'
import { publishChatChanged, stopTurnsIn } from './runtime'
import { SHARED_LATER, type ChatRow } from './store'
import { isInternalChat } from './internal-chats'
import { isPersonalFolder } from './projects'
import { chatView, type ChatAccess } from './shared'
import { chatUse } from './share-chat'
import { confirmMac } from './answer-share'
import { checkAudience, findingsState, rulesFingerprint, type AudienceFindings } from './audience-check'
import { createHash } from 'node:crypto'
import { sourceKey, sourceOf, type ReadSource } from './read-scope'
import { chatNodes, withheldAmong, type ReadGroup } from './shared-answers'
import { placeWords } from './place-words'
import { wideningAnswers, type WideningResult, type WideningSubject } from './widening'
import { isPeopleRow, peopleAudience, rememberAudience, resolveSubjects, subjectsOf, type AudienceSubject } from './chat-audience'
import { tr } from './i18n'
import { notificationsOf } from '../notifications/service'
import { chatFilesOf } from './chat-files'
import { pollSrt } from '../devenv/jobs'
import { devEnvFlag } from '../devenv/setting'
import { personLocale } from '../files/media-text'
import { closeFileAsks, copyMade, discardVerified, madeFilesOf, madeState, readVerified, type MadeFile, type VerifiedFile } from './chat-files-share'

const isAdmin = (role: string | undefined) => role === 'owner' || role === 'admin'
const subjectKey = (s: AudienceSubject) => `${s.type}:${s.id}`
/** The Share step's list, in the creator's words (the folder as the Files screen names it). */
const madeOut = (ctx: AppContext, files: readonly MadeFile[], L: Locale, me: string, f?: AudienceFindings): ChatMadeFile[] => {
  // made by an answer that used something a person being added cannot open (QA TC-7370): marked, and the dialog's
  // safer "without these files" becomes its first button
  const risky = f ? new Set([...f.fileAnswers, ...f.memoryAnswers, ...f.accountAnswers]) : new Set<string>()
  return files.map((x) => ({ name: x.name, place: placeWords(ctx.db, x.path.slice(0, x.path.lastIndexOf('/')), L, me), size: x.size, ...(risky.has(x.messageId) ? { private: true as const } : {}) }))
}
/** The files a new person misses (AudienceFindings.missedFiles) that I may read now myself (an answer of someone else
 * in the chat may have read a place I cannot: never named), each with where it is in the Files screen's words ("원가.xlsx
 * (영업 › 단가)", QA TC-7240), at most FILE_NAMES_MAX. */
const FILE_NAMES_MAX = 5
function fileNamesOf(ctx: AppContext, f: AudienceFindings, me: string, L: Locale, fromMe: ReadonlySet<string>): string[] {
  const p = loadPrincipal(ctx.db, me)
  if (!p) return []
  const rules = ctx.files.rules()
  const out: string[] = []
  for (const { path: rel, answers } of f.missedFiles) {
    if (out.length >= FILE_NAMES_MAX) break
    // read only by answers kept from me: not named (that would tell me what such an answer used)
    if (answers.every((id) => fromMe.has(id))) continue
    if (!atLeast(rules.access(p, rel.split('/').filter(Boolean)), 'read')) continue
    const dir = rel.slice(0, Math.max(0, rel.lastIndexOf('/')))
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const line = dir ? `${name} · ${placeWords(ctx.db, dir, L, me)}` : name
    if (!out.includes(line)) out.push(line)
  }
  return out
}
/** The key of a save with `withFiles` that brings nobody new in (a chat already shared): over the files and their bytes. */
const filesKeyOf = (ctx: AppContext, userId: string, chatId: string, files: readonly MadeFile[]) =>
  confirmMac(ctx, { kind: 'chat.files', v: 1, userId, chatId, made: madeState(files) })

/** The entries someone adds to a chat's audience, checked (the save and the widening list: the same rule): an active
 * person; a group that exists and, for a member, one of their own (admins any). Else 400 unknown_subject. */
export function checkNewSubjects(ctx: AppContext, me: Principal, added: readonly AudienceSubject[], locale: Locale): void {
  for (const s of added) {
    const u = s.type === 'user' ? ctx.db.query("SELECT guest FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(s.id) as { guest: number } | null : null
    // a guest is never shared a chat with (their one place is a room or a project): said so plainly (QA TC-6961)
    if (u?.guest) fail('validation', tr('chatShareGuest', locale), { params: { reason: 'unknown_subject' } })
    const ok = s.type === 'user' ? !!u
      : !!ctx.db.query('SELECT 1 FROM groups WHERE id = ?').get(s.id) && (isAdmin(me.role) || me.groups.includes(s.id))
    if (!ok) fail('validation', tr('chatShareUnknownPerson', locale), { params: { reason: 'unknown_subject' } })
  }
}

/** The widening list's `add` for a chat, checked like a save: at most CHAT_AUDIENCE_MAX entries (400 audience_full), and
 * the entries not in the chat's audience yet as checkNewSubjects. */
export function checkWideningAdd(ctx: AppContext, me: Principal, chat: Pick<ChatRow, 'id'>, add: readonly { subjectType: 'user' | 'group'; subjectId: string }[], locale: Locale): void {
  const keys = new Set(add.map((x) => `${x.subjectType}:${x.subjectId}`))
  if (keys.size > CHAT_AUDIENCE_MAX) fail('validation', tr('chatShareAudienceFull', locale), { params: { reason: 'audience_full' } })
  const there = new Set(subjectsOf(ctx.db, chat.id).map(subjectKey))
  checkNewSubjects(ctx, me, add.map((x) => ({ type: x.subjectType, id: x.subjectId })).filter((s) => !there.has(subjectKey(s))), locale)
}

/** Which of `groups` this person is in (by id, in the order given). */
const groupsOfIn = (db: AppContext['db'], userId: string, groups: readonly string[]): string[] => {
  const mine = new Set((db.query(`SELECT group_id FROM group_members WHERE user_id = ? AND group_id IN (SELECT value FROM json_each(?))`).all(userId, JSON.stringify(groups)) as { group_id: string }[]).map((g) => g.group_id))
  return groups.filter((g) => mine.has(g))
}

/** A scheduled task's run made this chat (or ran in it). */
const scheduledRun = (ctx: AppContext, r: Pick<ChatRow, 'id' | 'title_source'>): boolean =>
  r.title_source === 'schedule' || !!ctx.db.query('SELECT 1 FROM turns WHERE chat_id = ? AND schedule_id IS NOT NULL LIMIT 1').get(r.id)

/** GET /api/chats/:id/audience. `a`: the chat as chatFor found it for the caller ('view'). */
export function chatAudienceView(ctx: AppContext, rt: ChatRuntime, userId: string, a: ChatAccess): ChatAudience {
  const db = ctx.db
  const r = a.row
  const by = rt.store.userRef(r.user_id) ?? { id: r.user_id, name: r.user_id }
  if (a.kind === 'project') return { kind: 'project', canEdit: false, by, subjects: [] }
  if (!isPeopleRow(r)) return { kind: 'private', canEdit: a.creator && !r.project_id && !r.side_room_id, by, subjects: [] }
  const me = loadPrincipal(db, userId)
  // a group's size, and with a group in it the count, only for the creator and admins (S8)
  const full = a.creator || isAdmin(me?.role)
  const subjects = subjectsOf(db, r.id)
  // the groups listed that each person listed is in too (QA TC-2264): for the creator and admins, and only the groups
  // the viewer is in (admins any): a member never learns who is in a group of someone else's
  const listedGroups = full ? subjects.filter((s) => s.type === 'group' && (isAdmin(me?.role) || !!me?.groups.includes(s.id))).map((s) => s.id) : []
  const rows: ChatAudience['subjects'] = []
  for (const s of subjects) {
    if (s.type === 'user') {
      const u = db.query(`SELECT u.name, u.status, p.title, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.id = ? AND u.deleted_at IS NULL`).get(s.id) as { name: string; status: string; title: string | null; avatar_version: number | null } | null
      if (!u) continue
      // a disabled account does not see the chat: left out, but for its creator and admins, who see it marked inactive
      // (their save keeps the row, so the person is back in when enabled again)
      const inactive = u.status !== 'active'
      if (inactive && !full) continue
      const inGroups = listedGroups.length ? groupsOfIn(db, s.id, listedGroups) : []
      rows.push({ subjectType: 'user', subjectId: s.id, name: u.name, ...(u.title ? { title: u.title } : {}), ...(u.avatar_version ? { avatarVersion: u.avatar_version } : {}), ...(inactive ? { inactive: true as const } : {}), ...(inGroups.length ? { inGroups } : {}) })
    } else {
      const g = db.query('SELECT name FROM groups WHERE id = ?').get(s.id) as { name: string } | null
      if (!g) continue
      const mine = !!me && me.groups.includes(s.id)
      const members = full ? (db.query(`SELECT COUNT(*) AS n FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ? AND u.status = 'active' AND u.deleted_at IS NULL`).get(s.id) as { n: number }).n : undefined
      rows.push({ subjectType: 'group', subjectId: s.id, name: g.name, ...(members !== undefined ? { members } : {}), ...(mine ? { mine: true as const } : {}) })
    }
  }
  const groups = subjects.some((s) => s.type === 'group')
  // the creator: the files this chat made in my own folder that are not in the chat yet (the already-shared step)
  const made = a.creator ? madeFilesOf(ctx, r) : []
  const files = made.length ? { madeFiles: madeOut(ctx, made, personLocale(db, userId), userId), madeFilesKey: filesKeyOf(ctx, userId, r.id, made) } : {}
  const events = audienceEventsOf(db, r.id, full)
  return { kind: 'people', canEdit: a.creator, by, subjects: rows, ...(!groups || full ? { count: peopleAudience(db, r).length } : {}), ...files, ...(events.length ? { events } : {}) }
}

/** The most lines of who changed a chat's people that GET …/audience gives (the newest). */
export const AUDIENCE_EVENTS_SHOWN = 50

/** Record who changed a chat's people (chat_audience_events, migration 435): inside the save's or the leave's write. */
function addAudienceEvent(db: AppContext['db'], chatId: string, actor: string, kind: 'added' | 'removed' | 'left', subjects: readonly AudienceSubject[], at: string): void {
  db.query('INSERT INTO chat_audience_events (chat_id, at, actor_id, kind, subjects) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, at, actor, kind, JSON.stringify(subjects.map((x) => ({ t: x.type, id: x.id }))))
}

/** The chat's lines of who changed its people, oldest first, with names read now. `full` (its creator and admins): people
 * whose account is off are named too; for anyone else they are left out (as in the audience's list), and a line with
 * nobody left to name, or whose actor is off, is not shown. A deleted group is left out. */
function audienceEventsOf(db: AppContext['db'], chatId: string, full: boolean): NonNullable<ChatAudience['events']> {
  const rows = db.query('SELECT at, actor_id, kind, subjects FROM chat_audience_events WHERE chat_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(chatId, AUDIENCE_EVENTS_SHOWN) as { at: string; actor_id: string; kind: 'added' | 'removed' | 'left'; subjects: string }[]
  const person = (id: string): string | null => {
    const u = db.query('SELECT name, status, deleted_at FROM users WHERE id = ?').get(id) as { name: string; status: string; deleted_at: string | null } | null
    if (!u) return null
    return full || (u.status === 'active' && !u.deleted_at) ? u.name : null
  }
  const out: NonNullable<ChatAudience['events']> = []
  for (const e of rows.reverse()) {
    const actor = person(e.actor_id)
    if (!actor) continue
    let subjects: { t: string; id: string }[] = []
    try { subjects = JSON.parse(e.subjects) } catch { subjects = [] }
    const names = subjects.map((x) => x.t === 'group' ? (db.query('SELECT name FROM groups WHERE id = ?').get(x.id) as { name: string } | null)?.name ?? null : person(x.id)).filter((n): n is string => !!n)
    if (e.kind !== 'left' && !names.length) continue
    out.push({ at: e.at, kind: e.kind, actor, names })
  }
  return out
}

/** POST /api/chats/:id/leave: someone a chat was shared with by name takes themselves out ("Leave this chat", QA
 * TC-7651). Nothing of the chat stays theirs: their running and queued turns there stop, their hide row and waiting file
 * asks go, and the chat drops out of their windows. Its creator can't (they delete it); someone who would still see it
 * through a group listed is told so (the group is the creator's to change). The last entry gone makes it its creator's
 * own again, as a save that takes everyone out. `a`: the chat as chatFor found it ('view'). */
export function leaveChat(ctx: AppContext, rt: ChatRuntime, userId: string, a: ChatAccess, locale: Locale): void {
  const db = ctx.db
  if (a.kind !== 'people') fail('validation', tr('chatLeaveNotShared', locale), { params: { reason: 'chat_leave_not_shared' } })
  if (a.creator) fail('validation', tr('chatLeaveCreator', locale), { params: { reason: 'chat_leave_creator' } })
  const r = rt.store.chatRow(a.row.id) ?? fail('not_found')
  if (r.deleted_at || !isPeopleRow(r)) fail('not_found')
  const rest = subjectsOf(db, r.id).filter((x) => !(x.type === 'user' && x.id === userId))
  // still in it after the name goes (a group listed): the group is the creator's to take out
  if (resolveSubjects(db, rest).includes(userId)) {
    const groups = groupsOfIn(db, userId, rest.filter((x) => x.type === 'group').map((x) => x.id))
      .map((g) => (db.query('SELECT name FROM groups WHERE id = ?').get(g) as { name: string } | null)?.name).filter((n): n is string => !!n)
    const creator = rt.store.userRef(r.user_id)?.name ?? ''
    fail('conflict', tr('chatLeaveGroup', locale, { groups: groups.join(', '), name: creator }), { params: { reason: 'chat_leave_group' } })
  }
  // S7, as a save that removes someone: what runs or waits there for them stops first
  stopTurnsIn(ctx, userId, [r.id])
  const at = new Date().toISOString()
  const everyone = rest.length === 0
  db.transaction(() => {
    // the name entry is the only one that held them (checked above, again here: nothing waited in between)
    if (!db.query("SELECT 1 FROM chat_audience WHERE chat_id = ? AND subject_type = 'user' AND subject_id = ?").get(r.id, userId)) fail('not_found')
    db.query("DELETE FROM chat_audience WHERE chat_id = ? AND subject_type = 'user' AND subject_id = ?").run(r.id, userId)
    if (everyone) {
      db.query('UPDATE chats SET people_shared_at = NULL WHERE id = ?').run(r.id)
      db.query('DELETE FROM chat_list_hidden WHERE chat_id = ?').run(r.id)
    } else db.query('DELETE FROM chat_list_hidden WHERE chat_id = ? AND user_id = ?').run(r.id, userId)
    closeFileAsks(db, r.id, everyone ? null : [userId])
    rememberAudience(db, r.id, [userId], at)
    addAudienceEvent(db, r.id, userId, 'left', [], at)
    // counts only
    audit(db, { actor: userId, action: 'chat.leave', target: r.id, detail: { ...(everyone ? { private: true } : {}) } })
  })()
  if (devEnvFlag()) void pollSrt(ctx, { chatId: r.id }).catch(() => {})
  rt.forgetLiveViewers()
  rt.hub.publish(userId, { type: 'chat.updated', data: { chatId: r.id, change: 'deleted', chat: null } })
  rt.publishChat(r.user_id, r.id, 'updated')
}

/**
 * Why this chat can never be shared with people by its creator, whoever asks (null: it can): a room's chat, a deleted or
 * the server's own chat (not found); a chat in a project is shared with its members (or stays its creator's in a
 * personal one); a scheduled run's chat and a room's side chat are never shared. Also the "Ask for access" of a chat's
 * link (chat/access-requests.ts): a chat with a refusal here offers no request.
 */
export function peopleShareRefusal(ctx: AppContext, r: ChatRow): { status: 'not_found' } | { status: 'conflict'; reason: string; key: Parameters<typeof tr>[0] } | null {
  if (r.room_id || r.deleted_at || isInternalChat(ctx.db, r.id)) return { status: 'not_found' }
  if (r.project_id) {
    const p = ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(r.project_id) as { folder_path: string } | null
    if (p && isPersonalFolder(p.folder_path)) return { status: 'conflict', reason: 'project_personal', key: 'chatSharePersonalProject' }
    return { status: 'conflict', reason: 'share_people_in_project', key: 'chatSharePeopleInProject' }
  }
  // a run in a chat already shared with people ran with its gates (a task made there posts there, chat/schedules.ts
  // postsInto), like any turn there: its people can still be changed. A private chat a run made or ran in is never shared
  if (!isPeopleRow(r) && scheduledRun(ctx, r)) return { status: 'conflict', reason: 'scheduled_run', key: 'chatShareScheduled' }
  // a room's side chat holds the room's words; only the room's members may read them (QA TC-1010)
  if (r.side_room_id) return { status: 'conflict', reason: 'side_chat', key: 'chatShareSideChat' }
  return null
}

/**
 * The refusals of a change of who sees the chat, against the chat as it is now: someone else's chat is chatFor's 404
 * (or 403 for someone who sees it); then peopleShareRefusal.
 */
function changeable(ctx: AppContext, userId: string, a: ChatAccess, locale: Locale): void {
  const r = a.row
  if (r.room_id || r.deleted_at || isInternalChat(ctx.db, r.id)) fail('not_found')
  if (!a.creator) fail('forbidden', tr('chatShareCreatorOnly', locale), { params: { reason: 'chat_share_creator_only' } })
  const no = peopleShareRefusal(ctx, r)
  if (!no) return
  if (no.status === 'not_found') return fail('not_found')
  fail('conflict', tr(no.key, locale), { params: { reason: no.reason } })
}

/** The people a list of entries brings in who do not see the chat now (its creator left out), as principals. */
function gainedBy(ctx: AppContext, chat: ChatRow, add: readonly { subjectType: 'user' | 'group'; subjectId: string }[]): Principal[] {
  const db = ctx.db
  const now = new Set(isPeopleRow(chat) ? peopleAudience(db, chat) : [chat.user_id])
  return resolveSubjects(db, add.map((x) => ({ type: x.subjectType, id: x.subjectId }))).filter((id) => !now.has(id) && id !== chat.user_id)
    .map((id) => loadPrincipal(db, id)).filter((x): x is Principal => !!x)
}

/** The checks of the last minute (the preview, the widening list): the same list against the same chat, rules and
 * people answers from here, so 60 previews a minute never hash big files 60 times. A save never reads it. */
const CHECK_CACHE_MS = 60_000
/** `hidden`: the earlier answers kept from someone being added (and who: `hiddenFrom`); `fromMe`: the ones kept from me */
type Findings = { f: AudienceFindings; earlierFiles: number; made: MadeFile[]; hidden: string[]; hiddenFrom: string[]; fromMe: Set<string> }
const checksOf = new WeakMap<AppContext, Map<string, { at: number; value: Promise<Findings> }>>()

/** What the people `newPeople` (ids) would see that they could not before, with the answers whose records they miss
 * (chat/widening.ts), as `viewer` (its creator) may be told it, and the earlier uploads a first share shows them. */
async function findingsFor(ctx: AppContext, viewer: Principal, chat: ChatRow, newPeople: readonly string[], o: { cache?: string } = {}): Promise<Findings> {
  const compute = async () => {
    const db = ctx.db
    const gained = newPeople.map((id) => loadPrincipal(db, id)).filter((x): x is Principal => !!x)
    const recorded = new Map<string, Set<string>>()
    const rules = ctx.files.rules()
    wideningAnswers(db, { now: rules, after: rules }, { kind: 'chat', chatId: chat.id }, gained, viewer, { limit: 0 }, { collect: recorded })
    const f = await checkAudience(ctx, viewer.id, chat.id, newPeople, { sharedAt: chat.people_shared_at ?? chat.shared_at ?? null, recorded })
    // a first share also shows them the creator's earlier computer uploads (copied: chat/chat-files.ts)
    const earlierFiles = isPeopleRow(chat) ? 0 : await chatFilesOf(ctx).earlierUploads(chat.id)
    // the files the chat made in my own folder (the Share step), for its creator only
    // (never a file of an answer hidden from anyone in it or being added: chat/chat-files-share.ts hiddenAnswers)
    const made = viewer.id === chat.user_id ? madeFilesOf(ctx, chat, { audience: newPeople }) : []
    // a chat shared already: the earlier answers its records keep from someone being added (QA TC-7262: the dialog said
    // nothing and every answer was hidden from the newcomer); a first share records them for everyone it adds
    const hiddenIds = new Set<string>(), hiddenFrom = new Set<string>()
    let fromMe = new Set<string>()
    if (isPeopleRow(chat)) {
      const nodes = chatNodes(db, chat.id)
      // (not one already hidden from me: nothing of it is told)
      fromMe = withheldAmong(db, rules, nodes, viewer.id)
      for (const id of newPeople) for (const m of withheldAmong(db, rules, nodes, id)) if (!fromMe.has(m)) { hiddenIds.add(m); hiddenFrom.add(id) }
    }
    return { f, earlierFiles, made, hidden: [...hiddenIds].sort(), hiddenFrom: [...hiddenFrom].sort(), fromMe }
  }
  if (!o.cache) return compute()
  const now = Date.now()
  const cache = checksOf.get(ctx) ?? checksOf.set(ctx, new Map()).get(ctx)!
  for (const [k, v] of cache) if (now - v.at >= CHECK_CACHE_MS) cache.delete(k)
  const hit = cache.get(o.cache)
  if (hit) return hit.value
  const value = compute()
  cache.set(o.cache, { at: now, value })
  if (cache.size > 500) cache.delete(cache.keys().next().value!)
  value.catch(() => cache.delete(o.cache!))
  return value
}

/** The cache key of a check: who asks, the chat's state (its entries, its people, every message), the list, the people
 * it brings and the folder rules. */
const checkCacheKey = (ctx: AppContext, userId: string, chatId: string, state: ReturnType<typeof stateOf>, wanted: readonly AudienceSubject[], newPeople: readonly string[]) =>
  createHash('sha256').update(JSON.stringify([userId, chatId, state, wanted.map(subjectKey).sort(), newPeople, rulesFingerprint(ctx)])).digest('base64url')

/**
 * The widening list of one chat (chat/widening.ts wideningAnswers with the chat target; POST
 * /api/sharing/widening-answers {kind: 'chat'}): the answers of this chat that the people `add` (the Share dialog's whole
 * list) would bring in start seeing that they could not before (recorded places they miss, their own files, my
 * memories, my personal accounts: chat/audience-check.ts), as `viewer` (its creator) may see them. No folder rule
 * changes here: the new people are judged by the rules now.
 */
export async function chatWidening(ctx: AppContext, viewer: Principal, chat: ChatRow, add: readonly { subjectType: 'user' | 'group'; subjectId: string }[], page: { before?: number | null; limit: number }, locale: Locale): Promise<WideningResult> {
  const db = ctx.db
  const gained = gainedBy(ctx, chat, add)
  if (!gained.length) return { total: 0, totalCapped: false, items: [], nextRowid: null }
  const subjects: WideningSubject[] = []
  for (const x of add) {
    const people = gained.filter((g) => (x.subjectType === 'user' ? g.id === x.subjectId : g.groups.includes(x.subjectId))).map((g) => g.id)
    if (!people.length) continue
    const name = x.subjectType === 'user'
      ? (db.query('SELECT name FROM users WHERE id = ?').get(x.subjectId) as { name: string } | null)?.name
      : (db.query('SELECT name FROM groups WHERE id = ?').get(x.subjectId) as { name: string } | null)?.name
    if (name) subjects.push({ key: `${x.subjectType}:${x.subjectId}`, name, people })
  }
  const ids = gained.map((g) => g.id).sort()
  const wanted = add.map((x) => ({ type: x.subjectType, id: x.subjectId }))
  const { f } = await findingsFor(ctx, viewer, chat, ids, { cache: checkCacheKey(ctx, viewer.id, chat.id, stateOf(ctx, chat), wanted, ids) })
  const rules = ctx.files.rules()
  const words = { root: tr('scopeRoot', locale), mine: tr('sharedScopeMine', locale), room: tr('scopeRoom', locale), chat: tr('scopeChatFiles', locale) }
  // places in the Files screen's words, as the read card says them
  const place = (path: string) => placeWords(db, path, locale, viewer.id)
  return wideningAnswers(db, { now: rules, after: rules }, { kind: 'chat', chatId: chat.id }, gained, viewer, page, { subjects, words, place, extra: f.perAnswer })
}

/** The positions in the list as sent (`list`) of the entries just added (`added`) that bring in someone a warning is
 * about (`missing`, among the people they add now): the ones the warning names (QA TC-7042). Positions, never ids:
 * the check says who only as the sharer picked them. */
function warnPicksOf(ctx: AppContext, list: readonly { subjectType: 'user' | 'group'; subjectId: string }[], added: readonly AudienceSubject[], newPeople: readonly string[], missing: readonly string[]): number[] {
  const miss = new Set(missing), now = new Set(newPeople)
  const warn = new Set(added.filter((s) => resolveSubjects(ctx.db, [s]).some((id) => now.has(id) && miss.has(id))).map(subjectKey))
  return list.flatMap((x, i) => (warn.has(`${x.subjectType}:${x.subjectId}`) ? [i] : []))
}
type Picked = { list: readonly { subjectType: 'user' | 'group'; subjectId: string }[]; added: readonly AudienceSubject[]; people: readonly string[] }
/** The dialog's counts of a check (`picked`: the list as sent, the entries it adds and the people the check is for). */
const checkOf = (ctx: AppContext, added: number, x: Findings, L: Locale, me: string, picked?: Picked): ShareCheck => ({
  added, memoryAnswers: x.f.memoryAnswers.length, fileAnswers: x.f.fileAnswers.length, accountAnswers: x.f.accountAnswers.length,
  places: x.f.places, otherPlaces: x.f.otherPlaces, roomsUnseen: x.f.roomsUnseen, unchecked: x.f.unchecked.length, ...(x.earlierFiles ? { earlierFiles: x.earlierFiles } : {}),
  ...(x.made.length ? { madeFiles: madeOut(ctx, x.made, L, me, x.f) } : {}),
  ...(x.f.fileAnswers.length ? (() => { const names = fileNamesOf(ctx, x.f, me, L, x.fromMe); return names.length ? { fileNames: names } : {} })() : {}),
  ...(x.hidden.length ? { hiddenAnswers: x.hidden.length } : {}),
  ...(x.f.devAnswers.length ? { devAnswers: x.f.devAnswers.length } : {}),
  ...(picked ? { warnPicks: warnPicksOf(ctx, picked.list, picked.added, picked.people, [...x.f.missing, ...x.hiddenFrom]) } : {}),
})
/** A check with nothing in it but the files (a chat already shared: the step on its own). */
const filesCheck = (ctx: AppContext, made: readonly MadeFile[], L: Locale, me: string): ShareCheck => ({
  added: 0, memoryAnswers: 0, fileAnswers: 0, accountAnswers: 0, places: [], otherPlaces: false, roomsUnseen: false, unchecked: 0,
  ...(made.length ? { madeFiles: madeOut(ctx, made, L, me) } : {}),
})
/** The key a save of `wanted` must carry: over the list, the people it brings, every answer id each warning is about
 * (not counts), the places, the earlier uploads and every message of every branch. */
const keyOf = (ctx: AppContext, userId: string, chatId: string, wanted: readonly AudienceSubject[], x: Findings, messages: readonly string[]) =>
  confirmMac(ctx, { kind: 'chat.audience', v: 3, userId, chatId, subjects: wanted.map(subjectKey).sort(), ...findingsState(x.f), earlierFiles: x.earlierFiles, made: madeState(x.made), messages, ...(x.hidden.length ? { hidden: x.hidden } : {}) })

/** The list as asked, without repeats or me (the creator is always in it, never an entry); at most CHAT_AUDIENCE_MAX. */
function wantedOf(subjects: readonly { subjectType: 'user' | 'group'; subjectId: string }[], userId: string, locale: Locale): { wanted: AudienceSubject[]; seen: Set<string> } {
  const seen = new Set<string>()
  const wanted: AudienceSubject[] = []
  for (const s of subjects) {
    const x: AudienceSubject = { type: s.subjectType, id: s.subjectId }
    if (x.type === 'user' && x.id === userId) continue
    if (seen.has(subjectKey(x))) continue
    seen.add(subjectKey(x))
    wanted.push(x)
  }
  if (wanted.length > CHAT_AUDIENCE_MAX) fail('validation', tr('chatShareAudienceFull', locale), { params: { reason: 'audience_full' } })
  return { wanted, seen }
}

/** What a list would change against the chat as it is now, with the refusals of an add (safe operations, a turn running
 * or queued, an entry the creator may not add). */
function planOf(ctx: AppContext, rt: ChatRuntime, userId: string, me: Principal, a: ChatAccess, wanted: readonly AudienceSubject[], seen: ReadonlySet<string>, locale: Locale) {
  const db = ctx.db
  const r = rt.store.chatRow(a.row.id) ?? fail('not_found')
  changeable(ctx, userId, { ...a, row: r }, locale)
  const before = stateOf(ctx, r)
  const existing = new Set(before.subjects)
  const added = wanted.filter((s) => !existing.has(subjectKey(s)))
  const removed = subjectsOf(db, r.id).filter((s) => !seen.has(subjectKey(s)))
  if (added.length) {
    // while 1A is on every conversation is confidential, and a shared chat never is: no new people (removals go on)
    if (safeOpsEnabled() || confidentialChat(db, r.id)) fail('conflict', tr('chatShareSafeOps', locale), { params: { reason: 'safe_ops' } })
    // nothing may start or run while new people come in (a turn of the private chat would run without the read card)
    if (rt.activeTurn(r.id) || db.query("SELECT 1 FROM turns WHERE chat_id = ? AND status IN ('queued','running')").get(r.id)) fail('conflict', tr('chatShareBusy', locale), { params: { reason: 'chat_busy' } })
    // only the newly added entries are checked: an existing row of a group the creator left since stays valid
    checkNewSubjects(ctx, me, added, locale)
  }
  const after = [...existing].filter((k) => !removed.some((s) => subjectKey(s) === k)).map((k) => { const i = k.indexOf(':'); return { type: k.slice(0, i) as AudienceSubject['type'], id: k.slice(i + 1) } }).concat(added)
  const nowPeople = new Set(before.shared ? before.people : [userId])
  const afterPeople = new Set([userId, ...resolveSubjects(db, after)])
  const newPeople = [...afterPeople].filter((id) => !nowPeople.has(id)).sort()
  const lost = [...nowPeople].filter((id) => !afterPeople.has(id) && id !== userId)
  return { r, before, added, removed, after, nowPeople, afterPeople, newPeople, lost }
}

/** POST /api/chats/:id/audience/preview: the save's check without saving (the Share dialog, while picking). The same
 * refusals as a save; a 60-second cache per chat state, list, people and rules. `a`: the chat as chatFor found it. */
export async function previewChatAudience(ctx: AppContext, rt: ChatRuntime, userId: string, a: ChatAccess, body: { subjects: { subjectType: 'user' | 'group'; subjectId: string }[] }, locale: Locale): Promise<ChatAudiencePreview> {
  changeable(ctx, userId, a, locale)
  const { wanted, seen } = wantedOf(body.subjects, userId, locale)
  const me = loadPrincipal(ctx.db, userId)
  if (!me) return fail('forbidden')
  const plan = planOf(ctx, rt, userId, me, a, wanted, seen, locale)
  const empty: ShareCheck = { added: 0, memoryAnswers: 0, fileAnswers: 0, accountAnswers: 0, places: [], otherPlaces: false, roomsUnseen: false, unchecked: 0 }
  if (!plan.newPeople.length) return { check: empty, previewKey: '' }
  const x = await findingsFor(ctx, me, plan.r, plan.newPeople, { cache: checkCacheKey(ctx, userId, plan.r.id, plan.before, wanted, plan.newPeople) })
  // someone new would see a room it read but for old answers hidden from them: never shown, as a save says
  if (x.f.hidden) fail('conflict', tr('chatShareHidden', locale), { params: { reason: 'share_hidden' } })
  return { check: checkOf(ctx, plan.newPeople.length, x, locale, userId, { list: body.subjects, added: plan.added, people: plan.newPeople }), previewKey: keyOf(ctx, userId, plan.r.id, wanted, x, plan.before.messages) }
}

/** What a save is made against, read synchronously: the chat's entries, the people who see it now and every message of
 * every branch. The save goes ahead only while it is still this. */
function stateOf(ctx: AppContext, r: ChatRow) {
  const row = ctx.db.query('SELECT people_shared_at, project_id FROM chats WHERE id = ?').get(r.id) as Pick<ChatRow, 'people_shared_at' | 'project_id'> | null
  const shared = !!row && isPeopleRow(row)
  return {
    shared,
    subjects: subjectsOf(ctx.db, r.id).map(subjectKey).sort(),
    people: shared ? peopleAudience(ctx.db, r) : [r.user_id],
    messages: (ctx.db.query('SELECT id FROM messages WHERE chat_id = ? ORDER BY id').all(r.id) as { id: string }[]).map((m) => m.id),
  }
}
const same = (a: ReturnType<typeof stateOf>, b: ReturnType<typeof stateOf>) => JSON.stringify(a) === JSON.stringify(b)

/** PUT /api/chats/:id/audience. `a`: the caller's chat as chatFor found it ('view'). */
export async function putChatAudience(ctx: AppContext, rt: ChatRuntime, userId: string, a: ChatAccess, body: { subjects: { subjectType: 'user' | 'group'; subjectId: string }[]; confirmKey?: string; withFiles?: boolean }, locale: Locale): Promise<PutChatAudienceResult> {
  const db = ctx.db
  // from the room-send budget first (429): the check is no free probe of who may read what
  roomsOf(ctx).takeSendToken(userId)
  changeable(ctx, userId, a, locale)
  const { wanted, seen } = wantedOf(body.subjects, userId, locale)
  const me = loadPrincipal(db, userId)
  if (!me) return fail('forbidden')

  for (let round = 0; round < 3; round++) {
    const { r, before, added, removed, after, nowPeople, afterPeople, newPeople, lost } = planOf(ctx, rt, userId, me, a, wanted, seen, locale)
    if (!added.length && !removed.length) {
      // nothing to change; a private chat with nobody picked asks for someone first
      if (!before.shared) fail('validation', tr('chatShareNeedsPeople', locale), { params: { reason: 'needs_people' } })
      // a chat already shared: "Share with files" on its own (the files the chat made in my own folder)
      if (body.withFiles) {
        const made = madeFilesOf(ctx, r)
        const key = filesKeyOf(ctx, userId, r.id, made)
        if (body.confirmKey !== key) return { status: 'confirm', check: filesCheck(ctx, made, locale, userId), confirmKey: key, reason: body.confirmKey === undefined ? 'unchecked' : 'changed' }
        const v = made.length ? await readVerified(ctx, r, made) : { files: [] as VerifiedFile[], notCopied: 0 }
        if (!v) { const again = madeFilesOf(ctx, r); return { status: 'confirm', check: filesCheck(ctx, again, locale, userId), confirmKey: filesKeyOf(ctx, userId, r.id, again), reason: 'changed' } }
        const filesAdded = await copyMade(ctx, r, v.files, 'share')
        if (filesAdded) rt.publishChat(userId, r.id, 'updated')
        const out = rt.store.chatRow(r.id) ?? r
        return { status: 'saved', chat: chatView(rt, userId, out), audience: chatAudienceView(ctx, rt, userId, { ...a, row: out }), ...(filesAdded ? { filesAdded } : {}), ...(v.notCopied ? { filesNotCopied: v.notCopied } : {}) }
      }
      return { status: 'saved', chat: chatView(rt, userId, r), audience: chatAudienceView(ctx, rt, userId, { ...a, row: r }) }
    }

    // the check, for the people who would start to see it (nothing to check for removals or a group nobody new is in).
    // A save that brings anyone in carries the key of what they would see now (the preview's, or a confirm's): without
    // it, or with another state's, nothing is saved and the answer is the check (docs/DECISIONS.md "Share in one press")
    let confirm: PutChatAudienceResult | null = null
    let checked: AudienceFindings | null = null
    // the files a "Share with files" copies: the ones the key was made over (checked again at the press, below)
    let madeSeen: MadeFile[] = []
    if (newPeople.length) {
      const x = await findingsFor(ctx, me, r, newPeople)
      // (from here on nothing waits: the state read now is the one saved)
      const now = stateOf(ctx, rt.store.chatRow(r.id) ?? fail('not_found'))
      if (!same(now, before)) continue
      // someone new would see a room it read but for old answers hidden from them: never shown, confirmed or not
      if (x.f.hidden) fail('conflict', tr('chatShareHidden', locale), { params: { reason: 'share_hidden' } })
      const key = keyOf(ctx, userId, r.id, wanted, x, before.messages)
      if (body.confirmKey !== key) confirm = { status: 'confirm', check: checkOf(ctx, newPeople.length, x, locale, userId, { list: body.subjects, added, people: newPeople }), confirmKey: key, reason: body.confirmKey === undefined ? 'unchecked' : 'changed' }
      checked = x.f
      madeSeen = x.made
    } else if (body.withFiles && before.shared) {
      // only removals, and the files: the files' own key
      const made = madeFilesOf(ctx, r)
      const key = filesKeyOf(ctx, userId, r.id, made)
      if (body.confirmKey !== key) confirm = { status: 'confirm', check: filesCheck(ctx, made, locale, userId), confirmKey: key, reason: body.confirmKey === undefined ? 'unchecked' : 'changed' }
      madeSeen = made
    }
    if (confirm) return confirm
    // "Share with files": the press reads each file again from its descriptor and hashes the bytes it read. Anything
    // different from what the key was made over: nothing is saved or copied, the step is asked again
    let verified: Awaited<ReturnType<typeof readVerified>> = null
    if (body.withFiles && madeSeen.length) {
      verified = await readVerified(ctx, r, madeSeen, { audience: newPeople })
      if (!verified) {
        if (newPeople.length) continue
        const again = madeFilesOf(ctx, r)
        return { status: 'confirm', check: filesCheck(ctx, again, locale, userId), confirmKey: filesKeyOf(ctx, userId, r.id, again), reason: 'changed' }
      }
      if (!same(stateOf(ctx, rt.store.chatRow(r.id) ?? fail('not_found')), before)) { discardVerified(verified); continue }
    }

    // S7: the people who lose it stop first (their running or queued turn there would go on with their access and its
    // live text would reach them)
    for (const id of lost) stopTurnsIn(ctx, id, [r.id])
    const at = new Date().toISOString()
    const first = !before.shared && after.length > 0
    const everyone = after.length === 0
    let auditId = 0
    try { db.transaction(() => {
      // nothing changed since the check (synchronously: no turn can start in between)
      if (!same(stateOf(ctx, rt.store.chatRow(r.id) ?? fail('not_found')), before)) fail('conflict', tr('chatShareBusy', locale), { params: { reason: 'chat_busy' } })
      if (first) {
        db.query('UPDATE chats SET people_shared_at = ?, engine_session_id = NULL, engine_session_leaf_id = NULL WHERE id = ? AND people_shared_at IS NULL AND project_id IS NULL').run(at, r.id)
        // the turns so far were just checked: the rollback guard passes them, and their steps are their runner's
        db.query('UPDATE turns SET people_checked = 2, shared_checked = ? WHERE chat_id = ?').run(SHARED_LATER, r.id)
        // every answer so far stays with the people this share showed it to (chat/shared-answers.ts)
        const use = checked?.use ?? chatUse(db, r.id)
        const rules = ctx.files.rules()
        const places = new Map<string, ReadSource>()
        for (const s of [...use.other, ...use.files.map((f) => sourceOf(db, rules, f.path))]) places.set(sourceKey(s), s)
        // not all known (older answers the scope does not describe, my memories or personal accounts; every answer when
        // it read rooms it does not name): someone who sees it later and is not in this group misses that answer. Per
        // answer (QA TC-7262: one dev environment answer kept every answer from people added later); a dev environment
        // answer after the gap is not x: the sharer was told (devAnswers) and pressed Share
        const notAllIds = checked ? new Set([...checked.unchecked, ...checked.accountAnswers, ...checked.memoryAnswers]) : null
        const allNotAll = checked ? checked.roomsUnseen : !use.known || use.roomsUnseen
        const c = [...afterPeople].sort(), sources = [...places.values()]
        const add = db.query('INSERT OR IGNORE INTO shared_answer_reads (message_id, chat_id, reads) VALUES (?, ?, ?)')
        for (const id of use.answers) {
          const group: ReadGroup = { c, s: sources, ...(allNotAll || notAllIds?.has(id) ? { x: 1 as const } : {}) }
          add.run(id, r.id, JSON.stringify([group]))
        }
        audit(db, { actor: userId, action: 'chat.share', target: r.id, detail: { kind: 'people', audience: newPeople.length, answers: checked ? new Set([...checked.fileAnswers, ...checked.memoryAnswers, ...checked.accountAnswers]).size : 0, unchecked: checked?.unchecked.length ?? 0, memories: (checked?.memoryAnswers.length ?? 0) > 0, confirmed: body.confirmKey !== undefined } })
      }
      const ins = db.query('INSERT OR IGNORE INTO chat_audience (chat_id, subject_type, subject_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
      for (const s of added) ins.run(r.id, s.type, s.id, userId, at)
      const del = db.query('DELETE FROM chat_audience WHERE chat_id = ? AND subject_type = ? AND subject_id = ?')
      for (const s of removed) del.run(r.id, s.type, s.id)
      // everyone taken out: the chat is its creator's alone again (sharing again runs the check again)
      if (everyone) {
        db.query('UPDATE chats SET people_shared_at = NULL WHERE id = ?').run(r.id)
        db.query('DELETE FROM chat_list_hidden WHERE chat_id = ?').run(r.id)
      }
      for (const id of lost) db.query('DELETE FROM chat_list_hidden WHERE chat_id = ? AND user_id = ?').run(r.id, id)
      // the chat's own line of who changed its people ("{actor} added {names}", QA TC-7289): ids only, names read when shown
      if (added.length) addAudienceEvent(db, r.id, userId, 'added', added, at)
      if (removed.length) addAudienceEvent(db, r.id, userId, 'removed', removed, at)
      // their waiting asks to add a file of this chat go with them (everyone's when it is mine alone again)
      closeFileAsks(db, r.id, everyone ? null : lost)
      // who saw it, before or after this save: a link of someone who loses it later says why (chat/chat-audience.ts)
      rememberAudience(db, r.id, new Set([...nowPeople, ...afterPeople]), at)
      // counts only: no names, no content
      auditId = audit(db, { actor: userId, action: 'chat.audience', target: r.id, detail: {
        added: { people: added.filter((s) => s.type === 'user').length, groups: added.filter((s) => s.type === 'group').length },
        removed: { people: removed.filter((s) => s.type === 'user').length, groups: removed.filter((s) => s.type === 'group').length },
        newPeople: newPeople.length, lost: lost.length, ...(everyone ? { private: true } : {}), confirmed: body.confirmKey !== undefined,
      } })
    })() } catch (e) { discardVerified(verified); throw e }
    // a command running in this chat now is checked against its new people at once, not at the next poll
    // (devenv/srt/runner.ts: any change of a shared chat's people stops its running command)
    if (devEnvFlag()) void pollSrt(ctx, { chatId: r.id }).catch(() => {})
    // the private session's stash (its instructions held the memories): the next turn starts from the visible transcript
    if (first) fs.rmSync(path.join(ctx.config.dataDir, 'sessions', r.id), { recursive: true, force: true })
    // the creator's earlier computer uploads: copied to the chat's own files so everyone in it sees them (S6). A copy
    // that fails leaves that one its sender's alone, as before; the share stands
    // (in this request, read and written without blocking the server, each at most 50 MB: the creator is told how many
    // could not be shared, filesNotCopied)
    let filesNotCopied = 0
    if (first) { try { filesNotCopied = (await chatFilesOf(ctx).copyEarlier(r.id)).notCopied } catch (e) { ctx.log.warn('earlier uploads of a shared chat not copied', { err: e }) } }
    // "Share with files": the files checked at the press, into the chat (attached to the answers that made them)
    let filesAdded = 0
    if (verified && everyone) discardVerified(verified)
    if (verified && !everyone) {
      try { filesAdded = await copyMade(ctx, r, verified.files, 'share'); filesNotCopied += verified.notCopied } catch (e) { ctx.log.warn('files of a shared chat not added', { err: e }); filesNotCopied += verified.files.length + verified.notCopied }
    }
    // a running answer there works out who gets its live text again, now that the change is saved (chat/live-answer.ts)
    rt.forgetLiveViewers()
    // the people who lost it: their windows drop it (its id alone, nothing of it)
    for (const id of lost) rt.hub.publish(id, { type: 'chat.updated', data: { chatId: r.id, change: 'deleted', chat: null } })
    // everyone in it now hears the chat as they see it (the newly added get it as a new row of their list)
    rt.publishChat(userId, r.id, 'updated')
    // an Inbox notice for the people who start to see it (by name: "{name} shared a chat with you"; through a group: the
    // same row without a push); at most one a day per chat and person
    if (newPeople.length && !everyone) {
      const named = new Set(added.filter((s) => s.type === 'user').map((s) => s.id))
      try {
        const n = notificationsOf(ctx)
        for (const id of newPeople) n.chatShared(id, String(auditId), r.id, userId, named.has(id), at)
      } catch (e) { ctx.log.warn('chat share notices failed', { err: e }) }
    }
    // the people who lost it learn who stopped sharing it with them (QA TC-7272): ids only, the title shown only while
    // they see it again
    if (lost.length) {
      try { const n = notificationsOf(ctx); for (const id of lost) n.chatLost(id, r.id, userId, 'stopped', at) } catch (e) { ctx.log.warn('chat lost notices failed', { err: e }) }
    }
    // people taken out by name who still see it through a group listed: the creator is told which (QA TC-2264), only
    // through groups they are in themselves (admins: any). Through none of those: nothing is said (that would tell them
    // who is in a group they are not in)
    const afterGroups = after.filter((s) => s.type === 'group').map((s) => s.id)
    const keptThrough = removed.filter((s) => s.type === 'user' && afterPeople.has(s.id)).map((s) => {
      const name = (db.query('SELECT name FROM users WHERE id = ?').get(s.id) as { name: string } | null)?.name ?? ''
      const groups = groupsOfIn(db, s.id, afterGroups.filter((g) => isAdmin(me.role) || me.groups.includes(g)))
        .map((g) => (db.query('SELECT name FROM groups WHERE id = ?').get(g) as { name: string } | null)?.name).filter((n): n is string => !!n)
      return { name, groups }
    }).filter((k) => k.name && k.groups.length)
    const out = rt.store.chatRow(r.id)!
    return { status: 'saved', chat: chatView(rt, userId, out), audience: chatAudienceView(ctx, rt, userId, { ...a, row: out, kind: isPeopleRow(out) ? 'people' : null, shared: isPeopleRow(out) }), ...(filesNotCopied ? { filesNotCopied } : {}), ...(filesAdded ? { filesAdded } : {}), ...(keptThrough.length ? { keptThrough } : {}) }
  }
  return fail('conflict', tr('chatShareBusy', locale), { params: { reason: 'chat_busy' } })
}

/** POST /api/chats/:id/hide: a chat someone shared with me leaves my lists (mine only). Its creator: 400. */
export function hideChat(ctx: AppContext, userId: string, a: ChatAccess, hide: boolean, locale: Locale): void {
  if (a.kind !== 'people' || a.creator) fail('validation', tr('chatHideCreator', locale), { params: { reason: 'chat_hide_creator' } })
  if (hide) ctx.db.query('INSERT OR IGNORE INTO chat_list_hidden (user_id, chat_id, at) VALUES (?, ?, ?)').run(userId, a.row.id, new Date().toISOString())
  else ctx.db.query('DELETE FROM chat_list_hidden WHERE user_id = ? AND chat_id = ?').run(userId, a.row.id)
}

/** Opening a chat brings it back to the person's lists (POST /api/chats/:id/seen). True when it was hidden. */
export function unhideOnOpen(ctx: AppContext, userId: string, chatId: string): boolean {
  return ctx.db.query('DELETE FROM chat_list_hidden WHERE user_id = ? AND chat_id = ?').run(userId, chatId).changes > 0
}

/** How many chats this person shared with people and groups that someone else sees now (the admin's delete dialog:
 * deleting the account deletes them; disabling it keeps them). */
export function peopleSharedChatsOf(ctx: AppContext, userId: string): number {
  // every one shared with someone else now, not only those with others' messages (QA TC-7341: a chat they only read
  // goes too)
  return peopleSharedChatIdsOf(ctx, userId).length
}

/** This person's chats shared with people and groups (not in the trash) that someone else sees now. */
export function peopleSharedChatIdsOf(ctx: AppContext, userId: string): string[] {
  const rows = ctx.db.query('SELECT id, user_id FROM chats WHERE user_id = ? AND people_shared_at IS NOT NULL AND project_id IS NULL AND deleted_at IS NULL AND room_id IS NULL').all(userId) as { id: string; user_id: string }[]
  return rows.filter((c) => resolveSubjects(ctx.db, subjectsOf(ctx.db, c.id)).some((id) => id !== userId)).map((c) => c.id)
}

/** The creator's account was switched off or deleted: everyone in their chats shared with people reads it under the box
 * at once (Chat.shared.byGone, QA TC-7431). `ids`: the chats, read before a deletion took the rows away. */
export function creatorChatsChanged(ctx: AppContext, userId: string, ids: readonly string[] = peopleSharedChatIdsOf(ctx, userId)): void {
  for (const chatId of ids) { try { publishChatChanged(ctx, userId, chatId) } catch (e) { ctx.log.warn('a shared chat\'s people were not told of its creator\'s account', { err: e }) } }
}

/** The people in this person's chats shared with others, per chat, read before their account is deleted (the Inbox
 * notice 'account' then names the chats they lose, QA TC-7341). */
export function peopleInChatsOf(ctx: AppContext, userId: string): { chatId: string; people: string[] }[] {
  return peopleSharedChatIdsOf(ctx, userId).map((chatId) => ({ chatId, people: resolveSubjects(ctx.db, subjectsOf(ctx.db, chatId)).filter((id) => id !== userId) }))
}

/** After an account deletion: each person in its chats shared with others gets the notice 'account' (who, and when the
 * chat goes), and their windows hear the chat again. */
export function accountChatsGone(ctx: AppContext, userId: string, before: readonly { chatId: string; people: string[] }[]): void {
  const at = new Date().toISOString()
  try {
    const n = notificationsOf(ctx)
    for (const c of before) for (const id of c.people) n.chatLost(id, c.chatId, userId, 'account', at)
  } catch (e) { ctx.log.warn('notices of a deleted account\'s shared chats failed', { err: e }) }
  creatorChatsChanged(ctx, userId, before.map((c) => c.chatId))
}
