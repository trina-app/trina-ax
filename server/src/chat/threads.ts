// Threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md, migration 408). Teammates who
// see a shared chat (a team project's chat, or one shared with people and groups) talk under one finished answer; the
// AI never takes part, and nothing puts these tables in a turn by itself (no prompt, transcript, room tool, search, Often
// asked, title, memory or schedule does). Their words reach the AI one way: the AI's answer_comments tool when the user refers to
// them (chat/answer-comments.ts, docs/decisions/20261117-ai-reads-answer-comments.md: this chat only, through
// threadAccess below, the chat marked as having read rooms).
//
// One gate, threadAccess, on top of chatFor: every read, reply, delete, read mark, notice (when it is made and when the
// Inbox shows it), push and realtime event (and its replay, realtime/hub.ts stillVisible) goes through it, with nothing
// about who sees a thread stored. A thread follows its answer: who may not see the answer (it is hidden from them,
// chat/shared-answers.ts) sees none of it, with the same 404 as a missing thread. Followers are the answer's asker and
// everyone who replied; each gets one unread notice per thread (updated in place by later replies) and a push while
// "Replies in threads I'm part of" is on.
//
// @mentions (docs/decisions/20261118-chat-thread-mentions.md, migration 417): the reply box may mention the people who
// see the thread now (threadPeople, sent with the page). A send keeps only the ids that are among them at that moment
// and pass threadAccess for themselves, never the sender; the rest are dropped without a word. A mentioned person
// follows the thread from that reply on (as in a room's thread), so its notice and unread dot follow the same rules,
// and their notice says it mentions them (chat_thread_notices.mention_id) while that reply is there.
import type { Database } from 'bun:sqlite'
import { CHAT_THREAD_MAX, inQuietHours, plainLabel, type ChatThreadPage, type ChatThreadReadOnly, type ChatThreadReply, type ChatThreadSummary, type InboxNotification, type Locale, type NotificationEventType } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { teamTimeZone } from '../admin/settings'
import { loadPrincipal } from '../policy/access'
import { safeOpsEnabled } from '../safe-ops/runner'
import { confidentialChat } from '../safe-ops/confidential'
import { redactorFor } from '../integrations/connections/redact'
import { roomsOf } from '../rooms/service'
import { getPreferences } from '../notifications/preferences'
import { NOTIFICATION_RETENTION_MS, notificationsOf } from '../notifications/service'
import { getChatRuntime, type ChatRuntime } from './runtime'
import { Audiences, chatFor, isProjectSharedRow, isSharedRow, messageFor, messageView, type ChatAccess } from './shared'
import { AnswerSight, chatNodes, withheldAmong, type Node } from './shared-answers'
import { decodeCursor, encodeCursor, type ChatRow, type MessageRow, type MessageView } from './store'
import { mayEditProject } from './projects'
import { tr } from './i18n'

/** how long a reply's notice waits before it is pushed: someone with the thread on screen reads it meanwhile */
export const CHAT_THREAD_PUSH_DELAY_MS = 10_000
/** a thread's page of replies */
export const CHAT_THREAD_PAGE = 50
/** answers that can have a thread: finished ones (never one still being written or one that failed) */
const FINISHED = new Set(['done', 'stopped'])

interface ReplyRow { id: string; chat_id: string; root_id: string; author_id: string | null; content: string; client_id: string | null; created_at: string; mentions: string }
const REPLY_COLS = 'id, chat_id, root_id, author_id, content, client_id, created_at, mentions'

