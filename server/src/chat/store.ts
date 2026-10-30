// Chats, messages (a tree), projects, memories: rows <-> API shapes (shared/src/api/entities.ts).
import type { Database } from 'bun:sqlite'
import type { ApiErrorBody, Attachment, Chat, ChatRunState, EngineId, FileChangeSummary, Memory, Message, MessageStatus, Project, Step, TurnStopReason, Usage, UserRef } from '@mycel/shared/api'
import { STEP_TEXT } from '@mycel/shared'
import { newId } from '../db'

export interface ChatRow {
  id: string; user_id: string; project_id: string | null; title: string; engine: string; model: string | null
  engine_session_id: string | null; engine_session_leaf_id: string | null; session_tainted: number
  active_leaf_id: string | null; created_at: string; updated_at: string; deleted_at: string | null
  /** where the title came from (title.ts): 'auto' | 'ai' | 'user' | 'schedule' | 'legacy' */
  title_source: string
}
export interface MessageRow {
  id: string; chat_id: string; parent_id: string | null; role: 'user' | 'assistant'; author_id: string | null; content: string
  attachments: string; steps: string; status: MessageStatus; error: string | null; turn_id: string | null; engine: string | null
  model: string | null; files: string | null; client_message_id: string | null; created_at: string; updated_at: string | null
  /** migration 212: the answer paused at a per-answer limit (TurnStopReason), else null */
  stop_reason: string | null
  /** migration 213: 1 when the AI got only the recent part of the conversation for this answer */
  history_trimmed: number
}
export interface ProjectRow { id: string; name: string; folder_path: string; instructions: string; created_by: string | null; created_at: string }

export const CHAT_COLS = 'id, user_id, project_id, title, engine, model, engine_session_id, engine_session_leaf_id, session_tainted, active_leaf_id, created_at, updated_at, deleted_at, title_source'
export const MESSAGE_COLS = 'id, chat_id, parent_id, role, author_id, content, attachments, steps, status, error, turn_id, engine, model, files, client_message_id, created_at, updated_at, stop_reason, history_trimmed'
export const PROJECT_COLS = 'id, name, folder_path, instructions, created_by, created_at'

/** SQLite timestamps ("2026-10-21T03:04:05.678Z" from strftime, or ISO from JS) -> ISO with offset. */
export function iso(t: string | null | undefined): string {
  if (!t) return new Date(0).toISOString()
  if (/[zZ]|[+-]\d\d:\d\d$/.test(t)) return new Date(t).toISOString()
  return new Date(t.replace(' ', 'T') + 'Z').toISOString()
}

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

/** messages.error: JSON ApiErrorBody (stage 2) or a plain string (stage 1 rows). */
export function parseError(s: string | null): ApiErrorBody | null {
  if (!s) return null
  const j = json<ApiErrorBody | null>(s, null)
  if (j && typeof j === 'object' && typeof j.code === 'string' && typeof j.message === 'string') return j
  return { code: 'internal', message: s }
}

/** A team-file reference with everything about the file blanked (deleted, or not readable for the viewer). */
export const blankTeamAttachment = (a: Pick<Attachment, 'id'>): Attachment => ({ id: a.id, name: '', path: '', size: 0, mime: 'application/octet-stream', kind: 'other', source: 'team', unavailable: true })

export class ChatStore {
  private names = new Map<string, string>()
  /** Team-file references as `userId` may see them now (component C, set by the runtime). Without it every reference
   * is blanked: a message never shows a referenced file's name to someone the server could not check. */
  viewAttachments: ((userId: string, atts: Attachment[]) => Attachment[]) | null = null
  constructor(readonly db: Database) {}

  /** A message's attachments for the chat's owner (the only person who sees its messages), team references re-checked. */
  attachmentsOf(r: Pick<MessageRow, 'chat_id' | 'attachments'>): Attachment[] {
    const atts = json<Attachment[]>(r.attachments, [])
    if (!atts.some((a) => a.source === 'team')) return atts
    const owner = (this.db.query('SELECT user_id FROM chats WHERE id = ?').get(r.chat_id) as { user_id: string } | null)?.user_id
    if (!owner || !this.viewAttachments) return atts.map((a) => (a.source === 'team' ? blankTeamAttachment(a) : a))
    try { return this.viewAttachments(owner, atts) } catch { return atts.map((a) => (a.source === 'team' ? blankTeamAttachment(a) : a)) }
  }

