// Artifacts (design tab 3 `artifact` tool, tab 4 GET /api/chats/:id/artifacts): one row per version, grouped by
// `key` within a chat. create / rewrite store the whole content, update applies exact-string edits to the latest
// version. Saved versions are announced with artifact.updated (status done); component B sends the "writing"
// previews while the tool input streams.
import type { Artifact, ArtifactSummary, ArtifactType } from '@mycel/shared/api'
import type { ArtifactInput } from '@mycel/shared'
import type { z } from 'zod'
import type { AppContext } from '../context'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import { ToolError } from '../policy/errors'
import { normIso } from '../team-files/service'

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
export const MAX_VERSIONS_PER_KEY = 200

interface Row { id: string; chat_id: string; message_id: string | null; key: string; version: number; type: ArtifactType; title: string | null; language: string | null; content: string; created_at: string }
const COLS = 'id, chat_id, message_id, key, version, type, title, language, content, created_at'

const summary = (r: Row): ArtifactSummary => ({
  id: r.id, chatId: r.chat_id, messageId: r.message_id, key: r.key, version: r.version, type: r.type, title: r.title, language: r.language,
  createdAt: normIso(r.created_at), size: Buffer.byteLength(r.content, 'utf8'),
})
const full = (r: Row): Artifact => ({
  id: r.id, chatId: r.chat_id, messageId: r.message_id, key: r.key, version: r.version, type: r.type, title: r.title, language: r.language,
  content: r.content, createdAt: normIso(r.created_at),
})

export interface ArtifactTurn { userId: string; chatId: string; messageId: string | null }

export class Artifacts {
  constructor(private ctx: AppContext) {}

  private latest(chatId: string, key: string): Row | null {
    return this.ctx.db.query(`SELECT ${COLS} FROM artifacts WHERE chat_id = ? AND key = ? ORDER BY version DESC LIMIT 1`).get(chatId, key) as Row | null
  }

  /** The artifact tool. Throws ToolError with a message the model can act on. */
  apply(t: ArtifactTurn, a: z.output<typeof ArtifactInput>): ArtifactSummary {
    const prev = this.latest(t.chatId, a.key)
    let content: string
    if (a.action === 'update') {
      if (!prev) throw new ToolError(`no artifact with key '${a.key}' in this chat yet; use action "create"`)
      if (!a.edits?.length) throw new ToolError('update needs edits: [{ old, new }]')
      content = prev.content
      a.edits.forEach((e, i) => {
        if (!e.old) throw new ToolError(`edit ${i + 1}: "old" must not be empty`)
        const n = content.split(e.old).length - 1
        if (n === 0) throw new ToolError(`edit ${i + 1}: "old" text not found in version ${prev.version}; nothing was changed. Copy it exactly or use action "rewrite".`)
        if (n > 1) throw new ToolError(`edit ${i + 1}: "old" text appears ${n} times; include more surrounding text so it is unique`)
        content = content.replace(e.old, () => e.new)
      })
    } else {
      if (a.content === undefined) throw new ToolError(`${a.action} needs "content"`)
      content = a.content
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) throw new ToolError(`artifact is too large (max ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB)`)
    if (prev && prev.version >= MAX_VERSIONS_PER_KEY) throw new ToolError(`too many versions of '${a.key}'; create a new key`)
    const row: Row = {
      id: newId(), chat_id: t.chatId, message_id: t.messageId, key: a.key, version: (prev?.version ?? 0) + 1,
      type: (a.action === 'update' ? prev!.type : a.type) ?? prev?.type ?? 'markdown',
      title: a.title ?? prev?.title ?? null, language: a.language ?? (a.action === 'update' ? prev?.language ?? null : null),
      content, created_at: new Date().toISOString(),
    }
    this.ctx.db.query(`INSERT INTO artifacts (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.chat_id, row.message_id, row.key, row.version, row.type, row.title, row.language, row.content, row.created_at)
    const s = summary(row)
    this.ctx.services.realtime.publish(t.userId, {
      type: 'artifact.updated',
      data: { chatId: t.chatId, messageId: t.messageId, key: row.key, type: row.type, title: row.title, status: 'done', artifact: s },
    })
    return s
  }

  private ownChat(userId: string, chatId: string) {
    const c = this.ctx.db.query('SELECT id FROM chats WHERE id = ? AND user_id = ?').get(chatId, userId)
    if (!c) throw new HttpError('not_found')
  }

  /** GET /api/chats/:id/artifacts — every key with its versions, newest first. */
  list(userId: string, chatId: string): { items: { key: string; versions: ArtifactSummary[] }[] } {
    this.ownChat(userId, chatId)
    const rows = this.ctx.db.query(`SELECT ${COLS} FROM artifacts WHERE chat_id = ? ORDER BY key, version DESC`).all(chatId) as Row[]
    const groups = new Map<string, ArtifactSummary[]>()
    for (const r of rows) { const g = groups.get(r.key) ?? []; g.push(summary(r)); groups.set(r.key, g) }
    // keys in the order they were first created
    const items = [...groups.entries()].map(([key, versions]) => ({ key, versions }))
    items.sort((a, b) => a.versions[a.versions.length - 1]!.createdAt.localeCompare(b.versions[b.versions.length - 1]!.createdAt))
    return { items }
  }

  /** GET /api/artifacts/:id — own chats only. */
  get(userId: string, id: string): Artifact {
    const r = this.ctx.db.query(`SELECT a.${COLS.split(', ').join(', a.')} FROM artifacts a JOIN chats c ON c.id = a.chat_id WHERE a.id = ? AND c.user_id = ?`).get(id, userId) as Row | null
    if (!r) throw new HttpError('not_found')
    return full(r)
  }
}
