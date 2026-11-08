// "프로젝트 사람들과 공유" (shared/src/api/chats.ts shareChat; docs/DECISIONS.md "Shared project chats", "An existing chat
// shared"): the creator of a private chat in a team project that shares its chats makes it a shared chat, after a
// one-time check of what it contains. In a shared chat every read some of the project cannot see waits for the read
// card first (chat/turn.ts confirmSharedRead); a private chat's earlier turns had no such card, so their visible answers
// may carry content from narrower places (finance, the person's own folder, personal connections, Drive, the in-app
// browser, rooms) and from personal memories. Other people's turns start a fresh engine session fed only the visible
// transcript (chat/turn.ts, chat/shared.ts stashWrittenBy), so the visible messages are what gets disclosed: the same
// informed decision as "대화방에 보내기" (chat/answer-share.ts, its provenance line), with its code.
//
// The check, over every branch (viewers switch branches): every answer's files (message_sources, each with its sha256),
// the session's read scope when it describes every answer (else "not all known": an answer from before the newest first
// answer, whose session emptied the scope), and personal memories when a turn here ran while the person had one. Left
// out: what everyone in the audience reads now, and by the hash rule identical content a turn of this chat saved where
// the whole audience reads it now. Nothing left: shared at once. Otherwise "confirm" with the provenance line (places
// named only where the creator may look, never who), the memory note and an opaque key over the audience, the sources,
// the memories and every message of every branch; sent back while nothing changed, it shares. Every request takes from
// the room-send budget first, as "대화방에 보내기" does: the check is no free probe of who may read what.
//
// Sharing sets chats.shared_at; forgets the chat's engine session (a resumed private session keeps the memories of its
// instructions and tool results the transcript does not have; the creator's next turn starts from the visible
// transcript like anyone's); marks the chat's earlier turns as checked (chat/shared.ts unshareUncheckedChats unshares a
// shared chat with an unmarked turn, with no time filter: a turn from before migration 265 would unshare it at the next
// start, and these turns were just checked); and is audited (chat.share: counts and whether it was confirmed; no names,
// no content). Nothing unshares it (D1). The steps of the earlier answers show their words alone to everyone but the
// person whose turn it was (chat/store.ts viewSteps): their labels can name paths, addresses or a remembered text.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Locale, ShareChatResult } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { loadPrincipal } from '../policy/access'
import { confidentialChat } from '../safe-ops/confidential'
import { roomsOf } from '../rooms/service'
import type { ChatRuntime } from './runtime'
import { SHARED_LATER, type ChatRow, type ProjectRow } from './store'
import { canSeeProject } from './projects'
import { isInternalChat } from './internal-chats'
import { audienceOf, chatView, projectCanShare, type ChatAccess } from './shared'
import { confirmMac, provenanceChecker, useOf, type BranchUse } from './answer-share'
import { tr } from './i18n'

/** Does the chat's read scope describe every answer of the chat? The scope is emptied when a session starts on a first
 * message (chat/turn.ts newSession) and every turn since adds to it, on whatever branch; so it does when no answer was
 * made before the newest answer to a first message (and when there is no answer at all). */
function scopeDescribesAll(db: Database, chatId: string): boolean {
  // in the order the answers were written (rowid), not by the clock: a clock set back must not reorder them
  const first = db.query(`SELECT a.rowid AS rid FROM messages a JOIN messages q ON q.id = a.parent_id
    WHERE a.chat_id = ? AND a.role = 'assistant' AND q.parent_id IS NULL ORDER BY a.rowid DESC LIMIT 1`).get(chatId) as { rid: number } | null
  if (!first) return !db.query("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'assistant' LIMIT 1").get(chatId)
  return !db.query("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'assistant' AND rowid < ? LIMIT 1").get(chatId, first.rid)
}

/** What the whole chat used, every branch: the files every answer read, and the scope's other sources when the scope
 * describes every answer (chat/answer-share.ts useOf). */
export function chatUse(db: Database, chatId: string): BranchUse {
  const answers = (db.query("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at, rowid").all(chatId) as { id: string }[]).map((r) => r.id)
  return useOf(db, chatId, answers, scopeDescribesAll(db, chatId))
}