  /** The steps of an answer for the chat's owner: a step about an attached team file (id "attach-<reference id>",
   * TurnExec.attachmentsForTurn) loses its path once the owner can no longer open that file, like the attachment. */
  viewSteps(r: Pick<MessageRow, 'chat_id'>, steps: Step[]): Step[] {
    if (!steps.some((s) => s.tool === 'attachment')) return steps
    const owner = (this.db.query('SELECT user_id FROM chats WHERE id = ?').get(r.chat_id) as { user_id: string } | null)?.user_id
    const gone = (s: Step): boolean => {
      if (!s.id.startsWith('attach-')) return !!s.label && s.label !== STEP_TEXT.attachUnavailable.en // an unknown attachment step: no path shown
      if (!owner || !this.viewAttachments) return true
      try { return !!this.viewAttachments(owner, [{ id: s.id.slice('attach-'.length), source: 'team' } as Attachment])[0]?.unavailable } catch { return true }
    }
    return steps.map((s) => (s.tool === 'attachment' && gone(s) ? { ...s, label: STEP_TEXT.attachUnavailable.en, status: s.status === 'running' ? s.status : 'ok' } : s))
  }

  userRef(id: string | null): UserRef | null {
    if (!id) return null
    let name = this.names.get(id)
    if (name === undefined) {
      const r = this.db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | null
      name = r?.name ?? id
      this.names.set(id, name)
      if (this.names.size > 500) this.names.clear()
    }
    return { id, name }
  }
  forgetName(id: string) { this.names.delete(id) }

  // ---------------- chats ----------------
  chatRow(id: string): ChatRow | null {
    return this.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE id = ?`).get(id) as ChatRow | null
  }
  /** own chat (optionally including the trash) */
  ownChat(userId: string, id: string, o: { deleted?: boolean } = {}): ChatRow | null {
    const r = this.chatRow(id)
    if (!r || r.user_id !== userId) return null
    if (!o.deleted && r.deleted_at) return null
    return r
  }
  toChat(r: ChatRow, runState: ChatRunState): Chat {
    return {
      id: r.id, projectId: r.project_id, title: r.title, engine: (r.engine === 'codex' || r.engine === 'api' ? r.engine : 'claude-code') as EngineId, model: r.model,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), deletedAt: r.deleted_at ? iso(r.deleted_at) : null, runState,
    }
  }
  touchChat(id: string, at = new Date().toISOString()) { this.db.query('UPDATE chats SET updated_at = ? WHERE id = ?').run(at, id) }

  // ---------------- messages ----------------
  messageRow(id: string): MessageRow | null {
    return this.db.query(`SELECT ${MESSAGE_COLS} FROM messages WHERE id = ?`).get(id) as MessageRow | null
  }
  children(chatId: string, parentId: string | null): MessageRow[] {
    return (parentId === null
      ? this.db.query(`SELECT ${MESSAGE_COLS} FROM messages WHERE chat_id = ? AND parent_id IS NULL ORDER BY created_at, id`).all(chatId)
      : this.db.query(`SELECT ${MESSAGE_COLS} FROM messages WHERE chat_id = ? AND parent_id = ? ORDER BY created_at, id`).all(chatId, parentId)) as MessageRow[]
  }
  siblingIds(r: Pick<MessageRow, 'chat_id' | 'parent_id'>): string[] {
    return (r.parent_id === null
      ? this.db.query('SELECT id FROM messages WHERE chat_id = ? AND parent_id IS NULL ORDER BY created_at, id').all(r.chat_id)
      : this.db.query('SELECT id FROM messages WHERE chat_id = ? AND parent_id = ? ORDER BY created_at, id').all(r.chat_id, r.parent_id)
    ).map((x) => (x as { id: string }).id)
  }
  /** Root -> leaf path ending at `leafId` (inclusive). */
  pathTo(leafId: string | null): MessageRow[] {
    const out: MessageRow[] = []
    const seen = new Set<string>()
    let cur = leafId
    while (cur && !seen.has(cur) && out.length < 100_000) {
      seen.add(cur)
      const r = this.messageRow(cur)
      if (!r) break
      out.push(r)
      cur = r.parent_id
    }
    return out.reverse()
  }
  /** The newest leaf under `id`: follow the most recently created child at every step. */
  newestLeafUnder(chatId: string, id: string): string {
    let cur = id
    for (let i = 0; i < 100_000; i++) {
      const r = this.db.query('SELECT id FROM messages WHERE chat_id = ? AND parent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(chatId, cur) as { id: string } | null
      if (!r) return cur
      cur = r.id
    }
    return cur
  }
  toMessage(r: MessageRow, live?: { content: string; steps: Step[] }): Message {
    const siblings = this.siblingIds(r)
    const usage = r.role === 'assistant' && r.turn_id ? this.turnUsage(r.turn_id) : null
    return {
      id: r.id, chatId: r.chat_id, parentId: r.parent_id, role: r.role, author: r.role === 'user' ? this.userRef(r.author_id) : null,
      content: live?.content ?? r.content, attachments: this.attachmentsOf(r), steps: this.viewSteps(r, live?.steps ?? json<Step[]>(r.steps, []).filter(isStep)),
      status: r.status, error: parseError(r.error), turnId: r.turn_id, engine: (r.engine === 'codex' || r.engine === 'claude-code' || r.engine === 'api' ? r.engine : null) as EngineId | null,
      model: r.model, files: json<FileChangeSummary | null>(r.files, null), usage, createdAt: iso(r.created_at),
      branch: { index: Math.max(0, siblings.indexOf(r.id)), count: Math.max(1, siblings.length), siblingIds: siblings },
      // only when it paused at a limit: every other message keeps its earlier shape
      ...(r.role === 'assistant' && stopReasonOf(r.stop_reason) ? { stopReason: stopReasonOf(r.stop_reason) } : {}),
      ...(r.role === 'assistant' && r.history_trimmed === 1 ? { historyTrimmed: true } : {}),
    }
  }
  turnUsage(turnId: string): Usage | null {
    const t = this.db.query('SELECT input_tokens, output_tokens, cost_usd, status FROM turns WHERE id = ?').get(turnId) as { input_tokens: number; output_tokens: number; cost_usd: number; status: string } | null
    if (!t || t.status === 'queued' || t.status === 'running') return null
    return { inputTokens: t.input_tokens, outputTokens: t.output_tokens, costUsd: t.cost_usd }
  }
  insertMessage(m: {
    chatId: string; parentId: string | null; role: 'user' | 'assistant'; authorId: string | null; content: string; attachments?: Attachment[]
    status: MessageStatus; turnId?: string | null; engine?: string | null; model?: string | null; clientMessageId?: string | null; id?: string
  }): string {
    const id = m.id ?? newId()
    const now = new Date().toISOString()
    this.db.query(`INSERT INTO messages (id, chat_id, parent_id, role, author_id, content, attachments, steps, status, turn_id, engine, model, client_message_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, m.chatId, m.parentId, m.role, m.authorId, m.content, JSON.stringify(m.attachments ?? []), '[]', m.status,
      m.turnId ?? null, m.engine ?? null, m.model ?? null, m.clientMessageId ?? null, now, now)
    return id
  }

