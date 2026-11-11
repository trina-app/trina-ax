// Whether the page may reload by itself now. Both automatic reloads after a server update ask this: the one after the
// server reports its new version (components/Layout.tsx UpdateWatcher) and the one for a lazy part of the old build
// that is gone (lib/chunk-reload.ts). A reload the person asks for (a Reload button) keeps the text of messages that
// were not sent as their chats' drafts first.
import { isBusy } from './busy'
import { mergeDraft } from './composerDraft'
import { readDraft, writeDraft } from './localData'
import { useChats } from '../store/chats'
import { roomDrafts } from '../store/rooms'
import { useSession } from '../store/session'
import { useUi } from '../store/ui'

/**
 * A reload now would lose something: an upload, a non-empty draft or a recording (lib/busy.ts), an answer still
 * streaming on screen, a message still being sent or marked "not sent" (it lives only in this tab's memory, chats
 * store `local`), or a reply typed in a room's box, also one whose box is not on screen now (store/rooms.ts roomDrafts,
 * this tab's memory only).
 */
export function reloadWouldLose(): boolean {
  if (isBusy()) return true
  if ([...roomDrafts.values()].some((d) => d.trim())) return true
  return Object.values(useChats.getState().threads).some((th) => th.messages.some((m) => m.status === 'streaming' || !!m.local))
}

/** Something a reload would lose for good and that the person can finish: an upload, a recording (or its
 * transcription), a message still being sent or marked "not sent" (a draft is kept in this browser; an answer that
 * streams goes on on the server). */
export function unfinishedWork(): boolean {
  if (isBusy('upload') || isBusy('recording')) return true
  return Object.values(useChats.getState().threads).some((th) => th.messages.some((m) => !!m.local))
}

/** Before a reload the person asked for: the text of each message still being sent or not sent goes into its chat's
 * draft (lib/localData.ts, which the chat's composer starts from), after what is there and only once. Attachments are
 * not kept. A message that was delivered after all only leaves its text in the input box. */
export function keepUnsentAsDrafts(s?: Parameters<typeof writeDraft>[3]) {
  const st = useSession.getState().status
  if (st.kind !== 'signed-in') return
  const userId = st.me.user.id
  for (const [chatId, th] of Object.entries(useChats.getState().threads)) {
    for (const m of th.messages) {
      if (!m.local || !m.content.trim()) continue
      writeDraft(userId, chatId, mergeDraft(readDraft(userId, chatId, s), m.content), s)
    }
  }
}

/** The server cannot be reached now (the browser is offline, the live connection is down): a reload would land on the
 * offline page. */
export function serverUnreachable(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const conn = useUi.getState().conn
  return conn === 'reconnecting' || conn === 'offline'
}

/** nothing would be lost and the server can be reached */
export const mayReloadNow = () => !reloadWouldLose() && !serverUnreachable()
