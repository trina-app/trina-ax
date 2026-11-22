// A chat's own file edited in place (docs/AGENTS/plan/20261121-1206-chat-file-edit-versions.md): the thin layer the
// web's file panel calls over ChatFiles (chat/chat-files.ts, #230 P4), which does every check that matters (the chain's
// ROOT carriers, seesChat, the chat in the trash, safe operations, the storage, the 20 versions kept). Sharing a chat
// is for working together: whoever may open the file edits it (no view-only).
//
//   editState   may this person save a new version of this chain now: canEdit (the panel's pencil) a text name, a
//               chat shared with people (a project chat's save place is its project folder: read-only here), not in
//               the trash, safe operations off, not on the download-only list, at most CHAT_FILE_EDIT_MAX; canRestore
//               (Restore) the same without the text name and size (any file type, QA TC-7040)
//   saveText    a person's save: the whole text as putVersion's bytes; `beside` when someone saved after baseVersion
//   restoreTo   version n's bytes as a new head (ChatFiles.restore); at the cap the oldest after the first goes (pruned);
//               the chat's line "{actor} restored {file} to version {n}" (chat_file_events)
//   tellChat    the carrying messages' tiles again, to each person with a window open, as they may see them (never an
//               answer hidden from them): their "Updated by" line and size follow at once. The AI's saves reach it
//               through chat/chat-file-version-hook.ts (tellChatOnAiVersions)
import { CHAT_FILE_EDIT_MAX, type ChatFileSaved, type ChatFileVersions } from '@mycel/shared/api'
import type { ChatRow } from './store'
import { fail } from '../http/errors'
import { safeOpsEnabled } from '../safe-ops/runner'
import { personLocale } from '../files/media-text'
import { chatFilesOf, chatFileVersion, type ChatFileRow, type PutVersionResult } from './chat-files'
import { isPeopleRow } from './chat-audience'
import { tr } from './i18n'
import type { ChatRuntime } from './runtime'
import { Audiences } from './shared'
import { listenChatFileVersions } from './chat-file-version-hook'
import { AnswerSight } from './shared-answers'

/** Names a person edits as text in the panel (the same set as the web's) */
const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'csv', 'html', 'htm', 'json'])
export const editableName = (name: string): boolean => {
  const i = name.lastIndexOf('.')
  return i > 0 && TEXT_EXTS.has(name.slice(i + 1).toLowerCase())
}

type ChatRowLike = { id: string; deleted_at: string | null; people_shared_at: string | null; project_id: string | null }

/** Why this chain is not editable here now, or null. The caller checked the person may open it (404 first). `use`:
 * 'edit' (a save of the whole text: a text name, at most CHAT_FILE_EDIT_MAX) or 'restore' (an earlier version's own
 * bytes as a new head: any file type and size, QA TC-7040; ChatFiles.restore takes a version up to its own size). */
function readOnlyWhy(rt: ChatRuntime, chat: ChatRowLike, root: ChatFileRow, head: ChatFileRow, use: 'edit' | 'restore' = 'edit'): 'read_only' | 'safe_ops' | null {
  if (!isPeopleRow(chat) || chat.deleted_at) return 'read_only'
  if (use === 'edit' && !editableName(root.name)) return 'read_only'
  if (rt.files.quarantine.hasHash(head.sha256)) return 'read_only'
  if (use === 'edit' && head.size > CHAT_FILE_EDIT_MAX) return 'read_only'
  if (safeOpsEnabled()) return 'safe_ops'
  return null
}

/** The versions list and whether the person may edit (text) and restore (any file) now; the 404 of a missing file for
 * anyone who may not open it */
export function editState(rt: ChatRuntime, userId: string, chat: ChatRowLike, fileId: string): ChatFileVersions {
  const files = chatFilesOf(rt.ctx)
  const items = files.versions(userId, chat.id, fileId)
  if (!items.length) return fail('not_found')
  const o = files.open(userId, chat.id, fileId, false)
  return { items, canEdit: readOnlyWhy(rt, chat, o.root, o.row) === null, canRestore: readOnlyWhy(rt, chat, o.root, o.row, 'restore') === null }
}

