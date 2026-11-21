// A chat's own file edited in place, with versions (docs/AGENTS/plan/20261121-1206-chat-file-edit-versions.md): which
// names the panel edits as text, and the "Updated by <name> · <time>" line of the file's tile and the panel's header
// ("Updated by Trina for <name>" when the AI saved it for them). The server decides whether a person may save
// (ChatFileVersions.canEdit: a chat shared with people, not a project chat, not in the trash, safe operations off).
import type { Attachment, ChatFileVersion, Locale } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'
import { formatRelative } from './format'
import { extOf } from './paths'
import { aiName } from './tabs'

/** The versions a chain keeps (the server's CHAT_FILE_VERSIONS_KEPT): the first and the newest */
export const CHAT_FILE_VERSIONS_KEPT = 20

/** Names the panel edits as text (the server's chat/chat-file-edit.ts editableName): binary files have no pencil */
const TEXT_EXTS = ['md', 'markdown', 'txt', 'csv', 'html', 'htm', 'json']
export const chatTextEditable = (name: string | null | undefined): boolean => !!name && TEXT_EXTS.includes(extOf(name))

type T = (key: MessageKey, vars?: Record<string, string | number>) => string
type Who = { byName: string; ai?: true; at: string }

/** "Updated by Olga · 3 minutes ago", or "Updated by Trina for Olga · …" for the AI's */
export function updatedLine(t: T, locale: Locale, who: Who, now = Date.now()): string {
  const by = who.ai ? t('chatFile.updatedByAi', { ai: aiName(t), name: who.byName }) : t('chatFile.updatedBy', { name: who.byName })
  return `${by} · ${formatRelative(who.at, locale, now)}`
}

/** A tile's line: only for a chat file changed since it was sent (Attachment.updated: its head is not its root) */
export function tileUpdated(a: Pick<Attachment, 'source' | 'updated'>): Who | null {
  if (a.source !== 'chat' || !a.updated || a.updated.version <= 1) return null
  return { byName: a.updated.byName, at: a.updated.at, ...(a.updated.ai ? { ai: true as const } : {}) }
}

/** The panel header's line: the head when it is not the first file (oldest first, as the server lists them) */
export function headUpdated(items: readonly ChatFileVersion[]): Who | null {
  const head = items.find((v) => v.head) ?? items[items.length - 1]
  if (!head || head.version <= 1) return null
  return { byName: head.byName, at: head.createdAt, ...(head.ai ? { ai: true as const } : {}) }
}

/** Who saved a version, for its row in the list ("Olga", "Trina for Olga") */
export function versionBy(t: T, v: Pick<ChatFileVersion, 'byName' | 'ai'>): string {
  return v.ai ? t('chatFile.byAi', { ai: aiName(t), name: v.byName }) : v.byName
}
