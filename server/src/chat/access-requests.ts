// "Ask for access" on a chat's or a project's link (QA TC-4185, TC-4186; docs/decisions/
// 20261116-chat-project-ask-access.md; migration 411). The file requests' rules (files/shares.ts request / answer),
// for the two other things that have a link:
//
//   /c/<id>        a chat outside projects that its creator may share with people (chat/people-share.ts
//                  peopleShareRefusal: never a chat of a personal project, a scheduled run's, a room's side chat). The
//                  creator answers; Share adds the asker by name with the Share dialog's own save (putChatAudience), so
//                  a chat's first share runs the same check and answers "confirm" until the creator agrees to it.
//                  A shared chat of a team project (its members see it): the ask is for the project (below), and Share
//                  makes the asker a member. A private chat of a team project, or any chat while safe operations are
//                  on: no ask (canAsk false; the page never says why).
//   /projects/<id> a team project in projects/<name> whose members can be changed (chat/project-access.ts
//                  accessEditable). Its creator answers while they change its members; else the team owner and admins
//                  (as a file with no owner known). Share adds the asker as a member (write, the one role a project
//                  member has) with the members dialog's save (saveParticipants). A personal project: no ask.
//
// What the asker reads (GET /api/link-access/:kind/:id) is what a file's link says to someone it does not open for:
// that it is there, whether they may ask, when they asked. Never the title, the creator or who is in it. Guests never
// ask (403, as on a file's link). The limits are the file requests', counted together over both tables (one waiting
// per person and target; FILE_REQUESTS_PER_OWNER_DAY a day to one owner, FILE_REQUESTS_PER_HOUR an hour in all), and
// the pushes share FILE_REQUEST_PUSHES_PER_DAY with the file requests (files/share-push.ts).
//
// A request whose asker now opens the chat or project (shared with them another way) settles as approved when it is
// read; one whose chat or project went, as closed.
//
// One file of a chat shared with people (docs/decisions/20261121-share-chat-files.md): someone in the chat whose file
// link does not open asks its creator to add it (GET/POST /api/chats/:id/file-access). The same table, kind 'chat',
// target '<chat id>/<32 hex of the path's sha256>' (chat/chat-files-share.ts fileAskTarget), the path and the name the
// chat recorded in `message` as JSON (never shown as a note). Only for a path madeFilesOf lists for the chat; every
// other case is the one answer 'no'. The ask is untrusted: [Add to the chat] runs the Share step's own check again
// (madeFilesOf, the bytes read and hashed) and copies only then. It settles as approved once the chat has the file, as
// closed once the asker no longer sees the chat or the file no longer qualifies; leaving the chat closes it at once
// (people-share.ts closeFileAsks).
//
// Any other team file linked in a message of a shared chat (shared with people, or a shared project chat) that the asker
// sees, by someone who can read it now (QA after #651: the panel had only "can't be found, or you don't have access"):
// the room link's ask (files/linked-file-ask.ts), answers view / viewAsked / open, and the POST is an ordinary file
// access request (files/shares.ts request).
import type { Database } from 'bun:sqlite'
import { FILE_REQUESTS_PER_HOUR, FILE_REQUESTS_PER_OWNER_DAY, inQuietHours, plainLabel, type AccessKind, type AccessRequestAnswer, type ChatFileAccess, type ChatFileRequestResult, answerFilePaths, type InboxNotification, type LinkAccessRequestResult, type LinkAccessView, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { teamTimeZone } from '../admin/settings'
import { fail } from '../http/errors'
import { isStaff, loadPrincipal, type Principal } from '../policy/access'
import { newId } from '../db'
import { notificationsOf } from '../notifications/service'
import { getPreferences, pushEventEnabled } from '../notifications/preferences'
import { safeOpsEnabled } from '../safe-ops/runner'
import { confidentialChat } from '../safe-ops/confidential'
import { requestPushesToday, FILE_REQUEST_PUSHES_PER_DAY, requestPushSince } from '../files/share-push'
import { getChatRuntime } from './runtime'
import { chatFor } from './shared'
import { peopleShareRefusal, putChatAudience } from './people-share'
import { subjectsOf } from './chat-audience'
import { accessEditable, projectAccess, saveParticipants } from './project-access'
import { canSeeProject, isTeamProject, mayEditProject, mayManageProject } from './projects'
import type { ChatRow, ProjectRow } from './store'
import { ACCESS_REQUEST_TEXT } from './access-request-text'
import { isPeopleRow, isSharedRow } from './chat-audience'
import { withheldFrom } from './shared-answers'
import { fileSharesOf } from '../files/shares'
import { cleanLinkedPath, linkedFileAsk, type LinkedAsk } from '../files/linked-file-ask'
import { copyMade, copyOf, fileAskChat, fileAskTarget, madeFilesOf, readVerified } from './chat-files-share'

/** At most this many of a chat's messages with a file link are looked at for a linked file's ask (the newest first). */
const LINKED_SCAN_MAX = 500

/** What a file ask holds in `message`: the path and the name the chat recorded. */
const fileAskOf = (q: Pick<RequestRow, 'kind' | 'target_id' | 'message'>): { chatId: string; path: string; name: string } | null => {
  const chatId = q.kind === 'chat' ? fileAskChat(q.target_id) : null
  if (!chatId || !q.message) return null
  try {
    const v = JSON.parse(q.message) as { path?: unknown; name?: unknown }
    return typeof v.path === 'string' && typeof v.name === 'string' && fileAskTarget(chatId, v.path) === q.target_id ? { chatId, path: v.path, name: v.name } : null
  } catch { return null }
}
/** A link's path as the chat's records name it (no leading or trailing slash). */
const relOf = (p: string) => p.normalize('NFC').replace(/^\/+|\/+$/g, '')

type State = 'pending' | 'approved' | 'declined' | 'closed'
interface RequestRow { id: string; kind: AccessKind; target_id: string; requester_id: string; owner_id: string; message: string | null; state: State; created_at: string }
const COLS = 'id, kind, target_id, requester_id, owner_id, message, state, created_at'

const msg = (k: keyof typeof ACCESS_REQUEST_TEXT, L: Locale) => ACCESS_REQUEST_TEXT[k][L] ?? ACCESS_REQUEST_TEXT[k].en
const now = () => new Date().toISOString()
/** The link page's reads, at most this many a minute per person (in memory, per server; a restart forgets them). */
export const LINK_ACCESS_PER_MINUTE = 60
/** The active owner and admins (never a guest: stored as role 'member', and guest = 1 excluded too). */
const STAFF_SQL = "SELECT id FROM users WHERE role IN ('owner','admin') AND guest = 0 AND status = 'active' AND deleted_at IS NULL ORDER BY id"

/** What an ask on a link is about: the request's kind and target (a team project chat's link asks for its project),
 * whose it is (the per-owner limit) and who answers it (`answerers`: all of them, for the notices; `any`: whether there
 * is one, with an early exit, for the page). No answerer: no request, for whatever reason, and the page never says
 * which (security review of #1140). */
interface Target { kind: AccessKind; id: string; owner: string; answerers: () => string[]; any: () => boolean }
const NOBODY = { answerers: () => [] as string[], any: () => false }

const services = new WeakMap<AppContext, AccessRequests>()
export function accessRequestsOf(ctx: AppContext): AccessRequests {
  let s = services.get(ctx)
  if (!s) services.set(ctx, (s = new AccessRequests(ctx)))
  return s
}

export class AccessRequests {
  constructor(readonly ctx: AppContext) {}
  private get db(): Database { return this.ctx.db }
  private get rt() { return getChatRuntime(this.ctx) }

  // ---------------- who may see, share, answer ----------------
  /** The chat opens for the person now (chatFor 'view': its creator, its people, a shared project chat's members). */
  private chatOpens(userId: string, chatId: string): boolean {
    try { chatFor(this.rt, userId, chatId, 'view'); return true } catch { return false }
  }
  /** The project opens for the person now: its contents, or (the owner and admins, its creator) to manage it. */
  private projectOpens(p: Principal, r: ProjectRow): boolean {
    return canSeeProject(this.ctx.files, p, r) || mayManageProject(this.ctx.files, p, r)
  }
  /** May this person change the project's members now (the members dialog's save)? */
  private changesMembers(p: Principal, r: ProjectRow): boolean {
    return p.role !== 'guest' && isTeamProject(r) && mayManageProject(this.ctx.files, p, r) && accessEditable(r, this.ctx.files, p)
  }
  /** A project's answerers: its creator while they change its members, else the active owner and admins who may.
   * `first`: stop at the first one (the page asks only whether there is one). Reads the owner and admins only, never
   * every account. */
  private projectAnswerers(r: ProjectRow, first = false): string[] {
    const creator = r.created_by ? loadPrincipal(this.db, r.created_by) : null
    if (creator && creator.role !== 'guest' && mayEditProject(this.ctx.files, creator, r) && this.changesMembers(creator, r)) return [creator.id]
    const out: string[] = []
    for (const x of this.db.query(STAFF_SQL).all() as { id: string }[]) {
      const p = loadPrincipal(this.db, x.id)
      if (!p || !isStaff(p) || !this.changesMembers(p, r)) continue
      out.push(p.id)
      if (first) break
    }
    return out
  }
  private projectTarget(me: Principal, pr: ProjectRow): Target {
    const t = { kind: 'project' as const, id: pr.id, owner: pr.created_by ?? '' }
    // the owner or an admin who manages it adds themselves on its page (never an ask)
    if (this.changesMembers(me, pr)) return { ...t, ...NOBODY }
    return { ...t, answerers: () => this.projectAnswerers(pr), any: () => this.projectAnswerers(pr, true).length > 0 }
  }
  /** A chat's answerer: its creator, while active and no guest. */
  private chatAnswerers(r: ChatRow): string[] {
    const c = loadPrincipal(this.db, r.user_id)
    return c && c.role !== 'guest' ? [c.id] : []
  }
  /** May `p` share this chat with the asker now (its creator, the chat shareable, no safe operations)? */
  private sharesChat(p: Principal, r: ChatRow): boolean {
    return r.user_id === p.id && p.role !== 'guest' && !peopleShareRefusal(this.ctx, r) && !safeOpsEnabled() && !confidentialChat(this.db, r.id)
  }

  /** What a link's ask is about, for `me`; null: nothing to ask (unknown). */
  private targetOf(me: Principal, kind: AccessKind, id: string): Target | null {
    if (kind === 'project') {
      const r = this.rt.store.projectRow(id)
      if (!r || r.trashed_with !== null) return null
      if (!isTeamProject(r)) return { kind, id, owner: r.created_by ?? '', ...NOBODY }
      return this.projectTarget(me, r)
    }
    const r = this.rt.store.chatRow(id)
    if (!r) return null
    const no = peopleShareRefusal(this.ctx, r)
    if (no?.status === 'not_found') return null
    const pr = r.project_id ? this.rt.store.projectRow(r.project_id) : null
    // a chat of a project in the trash: unknown, as the project itself (security review of #1140)
    if (pr && pr.trashed_with !== null) return null
    const chat = { kind, id, owner: r.user_id }
    if (!no) {
      if (safeOpsEnabled() || confidentialChat(this.db, r.id)) return { ...chat, ...NOBODY }
      return { ...chat, answerers: () => this.chatAnswerers(r), any: () => this.chatAnswerers(r).length > 0 }
    }
    // a chat of a team project its members see: the ask is to join the project
    if (pr && r.shared_at && no.reason === 'share_people_in_project' && isTeamProject(pr)) return this.projectTarget(me, pr)
    return { ...chat, ...NOBODY }
  }

  /** Whether this request can still be answered: a chat still shareable (not moved into a project, deleted,
   * confidential, safe operations off) with its creator there; a project still there, out of the trash and a team
   * project. A project whose answerers are all gone for a moment keeps its requests (an admin may come back). */
  private answerable(q: RequestRow): boolean {
    const file = fileAskOf(q)
    if (file) {
      const r = this.rt.store.chatRow(file.chatId)
      return !!r && !r.deleted_at && isPeopleRow(r) && this.chatAnswerers(r).length > 0 && this.chatOpens(q.requester_id, r.id) && madeFilesOf(this.ctx, r, { only: file.path }).length > 0
    }
    if (q.kind === 'chat') {
      const r = this.rt.store.chatRow(q.target_id)
      return !!r && !peopleShareRefusal(this.ctx, r) && !safeOpsEnabled() && !confidentialChat(this.db, r.id) && this.chatAnswerers(r).length > 0
    }
    const r = this.rt.store.projectRow(q.target_id)
    return !!r && r.trashed_with === null && isTeamProject(r)
  }

  /** The person's own access to the link now (the route checked kind and the id's shape). */
  private opens(me: Principal, kind: AccessKind, id: string): boolean {
    if (kind === 'chat') return this.chatOpens(me.id, id)
    const r = this.rt.store.projectRow(id)
    return !!r && this.projectOpens(me, r)
  }
  /** The asker opens the request's target now. */
  private askerOpens(q: Pick<RequestRow, 'kind' | 'target_id' | 'requester_id' | 'message'>): boolean {
    // a file ask: the chat has the file now (and the asker still sees the chat)
    const file = fileAskOf(q)
    if (file) return !!copyOf(this.ctx, file.chatId, file.path, q.requester_id) && this.chatOpens(q.requester_id, file.chatId)
    const p = loadPrincipal(this.db, q.requester_id)
    return !!p && this.opens(p, q.kind, q.target_id)
  }

  /** A pending request that no longer waits: approved when the asker opens it now; closed when nobody can answer it
   * any more (its chat or project went, moved into a project, went to the trash, its answerers are gone). */
  private settle(q: RequestRow): RequestRow {
    if (q.state !== 'pending') return q
    const state: State | null = this.askerOpens(q) ? 'approved' : !this.answerable(q) ? 'closed' : null
    if (!state) return q
    this.db.query("UPDATE access_requests SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(state, now(), q.id)
    return { ...q, state }
  }
  private waiting(kind: AccessKind, target: string, userId: string): RequestRow | null {
    const q = this.db.query(`SELECT ${COLS} FROM access_requests WHERE kind = ? AND target_id = ? AND requester_id = ? AND state = 'pending'`).get(kind, target, userId) as RequestRow | null
    return q && this.settle(q).state === 'pending' ? q : null
  }

  // ---------------- the asker ----------------
  /** GET /api/link-access/:kind/:id. No ask possible, for whatever reason: the same answer (canAsk false). The date of
   * a waiting ask only for an ask of the link's own kind: a chat's link never shows its project's (that would tie the
   * chat to its project). */
  view(userId: string, kind: AccessKind, id: string, L: Locale): LinkAccessView {
    const me = this.asker(userId, L)
    this.readLimit(userId)
    if (this.opens(me, kind, id)) return { status: 'open' }
    const t = this.targetOf(me, kind, id)
    if (!t) return { status: 'unknown' }
    const asked = t.kind === kind ? this.waiting(t.kind, t.id, userId) : null
    return { status: 'no_access', canAsk: t.any(), askedAt: asked?.created_at ?? null }
  }

  private reads = new Map<string, number[]>()
  /** One page read of `userId`, or 429 past LINK_ACCESS_PER_MINUTE in the last minute (as the access preview's limit). */
  private readLimit(userId: string, at = Date.now()): void {
    const recent = (this.reads.get(userId) ?? []).filter((x) => at - x < 60_000)
    if (recent.length >= LINK_ACCESS_PER_MINUTE) {
      this.reads.set(userId, recent)
      fail('rate_limited', undefined, { retryAfter: Math.max(1, Math.ceil((60_000 - (at - recent[0]!)) / 1000)) })
    }
    recent.push(at)
    this.reads.set(userId, recent)
    if (this.reads.size > 10_000) for (const [k, ts] of this.reads) if (!ts.some((x) => at - x < 60_000)) this.reads.delete(k)
  }

  /** A signed-in member (never a guest: 403, as on a file's link). */
  private asker(userId: string, L: Locale): Principal {
    const me = loadPrincipal(this.db, userId)
    if (!me || me.role === 'guest') fail('forbidden', msg('requestOff', L), { params: { reason: 'access_request_off' } })
    return me!
  }

  /** POST /api/link-access/:kind/:id/request */
  request(userId: string, kind: AccessKind, id: string, message: string | undefined, L: Locale): LinkAccessRequestResult {
    const me = this.asker(userId, L)
    if (this.opens(me, kind, id)) return { status: 'open' }
    const t = this.targetOf(me, kind, id)
    if (!t) return fail('not_found')
    const answerers = t.answerers()
    if (!answerers.length) return fail('forbidden', msg('requestOff', L), { params: { reason: 'access_request_off' } })
    const waiting = this.waiting(t.kind, t.id, userId)
    // a waiting ask of this link's own kind: its date. One of the other kind (a project's, asked from a chat's link or
    // the other way round) is never told: the answer is a fresh ask's, after the same limits, so a chat's link never
    // shows that it belongs to the project asked for (security re-check of #1140)
    if (waiting && t.kind === kind) return { status: 'already', askedAt: waiting.created_at }
    // the file requests' limits, counted over both tables (files/shares.ts request)
    const at = Date.now()
    const hourAgo = new Date(at - 3600_000).toISOString(), dayAgo = new Date(at - 86400_000).toISOString()
    const count = (sql: string, ...args: string[]) => (this.db.query(sql).get(...args) as { n: number }).n
    const hour = count('SELECT COUNT(*) n FROM access_requests WHERE requester_id = ? AND created_at > ?', userId, hourAgo)
      + count('SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND created_at > ?', userId, hourAgo)
    const day = count('SELECT COUNT(*) n FROM access_requests WHERE requester_id = ? AND owner_id = ? AND created_at > ?', userId, t.owner, dayAgo)
      + count("SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND COALESCE(owner_id, '') = ? AND created_at > ?", userId, t.owner, dayAgo)
    if (hour >= FILE_REQUESTS_PER_HOUR || day >= FILE_REQUESTS_PER_OWNER_DAY) return fail('rate_limited', msg('tooMany', L), { retryAfter: 3600 })
    // (the other kind's ask already waits: nothing new is stored or told, the answer is a fresh ask's)
    if (waiting) return { status: 'sent', askedAt: now() }
    const note = message?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500) || null
    const created = now()
    this.db.query('INSERT INTO access_requests (id, kind, target_id, requester_id, owner_id, message, state, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(newId(), t.kind, t.id, userId, t.owner, note, 'pending', created)
    // ids only: never the title or the note
    audit(this.db, { actor: userId, action: 'access.request', target: `${t.kind}:${t.id}`, detail: { kind: t.kind, via: t.kind === kind ? 'link' : 'chat_link' } })
    // one Activity row per person, target and asker, brought back up by each new request
    for (const to of answerers) this.notify(to, 'access.requested', `${t.kind}:${t.id}:${userId}`, true)
    return { status: 'sent', askedAt: created }
  }

  // ---------------- one file of a chat shared with people ----------------
  /** What the asker may ask about `path` in `chatId` (the route checked they see the chat), or null: the one 'no'. */
  private fileAskable(userId: string, chatId: string, path: string) {
    const me = loadPrincipal(this.db, userId)
    const r = this.rt.store.chatRow(chatId)
    // a guest is never in a chat shared with people; the creator opens their own files
    if (!me || me.role === 'guest' || !r || r.deleted_at || !isPeopleRow(r) || r.user_id === userId || !this.chatOpens(userId, chatId)) return null
    const creator = loadPrincipal(this.db, r.user_id)
    if (!creator || creator.role === 'guest') return null
    const rel = relOf(path)
    // a copy on an answer hidden from me, or a file such an answer made: the one 'no' (review M1)
    const copy = copyOf(this.ctx, chatId, rel, userId)
    if (copy) return { r, rel, creator, copy, made: null }
    const made = madeFilesOf(this.ctx, r, { only: rel })[0]
    return made ? { r, rel, creator, copy: null, made } : null
  }

  /** Any other team file linked in a message of a shared chat (shared with people, or a shared project chat) that the
   * asker sees: the room link's ask (files/linked-file-ask.ts), by the person who linked it there (the message's
   * sender, or for an answer the person whose turn it was). The newest such message whose linker can read the file
   * now answers; an answer hidden from the asker (chat/shared-answers.ts) never counts. */
  private linkedAsk(userId: string, chatId: string, path0: string, create: boolean): LinkedAsk {
    const no = { kind: 'no' } as const
    const me = loadPrincipal(this.db, userId)
    const r = this.rt.store.chatRow(chatId)
    if (!me || me.role === 'guest' || !r || r.deleted_at || !isSharedRow(r) || !this.chatOpens(userId, chatId)) return no
    const path = cleanLinkedPath(typeof path0 === 'string' ? path0 : '')
    if (!path || path.length > 4096) return no
    const rows = this.db.query(`SELECT m.id, m.role, m.content, m.author_id, t.user_id AS runner FROM messages m LEFT JOIN turns t ON t.id = m.turn_id
      WHERE m.chat_id = ? AND m.content LIKE '%path=%' ORDER BY m.rowid DESC LIMIT ${LINKED_SCAN_MAX}`).all(chatId) as { id: string; role: string; content: string; author_id: string | null; runner: string | null }[]
    let hidden: Set<string> | null = null
    const tried = new Set<string>()
    for (const m of rows) {
      if (!answerFilePaths(m.content).some((p) => cleanLinkedPath(p) === path)) continue
      hidden ??= withheldFrom(this.db, this.ctx.files.rules(), chatId, userId)
      if (hidden.has(m.id)) continue
      const linker = m.role === 'assistant' ? m.runner : (m.author_id ?? m.runner)
      if (!linker || tried.has(linker)) continue
      tried.add(linker)
      const found = linkedFileAsk(this.ctx, me, path, linker, create)
      if (found.kind !== 'no') return found
    }
    return no
  }

  /** GET /api/chats/:id/file-access. One answer, 'no', for every case it cannot help with. */
  fileView(userId: string, chatId: string, path: string): ChatFileAccess {
    this.readLimit(userId)
    const x = this.fileAskable(userId, chatId, path)
    if (!x) {
      const f = this.linkedAsk(userId, chatId, path, false)
      if (f.kind === 'open') return { status: 'open', ...(f.link ? { link: f.link } : {}) }
      if (f.kind === 'no') return { status: 'no' }
      return f.askedAt ? { status: 'viewAsked', askedAt: f.askedAt, by: f.by } : { status: 'view', by: f.by }
    }
    if (x.copy) return { status: 'copy', fileId: x.copy.id, name: x.copy.name }
    const asked = this.waiting('chat', fileAskTarget(chatId, x.rel), userId)
    return asked ? { status: 'asked', askedAt: asked.created_at, by: x.creator.name, name: x.made!.name } : { status: 'ask', by: x.creator.name, name: x.made!.name }
  }

  /** POST /api/chats/:id/file-access: the ask, to the chat's creator. */
  fileRequest(userId: string, chatId: string, path: string, L: Locale): ChatFileRequestResult {
    this.readLimit(userId)
    const x = this.fileAskable(userId, chatId, path)
    if (!x) {
      // another linked team file: an ordinary file access request (its limits, its audit, its Activity row)
      const f = this.linkedAsk(userId, chatId, path, true)
      if (f.kind === 'open') return { status: 'open', ...(f.link ? { link: f.link } : {}) }
      if (f.kind === 'no' || !f.shareId) return fail('not_found')
      return fileSharesOf(this.ctx).request(userId, f.shareId, undefined, L)
    }
    if (x.copy) return { status: 'open' }
    const target = fileAskTarget(chatId, x.rel)
    const waiting = this.waiting('chat', target, userId)
    if (waiting) return { status: 'already', askedAt: waiting.created_at }
    this.limits(userId, x.r.user_id, L)
    const created = now()
    this.db.query('INSERT INTO access_requests (id, kind, target_id, requester_id, owner_id, message, state, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(newId(), 'chat', target, userId, x.r.user_id, JSON.stringify({ path: x.rel, name: x.made!.name }), 'pending', created)
    // ids only: never the path or the name
    audit(this.db, { actor: userId, action: 'access.request', target: `chat:${chatId}`, detail: { kind: 'chat', via: 'chat_file' } })
    this.notify(x.r.user_id, 'access.requested', `chat:${target}:${userId}`, true)
    return { status: 'sent', askedAt: created }
  }

  /** The file requests' limits, counted over both tables (files/shares.ts request): 429 past them. */
  private limits(userId: string, owner: string, L: Locale): void {
    const at = Date.now()
    const hourAgo = new Date(at - 3600_000).toISOString(), dayAgo = new Date(at - 86400_000).toISOString()
    const count = (sql: string, ...args: string[]) => (this.db.query(sql).get(...args) as { n: number }).n
    const hour = count('SELECT COUNT(*) n FROM access_requests WHERE requester_id = ? AND created_at > ?', userId, hourAgo)
      + count('SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND created_at > ?', userId, hourAgo)
    const day = count('SELECT COUNT(*) n FROM access_requests WHERE requester_id = ? AND owner_id = ? AND created_at > ?', userId, owner, dayAgo)
      + count("SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND COALESCE(owner_id, '') = ? AND created_at > ?", userId, owner, dayAgo)
    if (hour >= FILE_REQUESTS_PER_HOUR || day >= FILE_REQUESTS_PER_OWNER_DAY) fail('rate_limited', msg('tooMany', L), { retryAfter: 3600 })
  }

  // ---------------- the answer ----------------
  /** May `me` share the request's target with its asker now? */
  private mayAnswer(me: Principal, q: RequestRow): boolean {
    // a file ask: the chat's creator, whose own file it is
    const file = fileAskOf(q)
    if (file) {
      const r = this.rt.store.chatRow(file.chatId)
      return !!r && !r.deleted_at && isPeopleRow(r) && r.user_id === me.id && me.role !== 'guest'
    }
    if (q.kind === 'chat') {
      const r = this.rt.store.chatRow(q.target_id)
      return !!r && this.sharesChat(me, r)
    }
    const r = this.rt.store.projectRow(q.target_id)
    return !!r && r.trashed_with === null && this.changesMembers(me, r)
  }

  /** POST /api/access-requests/:id: Share or Decline by whoever may share it now. */
  async answer(userId: string, requestId: string, answer: 'approve' | 'decline', confirmKey: string | undefined, L: Locale): Promise<AccessRequestAnswer> {
    const row = this.db.query(`SELECT ${COLS} FROM access_requests WHERE id = ?`).get(requestId) as RequestRow | null
    const me = loadPrincipal(this.db, userId)
    if (!row || !me) return fail('not_found')
    // only someone the request went to (or who may share it now) learns anything about it
    const may = this.mayAnswer(me, row)
    const told = !!this.db.query("SELECT 1 FROM access_request_notices WHERE user_id = ? AND event_type = 'access.requested' AND source_id = ?").get(userId, `${row.kind}:${row.target_id}:${row.requester_id}`)
    if (!may && !told) return fail('not_found')
    // someone it went to who may not share it now (an admin taken out of the folder): the others answer it, and they
    // learn nothing of how it ended (review)
    if (!may) return fail('forbidden', msg('notSharer', L), { params: { reason: 'access_request_not_sharer' } })
    const q = this.settle(row)
    if (q.state !== 'pending') return { state: q.state }
    // the asker switched off, removed, or made a guest meanwhile: nobody waits any more (a guest is never added this way)
    const asker = loadPrincipal(this.db, q.requester_id)
    if (!asker || asker.role === 'guest') {
      this.db.query("UPDATE access_requests SET state = 'closed', decided_at = ? WHERE id = ? AND state = 'pending'").run(now(), q.id)
      return { state: 'closed' }
    }
    const target = `${q.kind}:${q.target_id}`
    if (answer === 'decline') {
      this.db.query("UPDATE access_requests SET state = 'declined', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(userId, now(), q.id)
      audit(this.db, { actor: userId, action: 'access.declined', target, detail: { kind: q.kind } })
      this.notify(q.requester_id, 'access.answered', q.id, false)
      return { state: 'declined' }
    }
    const file = fileAskOf(q)
    if (file) {
      // untrusted: the Share step's own check again, for that one path (madeFilesOf), and the bytes read and hashed
      const r = this.rt.store.chatRow(file.chatId)!
      const made = madeFilesOf(this.ctx, r, { only: file.path })
      const v = made.length ? await readVerified(this.ctx, r, made, { only: file.path }) : null
      if (!v || !v.files.length) {
        this.db.query("UPDATE access_requests SET state = 'closed', decided_at = ? WHERE id = ? AND state = 'pending'").run(now(), q.id)
        return { state: 'closed' }
      }
      await copyMade(this.ctx, r, v.files, 'request')
      this.db.query("UPDATE access_requests SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(userId, now(), q.id)
      audit(this.db, { actor: userId, action: 'access.approved', target: `chat:${file.chatId}`, detail: { kind: 'chat_file' } })
      this.rt.publishChat(userId, file.chatId, 'updated')
      this.notify(q.requester_id, 'access.answered', q.id, false)
      return { state: 'approved' }
    }
    if (q.kind === 'chat') {
      const rt = this.rt
      const a = chatFor(rt, userId, q.target_id, 'view', { locale: L })
      const subjects = subjectsOf(this.db, q.target_id).map((s) => ({ subjectType: s.type, subjectId: s.id }))
      subjects.push({ subjectType: 'user', subjectId: q.requester_id })
      // the Share dialog's own save: the check on a first share (confirm with its key), the busy chat, the 50
      const r = await putChatAudience(this.ctx, rt, userId, a, { subjects, ...(confirmKey ? { confirmKey } : {}) }, L)
      if (r.status === 'confirm') return { state: 'confirm', check: r.check, confirmKey: r.confirmKey }
    } else {
      const r = this.rt.store.projectRow(q.target_id)!
      const current = projectAccess(this.ctx, r, me)
      const participants = current.participants.map((x) => ({ subjectType: x.subjectType, subjectId: x.subjectId }))
      participants.push({ subjectType: 'user', subjectId: q.requester_id })
      saveParticipants(this.ctx, r, me, { id: me.id, name: me.name }, { participants, expectedHash: current.rulesHash }, L)
    }
    this.db.query("UPDATE access_requests SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(userId, now(), q.id)
    audit(this.db, { actor: userId, action: 'access.approved', target, detail: { kind: q.kind } })
    // a chat's save told them already ("{name} shared a chat with you", pushed: a share by name); a project's says nothing
    // to the person added, so they get the answer here
    if (q.kind === 'project') this.notify(q.requester_id, 'access.answered', q.id, false)
    return { state: 'approved' }
  }

  private notify(to: string, event: 'access.requested' | 'access.answered', source: string, rearm: boolean) {
    try { notificationsOf(this.ctx).accessRequestNotice(to, event, source, rearm) } catch (err) { this.ctx.log.warn('access request notice failed', { err }) }
  }

  // ---------------- Activity and push ----------------
  /** An access.requested notice's source (`<kind>:<target>:<asker>`) as its receiver sees it now: the newest request of
   * that asker for it (settled), the target's name, and whether the receiver may answer it now. Null: the target, the
   * request or the receiver is gone. */
  private askedOf(userId: string, sourceId: string) {
    const [kind, target, asker] = sourceId.split(':') as [AccessKind | undefined, string | undefined, string | undefined]
    if ((kind !== 'chat' && kind !== 'project') || !target || !asker) return null
    const row = this.db.query(`SELECT ${COLS} FROM access_requests WHERE kind = ? AND target_id = ? AND requester_id = ? ORDER BY created_at DESC LIMIT 1`).get(kind, target, asker) as RequestRow | null
    const me = loadPrincipal(this.db, userId)
    if (!row || !me) return null
    const q = this.settle(row)
    const file = fileAskOf(q)
    const chatId = file?.chatId ?? target
    const name = kind === 'chat' ? this.rt.store.chatRow(chatId) : this.rt.store.projectRow(target)
    if (!name || (kind === 'chat' && (name as ChatRow).deleted_at)) return null
    const title = kind === 'chat' ? (name as ChatRow).title : (name as ProjectRow).name
    return { request: q, kind, target: kind === 'chat' ? chatId : target, asker, title, may: this.mayAnswer(me, q), file }
  }

  /** The push of a request (push-service.ts): while it waits, this person may answer it and the asker is active. */
  requestWaitsOn(userId: string, sourceId: string): boolean {
    const a = this.askedOf(userId, sourceId)
    if (!a || !a.may || a.request.state !== 'pending') return false
    const asker = loadPrincipal(this.db, a.asker)
    return !!asker && asker.role !== 'guest'
  }

  /** An Activity row's details for its viewer (notifications/service.ts out). Names read now. */
  noticeOut(row: { id: string; user_id: string; event_type: string; source_id: string; created_at: string; read_at: string | null }): InboxNotification {
    const base = { id: row.id, eventType: row.event_type as InboxNotification['eventType'], sourceId: row.source_id, code: row.event_type as InboxNotification['code'], createdAt: row.created_at, readAt: row.read_at, chatId: null, outcome: null }
    const gone = { ...base, link: null, accessRequest: { kind: null, by: null, name: null, targetId: null, gone: true as const } }
    const nameOf = (id: string) => (this.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { name: string } | null)?.name ?? null
    if (row.event_type === 'access.answered') {
      const q = this.db.query(`SELECT ${COLS} FROM access_requests WHERE id = ? AND requester_id = ?`).get(row.source_id, row.user_id) as RequestRow | null
      if (!q) return gone
      // a file of a chat added: the file's name and the chat, while the asker still sees it
      const file = fileAskOf(q)
      if (file && q.state === 'approved') {
        if (!this.chatOpens(row.user_id, file.chatId)) return gone
        const c = this.rt.store.chatRow(file.chatId)
        return { ...base, chatId: file.chatId, link: 'chat', accessRequest: { kind: 'chat', by: null, name: c?.title ? plainLabel(c.title, 120) : null, targetId: file.chatId, state: 'approved', file: { name: plainLabel(file.name, 200) } } }
      }
      // a decline says nothing about the chat or project (as a file's)
      if (q.state !== 'approved' || q.kind !== 'project') return { ...base, link: null, accessRequest: { kind: null, by: null, name: null, targetId: null, state: 'declined' } }
      const r = this.rt.store.projectRow(q.target_id)
      const me = loadPrincipal(this.db, row.user_id)
      if (!r || !me || !canSeeProject(this.ctx.files, me, r)) return gone
      return { ...base, link: 'project', accessRequest: { kind: 'project', by: null, name: plainLabel(r.name, 120), targetId: r.id, state: 'approved' } }
    }
    if (row.event_type !== 'access.requested') return gone
    const a = this.askedOf(row.user_id, row.source_id)
    if (!a) return gone
    const me = loadPrincipal(this.db, row.user_id)
    // the chat's or project's name only to someone who may answer it, or who opens it themselves
    if (!me || (!a.may && !this.opens(me, a.kind, a.target))) return gone
    const q = a.request
    return {
      ...base, link: null,
      accessRequest: { kind: a.kind, by: nameOf(a.asker), name: a.title ? plainLabel(a.title, 120) : null, targetId: a.target, ...(q.message && !a.file ? { note: q.message } : {}), ...(a.file ? { file: { name: plainLabel(a.file.name, 200) } } : {}), requestId: q.id, state: q.state, ...(a.may && q.state === 'pending' ? { canAnswer: true as const } : {}) },
    }
  }
}

/** The request notices that hold for a push now (push-service.ts SOURCES wanted): unread, an access.requested, the
 * switch on, outside quiet hours, made after this build's migration, the day's cap not reached (shared with the file
 * requests), and the request still waiting on this person. */
export function accessRequestPushWanted(ctx: AppContext, notificationId: string, at = Date.now()): boolean {
  const n = ctx.db.query('SELECT id, user_id, event_type, source_id, created_at, read_at, suppressed FROM access_request_notices WHERE id = ?').get(notificationId) as { id: string; user_id: string; event_type: string; source_id: string; created_at: string; read_at: string | null; suppressed: number } | null
  if (!n || n.read_at || n.suppressed || n.event_type !== 'access.requested') return false
  const prefs = getPreferences(ctx.db, n.user_id)
  if (!pushEventEnabled(prefs, 'access.requested')) return false
  if (inQuietHours(prefs.quietHours, teamTimeZone(ctx.db), at)) return false
  const from = requestPushSince(ctx.db, 411)
  if (!from || n.created_at < from) return false
  if (requestPushesToday(ctx.db, n.user_id, n.id, at) >= FILE_REQUEST_PUSHES_PER_DAY) return false
  return accessRequestsOf(ctx).requestWaitsOn(n.user_id, n.source_id)
}
/** A tap opens the request in Activity while it still waits on the person. */
export function accessRequestPushPath(ctx: AppContext, notificationId: string): string | null {
  const n = ctx.db.query('SELECT id, user_id, source_id, event_type FROM access_request_notices WHERE id = ?').get(notificationId) as { id: string; user_id: string; source_id: string; event_type: string } | null
  return n && n.event_type === 'access.requested' && accessRequestsOf(ctx).requestWaitsOn(n.user_id, n.source_id) ? `/activity/${n.id}` : null
}