/**
 * Did the person's memories go into this chat's answers? Every turn of a person's own chat has their memories in its
 * instructions (chat/turn.ts promptInput; a shared chat's and a room's never), so: an answer here was written while they
 * had a memory. A memory is deleted for good, so one deleted since this chat's first answer counts as one they had
 * (memory.delete and memory.clear are audited; the AI's forget is a step of an answer of theirs).
 */
export function memoriesInPlay(db: Database, chatId: string, userId: string): boolean {
  const span = db.query("SELECT MIN(created_at) AS first, MAX(updated_at) AS last FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { first: string | null; last: string | null }
  if (!span.first) return false
  return !!db.query('SELECT 1 FROM memories WHERE user_id = ? AND created_at <= ? LIMIT 1').get(userId, span.last ?? span.first)
    || !!db.query("SELECT 1 FROM audit_log WHERE actor_id = ? AND action IN ('memory.delete', 'memory.clear') AND at >= ? LIMIT 1").get(userId, span.first)
    || !!db.query(`SELECT 1 FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.user_id = ? AND m.role = 'assistant' AND m.created_at >= ?
      AND m.steps LIKE '%"tool":"forget"%' LIMIT 1`).get(userId, span.first)
}

/** A scheduled task's run made this chat (or ran in it). */
const scheduledRun = (db: Database, r: Pick<ChatRow, 'id' | 'title_source'>): boolean =>
  r.title_source === 'schedule' || !!db.query('SELECT 1 FROM turns WHERE chat_id = ? AND schedule_id IS NOT NULL LIMIT 1').get(r.id)

/**
 * The refusals, against the chat and its project as they are now (each a 409 with its reason): someone else's chat and
 * a missing one are chatFor's not_found already. Returns the project. Called again right before the chat is shared.
 */
function shareable(ctx: AppContext, rt: ChatRuntime, userId: string, r: ChatRow, locale: Locale): ProjectRow {
  const db = ctx.db
  const no = (reason: string, key: Parameters<typeof tr>[0]): never => fail('conflict', tr(key, locale), { params: { reason } })
  if (r.room_id || r.deleted_at || r.user_id !== userId || isInternalChat(db, r.id)) return fail('not_found')
  if (r.shared_at) return no('already_shared', 'chatShareAlready')
  if (scheduledRun(db, r)) return no('scheduled_run', 'chatShareScheduled')
  // while safe operations (1A) are on every conversation is confidential, and a shared chat never is
  if (confidentialChat(db, r.id)) return no('safe_ops', 'chatShareSafeOps')
  const project = r.project_id ? rt.store.projectRow(r.project_id) : null
  const me = loadPrincipal(db, userId)
  // a project I do not see (no read access, or its folder in the trash for a member) says nothing about its setting
  if (!project || !me || !canSeeProject(ctx.files, me, project)) return no('project_not_sharing', 'chatShareNoProject')
  if (!projectCanShare(project)) return no('project_personal', 'sharedProjectPersonal')
  if (project.trashed_with !== null) return no('project_in_trash', 'projectInTrash')
  if (project.share_chats !== 1) return no('project_not_sharing', 'chatShareNoProject')
  if (rt.activeTurn(r.id)) return no('chat_busy', 'chatShareBusy')
  return project
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** What a check was made for, read synchronously: the chat's project, the people who would see it besides its creator
 * (sorted) and every message of every branch. The share goes ahead only while it is still this. */
function stateOf(ctx: AppContext, rt: ChatRuntime, userId: string, chatId: string, locale: Locale): { project: ProjectRow; audience: string[]; messages: string[] } {
  const project = shareable(ctx, rt, userId, rt.store.chatRow(chatId) ?? fail('not_found'), locale)
  return {
    project,
    audience: audienceOf(ctx.db, ctx.files, project).filter((id) => id !== userId).sort(),
    messages: (ctx.db.query('SELECT id FROM messages WHERE chat_id = ? ORDER BY id').all(chatId) as { id: string }[]).map((m) => m.id),
  }
}

/** POST /api/chats/:id/share. `a`: the caller's chat as chatFor found it ('view'). */
export async function shareChat(ctx: AppContext, rt: ChatRuntime, userId: string, a: ChatAccess, body: { confirmKey?: string; ask?: boolean }, locale: Locale): Promise<ShareChatResult> {
  const db = ctx.db
  if (a.shared) fail('conflict', tr('chatShareAlready', locale), { params: { reason: 'already_shared' } })
  shareable(ctx, rt, userId, a.row, locale)
  // from the room-send budget first (429): asking who could not read what is no free probe
  roomsOf(ctx).takeSendToken(userId)

  // The check takes a moment (file hashes): the state it was made for is read again after it, synchronously with the
  // update, and a change meanwhile (the chat moved to another project, someone joined or left, a new message) means
  // checking again (at most three times)
  for (let round = 0; round < 3; round++) {
    const before = stateOf(ctx, rt, userId, a.row.id, locale)
    const { project, audience, messages } = before
    const use = chatUse(db, a.row.id)
    const prov = await provenanceChecker(ctx, userId, audience, use.answers).of([use], new Set())
    // (also with nobody else in the project now: whoever gets access later sees the whole chat)
    const memories = memoriesInPlay(db, a.row.id, userId)
    // (from here on nothing waits: the state read now is the one shared)
    const now = stateOf(ctx, rt, userId, a.row.id, locale)
    if (now.project.id !== project.id || !sameList(now.audience, audience) || !sameList(now.messages, messages)) continue
    const key = confirmMac(ctx, { kind: 'chat.share', v: 1, userId, chatId: a.row.id, projectId: project.id, audience, sources: prov.keys, places: prov.places, otherPlaces: prov.otherPlaces, unknown: prov.unknown, memories, messages })
    // a member who would see a room it read but for old answers hidden from them: never shown it, confirmed or not
    if (audience.length && prov.hidden) fail('conflict', tr('chatShareHidden', locale), { params: { reason: 'share_hidden' } })
    const people = prov.unknown ? audience.length : prov.missing.size
    const applies = people > 0 || memories
    // `ask` (the title menu): the question comes first even when nothing applies; the key then shares. A key that is
    // sent must be this state's, whatever applies: a yes to "share with 3 people?" is no yes once 30 would see it
    if ((applies || body.ask || body.confirmKey !== undefined) && body.confirmKey !== key) {
      return {
        status: 'confirm', audience: audience.length, memories, confirmKey: key,
        provenance: people > 0 ? { people, places: prov.places, otherPlaces: prov.otherPlaces, ...(prov.unknown ? { unknown: true as const } : {}) } : null,
        ...(body.confirmKey !== undefined ? { reason: 'changed' as const } : {}),
      }
    }
    // shared, with nothing in between: stateOf just checked the chat and its project again (no turn queued or running),
    // and nothing can start a turn before the update (a turn of the private chat would run without the read card)
    const at = new Date().toISOString()
    db.transaction(() => {
      db.query('UPDATE chats SET shared_at = ?, engine_session_id = NULL, engine_session_leaf_id = NULL WHERE id = ? AND shared_at IS NULL').run(at, a.row.id)
      // these turns were just checked: the rollback guard must not take them for an older build's
      // (and marked as before the share, whatever the clock says: their steps are their runner's, chat/store.ts viewSteps)
      db.query('UPDATE turns SET shared_checked = ? WHERE chat_id = ?').run(SHARED_LATER, a.row.id)
      audit(db, { actor: userId, action: 'chat.share', target: a.row.id, detail: { audience: audience.length, people, unknown: prov.unknown, memories, confirmed: body.confirmKey !== undefined } })
    })()
    // the private session's stash (its instructions held the memories): the next turn starts from the visible transcript
    fs.rmSync(path.join(ctx.config.dataDir, 'sessions', a.row.id), { recursive: true, force: true })
    rt.publishChat(userId, a.row.id, 'updated')
    return { status: 'shared', chat: chatView(rt, userId, rt.store.chatRow(a.row.id)!) }
  }
  return fail('conflict', tr('chatShareBusy', locale), { params: { reason: 'chat_busy' } })
}
