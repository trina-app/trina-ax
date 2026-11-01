// Whether the page may reload by itself now. Both automatic reloads after a server update ask this: the one after the
// server reports its new version (components/Layout.tsx UpdateWatcher) and the one for a lazy part of the old build
// that is gone (lib/chunk-reload.ts).
import { isBusy } from './busy'
import { useChats } from '../store/chats'
import { useUi } from '../store/ui'

/**
 * A reload now would lose something: an upload, a non-empty draft or a recording (lib/busy.ts), an answer still
 * streaming on screen, or a message still being sent or marked "not sent" (it lives only in this tab's memory, chats
 * store `local`).
 */
export function reloadWouldLose(): boolean {
  if (isBusy()) return true
  return Object.values(useChats.getState().threads).some((th) => th.messages.some((m) => m.status === 'streaming' || !!m.local))
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
