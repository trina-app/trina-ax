// "Continue in a chat only you see" on a shared chat (docs/decisions/20261126-chat-fork.md, plan
// docs/AGENTS/plan/20261126-0813-chat-fork.md): a fork. A new chat only its person sees, in the shared chat's project
// (a chat shared with people: outside projects), that holds the conversation up to the end of the branch on screen as
// that person sees it now, and whose AI goes on from their own engine session (Claude Code) or from the copied history
// (Codex, the API engine, no session of theirs, a check that fails). The shared chat is not changed, nobody is told, and
// nobody else ever sees the fork.
//
// "Fork" on a chat of the person's own, or on a fork of theirs (docs/decisions/20261126-chat-fork-tree.md): the same
// copy, with the person as its only audience (everything on the branch; copies stay copies), in the chat's project while
// they still see it. Each fork sits under the chat it came from in its person's history (chats.fork_parent, migration
// 463; shared.ts forkParentsOf); their own computer uploads get rows of the fork's own (kept after the original is
// purged); the first answer of a fork of their own chat resumes the copied session as any chat of theirs (turn.ts).
//
// What is copied, and how (one transaction, then the session file):
//   - each finished message of the branch as the person sees it (ChatStore.toMessage with the shared chat's view for
//     them): other people's words keep their names; an answer hidden from them is one row with withheld_copy = 1 and
//     nothing of it (chat/shared-answers.ts keeps it hidden in the fork); attachments as they see them, a chat file by
//     reference to the chat that keeps it (Attachment.fromChat, chat/chat-files.ts); new ids, the same chain, the same
//     times. Later edits or deletes in the original do not follow;
//   - a turns row per copied answer (its runner, no usage: the answer was paid for once), so the per-runner rules (who
//     sees what, steps, the step records) read the copies as they read the original;
//   - each answer's record (shared_answer_reads, ids mapped in left_out), the read scope and the marks (session_tainted,
//     others_words, room_outside), never cleared: remember protection and a later share of the fork work as there;
//   - another person's step notes only as the shared chat gives them to the person's fresh session today
//     (step-record.ts othersNotesFor: the file tools, paths everyone there may list; none for an answer some there may
//     not see or from before the share);
//   - after the commit, the person's own Claude Code session of that branch (chat/shared.ts ownSessionOn), copied into
//     the fork's own session folder and pointed at like any chat's (engine_session_id / engine_session_leaf_id, the
//     copied turns of that session carry the copy as theirs): resetEngineSessions and every other cleanup cover it. A
//     failure leaves a fork without a session, never a stray file. chat/turn.ts resumes it once (fork_pending) with the
//     checks for this person only.
// Not copied: pins, mute, threads under answers, schedules, the people or the share, open cards.
import fs from 'node:fs'
import path from 'node:path'
import type { Attachment, Locale } from '@mycel/shared/api'
import { newId } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { loadPrincipal, type Principal } from '../policy/access'
import { confidentialChat } from '../safe-ops/confidential'
import { safeOpsEnabled } from '../safe-ops/runner'
import { guestAi, heldProject, isGuest } from '../auth/guests'
import type { ChatRuntime } from './runtime'
import { SHARED_LATER, type ChatRow, type MessageRow, type StoredStep } from './store'
import { Audiences, chatFor, messageView, ownSessionOn } from './shared'
import { answerHiddenFrom } from './shared-answers'
import { othersNotesFor, parseNotes } from './step-record'
import { TEXT, tr } from './i18n'
import { canSeeProject } from './projects'

/** Why this chat cannot be forked by this person (a 409 or 403 with its reason), or null. */
function refusal(rt: ChatRuntime, userId: string, r: ChatRow, projectId: string | null): { code: 'conflict' | 'forbidden'; reason: string } | null {
  if (safeOpsEnabled() || confidentialChat(rt.db, r.id)) return { code: 'conflict', reason: 'safe_ops' }
  // a room's side chat and a scheduled task's run chat are never shared; refused here too, in case
  if (r.side_room_id || r.title_source === 'schedule' || rt.db.query('SELECT 1 FROM turns WHERE chat_id = ? AND schedule_id IS NOT NULL LIMIT 1').get(r.id)) return { code: 'conflict', reason: 'fork_not_here' }
  // a guest: only where they may start a chat (their one project) and while they have an AI (docs/DECISIONS.md "Guests:
  // only what they were invited to")
  if (isGuest(rt.db, userId) && (!projectId || heldProject(rt.db, userId, rt.files.rules()) !== projectId || guestAi(rt.db, userId) === 'none')) return { code: 'forbidden', reason: 'fork_guest' }
  return null
}