  // ---------------- projects ----------------
  projectRow(id: string): ProjectRow | null { return this.db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as ProjectRow | null }
  toProject(r: ProjectRow, canEdit: boolean): Project {
    return { id: r.id, name: r.name, folderPath: r.folder_path, instructions: r.instructions, createdBy: this.userRef(r.created_by), createdAt: iso(r.created_at), canEdit }
  }

  // ---------------- memories ----------------
  toMemory(r: { id: string; text: string; source_chat_id: string | null; created_at: string }): Memory {
    return { id: r.id, text: r.text, sourceChatId: r.source_chat_id, createdAt: iso(r.created_at) }
  }
}

/** messages.stop_reason / turns.stop_reason: a known per-answer limit, else null */
export const stopReasonOf = (v: string | null | undefined): TurnStopReason | null => (v === 'tool_limit' || v === 'time_limit' ? v : null)

function isStep(s: unknown): s is Step {
  // stage-1 rows stored a list of tool names; only full step objects are shown
  return !!s && typeof s === 'object' && typeof (s as Step).id === 'string' && typeof (s as Step).label === 'string'
}

/** Opaque cursor helpers (base64url JSON). */
export const encodeCursor = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
/** Decode a cursor whose fields `keys` are all strings; null when absent or not one of ours. */
export function decodeCursor<K extends string>(c: string | undefined, keys: readonly K[]): Record<K, string> | null {
  if (!c) return null
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!v || typeof v !== 'object' || keys.some((k) => typeof v[k] !== 'string' || (v[k] as string).length > 200)) return null
    return v as Record<K, string>
  } catch { return null }
}
