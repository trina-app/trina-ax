// "Continue in a chat only you see" (docs/DECISIONS.md "Team project chats shared by default"): from a shared project
// chat, the project's page with a new chat's box set to "Only me" and the question in it (pages/Projects.tsx reads it;
// components/chat/NewChatComposer.tsx `startPrivate`). Nothing is sent until the person sends it. Kept in this window,
// not in the address's state: a phone's tab stack may go back to the project page's own entry (lib/screenHistory.ts),
// whose state is the old one.
import type { NavigateFunction } from 'react-router-dom'
import { create } from 'zustand'
import { RAIL_STATE_KEY } from '../../lib/rail'
import { useChats } from '../../store/chats'

/** The question waiting for a project's box ("Only me"), numbered so each ask starts the box again. */
interface PrivateAsk { projectId: string | null; text: string; n: number }
const usePrivateAskStore = create<PrivateAsk>(() => ({ projectId: null, text: '', n: 0 }))

/** The ask waiting for this project's box, or null. */
export const usePrivateAsk = (projectId: string | undefined): { text: string; n: number } | null =>
  usePrivateAskStore((s) => (projectId && s.projectId === projectId ? s : null))

/** The project page went away: its waiting ask goes with it (the box keeps its own draft). */
export const forgetPrivateAsk = (projectId: string | undefined) =>
  usePrivateAskStore.setState((s) => (projectId && s.projectId === projectId ? { projectId: null, text: '' } : s))

export function askPrivately(navigate: NavigateFunction, projectId: string, text: string) {
  usePrivateAskStore.setState((s) => ({ projectId, text, n: s.n + 1 }))
  navigate(`/projects/${projectId}`, { state: { [RAIL_STATE_KEY]: 'projects' } })
}

/** My latest question in a chat, as this window has it ('' when none is loaded). */
export const lastOwnQuestion = (chatId: string, me: string | undefined): string =>
  (useChats.getState().threads[chatId]?.messages ?? []).filter((m) => m.role === 'user' && !m.local && m.author?.id === me).at(-1)?.content ?? ''