/** A reply's stored mentions (a JSON array of ids; anything else: none). */
export function parseReplyMentions(raw: string | null | undefined): string[] {
  if (!raw || raw === '[]') return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** What threadAccess found: the chat as chatFor gave it, the answer, whether the caller may delete other people's
 * replies, and why they may not reply (null: they may). */
export interface ThreadGate { a: ChatAccess; root: MessageRow; moderator: boolean; readOnly: ChatThreadReadOnly | null }

/** Is this answer hidden from `viewer` (chat/shared-answers.ts)? Never an answer of their own question; a chat of one
 * person has no view, so nothing is hidden there. */
function rootHidden(rt: ChatRuntime, row: ChatRow, root: MessageRow, viewer: string, locale: Locale, view?: MessageView): boolean {
  if (root.turn_id && rt.store.turnUser(root.turn_id) === viewer) return false
  const v = view ?? messageView(rt, row, viewer, locale)
  return v?.withheld?.(root.id) ?? false
}

const hasReplies = (db: Database, chatId: string, rootId: string): boolean =>
  !!db.query('SELECT 1 FROM chat_thread_replies WHERE chat_id = ? AND root_id = ? LIMIT 1').get(chatId, rootId)

/**
 * The one gate. 'view': whoever may view the chat now (chatFor 'view'; its creator or a project editor also while it is
 * in the trash), the answer finished and not hidden from them. 'post': chatFor 'continue' (not in the trash, not while
 * safe operations are on or for a confidential chat: 409 safe_ops) and the chat shared now. A chat that stopped being
 * shared keeps its replies readable for whoever still sees it (its creator) and takes no new ones (409 not_shared). A
 * missing chat or answer, a question, another chat's answer, an answer hidden from the caller, an answer still being
 * written or one that failed: the one 404.
 */
export function threadAccess(rt: ChatRuntime, userId: string, chatId: string, rootId: string, mode: 'view' | 'post', locale: Locale = 'en'): ThreadGate {
  const a = chatFor(rt, userId, chatId, mode === 'post' ? 'continue' : 'view', { deleted: mode === 'view', locale })
  const root = rt.store.messageRow(rootId)
  if (!root || root.chat_id !== a.row.id || root.role !== 'assistant' || !FINISHED.has(root.status)) return fail('not_found')
  const shared = isSharedRow(a.row)
  if (!shared) {
    // a chat never shared has no thread; one that stopped being shared keeps what it has, read-only
    if (!hasReplies(rt.db, a.row.id, root.id)) return fail('not_found')
    if (mode === 'post') return fail('conflict', tr('chatThreadNotShared', locale), { params: { reason: 'not_shared' } })
  }
  if (rootHidden(rt, a.row, root, userId, locale)) return fail('not_found')
  // a project chat: its creator or an editor of its project; a chat shared with people (or no longer shared): its creator
  const moderator = a.creator || (a.kind === 'project' && a.editor)
  const readOnly: ChatThreadReadOnly | null = a.row.deleted_at ? 'trash' : !shared ? 'not_shared' : safeOpsEnabled() || confidentialChat(rt.db, a.row.id) ? 'safe_ops' : null
  return { a, root, moderator, readOnly }
}

/** Does `userId` see this thread now (threadAccess 'view')? For the places outside the routes: notices, the Inbox, push,
 * the realtime fan-out and its replay. Never throws. */
export function threadVisibleTo(ctx: AppContext, userId: string, chatId: string, rootId: string): boolean {
  try {
    threadAccess(getChatRuntime(ctx), userId, chatId, rootId, 'view')
    return true
  } catch {
    return false
  }
}

/** Does `userId` still see this chat (chatFor 'view', the trash too, for the chat's own windows): for the realtime
 * replay of a chat's events (realtime/hub.ts stillVisible, QA TC-3788). A chat that is gone or an old room AI session:
 * true (nothing of it to keep back; its events carry nothing new). No chat runtime: false. Never throws. */
export function chatVisibleTo(ctx: AppContext, userId: string, chatId: string): boolean {
  try {
    // no chat runtime: nothing can say who sees the chat, so it is refused (the replay becomes a resync), as the file
    // check refuses when it cannot judge
    const rt = getChatRuntime(ctx)
    const r = rt.store.chatRow(chatId)
    // a chat that is gone carries nothing to keep back. An old room AI session (chats.room_id, docs/DECISIONS.md "Room
    // @트리나 code removed") is never one of a person's chats and nothing publishes its events (runtime.ts publishChat
    // returns first), so there is nothing of it to judge either
    if (!r || r.room_id) return true
    chatFor(rt, userId, chatId, 'view', { deleted: true })
    return true
  } catch {
    return false
  }
}

/** May `userId` delete other people's replies in this chat (ThreadGate.moderator), for someone other than the caller
 * (the realtime fan-out's canDelete). */
function moderates(rt: ChatRuntime, row: ChatRow, userId: string): boolean {
  if (row.user_id === userId) return true
  if (!isProjectSharedRow(row)) return false
  const p = rt.store.projectRow(row.project_id!)
  const me = loadPrincipal(rt.db, userId)
  return !!p && !!me && mayEditProject(rt.files, me, p)
}

/** Can a reply be deleted at all now: not while the chat is in the trash or safe operations are on (read-only for
 * everyone, as every other write: QA TC-3783, TC-3784). A chat no longer shared: its creator may still tidy it. */
const deletable = (readOnly: ChatThreadReadOnly | null) => readOnly !== 'trash' && readOnly !== 'safe_ops'

function replyOut(rt: ChatRuntime, r: ReplyRow, viewer: string, moderator: boolean, canDelete = true): ChatThreadReply {
  return { id: r.id, chatId: r.chat_id, rootId: r.root_id, author: rt.store.userRef(r.author_id), content: r.content, mentions: parseReplyMentions(r.mentions), createdAt: r.created_at, canDelete: canDelete && (r.author_id === viewer || moderator) }
}

/**
 * The summary under each of these answers for `viewer` (Message.thread), from three grouped reads for a whole page:
 * how many replies and the last one's time, up to 3 people who replied (the latest first), and whether a thread they
 * follow has a reply by someone else after the newest they read. Answers without replies are absent. The caller passes
 * only answers the viewer may see.
 */
export function threadSummaries(db: Database, rootIds: readonly string[], viewer: string): Map<string, ChatThreadSummary> {
  const out = new Map<string, ChatThreadSummary>()
  if (!rootIds.length) return out
  const ids = JSON.stringify(rootIds)
  for (const r of db.query(`SELECT root_id, COUNT(*) AS n, MAX(created_at) AS last FROM chat_thread_replies WHERE root_id IN (SELECT value FROM json_each(?)) GROUP BY root_id`).all(ids) as { root_id: string; n: number; last: string }[])
    out.set(r.root_id, { replyCount: r.n, lastReplyAt: r.last, repliers: [], newReplies: false })
  if (!out.size) return out
  for (const r of db.query(`SELECT r.root_id, r.author_id AS id, COALESCE(u.name, r.author_id) AS name, MAX(r.id) AS last FROM chat_thread_replies r LEFT JOIN users u ON u.id = r.author_id
    WHERE r.root_id IN (SELECT value FROM json_each(?)) AND r.author_id IS NOT NULL GROUP BY r.root_id, r.author_id ORDER BY r.root_id, last DESC`).all(ids) as { root_id: string; id: string; name: string }[]) {
    const s = out.get(r.root_id)
    if (s && s.repliers.length < 3) s.repliers.push({ id: r.id, name: r.name })
  }
  for (const r of db.query(`SELECT f.root_id FROM chat_thread_follows f WHERE f.user_id = ? AND f.root_id IN (SELECT value FROM json_each(?))
    AND EXISTS (SELECT 1 FROM chat_thread_replies r WHERE r.root_id = f.root_id AND r.id > COALESCE(f.last_read_id, '') AND (r.author_id IS NULL OR r.author_id <> f.user_id))`).all(viewer, ids) as { root_id: string }[]) {
    const s = out.get(r.root_id)
    if (s) s.newReplies = true
  }
  return out
}

/**
 * The people who see this thread now, other than `viewer`: the chat's audience (Audiences.ofChat: a project chat's
 * project audience, a people-shared chat's creator and its people and groups; a guest only where the chat's audience
 * holds them) without anyone the answer is hidden from (its asker always sees it). A chat no longer shared: nobody.
 * Sorted by name. Who the reply box may mention, and the first check on a send's mentions.
 */
export function threadPeople(rt: ChatRuntime, row: ChatRow, root: MessageRow, viewer: string): { id: string; name: string }[] {
  const ids = new Audiences(rt.db, rt.files).ofChat(row)
  if (!ids.length) return []
  // whether the answer is hidden from someone depends only on it and the messages above it on its branch: the chat is
  // read once, and each person is judged on that chain alone (not on every answer of the chat), with one rule set
  const nodes = chatNodes(rt.db, row.id)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const chain: Node[] = []
  for (let n = byId.get(root.id), seen = new Set<string>(); n && !seen.has(n.id); n = n.parent ? byId.get(n.parent) : undefined) { seen.add(n.id); chain.push(n) }
  const rules = rt.files.rules()
  const asker = root.turn_id ? rt.store.turnUser(root.turn_id) : null
  const out: { id: string; name: string }[] = []
  for (const id of ids) {
    if (id === viewer) continue
    if (id !== asker && withheldAmong(rt.db, rules, chain, id).has(root.id)) continue
    const u = rt.store.userRef(id)
    if (u) out.push({ id: u.id, name: u.name })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The mentions of a send that count: each id once, in the order given, never the sender, only someone among the
 * thread's people now who also passes threadAccess for themselves (the one gate). Everyone else is dropped. */
function validMentions(ctx: AppContext, rt: ChatRuntime, g: ThreadGate, userId: string, ids: readonly string[] | undefined): string[] {
  if (!ids?.length) return []
  const people = new Set(threadPeople(rt, g.a.row, g.root, userId).map((p) => p.id))
  return [...new Set(ids)].filter((id) => id !== userId && people.has(id) && threadVisibleTo(ctx, id, g.a.row.id, g.root.id))
}

/** One answer's summary for `viewer`, or null when it has no replies. */
const summaryOf = (db: Database, rootId: string, viewer: string): ChatThreadSummary | null => threadSummaries(db, [rootId], viewer).get(rootId) ?? null

/** GET …/messages/:messageId/thread: the answer as the viewer sees it and a page of replies (the newest page first,
 * oldest first within it; `cursor` fetches older ones). */
export function listThread(rt: ChatRuntime, userId: string, chatId: string, rootId: string, q: { cursor?: string; limit?: number }, locale: Locale): ChatThreadPage {
  const g = threadAccess(rt, userId, chatId, rootId, 'view', locale)
  const view = messageView(rt, g.a.row, userId, locale)
  const root = messageFor(rt, g.a.row, g.root, userId, locale, view)
  const limit = Math.min(100, Math.max(1, q.limit ?? CHAT_THREAD_PAGE))
  let before: string | null = null
  if (q.cursor) {
    const c = decodeCursor(q.cursor, ['before'])
    if (!c) return fail('validation', undefined, { fields: { 'query.cursor': 'bad cursor' } })
    before = c.before
  }
  const rows = rt.db.query(`SELECT ${REPLY_COLS} FROM chat_thread_replies WHERE chat_id = ? AND root_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
    .all(g.a.row.id, g.root.id, before, before, limit + 1) as ReplyRow[]
  const more = rows.length > limit
  const page = rows.slice(0, limit).reverse()
  const count = (rt.db.query('SELECT COUNT(*) AS n FROM chat_thread_replies WHERE chat_id = ? AND root_id = ?').get(g.a.row.id, g.root.id) as { n: number }).n
  const summary = summaryOf(rt.db, g.root.id, userId)
  const onShownBranch = rt.store.pathTo(g.a.row.active_leaf_id).some((m) => m.id === g.root.id)
  return {
    root: summary ? { ...root, thread: summary } : root,
    replies: page.map((r) => replyOut(rt, r, userId, g.moderator, deletable(g.readOnly))),
    nextCursor: more && page[0] ? encodeCursor({ before: page[0].id }) : null,
    canReply: !g.readOnly && count < CHAT_THREAD_MAX,
    ...(g.readOnly ? { readOnlyReason: g.readOnly } : {}),
    version: { index: root.branch.index + 1, count: root.branch.count },
    onShownBranch,
    full: count >= CHAT_THREAD_MAX,
    // only with the first page (the app keeps it while it reads older ones), and only while I may reply
    ...(!g.readOnly && !q.cursor ? { people: threadPeople(rt, g.a.row, g.root, userId) } : {}),
  }
}

/**
 * The thread's change to everyone who sees the chat and the answer now, each as they see it (their own summary and
 * whether they may delete the reply). The audience is worked out now (Audiences.ofChat; for a chat no longer shared,
 * its creator while they still see the thread); an answer hidden from someone tells them nothing.
 */
function fanOut(ctx: AppContext, rt: ChatRuntime, row: ChatRow, root: MessageRow, ev: { change: 'reply' | 'deleted'; reply?: ReplyRow; replyId?: string }) {
  const aud = new Audiences(rt.db, rt.files)
  let ids = aud.ofChat(row)
  if (!ids.length) ids = threadVisibleTo(ctx, row.user_id, row.id, root.id) ? [row.user_id] : []
  const sight = new AnswerSight(rt.db, rt.files)
  const asker = root.turn_id ? rt.store.turnUser(root.turn_id) : null
  for (const uid of ids) {
    if (uid !== asker && sight.withheld(row.id, uid).has(root.id)) continue
    const thread = summaryOf(rt.db, root.id, uid)
    const reply = ev.reply ? replyOut(rt, ev.reply, uid, moderates(rt, row, uid)) : undefined
    rt.hub.publish(uid, { type: 'chat.thread', data: { chatId: row.id, rootId: root.id, change: ev.change, ...(reply ? { reply } : {}), ...(ev.replyId ? { replyId: ev.replyId } : {}), thread } })
  }
}

/** Follow a thread (the answer's asker, someone who replied); `read`: the newest reply they have read. */
function follow(db: Database, rootId: string, chatId: string, userId: string, read: string | null, at: string) {
  db.query(`INSERT INTO chat_thread_follows (root_id, user_id, chat_id, last_read_id, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(root_id, user_id) DO UPDATE SET last_read_id = CASE WHEN excluded.last_read_id IS NOT NULL AND (chat_thread_follows.last_read_id IS NULL OR chat_thread_follows.last_read_id < excluded.last_read_id) THEN excluded.last_read_id ELSE chat_thread_follows.last_read_id END`)
    .run(rootId, userId, chatId, read, at)
}

/**
 * POST …/messages/:messageId/thread: a reply as the caller. The gate comes first (a 404 never waits behind a 429), then
 * the same clientId again returns the first reply, then the cap and the rooms' sending budget. The answer's asker
 * follows the thread from its first reply; the replier from theirs (their own reply read). Followers other than the
 * replier who still see the thread get their notice.
 */
export function sendReply(ctx: AppContext, rt: ChatRuntime, userId: string, chatId: string, rootId: string, body: { text: string; clientId: string; mentions?: string[] }, locale: Locale): ChatThreadReply {
  const g = threadAccess(rt, userId, chatId, rootId, 'post', locale)
  const db = rt.db
  const again = db.query(`SELECT ${REPLY_COLS} FROM chat_thread_replies WHERE author_id = ? AND client_id = ?`).get(userId, body.clientId) as ReplyRow | null
  if (again) {
    if (again.chat_id !== g.a.row.id || again.root_id !== g.root.id) return fail('conflict', undefined, { params: { reason: 'client_id_used' } })
    return replyOut(rt, again, userId, g.moderator)
  }
  const n = (db.query('SELECT COUNT(*) AS n FROM chat_thread_replies WHERE chat_id = ? AND root_id = ?').get(g.a.row.id, g.root.id) as { n: number }).n
  if (n >= CHAT_THREAD_MAX) return fail('conflict', tr('chatThreadFull', locale), { params: { reason: 'thread_full' } })
  roomsOf(ctx).takeSendToken(userId)
  const mentioned = validMentions(ctx, rt, g, userId, body.mentions)
  const at = new Date().toISOString()
  const r: ReplyRow = { id: newId(), chat_id: g.a.row.id, root_id: g.root.id, author_id: userId, content: body.text.trimEnd(), client_id: body.clientId, created_at: at, mentions: JSON.stringify(mentioned) }
  const asker = g.root.turn_id ? rt.store.turnUser(g.root.turn_id) : null
  db.transaction(() => {
    // the newest reply before this one: a newly mentioned follower has read up to there (this reply is new to them)
    const prev = (db.query('SELECT id FROM chat_thread_replies WHERE root_id = ? ORDER BY id DESC LIMIT 1').get(r.root_id) as { id: string } | null)?.id ?? null
    db.query(`INSERT INTO chat_thread_replies (${REPLY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.chat_id, r.root_id, r.author_id, r.content, r.client_id, r.created_at, r.mentions)
    if (asker && asker !== userId) follow(db, r.root_id, r.chat_id, asker, null, at)
    follow(db, r.root_id, r.chat_id, userId, r.id, at)
    // (someone who already follows keeps their read mark: a mention never marks earlier replies read)
    const join = db.query('INSERT INTO chat_thread_follows (root_id, user_id, chat_id, last_read_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(root_id, user_id) DO NOTHING')
    for (const id of mentioned) join.run(r.root_id, id, r.chat_id, prev, at)
  })()
  const followers = db.query('SELECT user_id FROM chat_thread_follows WHERE root_id = ? AND user_id <> ?').all(r.root_id, userId) as { user_id: string }[]
  for (const f of followers) {
    // checked now, not only when the push goes: someone who lost the chat gets no notice at all
    if (!threadVisibleTo(ctx, f.user_id, r.chat_id, r.root_id)) continue
    try { notificationsOf(ctx).chatThreadReply(f.user_id, { chatId: r.chat_id, rootId: r.root_id, replyId: r.id, by: userId, mention: mentioned.includes(f.user_id) }) }
    catch { ctx.log.warn('chat thread notice deferred') }
  }
  fanOut(ctx, rt, g.a.row, g.root, { change: 'reply', reply: r })
  return replyOut(rt, r, userId, g.moderator)
}

/**
 * The unread notices of a thread after a reply went: each still points at the newest reply its person has not read
 * (someone else's, after their read mark); one with none left goes (its pushes with it), so nobody is told of a reply
 * that is gone.
 */
function settleNotices(ctx: AppContext, rootId: string) {
  const db = ctx.db
  const rows = db.query(`SELECT n.id, n.user_id, (SELECT r.id FROM chat_thread_replies r WHERE r.root_id = n.source_id AND (r.author_id IS NULL OR r.author_id <> n.user_id)
      AND r.id > COALESCE(f.last_read_id, '') ORDER BY r.id DESC LIMIT 1) AS newest
    FROM chat_thread_notices n LEFT JOIN chat_thread_follows f ON f.root_id = n.source_id AND f.user_id = n.user_id WHERE n.source_id = ? AND n.read_at IS NULL`).all(rootId) as { id: string; user_id: string; newest: string | null }[]
  for (const n of rows) {
    if (n.newest) {
      const by = (db.query('SELECT author_id FROM chat_thread_replies WHERE id = ?').get(n.newest) as { author_id: string | null } | null)?.author_id ?? null
      db.query('UPDATE chat_thread_notices SET reply_id = ?, by_user = ? WHERE id = ?').run(n.newest, by, n.id)
      continue
    }
    db.query('DELETE FROM chat_thread_notices WHERE id = ?').run(n.id)
    notificationsOf(ctx).changed(n.user_id)
  }
}

/** DELETE /api/chats/:id/thread-replies/:replyId: its author, or whoever moderates the chat (audited, ids only). The
 * reply must be of this chat (another chat's id: 404), in a thread the caller sees; not while the chat is in the trash. */
export function deleteReply(ctx: AppContext, rt: ChatRuntime, userId: string, chatId: string, replyId: string, locale: Locale): void {
  // the chat first: a reply of a chat the caller cannot see is the chat's own 404
  chatFor(rt, userId, chatId, 'view', { locale })
  const r = rt.db.query(`SELECT ${REPLY_COLS} FROM chat_thread_replies WHERE id = ? AND chat_id = ?`).get(replyId, chatId) as ReplyRow | null
  if (!r) return fail('not_found')
  const g = threadAccess(rt, userId, chatId, r.root_id, 'view', locale)
  if (g.a.row.deleted_at) return fail('not_found')
  // safe operations on (or a confidential chat): read-only, as sending (409 safe_ops, chatFor 'continue')
  if (g.readOnly === 'safe_ops') return fail('conflict', tr('threadReplyDeleteSafeOps', locale), { params: { reason: 'safe_ops' } })
  const own = r.author_id === userId
  if (!own && !g.moderator) return fail('forbidden', undefined, { params: { reason: 'thread_reply_not_yours' } })
  rt.db.query('DELETE FROM chat_thread_replies WHERE id = ? AND chat_id = ?').run(r.id, chatId)
  if (!own) audit(rt.db, { actor: userId, action: 'chat.thread_reply_deleted', target: chatId, detail: { root: r.root_id, reply: r.id, author: r.author_id } })
  settleNotices(ctx, r.root_id)
  fanOut(ctx, rt, g.a.row, g.root, { change: 'deleted', replyId: r.id })
}

/** POST …/thread/read: the caller read the thread up to this reply (one of this thread's). Their follow moves forward
 * (never back), the notices it covers count as read, and their other windows hear it. */
export function markRead(ctx: AppContext, rt: ChatRuntime, userId: string, chatId: string, rootId: string, upTo: string, locale: Locale): void {
  const g = threadAccess(rt, userId, chatId, rootId, 'view', locale)
  const db = rt.db
  if (!db.query('SELECT 1 FROM chat_thread_replies WHERE id = ? AND chat_id = ? AND root_id = ?').get(upTo, g.a.row.id, g.root.id)) return fail('not_found')
  db.query('UPDATE chat_thread_follows SET last_read_id = ? WHERE root_id = ? AND user_id = ? AND (last_read_id IS NULL OR last_read_id < ?)').run(upTo, g.root.id, userId, upTo)
  const read = db.query('UPDATE chat_thread_notices SET read_at = ? WHERE user_id = ? AND source_id = ? AND read_at IS NULL AND reply_id <= ?').run(new Date().toISOString(), userId, g.root.id, upTo)
  if (read.changes) {
    db.query(`UPDATE chat_thread_push_deliveries SET state = 'cancelled', lease_until = NULL WHERE state IN ('pending', 'sending') AND notification_id IN
      (SELECT id FROM chat_thread_notices WHERE user_id = ? AND source_id = ? AND read_at IS NOT NULL)`).run(userId, g.root.id)
    notificationsOf(ctx).changed(userId)
  }
  rt.hub.publish(userId, { type: 'chat.thread', data: { chatId: g.a.row.id, rootId: g.root.id, change: 'read', thread: summaryOf(db, g.root.id, userId) } })
}

// ---------------- notices and push (notifications/service.ts, push-service.ts, push-events.ts) ----------------

type NoticeRow = { user_id: string; chat_id: string; source_id: string; by_user: string | null; reply_id: string; read_at: string | null; suppressed: number; mention_id: string | null }
const noticeOf = (db: Database, id: string) => db.query('SELECT user_id, chat_id, source_id, by_user, reply_id, read_at, suppressed, mention_id FROM chat_thread_notices WHERE id = ?').get(id) as NoticeRow | null
/** Who mentioned the notice's person: the author of the newest reply still there, from the notice's first mention
 * (mention_id, kept from the first one: notifications/service.ts chatThreadReply) up to its newest reply, that mentions
 * them. One of several mentions deleted: an earlier or later one still counts; none left: null (a plain reply notice). */
function mentionerOf(db: Database, n: NoticeRow): { by: string | null } | null {
  if (!n.mention_id) return null
  const r = db.query(`SELECT author_id FROM chat_thread_replies WHERE root_id = ? AND id >= ? AND id <= ? AND mentions <> '[]' AND json_valid(mentions)
    AND EXISTS (SELECT 1 FROM json_each(mentions) j WHERE j.value = ?) ORDER BY id DESC LIMIT 1`).get(n.source_id, n.mention_id, n.reply_id, n.user_id) as { author_id: string | null } | null
  return r ? { by: r.author_id } : null
}
/** the notice still has its reply (one deleted since: settleNotices moved it or removed the notice) */
const replyThere = (db: Database, n: NoticeRow) => !!db.query('SELECT 1 FROM chat_thread_replies WHERE id = ? AND root_id = ?').get(n.reply_id, n.source_id)

/** Asked before and after each send (push-service.ts SOURCES wanted): unread, its reply still there, "Replies in threads
 * I'm part of" on, outside the person's quiet hours, and the thread still theirs to see. */
export function chatThreadWanted(ctx: AppContext, notificationId: string, now = Date.now()): boolean {
  const n = noticeOf(ctx.db, notificationId)
  if (!n || n.read_at || n.suppressed || !replyThere(ctx.db, n)) return false
  const prefs = getPreferences(ctx.db, n.user_id)
  if (!prefs.roomThreadReplies) return false
  if (inQuietHours(prefs.quietHours, teamTimeZone(ctx.db), now)) return false
  return threadVisibleTo(ctx, n.user_id, n.chat_id, n.source_id)
}

/** My unread thread mentions, as the 프로젝트 list counts them (web/src/store/chatMentions.ts: each unread notice of a
 * thread that one of its replies still there mentions me in, while I see the thread; the Inbox's 30 days, at most its
 * 500 newest): the push badge adds them to n (notifications/push-badge.ts), as the page does. Never throws. */
export function unreadThreadMentions(ctx: AppContext, userId: string, now = Date.now()): number {
  try {
    const rows = ctx.db.query(`SELECT id FROM chat_thread_notices WHERE user_id = ? AND read_at IS NULL AND suppressed = 0 AND mention_id IS NOT NULL
      AND created_at >= ? ORDER BY created_at DESC LIMIT ${MENTIONS_COUNTED}`).all(userId, new Date(now - NOTIFICATION_RETENTION_MS).toISOString()) as { id: string }[]
    let n = 0
    for (const r of rows) {
      const row = noticeOf(ctx.db, r.id)
      if (row && replyThere(ctx.db, row) && mentionerOf(ctx.db, row) && threadVisibleTo(ctx, userId, row.chat_id, row.source_id)) n++
    }
    return n
  } catch {
    return 0
  }
}
/** the page reads at most 5 pages of 100 notices (chatMentions.ts MENTIONS_READ × MENTIONS_PAGES) */
const MENTIONS_COUNTED = 500

/** A tap opens the thread (/c/<chat>/t/<answer>, ids only) while the person still sees it; else the app's start page. */
export function chatThreadPath(ctx: AppContext, notificationId: string): string | null {
  const n = noticeOf(ctx.db, notificationId)
  return n && threadVisibleTo(ctx, n.user_id, n.chat_id, n.source_id) ? `/c/${n.chat_id}/t/${n.source_id}` : null
}

/** The Inbox row, read now: who replied (the newest replier, while their account is there) and the chat's title (a
 * stored connection secret of its creator hidden, one plain line) while the reader still sees the thread and its reply
 * is there; else `gone`, with no name, title or link. Never a reply's text. */
export function chatThreadNoticeOut(ctx: AppContext, row: { id: string; user_id: string; event_type: NotificationEventType; source_id: string; created_at: string; read_at: string | null }): InboxNotification {
  const base = { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, outcome: null }
  const n = noticeOf(ctx.db, row.id)
  const sees = !!n && replyThere(ctx.db, n) && threadVisibleTo(ctx, row.user_id, n.chat_id, n.source_id)
  if (!sees) return { ...base, chatId: null, link: null, chatThread: { chatId: null, rootId: null, name: null, title: null, gone: true } }
  const c = ctx.db.query('SELECT user_id, title FROM chats WHERE id = ?').get(n!.chat_id) as { user_id: string; title: string } | null
  // a reply of it mentions the reader: who mentioned them (else the newest replier)
  const mention = mentionerOf(ctx.db, n!)
  const by = mention ? mention.by : n!.by_user
  const u = by ? ctx.db.query("SELECT name FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(by) as { name: string } | null : null
  const title = c ? plainLabel(redactorFor(ctx, c.user_id).hide(c.title || '')) : ''
  return { ...base, chatId: n!.chat_id, link: 'chat_thread', chatThread: { chatId: n!.chat_id, rootId: n!.source_id, name: u ? plainLabel(u.name, 80) : null, title: title || null, ...(mention ? { mention: true as const } : {}) } }
}

/** The people who follow a thread, for a test or a check: the asker and the repliers. */
export const followersOf = (db: Database, rootId: string): string[] =>
  (db.query('SELECT user_id FROM chat_thread_follows WHERE root_id = ? ORDER BY user_id').all(rootId) as { user_id: string }[]).map((r) => r.user_id)