/** At most this many saves and restores per person a minute (429 with retryAfter), counted only once the person may
 * edit the file (someone it is hidden from gets the 404 first, never a 429 that says it is there) */
export const CHAT_FILE_SAVES_PER_MINUTE = 30
const saves = new WeakMap<ChatRuntime, Map<string, number[]>>()
function saveLimit(rt: ChatRuntime, userId: string, at = Date.now()): void {
  const all = saves.get(rt) ?? saves.set(rt, new Map()).get(rt)!
  const recent = (all.get(userId) ?? []).filter((x) => at - x < 60_000)
  if (recent.length >= CHAT_FILE_SAVES_PER_MINUTE) {
    all.set(userId, recent)
    fail('rate_limited', undefined, { retryAfter: Math.max(1, Math.ceil((60_000 - (at - recent[0]!)) / 1000)) })
  }
  recent.push(at)
  all.set(userId, recent)
  if (all.size > 10_000) for (const [k, ts] of all) if (!ts.some((x) => at - x < 60_000)) all.delete(k)
}

/** The chat's row as it is now (not the one the route read): a chat moved to a project or made private since is not a
 * place to save (S2 review I1) */
const chatNow = (rt: ChatRuntime, chatId: string): ChatRowLike => (rt.store.chatRow(chatId) as ChatRow | null) ?? fail('not_found')

function assertEditable(rt: ChatRuntime, userId: string, chatIn: ChatRowLike, fileId: string, use: 'edit' | 'restore' = 'edit'): ChatFileRow {
  // may not open it: the 404 of a missing file, before anything says what it is
  const o = chatFilesOf(rt.ctx).open(userId, chatIn.id, fileId, false)
  const chat = chatNow(rt, chatIn.id)
  const why = readOnlyWhy(rt, chat, o.root, o.row, use)
  const locale = personLocale(rt.db, userId)
  if (why === 'safe_ops') fail('conflict', tr('sharedChatSafeOps', locale), { params: { reason: 'safe_ops' } })
  if (why) fail('conflict', tr('chatFileReadOnly', locale), { params: { reason: 'chat_file_read_only' } })
  saveLimit(rt, userId)
  return o.root
}

/** Right before putVersion, in the same synchronous step: still a chat shared with people, not a project chat, not in
 * the trash (S2 review I1). ChatFiles' own check at the insert covers who may open it. */
function stillPeopleChat(rt: ChatRuntime, userId: string, chatId: string): void {
  const c = chatNow(rt, chatId)
  if (!isPeopleRow(c) || c.deleted_at) fail('conflict', tr('chatFileReadOnly', personLocale(rt.db, userId)), { params: { reason: 'chat_file_read_only' } })
}

// beside: the version saved in between (theirs), so the notice names them and opens it (QA TC-6956); pruned: the
// versions this save removed at the cap (QA TC-6949)
const saved = (rt: ChatRuntime, r: PutVersionResult): ChatFileSaved => ({
  version: chatFileVersion(rt.db, r.row, true), beside: r.beside,
  ...(r.beside ? { besideOf: chatFileVersion(rt.db, r.replaced, false) } : {}), ...(r.pruned.length ? { pruned: r.pruned } : {}),
})

/** A person's save of the whole text (putVersion: the chain's root name, limits, storage, pruning, audit) */
export async function saveText(rt: ChatRuntime, userId: string, chat: ChatRowLike, fileId: string, content: string, baseVersion?: string): Promise<ChatFileSaved> {
  const root = assertEditable(rt, userId, chat, fileId)
  const bytes = new TextEncoder().encode(content)
  stillPeopleChat(rt, userId, chat.id)
  // and again at the insert itself (putVersion's recheck, after the bytes are written): a chat moved to a project or
  // made private meanwhile gets no version, and the bytes go
  const recheck = () => stillPeopleChat(rt, userId, chat.id)
  const r = await chatFilesOf(rt.ctx).putVersion(userId, chat.id, root.id, { bytes }, { recheck, ...(baseVersion ? { expectHead: baseVersion } : {}) })
  tellChat(rt, chat.id, root.id)
  return saved(rt, r)
}