/** My own chat's project for its fork: while I see it and it is not in the trash (createChat's check), else none. */
function ownProject(rt: ChatRuntime, userId: string, projectId: string | null): string | null {
  if (!projectId) return null
  const p = rt.store.projectRow(projectId)
  const me = loadPrincipal(rt.db, userId)
  return p && me && p.trashed_with === null && canSeeProject(rt.files, me, p) ? p.id : null
}

/** The messages a fork copies: the branch up to `leafId`, finished ones only (a running answer, and the question it
 * answers, stay out). */
function finishedPath(rt: ChatRuntime, chatId: string, leafId: string | null): MessageRow[] {
  const all = rt.store.pathTo(leafId)
  if (all.some((m) => m.chat_id !== chatId)) return []
  const cut = all.findIndex((m) => m.status === 'streaming')
  const out = cut < 0 ? all : all.slice(0, cut)
  // (a question at the end has no answer to go on from: the fork's first message answers the person's own question)
  while (out.length && out[out.length - 1]!.role === 'user') out.pop()
  return out
}

export interface ForkOptions { leafId?: string; engine: string; model: string | null; locale: Locale; title: (src: ChatRow) => string }

/**
 * Fork the chat `chatId` for `userId`, a shared one or their own (POST /api/chats/:id/fork): the new chat's row. 404 as the chat routes
 * (chatFor 'view'; another person's chat of one person); 409 safe_ops, fork_not_here, fork_nothing
 * (no finished answer on the branch yet); 403 fork_guest.
 */
