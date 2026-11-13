// "Continue in a chat only you see" (docs/DECISIONS.md "Team project chats shared by default"): from a shared project
// chat, the project's page with a new chat's box set to "Only me" and the question in it (pages/Projects.tsx reads the
// state; components/chat/NewChatComposer.tsx `startPrivate`). Nothing is sent until the person sends it.
import type { NavigateFunction } from 'react-router-dom'
import { RAIL_STATE_KEY } from '../../lib/rail'
import { useChats } from '../../store/chats'

/** The navigation state the project page reads: the text for the box, and that the new chat starts "Only me". */
export interface PrivateAskState { privateAsk: string }

export const privateAskOf = (state: unknown): string | null => {
  const v = state && typeof state === 'object' ? (state as Partial<PrivateAskState>).privateAsk : undefined
  return typeof v === 'string' ? v : null
}

export function askPrivately(navigate: NavigateFunction, projectId: string, text: string) {
  navigate(`/projects/${projectId}`, { state: { privateAsk: text, [RAIL_STATE_KEY]: 'projects' } })
}

/** My latest question in a chat, as this window has it ('' when none is loaded). */
export const lastOwnQuestion = (chatId: string, me: string | undefined): string =>
  (useChats.getState().threads[chatId]?.messages ?? []).filter((m) => m.role === 'user' && !m.local && m.author?.id === me).at(-1)?.content ?? ''
