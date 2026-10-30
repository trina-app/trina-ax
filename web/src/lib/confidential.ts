// Whether an artifact or an HTML / SVG preview may run its scripts on this device (lib/artifacts.ts frameRunsScripts):
// not in a confidential chat (Safe operations 1A) outside the desktop app. The flag comes with the chat
// (Chat.confidential) or, while 1A is on, with the whole server (Me.server.allChatsConfidential: every chat, and every
// file preview).
import { useEffect, useState } from 'react'
import { api, API } from './api'
import { frameRunsScripts } from './artifacts'
import { isDesktop } from './desktop'
import { useChats } from '../store/chats'
import { useMe } from '../store/session'

/** chats that are not in the sidebar list, asked once per page load */
const asked = new Map<string, boolean>()

/** true / false, or null while a chat outside the loaded list is being asked for (callers show nothing meanwhile). */
export function useConfidentialChat(chatId: string | null): boolean | null {
  const all = !!useMe()?.server.allChatsConfidential
  const listed = useChats((s) => (chatId ? s.chats.find((c) => c.id === chatId) : undefined))
  const [fetched, setFetched] = useState<{ id: string; confidential: boolean } | null>(null)
  const need = !all && !!chatId && !listed
  useEffect(() => {
    if (!need || !chatId) return
    const known = asked.get(chatId)
    if (known !== undefined) return setFetched({ id: chatId, confidential: known })
    let live = true
    api.call(API.getChat, { params: { id: chatId } }).then(
      (c) => {
        asked.set(chatId, !!c.confidential)
        if (live) setFetched({ id: chatId, confidential: !!c.confidential })
      },
      // could not tell: show it without scripts
      () => live && setFetched({ id: chatId, confidential: true }),
    )
    return () => {
      live = false
    }
  }, [need, chatId])
  if (all) return true
  if (!chatId) return false
  if (listed) return !!listed.confidential
  return fetched?.id === chatId ? fetched.confidential : null
}

/** Scripts may run in this chat's artifacts / previews here; null while that is not known yet. */
export function useFrameScripts(chatId: string | null): boolean | null {
  const confidential = useConfidentialChat(chatId)
  return confidential === null ? null : frameRunsScripts({ confidential, desktop: isDesktop() })
}