export function forkChat(rt: ChatRuntime, userId: string, chatId: string, o: ForkOptions): ChatRow {
  const L = o.locale
  const a = chatFor(rt, userId, chatId, 'view', { locale: L })
  // a chat of one person forks for that person only (another person's private chat is never theirs to open: chatFor
  // says 404 already; said again here)
  if (!a.shared && a.row.user_id !== userId) fail('not_found')
  const src = a.row
  // a shared project chat: its project; one shared with people: outside projects; my own chat: its project while I
  // still see it (else outside projects, as its own page names none)
  const projectId = a.kind === 'project' ? a.project!.id : a.shared ? null : ownProject(rt, userId, src.project_id)
  const no = refusal(rt, userId, src, projectId)
  if (no) fail(no.code, no.reason === 'safe_ops' ? tr('sharedChatSafeOps', L) : tr('forkNotHere', L), { params: { reason: no.reason } })
  const leaf = o.leafId ?? src.active_leaf_id
  const msgs = finishedPath(rt, src.id, leaf)
  if (!msgs.some((m) => m.role === 'assistant')) fail('conflict', tr('forkNothingYet', L), { params: { reason: 'fork_nothing' } })

  const db = rt.db
  const view = messageView(rt, src, userId, L)
  // another person's notes as the shared chat gives them to this person's fresh session (step-record.ts): paths only
  // where this person and everyone who sees the chat now may list them; none for an answer hidden from some of them
  const aud = new Audiences(db, rt.files)
  const audience = aud.ofChat(src)
  const rules = rt.files.rules()
  const people = audience.map((id) => loadPrincipal(db, id)).filter((x): x is Principal => !!x)
  const me = loadPrincipal(db, userId)
  const canList = (p: string) => { const segs = p.split('/').filter(Boolean); try { return !!me && rules.canList(me, segs) && people.every((x) => rules.canList(x, segs)) } catch { return false } }

  const ids = new Map<string, string>()
  const turnIds = new Map<string, string>()
  for (const m of msgs) { ids.set(m.id, newId()); if (m.turn_id) turnIds.set(m.turn_id, newId()) }
  const forkId = newId()
  const now = new Date().toISOString()
  const others = msgs.some((m) => m.role === 'user' && m.author_id !== userId)
  const c = db.query('SELECT session_tainted, others_words, room_outside, session_read_scope FROM chats WHERE id = ?').get(src.id) as { session_tainted: number; others_words: number; room_outside: number; session_read_scope: string | null }
  // the line back says the original's title; the fork itself is "<title> (이어서)" (once: a fork of a fork keeps one), a
  // name the person changes as any other
  const fromTitle = o.title(src)
  const title = forkTitle(fromTitle, L)

  // my own computer uploads on the branch (uploads/attachments.ts rows, kept with their chat): a row of the fork's own
  // for each, the same file in my folder, so the fork's pictures, an edit and a send again keep them after the original
  // is purged from the trash (its rows go with it). Another person's upload is never copied (as I see it, if at all)
  const uploads = new Map<string, string>()
  const thumbs: { from: string; to: string; id: string }[] = []
  const upRow = db.query('SELECT id, user_id, chat_id, path, name, size, mime, kind, width, height, sha256, thumb_path, created_at FROM attachments WHERE id = ? AND chat_id = ? AND user_id = ?')
  const upIns = db.query('INSERT INTO attachments (id, user_id, chat_id, path, name, size, mime, kind, width, height, sha256, thumb_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const ownUpload = (id: string): string => {
    const had = uploads.get(id)
    if (had) return had
    const r = upRow.get(id, src.id, userId) as { id: string; user_id: string; chat_id: string; path: string; name: string; size: number; mime: string; kind: string; width: number | null; height: number | null; sha256: string; thumb_path: string | null; created_at: string } | null
    if (!r) return id
    const nid = newId()
    // thumbs/<id>.<ext>: the sweep keeps a thumbnail while a row of its id is there (uploads/attachments.ts sweep)
    const thumb = r.thumb_path ? `thumbs/${nid}${path.extname(r.thumb_path)}` : null
    upIns.run(nid, r.user_id, forkId, r.path, r.name, r.size, r.mime, r.kind, r.width, r.height, r.sha256, thumb, r.created_at)
    if (thumb) thumbs.push({ from: r.thumb_path!, to: thumb, id: nid })
    uploads.set(id, nid)
    return nid
  }

  db.transaction(() => {
    db.query(`INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at, seen_at, active_leaf_id,
        session_tainted, others_words, room_outside, session_read_scope, fork_of, fork_at, fork_title, fork_pending, fork_parent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
      .run(forkId, userId, projectId, title, src.title_source === 'auto' ? 'ai' : src.title_source, o.engine, o.model, now, now, now, ids.get(msgs[msgs.length - 1]!.id)!,
        // another person's words in it: the mark that keeps the person's Always for sends to what their own message names
        // (chat/shared-actions.ts othersWordsIn), as in the shared chat
        c.session_tainted || (others ? 1 : 0), c.others_words || (others ? 1 : 0), c.room_outside, c.session_read_scope, src.id, msgs[msgs.length - 1]!.id, fromTitle,
        // it sits under the chat it came from in my list (migration 463; "Detach to top level" clears it)
        src.id)
    const insMsg = db.query(`INSERT INTO messages (id, chat_id, parent_id, role, author_id, content, attachments, steps, step_notes, status, error, turn_id, engine, model, files,
        created_at, updated_at, stop_reason, history_trimmed, history_small_model, stopped_for, fork_copy, withheld_copy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    const insTurn = db.query(`INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, ended_at, message_id, user_message_id, shared_checked, people_checked, stop_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    const insRec = db.query('INSERT INTO shared_answer_reads (message_id, chat_id, reads, left_out) VALUES (?,?,?,?)')
    const insSrc = db.query('INSERT INTO message_sources (message_id, ord, path, sha256, locs, via, by_main, by_subagent) SELECT ?, ord, path, sha256, locs, via, by_main, by_subagent FROM message_sources WHERE message_id = ?')
    const notesOf = db.query('SELECT step_notes FROM messages WHERE id = ?')
    for (const m of msgs) {
      const id = ids.get(m.id)!
      const stepNotes = m.role === 'assistant' ? (notesOf.get(m.id) as { step_notes: string | null } | null)?.step_notes ?? null : null
      const t = m.turn_id ? db.query('SELECT user_id, engine, model, status, started_at, ended_at, shared_checked, stop_reason FROM turns WHERE id = ?').get(m.turn_id) as
        { user_id: string; engine: string; model: string | null; status: string; started_at: string; ended_at: string | null; shared_checked: number; stop_reason: string | null } | null : null
      const runner = m.role === 'assistant' ? t?.user_id ?? null : m.author_id
      const mine = runner === userId
      const shown = rt.store.toMessage(m, undefined, view)
      const withheld = m.role === 'assistant' && !!shown.withheld
      const parent = m.parent_id ? ids.get(m.parent_id) ?? null : null
      // attachments as this person sees them (a computer upload of someone else's not there, a team file they may not
      // open "unavailable"); a chat file by reference to the chat that keeps it
      const atts: Attachment[] = withheld ? [] : shown.attachments.map((x) => (x.source === 'chat' ? { ...x, fromChat: x.fromChat ?? src.id } : !x.source || x.source === 'upload' ? { ...x, id: ownUpload(x.id) } : x))
      let steps = '[]'
      let notes: string | null = null
      let files: string | null = null
      let error: string | null = null
      if (!withheld) {
        if (mine || m.role === 'user') {
          steps = m.steps; notes = stepNotes; files = m.files; error = m.error
        } else {
          // another person's answer: its steps as this person saw them (their words, paths only where this person may
          // list them), keeping the server-only path list where it showed, so the fork's step records read them as the
          // shared chat's do; their notes as the shared chat gives them to this person (othersNotesFor)
          const raw = new Map((JSON.parse(m.steps || '[]') as StoredStep[]).map((s) => [s.id, s]))
          const before = !t || t.shared_checked === SHARED_LATER
          const out = shown.steps.map((s) => { const r = raw.get(s.id); return !before && r?.sv && s.label === r.sv.label ? { ...s, sv: r.sv } : s })
          steps = JSON.stringify(out)
          let hidden = before
          if (!hidden) { try { hidden = answerHiddenFrom(db, rt.files, src.id, m.id, audience).size > 0 } catch { hidden = true } }
          const kept = hidden ? {} : othersNotesFor(out, parseNotes(stepNotes), canList)
          notes = Object.keys(kept).length ? JSON.stringify(kept) : null
          files = shown.files ? JSON.stringify(shown.files) : null
          error = shown.error ? JSON.stringify(shown.error) : null
        }
      }
      const turnId = m.turn_id ? turnIds.get(m.turn_id)! : null
      // the turn row first: messages.turn_id points at it
      if (t && turnId && m.role === 'assistant') insTurn.run(turnId, forkId, t.user_id, t.engine, t.model, t.status, t.started_at, t.ended_at, id, parent, t.shared_checked, t.stop_reason)
      insMsg.run(id, forkId, parent, m.role, m.author_id, withheld ? '' : shown.content, JSON.stringify(atts), steps, notes, m.status, error, m.role === 'assistant' && t ? turnId : null,
        m.engine, m.model, files, m.created_at, m.updated_at, m.stop_reason, m.history_trimmed, m.history_small_model, m.stopped_for ?? null, withheld ? 1 : 0)
      if (m.role === 'assistant') {
        const rec = db.query('SELECT reads, left_out FROM shared_answer_reads WHERE message_id = ?').get(m.id) as { reads: string; left_out: string } | null
        if (rec) {
          let left: string[] = []
          try { left = (JSON.parse(rec.left_out || '[]') as string[]).map((x) => ids.get(x)).filter((x): x is string => !!x) } catch { left = [] }
          insRec.run(id, forkId, rec.reads, JSON.stringify(left))
        }
        if (!withheld) insSrc.run(id, m.id)
      }
    }
    audit(db, { actor: userId, action: 'chat.fork', target: forkId, detail: { from: src.id, messages: msgs.length, projectId, ...(a.shared ? {} : { own: true }) } })
  })()

  // the copied uploads' thumbnails (a failure: none, the picture's own file is shown or its tile)
  for (const x of thumbs) {
    try { fs.copyFileSync(path.join(rt.ctx.config.dataDir, ...x.from.split('/')), path.join(rt.ctx.config.dataDir, ...x.to.split('/'))) }
    catch { try { db.query('UPDATE attachments SET thumb_path = NULL WHERE id = ?').run(x.id) } catch { /* the tile shows */ } }
  }

  // the person's own Claude Code session of this branch, after the commit: copied into the fork's own folder, then
  // pointed at. Any failure: no session (the first answer starts fresh from the copied words), never a stray file
  try {
    const own = ownSessionOn(db, src.id, userId, msgs.map((m) => m.id), (sid) => rt.sessionStash(src.id, sid), (f) => fs.existsSync(f))
    const leafCopy = own ? ids.get(own.leaf) : undefined
    if (own && leafCopy) {
      const from = rt.sessionStash(src.id, own.sid)
      const to = rt.sessionStash(forkId, own.sid)
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
      try {
        fs.copyFileSync(from, to)
        fs.chmodSync(to, 0o600)
        const answers = own.answers.map((x) => ids.get(x)).filter((x): x is string => !!x)
        db.transaction(() => {
          db.query('UPDATE chats SET engine_session_id = ?, engine_session_leaf_id = ? WHERE id = ?').run(own.sid, leafCopy, forkId)
          for (const mid of answers) db.query('UPDATE turns SET engine_session_blob = ? WHERE chat_id = ? AND message_id = ? AND user_id = ?').run(to, forkId, mid, userId)
        })()
      } catch (e) {
        fs.rmSync(to, { force: true })
        throw e
      }
    }
  } catch (e) { rt.log.warn('fork session copy failed', { err: e, chat: forkId }) }
  return rt.store.chatRow(forkId)!
}

/** Has every other person's message in this chat come from its fork's copy (chat/fork.ts): the chat is the person's own
 * but for words they already saw (decision 3: their tools ask with the usual card, their own Always allow ends it)? */
export function forkCopiesOnly(rt: Pick<ChatRuntime, 'db'>, chat: Pick<ChatRow, 'id' | 'user_id' | 'fork_of' | 'shared_at' | 'people_shared_at'>): boolean {
  if (!chat.fork_of || chat.shared_at || chat.people_shared_at) return false
  return !rt.db.query("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' AND author_id IS NOT NULL AND author_id <> ? AND fork_copy = 0 LIMIT 1").get(chat.id, chat.user_id)
}

/** The first answer of a fork (chat/turn.ts forkNote): was it made from its person's own chat ("Fork"), not from a
 * shared one? The chat it came from as it is now: `userId`'s and not shared (someone else's chat that stopped being
 * shared after the fork is still a shared chat's fork, with its checks); gone, by whether the copy holds anyone else's
 * words (`others`). */
export function forkOfOwn(db: ChatRuntime['db'], sourceId: string, userId: string, others: boolean): { others: boolean } | null {
  const r = db.query('SELECT user_id, shared_at, people_shared_at FROM chats WHERE id = ?').get(sourceId) as { user_id: string; shared_at: string | null; people_shared_at: string | null } | null
  if (!r) return others ? null : { others }
  return r.user_id !== userId || r.shared_at || r.people_shared_at ? null : { others }
}

/** "<title> (continued)" in the person's language, once: a fork of a fork made while they read another language keeps
 * one suffix, in today's language (never "X (이어서) (lanjutan)"). An empty title stays empty (the apps say "New chat"). */
export function forkTitle(fromTitle: string, locale: Locale): string {
  const suffix = tr('forkTitleSuffix', locale)
  // every suffix at the end goes (an older title can carry two: "X (이어서) (lanjutan)")
  const all = Object.values(TEXT.forkTitleSuffix)
  let base = fromTitle
  for (let had = all.find((x) => base.endsWith(x)); had; had = all.find((x) => base.endsWith(x))) base = base.slice(0, -had.length)
  return !base.trim() ? fromTitle : `${base.slice(0, 200 - suffix.length)}${suffix}`
}
