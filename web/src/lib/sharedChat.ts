// Shared project chats (docs/DECISIONS.md "Shared project chats") as the screens see them: what the person may do in
// one (Chat.shared), whether a project's new chats are shared, and the server's refusals in the person's words. A chat
// without `shared` is a chat of one person: everything stays as it was.
import type { Chat, Project } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'
import { ApiError } from './api'

export interface SharedRights {
  /** a shared project chat */
  shared: boolean
  /** rename and the engine: its creator (every chat of one person is its person's) */
  creator: boolean
  /** delete (and restore): its creator or an editor of its project */
  canDelete: boolean
  /** a shared chat never changes project (409 shared_chat_move) */
  canMove: boolean
}

export function sharedRights(chat: Pick<Chat, 'shared'> | null | undefined, me: string): SharedRights {
  const s = chat?.shared
  if (!s) return { shared: false, creator: true, canDelete: true, canMove: true }
  return { shared: true, creator: s.by.id === me, canDelete: s.canDelete, canMove: false }
}

/** A chat started now in this project is a shared chat (server/src/chat/shared.ts sharesNewChats): the setting is on (the
 * server never says so for a personal project), its folder is not in the trash, and safe operations are off. */
export const sharesNewChats = (p: Pick<Project, 'shareChats' | 'inTrash'> | null | undefined, safeOps: boolean): boolean =>
  !!p?.shareChats && !p.inTrash && !safeOps

/**
 * Who sees a chat, as the line under its box says it (docs/DECISIONS.md "Who sees it, always"). `shared`: the shared
 * chat's (Chat.shared) or the project's whose new chat will be shared (Project); null for a chat of one person, which
 * nobody else ever sees, admins included.
 * - 'me': a chat of one person, or a shared one whose count is 1;
 * - 'admins': a shared one nobody else sees by a rule of its folder (`alone`): besides me only the owner and admins. Only
 *   a project made before outside projects/: in projects/ the owner and admins see it only as members (docs/DECISIONS.md
 *   "Project contents only for members"), so there `alone` comes only with a count of 1;
 * - 'people': how many see it (in projects/ its members, as the project's 멤버 line counts them).
 */
export type WhoSees = { kind: 'me' } | { kind: 'admins' } | { kind: 'people'; n: number }
export function whoSees(shared: { audience?: number; alone?: boolean } | null | undefined): WhoSees {
  if (!shared) return { kind: 'me' }
  const n = shared.audience ?? 0
  if (n <= 1) return { kind: 'me' }
  return shared.alone ? { kind: 'admins' } : { kind: 'people', n }
}

/** How many people in the project see a chat once it is shared, counted as the line under its box and the copy-link
 * toast count them (Chat.shared.audience: everyone who sees the project, me included). The share check's `audience`
 * (ShareChatResult) is the others, so the share dialog adds me (QA TC-070: the dialog said 2 where the line and the
 * toast said 3). */
export const seenOnceShared = (others: number): number => others + 1

/** The refusals about shared chats and the words the screens use for them (the server sends the same, localized; these
 * keep one wording where the screen already says it). */
const REASONS: Record<string, MessageKey> = {
  shared_chat_move: 'chat.sharedNoMove',
  project_personal: 'projects.shareChatsPersonal',
}

/** The reason a request about a shared chat or a project's setting was refused (409 / 403 `params.reason`), or null. */
export const refusalReason = (e: unknown): string | null =>
  e instanceof ApiError && (e.status === 409 || e.status === 403) && typeof e.body.params?.reason === 'string' ? e.body.params.reason : null

/** The refusal in the person's words: a reason the screens name, else null (the caller shows the server's own message).
 * `where`: safe operations refuse a chat ("continue in a chat of your own") and the project setting differently. */
export function refusalKey(e: unknown, where: 'chat' | 'project'): MessageKey | null {
  const reason = refusalReason(e)
  if (!reason) return null
  if (reason === 'safe_ops') return where === 'chat' ? 'chat.sharedSafeOps' : 'projects.shareChatsSafeOps'
  return REASONS[reason] ?? null
}
