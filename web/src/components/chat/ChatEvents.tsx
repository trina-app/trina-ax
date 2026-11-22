// Who changed a chat's people, between its messages (docs/decisions/20261122-shared-chat-leave-and-lost-notices.md, QA
// TC-7289): "{actor} added {names}", "{actor} removed {names}", "{actor} left", in the rooms' event style (a quiet
// centred line). Read with the chat's audience (GET /api/chats/:id/audience `events`) for a chat shared with people, again
// whenever how many see it changes.
import { useEffect, useState } from 'react'
import type { ChatAudience } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'

export type AudienceEvent = NonNullable<ChatAudience['events']>[number]

/** The chat's lines, oldest first ([] while not read, for a chat not shared with people, or when the read fails). `key`:
 * read again when it changes (the chat's count of people). */
export function useAudienceEvents(chatId: string | null, key: unknown): AudienceEvent[] {
  const [events, setEvents] = useState<AudienceEvent[]>([])
  useEffect(() => {
    if (!chatId) { setEvents([]); return }
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
  const text = e.kind === 'left' ? t('chat.event.left', { actor: e.actor }) : t(e.kind === 'added' ? 'chat.event.added' : 'chat.event.removed', { actor: e.actor, names })
  return <p className="text-center text-xs break-words text-faint" title={formatDateTime(e.at, locale)} data-testid="chat-event" data-kind={e.kind}>{text}</p>
}
