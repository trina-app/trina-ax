// Who changed a chat's people, between its messages (docs/decisions/20261122-shared-chat-leave-and-lost-notices.md, QA
// TC-7289): "{actor} added {names}", "{actor} removed {names}", "{actor} left", and who restored a file's version ("{actor}
// restored {file} to version {n}", QA TC-v1c-01), in the rooms' event style (a quiet centred line). Read with the chat's audience (GET /api/chats/:id/audience `events`) for a chat shared with people, again
// whenever how many see it or how many messages it has changes.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChatAudience } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'

export type AudienceEvent = NonNullable<ChatAudience['events']>[number]

/** The chat's lines, oldest first ([] while not read, for a chat not shared with people, or when the read fails). `key`:
 * read again when it changes (the chat's count of people). */
export function useAudienceEvents(chatId: string | null, key: unknown): AudienceEvent[] {
  const [events, setEvents] = useState<AudienceEvent[]>([])
  // (another chat's lines never stay on screen while this one's are read; the same chat's stay while they are read
  // again, so they do not blink on every change)
  useEffect(() => { setEvents([]) }, [chatId])
  useEffect(() => {
    if (!chatId) return
    let live = true
    api.call(API.getChatAudience, { params: { id: chatId } }).then((a) => { if (live) setEvents(a.events ?? []) }, () => {})
    return () => { live = false }
  }, [chatId, key])
  return events
}

/** The lines that fall after `after` (exclusive; null: from the start) and up to `until` (inclusive; null: to the end). */
export function eventsBetween(events: readonly AudienceEvent[], after: string | null, until: string | null): AudienceEvent[] {
  return events.filter((e) => (after === null || e.at > after) && (until === null || e.at <= until))
}

export function ChatEventLine({ e }: { e: AudienceEvent }) {
  const t = useT()
  const locale = useLocale()
  const names = e.names.join(t('rooms.nameSep'))
  const text = e.kind === 'left' ? t('chat.event.left', { actor: e.actor })
    : e.kind === 'restored' ? t('chat.event.restored', { actor: e.actor, file: e.names[0] ?? '', n: e.version ?? 1 })
    : t(e.kind === 'added' ? 'chat.event.added' : 'chat.event.removed', { actor: e.actor, names })
  return <p className="text-center text-xs break-words text-faint" title={formatDateTime(e.at, locale)} data-testid="chat-event" data-kind={e.kind}>{text}</p>
}

/** A chat made by "Continue in a chat only you see" (Chat.forkedFrom, docs/decisions/20261126-chat-fork.md): one quiet
 * line above its copied messages, "Continued from ‹title›", the title a link while I may still open that chat. */
export function ForkedFromLine({ from }: { from: { title: string; chatId?: string } }) {
  const t = useT()
  const mark = '\u0001'
  const [before = '', after = ''] = t('chat.forkedFrom', { title: mark }).split(mark)
  const title = from.title.trim() || t('chat.untitled')
  return (
    <p className="text-center text-xs break-words text-faint" data-testid="chat-forked-from">
      {before}
      {from.chatId
        ? <Link to={`/c/${from.chatId}`} className="font-medium text-muted underline decoration-line-strong underline-offset-4 hover:text-ink" title={t('chat.forkedFromOpen')} data-testid="chat-forked-from-link">{title}</Link>
        : <span>{title}</span>}
      {after}
    </p>
  )
}
