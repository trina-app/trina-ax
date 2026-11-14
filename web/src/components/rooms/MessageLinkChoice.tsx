// Slack's "Show message / Only show link" in a room's box (docs/DECISIONS.md "Message links and their previews"): while
// the text holds links to messages of another conversation, the box asks the server once per changed set of links which
// of them some reader of this room (or thread) cannot see (POST …/message-links/audience, after a short pause). For each
// such link, one line: "Some people here can't see that message." with Only show link (chosen) / Show message. Show
// message puts the card in its place exactly as it will be stored, with ✕ to go back. No names, no count. Nothing to
// ask: nothing shows. A failure (429 included) asks nothing: only links go, the safe way.
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { API, linkCount, MESSAGE_LINK_PREVIEWS_MAX, parseMessageLinks, type MessageLinkAudience } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { useT } from '../../i18n'
import { Tooltip } from '../Tooltip'
import { MessageLinkCard } from './MessageLinkCard'
import { useLinkHosts } from './MessageLinkChip'

type Item = MessageLinkAudience['items'][number]
/** the pause after the last change before the box asks */
export const AUDIENCE_DEBOUNCE_MS = 400

/** The links of `text` the box may ask about: this team's (its hosts), not into this room, at most
 * MESSAGE_LINK_PREVIEWS_MAX, none when the text has more links than that (no card would show). */
export function askableLinks(text: string, roomId: string, hosts: ReadonlySet<string>): { roomId: string; messageId: string }[] {
  if (!text.includes('/rooms/') || linkCount(text) > MESSAGE_LINK_PREVIEWS_MAX) return []
  return parseMessageLinks(text).filter((l) => hosts.has(l.host) && l.roomId !== roomId).slice(0, MESSAGE_LINK_PREVIEWS_MAX).map((l) => ({ roomId: l.roomId, messageId: l.messageId }))
}

/** The box's question and the sender's choices: `items` to ask about, `shown` the ones set to Show message (what the
 * send's showMessages carries). */
export function useLinkChoice(roomId: string, threadRootId: string | null, text: string) {
  const hosts = useLinkHosts()
  const links = useMemo(() => askableLinks(text, roomId, hosts), [text, roomId, hosts])
  const key = links.map((l) => l.messageId).join(',')
  const [items, setItems] = useState<Item[]>([])
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set())
  const asked = useRef('')
  // another room or thread (the box is not made again): nothing of the last one's question or choices goes with it
  useEffect(() => {
    asked.current = ''
    setItems([])
    setShown(new Set())
  }, [roomId, threadRootId])
  useEffect(() => {
    if (!key) {
      asked.current = ''
      setItems([])
      setShown(new Set())
      return
    }
    if (asked.current === `${roomId}|${threadRootId}|${key}`) return
    let live = true
    const timer = setTimeout(() => {
      asked.current = `${roomId}|${threadRootId}|${key}`
      api
        .call(API.roomMessageLinkAudience, { params: { id: roomId }, body: { links, ...(threadRootId ? { threadRootId } : {}) } })
        .then((r) => live && setItems(r.items), () => live && setItems([]))
    }, AUDIENCE_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // (links is the same while key is)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, roomId, threadRootId])
  // a link taken out of the text takes its choice with it
  const present = useMemo(() => new Set(key.split(',')), [key])
  const asking = items.filter((i) => present.has(i.messageId))
  const chosen = [...shown].filter((id) => asking.some((i) => i.messageId === id && i.snapshotAllowed))
  const set = (id: string, on: boolean) => setShown((s) => {
    const n = new Set(s)
    if (on) n.add(id)
    else n.delete(id)
    return n
  })
  return { items: asking, shown: new Set(chosen), showMessages: chosen, set, reset: () => setShown(new Set()) }
}

/** The lines in the box (one per link to ask about). */
export function MessageLinkChoice({ choice }: { choice: ReturnType<typeof useLinkChoice> }) {
  const t = useT()
  if (!choice.items.length) return null
  return (
    <div className="space-y-1.5 px-3 pt-2.5 max-md:px-4" data-testid="message-link-choice">
      {choice.items.map((i) =>
        choice.shown.has(i.messageId) && i.preview ? (
          <div key={i.messageId} className="relative max-w-xl" data-testid="message-link-choice-card">
            <MessageLinkCard p={i.preview} nested={[]} still />
            <Tooltip label={t('rooms.link.onlyLink')}>
              <button type="button" onClick={() => choice.set(i.messageId, false)} aria-label={t('rooms.link.onlyLink')} className="absolute top-1.5 right-1.5 rounded-md p-1 text-faint hover:bg-hover hover:text-ink" data-testid="message-link-choice-undo">
                <X size={14} aria-hidden />
              </button>
            </Tooltip>
          </div>
        ) : (
          <div key={i.messageId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="message-link-choice-line">
            <p role="status" className="min-w-0 flex-1 text-sm text-ink">{t('rooms.link.someoneCannotSee')}</p>
            {i.snapshotAllowed && (
              <div role="group" className="inline-flex shrink-0 rounded-lg border border-line p-0.5 text-xs">
                {([false, true] as const).map((on) => (
                  <button
                    key={String(on)}
                    type="button"
                    aria-pressed={choice.shown.has(i.messageId) === on}
                    onClick={() => choice.set(i.messageId, on)}
                    className={clsx('rounded-md px-2 py-1 font-medium focus-visible:outline-2 focus-visible:outline-accent', choice.shown.has(i.messageId) === on ? 'bg-subtle text-ink' : 'text-muted hover:text-ink')}
                    data-testid={on ? 'message-link-show' : 'message-link-only'}
                  >
                    {on ? t('rooms.link.showMessage') : t('rooms.link.onlyLink')}
                  </button>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  )
}
