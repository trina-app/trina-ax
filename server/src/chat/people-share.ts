// "Share…" for a chat outside projects (docs/DECISIONS.md "Chats shared with people and groups", QA TC-1405; plan
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
import fs from 'node:fs'
import path from 'node:path'
import type { ChatAudience, Locale, PutChatAudienceResult } from '@mycel/shared/api'
import { CHAT_AUDIENCE_MAX } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { loadPrincipal, type Principal } from '../policy/access'
import { confidentialChat } from '../safe-ops/confidential'
import { safeOpsEnabled } from '../safe-ops/runner'
import { roomsOf } from '../rooms/service'
import type { ChatRuntime } from './runtime'
import { stopTurnsIn } from './runtime'
import { SHARED_LATER, type ChatRow } from './store'
import { isInternalChat } from './internal-chats'
import { isPersonalFolder } from './projects'
import { chatView, type ChatAccess } from './shared'
import { chatUse, memoriesInPlay } from './share-chat'
import { confirmMac, provenanceChecker } from './answer-share'
import { sourceKey, sourceOf, type ReadSource } from './read-scope'
import type { ReadGroup } from './shared-answers'
import { placeWords } from './place-words'
import { wideningAnswers, type WideningResult, type WideningSubject } from './widening'
import { isPeopleRow, peopleAudience, resolveSubjects, subjectsOf, type AudienceSubject } from './chat-audience'
import { tr } from './i18n'
import { notificationsOf } from '../notifications/service'
import { chatFilesOf } from './chat-files'

const isAdmin = (role: string | undefined) => role === 'owner' || role === 'admin'
const subjectKey = (s: AudienceSubject) => `${s.type}:${s.id}`

/** The entries someone adds to a chat's audience, checked (the save and the widening list: the same rule): an active
 * person; a group that exists and, for a member, one of their own (admins any). Else 400 unknown_subject. */