/** Restore version `n`: a new head with its bytes */
export async function restoreTo(rt: ChatRuntime, userId: string, chat: ChatRowLike, fileId: string, n: number): Promise<ChatFileSaved> {
  const root = assertEditable(rt, userId, chat, fileId, 'restore')
  stillPeopleChat(rt, userId, chat.id)
  const r = await chatFilesOf(rt.ctx).restore(userId, chat.id, root.id, n, { recheck: () => stillPeopleChat(rt, userId, chat.id) })
  // the chat's line "{actor} restored {file} to version {n}" (S-032): written after the version is in, best effort (the
  // restore stands either way)
  try { addFileRestoreEvent(rt.db, chat.id, userId, root.id, n, r.row.created_at) } catch (e) { rt.log.warn('chat file restore line not written', { err: e, chat: chat.id }) }
  tellChat(rt, chat.id, root.id)
  return saved(rt, r)
}

/** Record a restore of a chat file's version (chat_file_events, migration 439): "{actor} restored {file} to version {n}"
 * between the chat's messages (S-032; read by chat/people-share.ts chatEventsOf). `rootId`: the chain's root, so the
 * line shows only to people who may open it. */
export function addFileRestoreEvent(db: ChatRuntime['db'], chatId: string, actor: string, rootId: string, version: number, at = new Date().toISOString()): void {
  db.query("INSERT INTO chat_file_events (chat_id, at, actor_id, kind, file_id, version) VALUES (?, ?, ?, 'restored', ?, ?)").run(chatId, at, actor, rootId, version)
}

/** The AI's new versions (chat/place-ctx.ts, through chat/chat-file-version-hook.ts) tell the chat as a person's save
 * does: once per runtime, until its server closes. A version of another runtime's chat finds no chat row here: nothing. */
const listening = new WeakSet<ChatRuntime>()
export function tellChatOnAiVersions(rt: ChatRuntime): void {
  if (listening.has(rt)) return
  listening.add(rt)
  const stop = listenChatFileVersions((chatId, fileId) => tellChat(rt, chatId, fileId))
  rt.ctx.onClose(stop)
}

/** The messages of the chat that carry the chain (by its root's id) get their tiles again, for each person in the chat
 * with a window open, as they may see them now (an answer hidden from them: nothing). Best effort: a failure here never
 * fails the save (a reload shows it). */
export function tellChat(rt: ChatRuntime, chatId: string, rootId: string): void {
  try {
    const chat = rt.store.chatRow(chatId)
    if (!chat || chat.deleted_at) return
    const msgs = rt.db.query("SELECT DISTINCT m.id, m.chat_id, m.attachments, m.author_id FROM messages m, json_each(m.attachments) j WHERE m.chat_id = ? AND json_valid(m.attachments) AND json_extract(j.value, '$.id') = ?").all(chatId, rootId) as { id: string; chat_id: string; attachments: string; author_id: string | null }[]
    if (!msgs.length) return
    const sight = new AnswerSight(rt.db, rt.files)
    const files = chatFilesOf(rt.ctx)
    for (const id of new Set(new Audiences(rt.db, rt.files).ofChat(chat))) {
      if (!rt.hub.hasOpenWindow(id)) continue
      // the chain as this person may open it (the root's carriers, P4): not theirs, nothing about it
      if (!files.find(id, chatId, rootId)) continue
      const hidden = sight.withheld(chatId, id)
      for (const m of msgs) {
        if (hidden.has(m.id)) continue
        const attachments = rt.store.attachmentsOf(m, id)
        rt.hub.publishOpen([id], { type: 'message.attachments', data: { chatId, messageId: m.id, attachments } })
      }
    }
  } catch (err) {
    rt.log.warn('chat file change not told to the chat', { err, chat: chatId })
  }
}
