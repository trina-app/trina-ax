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

/** What the frames of a chat need to know: confidential (Safe operations 1A), and shared with other people (they open
 * its artifacts too: lib/frame-scripts.ts puts no team scripts into those). */
type Flags = { confidential: boolean; shared: boolean }
/** chats that are not in my history list, asked once per page load */
const asked = new Map<string, Flags>()

/** The flags of a chat, or null while a chat outside the loaded list is being asked for. */
function useChatFlags(chatId: string | null): Flags | null {
  const listed = useChats((s) => (chatId ? s.chats.find((c) => c.id === chatId) : undefined))
  const [fetched, setFetched] = useState<{ id: string; flags: Flags } | null>(null)
  const need = !!chatId && !listed
  useEffect(() => {
    if (!need || !chatId) return
    const known = asked.get(chatId)
    if (known !== undefined) return setFetched({ id: chatId, flags: known })
    let live = true
    api.call(API.getChat, { params: { id: chatId } }).then(
      (c) => {
        const flags = { confidential: !!c.confidential, shared: !!c.shared }
        asked.set(chatId, flags)
        if (live) setFetched({ id: chatId, flags })
      },
      // could not tell: show it without scripts
      () => live && setFetched({ id: chatId, flags: { confidential: true, shared: true } }),
    )
    return () => {
      live = false
    }
  }, [need, chatId])
  if (!chatId) return { confidential: false, shared: false }
  if (listed) return { confidential: !!listed.confidential, shared: !!listed.shared }
  return fetched?.id === chatId ? fetched.flags : null
}

/** true / false, or null while a chat outside the loaded list is being asked for (callers show nothing meanwhile). */
export function useConfidentialChat(chatId: string | null): boolean | null {
  const all = !!useMe()?.server.allChatsConfidential
  const flags = useChatFlags(all ? null : chatId)
  if (all) return true
  return flags === null ? null : flags.confidential
}

/** Whether other people see this chat (a shared chat); null while that is not known yet. */
export function useSharedChat(chatId: string | null): boolean | null {
  return useChatFlags(chatId)?.shared ?? null
}

/** Scripts may run in this chat's artifacts / previews here; null while that is not known yet. */
export function useFrameScripts(chatId: string | null): boolean | null {
  const confidential = useConfidentialChat(chatId)
  return confidential === null ? null : frameRunsScripts({ confidential, desktop: isDesktop() })
}
