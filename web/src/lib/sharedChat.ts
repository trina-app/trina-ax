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

/** A chat of a list as it is now, with the faces of the others who wrote in it it had (Chat.shared.people): those come
 * with the lists and chat.updated, not with a single chat or an action's answer (docs/DECISIONS.md "Faces in every chat
 * list"). */
export const keepFaces = (old: Chat | undefined, chat: Chat): Chat =>
  old?.shared?.people && chat.shared && !chat.shared.people ? { ...chat, shared: { ...chat.shared, people: old.shared.people, peopleCount: old.shared.peopleCount } } : chat

export function sharedRights(chat: Pick<Chat, 'shared'> & Partial<Pick<Chat, 'sideRoomId'>> | null | undefined, me: string): SharedRights {
  const s = chat?.shared
  // a room's side chat never goes into a project (the server refuses it: side_chat_no_project, QA TC-1010)
  if (!s) return { shared: false, creator: true, canDelete: true, canMove: !chat?.sideRoomId }
  return { shared: true, creator: s.by.id === me, canDelete: s.canDelete, canMove: false }
}

/** A chat started now in this project is a shared chat unless it starts "Only me" (server/src/chat/shared.ts
 * sharesNewChats; docs/DECISIONS.md "Team project chats shared by default"): a team project (every one shares its
 * chats; the server never says so for a personal project), its folder not in the trash, and safe operations off. */
export const sharesNewChats = (p: Pick<Project, 'shareChats' | 'inTrash'> | null | undefined, safeOps: boolean): boolean =>
  !!p?.shareChats && !p.inTrash && !safeOps

/** A team project: one with members, its folder outside `users/` (a personal project is its person's alone). */
export const isTeamProject = (p: Pick<Project, 'folderPath'> | null | undefined): boolean =>
  !!p && p.folderPath !== 'users' && !p.folderPath.startsWith('users/')

/** A chat of one person in a team project (in place, safe operations off): only its creator sees it; they may share it
 * with the project's members (components/chat/ShareChat.tsx mayShareChat), and its rows show a lock. */
export const privateInTeamProject = (chat: Partial<Pick<Chat, 'shared' | 'deletedAt'>>, p: Pick<Project, 'folderPath' | 'inTrash'> | null | undefined): boolean =>
  !chat.shared && !chat.deletedAt && isTeamProject(p) && !p!.inTrash

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
}

/** The reason a request about a shared chat or a project's setting was refused (409 / 403 `params.reason`), or null. */
export const refusalReason = (e: unknown): string | null =>
  e instanceof ApiError && (e.status === 409 || e.status === 403) && typeof e.body.params?.reason === 'string' ? e.body.params.reason : null

/** A 404 for a project, or one of its shared chats, that the caller was taken out of (or left): the project's name, for
 * "You're no longer a member of <project>" in place of the generic not-found (QA TC-1067). Null for any other error. */
export const noLongerMemberOf = (e: unknown): string | null =>
  e instanceof ApiError && e.status === 404 && e.body.params?.reason === 'no_longer_member' && typeof e.body.params.project === 'string' ? e.body.params.project : null

/** The refusal in the person's words: a reason the screens name, else null (the caller shows the server's own message).
 * `where`: safe operations refuse a chat ("continue in a chat of your own") and the project setting differently. */
export function refusalKey(e: unknown, where: 'chat' | 'project'): MessageKey | null {
  const reason = refusalReason(e)
  if (!reason) return null
  // (a project's own refusals: the server's words, since the switch is gone)
  if (reason === 'safe_ops') return where === 'chat' ? 'chat.sharedSafeOps' : null
  return REASONS[reason] ?? null
}