export function checkNewSubjects(ctx: AppContext, me: Principal, added: readonly AudienceSubject[], locale: Locale): void {
  for (const s of added) {
    const ok = s.type === 'user'
      // a guest is never shared a chat with (their one place is a room or a project): the same answer as an unknown person
      ? !!ctx.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL AND guest = 0").get(s.id)
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
      rows.push({ subjectType: 'user', subjectId: s.id, name: u.name, ...(u.title ? { title: u.title } : {}), ...(u.avatar_version ? { avatarVersion: u.avatar_version } : {}), ...(inactive ? { inactive: true as const } : {}) })
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
  return { kind: 'people', canEdit: a.creator, by, subjects: rows, ...(!groups || full ? { count: peopleAudience(db, r).length } : {}) }
}

/**
 * The refusals of a change of who sees the chat, against the chat as it is now: someone else's chat is chatFor's 404
 * (or 403 for someone who sees it); a chat in a project is shared with its members (or stays its creator's in a
 * personal one); a scheduled run's chat and a room's side chat are never shared.
 */
function changeable(ctx: AppContext, userId: string, a: ChatAccess, locale: Locale): void {
  const r = a.row
  const no = (status: 'conflict' | 'validation', reason: string, key: Parameters<typeof tr>[0]): never => fail(status, tr(key, locale), { params: { reason } })
  if (r.room_id || r.deleted_at || isInternalChat(ctx.db, r.id)) fail('not_found')
  if (!a.creator) fail('forbidden', tr('chatShareCreatorOnly', locale), { params: { reason: 'chat_share_creator_only' } })
  if (r.project_id) {
    const p = ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(r.project_id) as { folder_path: string } | null
    if (p && isPersonalFolder(p.folder_path)) no('conflict', 'project_personal', 'chatSharePersonalProject')
    no('conflict', 'share_people_in_project', 'chatSharePeopleInProject')
  }
  if (scheduledRun(ctx, r)) no('conflict', 'scheduled_run', 'chatShareScheduled')
  // a room's side chat holds the room's words; only the room's members may read them (QA TC-1010)
  if (r.side_room_id) no('conflict', 'side_chat', 'chatShareSideChat')
}

/**
 * The widening list of one chat (chat/widening.ts wideningAnswers with the chat target; POST
 * /api/sharing/widening-answers {kind: 'chat'}): the answers of this chat that the people `add` (the Share dialog's whole
 * list) would bring in start seeing although they miss a place one used, as `viewer` (its creator) may see them. The
 * count of the save's confirm (`hiddenAnswers`) is this list's `total`, so the warning and the list agree. No folder rule
 * changes here: the new people are judged by the rules now.
 */
export function chatWidening(ctx: AppContext, viewer: Principal, chat: ChatRow, add: readonly { subjectType: 'user' | 'group'; subjectId: string }[], page: { before?: number | null; limit: number }, locale: Locale): WideningResult {
  const db = ctx.db
  const now = new Set(isPeopleRow(chat) ? peopleAudience(db, chat) : [chat.user_id])
  const gained = resolveSubjects(db, add.map((x) => ({ type: x.subjectType, id: x.subjectId }))).filter((id) => !now.has(id) && id !== chat.user_id)
    .map((id) => loadPrincipal(db, id)).filter((x): x is Principal => !!x)
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
  const rules = ctx.files.rules()
  const words = { root: tr('scopeRoot', locale), mine: tr('sharedScopeMine', locale), room: tr('scopeRoom', locale), chat: tr('scopeChatFiles', locale) }
  // places in the Files screen's words, as the read card says them
  const place = (path: string) => placeWords(db, path, locale, viewer.id)
  return wideningAnswers(db, { now: rules, after: rules }, { kind: 'chat', chatId: chat.id }, gained, viewer, page, { subjects, words, place })
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
export async function putChatAudience(ctx: AppContext, rt: ChatRuntime, userId: string, a: ChatAccess, body: { subjects: { subjectType: 'user' | 'group'; subjectId: string }[]; confirmKey?: string }, locale: Locale): Promise<PutChatAudienceResult> {
  const db = ctx.db
  // from the room-send budget first (429): the check is no free probe of who may read what
  roomsOf(ctx).takeSendToken(userId)
  changeable(ctx, userId, a, locale)
  // the list as asked, without repeats; the creator is always in it (never an entry)
  const seen = new Set<string>()
  const wanted: AudienceSubject[] = []
  for (const s of body.subjects) {
    const x: AudienceSubject = { type: s.subjectType, id: s.subjectId }
    if (x.type === 'user' && x.id === userId) continue
    if (seen.has(subjectKey(x))) continue
    seen.add(subjectKey(x))
    wanted.push(x)
  }
  if (wanted.length > CHAT_AUDIENCE_MAX) fail('validation', tr('chatShareAudienceFull', locale), { params: { reason: 'audience_full' } })
  const me = loadPrincipal(db, userId)
  if (!me) return fail('forbidden')

  for (let round = 0; round < 3; round++) {
    const r = rt.store.chatRow(a.row.id) ?? fail('not_found')
    changeable(ctx, userId, { ...a, row: r }, locale)
    const before = stateOf(ctx, r)
    const existing = new Set(before.subjects)
    const added = wanted.filter((s) => !existing.has(subjectKey(s)))
    const removed = subjectsOf(db, r.id).filter((s) => !seen.has(subjectKey(s)))
    if (!added.length && !removed.length) {
      // nothing to change; a private chat with nobody picked asks for someone first
      if (!before.shared) fail('validation', tr('chatShareNeedsPeople', locale), { params: { reason: 'needs_people' } })
      return { status: 'saved', chat: chatView(rt, userId, r), audience: chatAudienceView(ctx, rt, userId, { ...a, row: r }) }
    }
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

    // the check, for the people who would start to see it (nothing to check for removals or a group nobody new is in)
    let confirm: PutChatAudienceResult | null = null
    let checked: { use: ReturnType<typeof chatUse>; memories: boolean; people: number; unknown: boolean } | null = null
    if (newPeople.length) {
      const use = chatUse(db, r.id)
      const prov = await provenanceChecker(ctx, userId, newPeople, use.answers).of([use], new Set())
      const memories = memoriesInPlay(db, r.id, userId)
      // a first share also shows the creator's earlier computer uploads to them (copied: chat/chat-files.ts)
      const earlierFiles = before.shared ? 0 : chatFilesOf(ctx).earlierUploads(r.id)
      const hiddenAnswers = chatWidening(ctx, me, r, wanted.map((s) => ({ subjectType: s.type, subjectId: s.id })), { limit: 0 }, locale).total
      // (from here on nothing waits: the state read now is the one saved)
      const now = stateOf(ctx, rt.store.chatRow(r.id) ?? fail('not_found'))
      if (!same(now, before)) continue
      // someone new would see a room it read but for old answers hidden from them: never shown, confirmed or not
      if (prov.hidden) fail('conflict', tr('chatShareHidden', locale), { params: { reason: 'share_hidden' } })
      const key = confirmMac(ctx, { kind: 'chat.audience', v: 1, userId, chatId: r.id, subjects: wanted.map(subjectKey).sort(), newPeople, sources: prov.keys, places: prov.places, otherPlaces: prov.otherPlaces, unknown: prov.unknown, memories, hiddenAnswers, earlierFiles, messages: before.messages })
      const people = prov.unknown ? newPeople.length : prov.missing.size
      const applies = people > 0 || memories || hiddenAnswers > 0 || earlierFiles > 0
      if ((applies || body.confirmKey !== undefined) && body.confirmKey !== key) {
        confirm = {
          status: 'confirm', added: newPeople.length, memories, hiddenAnswers, confirmKey: key, ...(earlierFiles ? { earlierFiles } : {}),
          provenance: people > 0 ? { people, places: prov.places, otherPlaces: prov.otherPlaces, ...(prov.unknown ? { unknown: true as const } : {}) } : null,
          ...(body.confirmKey !== undefined ? { reason: 'changed' as const } : {}),
        }
      }
      checked = { use, memories, people, unknown: prov.unknown }
    }
    if (confirm) return confirm

    // S7: the people who lose it stop first (their running or queued turn there would go on with their access and its
    // live text would reach them)
    for (const id of lost) stopTurnsIn(ctx, id, [r.id])
    const at = new Date().toISOString()
    const first = !before.shared && after.length > 0
    const everyone = after.length === 0
    let auditId = 0
    db.transaction(() => {
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
        const group: ReadGroup = { c: [...afterPeople].sort(), s: [...places.values()], ...(!use.known || use.roomsUnseen || checked?.memories ? { x: 1 as const } : {}) }
        const add = db.query('INSERT OR IGNORE INTO shared_answer_reads (message_id, chat_id, reads) VALUES (?, ?, ?)')
        for (const id of use.answers) add.run(id, r.id, JSON.stringify([group]))
        audit(db, { actor: userId, action: 'chat.share', target: r.id, detail: { kind: 'people', audience: newPeople.length, people: checked?.people ?? 0, unknown: checked?.unknown ?? false, memories: checked?.memories ?? false, confirmed: body.confirmKey !== undefined } })
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
      // counts only: no names, no content
      auditId = audit(db, { actor: userId, action: 'chat.audience', target: r.id, detail: {
        added: { people: added.filter((s) => s.type === 'user').length, groups: added.filter((s) => s.type === 'group').length },
        removed: { people: removed.filter((s) => s.type === 'user').length, groups: removed.filter((s) => s.type === 'group').length },
        newPeople: newPeople.length, lost: lost.length, ...(everyone ? { private: true } : {}), confirmed: body.confirmKey !== undefined,
      } })
    })()
    // the private session's stash (its instructions held the memories): the next turn starts from the visible transcript
    if (first) fs.rmSync(path.join(ctx.config.dataDir, 'sessions', r.id), { recursive: true, force: true })
    // the creator's earlier computer uploads: copied to the chat's own files so everyone in it sees them (S6). A copy
    // that fails leaves that one its sender's alone, as before; the share stands
    // (in this request, read and written without blocking the server, each at most 50 MB: the creator is told how many
    // could not be shared, filesNotCopied)
    let filesNotCopied = 0
    if (first) { try { filesNotCopied = (await chatFilesOf(ctx).copyEarlier(r.id)).notCopied } catch (e) { ctx.log.warn('earlier uploads of a shared chat not copied', { err: e }) } }
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
    const out = rt.store.chatRow(r.id)!
    return { status: 'saved', chat: chatView(rt, userId, out), audience: chatAudienceView(ctx, rt, userId, { ...a, row: out, kind: isPeopleRow(out) ? 'people' : null, shared: isPeopleRow(out) }), ...(filesNotCopied ? { filesNotCopied } : {}) }
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

/** How many chats this person shared with people and groups that hold other people's messages (the admin's delete
 * dialog: deleting the account deletes them for good; disabling it keeps them). */
export function peopleSharedChatsOf(ctx: AppContext, userId: string): number {
  return (ctx.db.query(`SELECT COUNT(*) AS n FROM chats c WHERE c.user_id = ? AND c.people_shared_at IS NOT NULL AND c.project_id IS NULL
    AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.role = 'user' AND m.author_id IS NOT NULL AND m.author_id <> c.user_id)`).get(userId) as { n: number }).n
}
