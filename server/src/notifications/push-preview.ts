// What a phone notification of a person's message says as its line (docs/decisions/20261124-push-preview-slack-rule.md,
// owner 2026-11-24 "슬랙룰 따라가자"): the message itself, as one plain line of at most PUSH_PREVIEW_MAX characters;
// for a message with files and no text, what was sent ("Sent a photo", "Sent a file: report.pdf"). Only while the
// reader's "Show message preview in notifications" is on (on by default). Never text that may hold a secret: a
// password, a key, a token, a card number or a one-time code (chat/auto-memory.ts secretIn), or a stored connection
// secret of the writer or the reader (the server's own redactor; a redactor that cannot be built withholds). Never text
// while the team runs safe operations (1A: every conversation is confidential). null: the caller's generic line.
//
// The words go from this server to the person's own phone over https (push-service.ts label), never through the push
// gateway, Apple or Google; the phone's own setting decides whether its lock screen shows them.
import { plainLabel, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { secretIn } from '../chat/auto-memory'
import type { Database } from 'bun:sqlite'
import { holdsKey, redactorFor } from '../integrations/connections/redact'
import { safeOpsEnabled } from '../safe-ops/runner'
import { confidentialChat } from '../safe-ops/confidential'
import { PUSH_FILE_WORDS, SHARED_CHAT } from './text'

/** The longest line sent (a phone shows two to four lines of it). */
export const PUSH_PREVIEW_MAX = 200
/** The longest file name in a line. */
const FILE_NAME_MAX = 80

/** A file of the message: its name only when the reader may be told it (`named`). */
export interface PreviewFile { name: string; image: boolean; named: boolean }

/** Every line of a text as one plain line, at most `max` characters, cut with "…". */
export function previewOf(text: string, max = PUSH_PREVIEW_MAX): string {
  return plainLabel(text.split('\n').map((l) => l.trim()).filter(Boolean).join(' '), max)
}

/** Does this text hold something that must never be on a phone's screen? `writer` / `reader`: whose stored connection
 * secrets are looked for (null: nobody's, e.g. Trina's answer has no writer). */
export function unsafeForPush(ctx: AppContext, text: string, writer: string | null, reader: string): boolean {
  if (secretIn(text)) return true
  for (const who of new Set([writer, reader])) if (who && holdsKey(redactorFor(ctx, who), text)) return true
  return false
}

/** The line, or null for the caller's generic line. */
export function pushPreview(ctx: AppContext, o: { preview: boolean; text: string; files?: readonly PreviewFile[]; writer: string | null; reader: string; locale: Locale; chatId?: string }): string | null {
  if (!o.preview || safeOpsEnabled() || (o.chatId && confidentialChat(ctx.db, o.chatId))) return null
  const line = previewOf(o.text)
  if (line) return unsafeForPush(ctx, line, o.writer, o.reader) ? null : line
  const files = o.files ?? []
  if (!files.length) return null
  const w = (k: keyof typeof PUSH_FILE_WORDS, v: Record<string, string> = {}) => PUSH_FILE_WORDS[k][o.locale].replace(/\{(n|name)\}/g, (_, x: string) => v[x] ?? '')
  const n = String(files.length)
  if (files.every((f) => f.image)) return files.length === 1 ? w('photo') : w('photos', { n })
  if (files.length > 1) return w('files', { n })
  const name = files[0]!.named ? plainLabel(files[0]!.name, FILE_NAME_MAX) : ''
  return name && !unsafeForPush(ctx, name, o.writer, o.reader) ? w('fileNamed', { name }) : w('file')
}

/** a person's name while their account is there and switched on */
export const activeName = (db: Database, id: string) => {
  const u = db.query("SELECT name FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(id) as { name: string } | null
  return u ? plainLabel(u.name, 80) : null
}
/** Where a chat is, as a notification's title says it: its title (its creator's stored connection secrets hidden, as
 * the Inbox does), else its project's name, else the generic "Shared chat". The title only while the reader's preview
 * is on and only when it is not message text: a chat is named after its first message until a title is made for it,
 * so a title that equals, or starts or is the start of, the text of a message in the chat would repeat the message
 * (owner's check 2026-11-24). A title that looks like a secret is left out too (unsafeForPush, as the line). */
export function chatPlace(ctx: AppContext, chatId: string, reader: string, o: { preview: boolean; locale: Locale }): string {
  const c = ctx.db.query('SELECT c.user_id, c.title, p.name project FROM chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?').get(chatId) as { user_id: string; title: string; project: string | null } | null
  const generic = SHARED_CHAT[o.locale]
  if (!c) return generic
  const title = o.preview ? plainLabel(redactorFor(ctx, c.user_id).hide(c.title || ''), 80) : ''
  if (title && !unsafeForPush(ctx, title, c.user_id, reader) && !titleIsMessage(ctx, chatId, title)) return title
  const project = plainLabel(c.project ?? '', 80)
  return project && !unsafeForPush(ctx, project, null, reader) ? project : generic
}
/** How many of a chat's first messages a title is compared with (a title is made from the first one or two). */
const TITLE_MESSAGES = 20
/** Is this title the text of one of the chat's first messages (equal, or one starts the other; "…" of a cut ignored)? */
export function titleIsMessage(ctx: AppContext, chatId: string, title: string): boolean {
  const t = title.replace(/…$/, '').trim().toLowerCase()
  if (!t) return false
  const rows = ctx.db.query(`SELECT content FROM messages WHERE chat_id = ? ORDER BY created_at, id LIMIT ${TITLE_MESSAGES}`).all(chatId) as { content: string }[]
  return rows.some((r) => {
    const m = previewOf(r.content, 100_000).toLowerCase()
    return !!m && (m === t || m.startsWith(t) || t.startsWith(m))
  })
}
/** A chat message's files for its push line: pictures, and a name only for a file kept with the chat (never a team
 * folder file's: each person sees those by their own access). */
export function previewFiles(raw: string): PreviewFile[] {
  let list: unknown
  try { list = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(list)) return []
  return list.filter((a): a is { name?: unknown; kind?: unknown; source?: unknown; unavailable?: unknown } => !!a && typeof a === 'object')
    .map((a) => ({ name: typeof a.name === 'string' ? a.name : '', image: a.kind === 'image', named: a.source !== 'team' && !a.unavailable && typeof a.name === 'string' }))
}
