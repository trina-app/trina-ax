// What a row of the AI chats says about its chat (the sidebar's 트리나 기록 and 모두 보기, the phone's drawer, Home's
// latest chats on a phone): one session marker at the row's right end (docs/DECISIONS.md "Session markers",
// lib/sessionMarkers.ts): "?" in a 16 px amber pill (the rooms' "@" shape) while the AI waits for my answer or an answer
// failed or paused that I have not seen; a 12 px grey ring while an answer runs or waits its turn (standing still with
// reduced motion); an 8 px accent dot for an answer I have not seen. Nothing on an idle row. From the chat list itself
// (Chat.waiting, Chat.unseen, Chat.lastOutcome, runState: the same after a reload and on every device) and the cards
// open in this window; no request per chat. Its label is the reason, which the row's link name then includes.
import clsx from 'clsx'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { markerOf, type Marker } from '../../lib/sessionMarkers'
import { useChats } from '../../store/chats'
import { cardQuestion, reasonText, useSessionMarkers } from '../../store/sessionMarkers'

/** never sent in and never named: created for the attachments of a draft (the composer, "Ask AI about this") */
export const isUnused = (c: Pick<Chat, 'title' | 'createdAt' | 'updatedAt' | 'runState'>) => !c.title && c.createdAt === c.updatedAt && c.runState === 'idle'

type Marked = Pick<Chat, 'id' | 'runState' | 'waiting' | 'unseen' | 'lastOutcome' | 'confidential'>
/** A chat's marker and its reason in words, as this window shows them: the AI's question itself when this window has
 * its card (not for a confidential chat), else the marker's words. */
export function useChatMarker(chat: Marked): { marker: Marker | null; reason: string } {
  const t = useT()
  const here = useSessionMarkers((s) => s.visible && s.onScreen === chat.id)
  const card = useChats((s) => Object.values(s.requests).some((r) => r.chatId === chat.id))
  const marker = markerOf(chat, { here, card })
  const question = useChats((s) => (marker?.reason === 'card' && !chat.confidential ? cardQuestion(s.requests, chat.id) : undefined))
  return { marker, reason: marker ? reasonText(marker.reason, t, question) : '' }
}

/** The marker itself (role img, named by the reason). */
export function SessionMarker({ marker, label, className }: { marker: Marker; label: string; className?: string }) {
  if (marker.kind === 'ask')
    return (
      <span role="img" aria-label={label} className={clsx('flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warn px-1 text-micro leading-none font-bold text-canvas', className)} data-testid="marker-ask" data-reason={marker.reason}>
        <span aria-hidden>?</span>
      </span>
    )
  if (marker.kind === 'running')
    return <span role="img" aria-label={label} className={clsx('size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-faint border-r-transparent motion-reduce:animate-none', className)} data-testid="marker-running" data-reason={marker.reason} />
  return <span role="img" aria-label={label} className={clsx('size-2 shrink-0 rounded-full bg-accent', className)} data-testid="marker-new" />
}
