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
import { isSharedChat, severalAuthors, visibleSharedChat } from '../chat/shared'
import { withheldFrom } from '../chat/shared-answers'
import { ToolError } from '../policy/errors'
import { assertStorageRoomForAI } from '../system/storage'
import { normIso } from '../team-files/service'

/** one version's content (second limits audit N31: 2 MB before). Kept as a row of `artifacts`; the Files screen's
 * "save to the team folder" takes up to 10 MiB of text (SaveContentBody), so a saved artifact still fits. */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
export const MAX_VERSIONS_PER_KEY = 200
/** every version of every artifact of one chat together: each version is stored whole, so 200 versions of a 10 MB
 * page would be 2 GB in the database; 100 MB is ten full-size pages or hundreds of usual ones (second limits audit
 * review). Over it the AI is told to save the page as a file instead. */
export const MAX_ARTIFACT_BYTES_PER_CHAT = 100 * 1024 * 1024

interface Row { id: string; chat_id: string; message_id: string | null; key: string; version: number; type: ArtifactType; title: string | null; language: string | null; content: string; created_at: string }
const COLS = 'id, chat_id, message_id, key, version, type, title, language, content, created_at'

/** a row without its content, its size from the database (the list never loads the pages themselves) */
type SizedRow = Omit<Row, 'content'> & { size: number }
const LIST_COLS = 'id, chat_id, message_id, key, version, type, title, language, length(CAST(content AS BLOB)) AS size, created_at'
const summary = (r: SizedRow): ArtifactSummary => ({
  id: r.id, chatId: r.chat_id, messageId: r.message_id, key: r.key, version: r.version, type: r.type, title: r.title, language: r.language,
  createdAt: normIso(r.created_at), size: r.size,
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

  /**
   * The versions of a shared chat's artifacts hidden from `userId` (an empty set for a chat of one person): those an
   * answer hidden from them made (chat/shared-answers.ts), and every later version of the same key but the ones of
   * their own turns. A version may take its content, title or type from the one before it on any branch, so once one
   * is hidden the rest of the key stays hidden (fails closed); their own version took nothing from one hidden from them
   * (apply).
   */
  hiddenVersions(userId: string, chatId: string): ReadonlySet<string> {
    // (also a chat others wrote in before it stopped being shared: chat/shared.ts severalAuthors)
    if (!isSharedChat(this.ctx.db, chatId) && !severalAuthors(this.ctx.db, chatId)) return new Set()
    const hidden = withheldFrom(this.ctx.db, this.ctx.files.rules(), chatId, userId)
    const rows = this.ctx.db.query(`SELECT a.id, a.key, a.message_id, t.user_id AS runner FROM artifacts a LEFT JOIN messages m ON m.id = a.message_id
      LEFT JOIN turns t ON t.id = m.turn_id WHERE a.chat_id = ? ORDER BY a.key, a.version`).all(chatId) as { id: string; key: string; message_id: string | null; runner: string | null }[]
    const out = new Set<string>()
    let key: string | null = null, tainted = false
    for (const r of rows) {
      if (r.key !== key) { key = r.key; tainted = false }
      const own = !!r.message_id && hidden.has(r.message_id)
      if (own) tainted = true
      if (own || (tainted && r.runner !== userId)) out.add(r.id)
    }
    return out
  }

  /** The artifact tool. Throws ToolError with a message the model can act on. */
  apply(t: ArtifactTurn, a: z.output<typeof ArtifactInput>): ArtifactSummary {
    const latest = this.latest(t.chatId, a.key)
    // a shared chat: a version hidden from this person (hiddenVersions) is not theirs: an update finds nothing, and a
    // new version takes nothing from it (its number goes on)
    const hidden = !!latest && this.hiddenVersions(t.userId, t.chatId).has(latest.id)
    const prev = hidden ? null : latest
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
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_ARTIFACT_BYTES) throw new ToolError(`artifact is too large (max ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB); split it into several artifacts (other keys) or save it as a file with write`)
    // every version is kept whole: the team disk near full refuses it like a file (system/storage.ts)
    assertStorageRoomForAI(bytes)
    if (latest && latest.version >= MAX_VERSIONS_PER_KEY) throw new ToolError(`too many versions of '${a.key}'; create a new key`)
    const used = (this.ctx.db.query('SELECT coalesce(sum(length(CAST(content AS BLOB))), 0) AS n FROM artifacts WHERE chat_id = ?').get(t.chatId) as { n: number }).n
    if (used + bytes > MAX_ARTIFACT_BYTES_PER_CHAT) throw new ToolError(`this chat's pages and their versions already take ${Math.round(used / 1024 / 1024)} MB, and one chat keeps at most ${MAX_ARTIFACT_BYTES_PER_CHAT / 1024 / 1024} MB of them; nothing was saved. Save this page as a file in the team folder with write instead (the user opens it from Files), or suggest a new chat for more pages`)
    const row: Row = {
      id: newId(), chat_id: t.chatId, message_id: t.messageId, key: a.key, version: (latest?.version ?? 0) + 1,
      type: (a.action === 'update' ? prev!.type : a.type) ?? prev?.type ?? 'markdown',
      title: a.title ?? prev?.title ?? null, language: a.language ?? (a.action === 'update' ? prev?.language ?? null : null),
      content, created_at: new Date().toISOString(),
    }
    this.ctx.db.query(`INSERT INTO artifacts (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.chat_id, row.message_id, row.key, row.version, row.type, row.title, row.language, row.content, row.created_at)
    const s = summary({ ...row, size: bytes })
    this.ctx.services.realtime.publish(t.userId, {
      type: 'artifact.updated',
      data: { chatId: t.chatId, messageId: t.messageId, key: row.key, type: row.type, title: row.title, status: 'done', artifact: s },
    })
    return s
  }

  /** The caller's own chat (a shared one only while they still see its project), or a shared project chat they see
   * (chat/shared.ts): a shared chat's artifacts are part of its transcript. */
  private ownChat(userId: string, chatId: string) {
    if (visibleSharedChat(this.ctx.db, this.ctx.files, userId, chatId)) return
    const c = this.ctx.db.query('SELECT id FROM chats WHERE id = ? AND user_id = ? AND shared_at IS NULL').get(chatId, userId)
    if (!c) throw new HttpError('not_found')
  }

  /** GET /api/chats/:id/artifacts — every key with its versions, newest first. */
  list(userId: string, chatId: string): { items: { key: string; versions: ArtifactSummary[] }[] } {
    this.ownChat(userId, chatId)
    // (a shared chat: none hidden from the caller)
    const hidden = this.hiddenVersions(userId, chatId)
    const rows = (this.ctx.db.query(`SELECT ${LIST_COLS} FROM artifacts WHERE chat_id = ? ORDER BY key, version DESC`).all(chatId) as SizedRow[]).filter((r) => !hidden.has(r.id))
    const groups = new Map<string, ArtifactSummary[]>()
    for (const r of rows) { const g = groups.get(r.key) ?? []; g.push(summary(r)); groups.set(r.key, g) }
    // keys in the order they were first created
    const items = [...groups.entries()].map(([key, versions]) => ({ key, versions }))
    items.sort((a, b) => a.versions[a.versions.length - 1]!.createdAt.localeCompare(b.versions[b.versions.length - 1]!.createdAt))
    return { items }
  }

  /** GET /api/artifacts/:id — own chats, and shared project chats the caller sees. */
  get(userId: string, id: string): Artifact {
    const r = this.ctx.db.query(`SELECT a.${COLS.split(', ').join(', a.')} FROM artifacts a WHERE a.id = ?`).get(id) as Row | null
    if (!r) throw new HttpError('not_found')
    this.ownChat(userId, r.chat_id)
    if (this.hiddenVersions(userId, r.chat_id).has(r.id)) throw new HttpError('not_found')
    return full(r)
  }
}
