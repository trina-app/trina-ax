// The seam between a new version of a chat file and the people who have the chat open (plan
// docs/AGENTS/plan/20261121-1240-places-ai-versions.md). The AI's saves (chat/place-ctx.ts version) call
// onChatFileVersion; the web's live update (S2, chat/chat-file-edit.ts tellChat: the carrying messages' tiles again, as
// each person may see them) registers with listenChatFileVersions. Kept apart from both, so neither depends on the
// other. A listener that fails never fails the save (a reload shows the new version).

/** A listener: the chat and the chain's id (its root's file_id, the one messages carry) */
export type ChatFileVersionListener = (chatId: string, fileId: string) => void

const listeners = new Set<ChatFileVersionListener>()

/** Hear every new version of a chat file the AI saved. Returns the way to stop hearing. */
export function listenChatFileVersions(fn: ChatFileVersionListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** A new version of the chain `fileId` (its root's id) of chat `chatId` was saved: tell the listeners, best effort */
export function onChatFileVersion(chatId: string, fileId: string): void {
  for (const fn of [...listeners]) {
    try { fn(chatId, fileId) } catch { /* a listener never fails the save */ }
  }
}
