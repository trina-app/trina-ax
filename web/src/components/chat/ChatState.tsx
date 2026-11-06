// What a row of the AI chats says about its chat (the sidebar and the phone's drawer, Home's latest chats on a phone):
// the AI asked something and waits for me (a warn dot, then "답변 필요" after the title: tab 5 "주의가 필요한 채팅"), an
// answer runs or waits its turn (a pulsing dot), an intro deck finished there while I was elsewhere (store/deckBuilds.ts),
// or an answer finished after I last had the chat on screen (a still dot). The chat list says the last two that
// survive a reload, for every window and device (Chat.waiting, Chat.unseen; docs/DECISIONS.md "Desktop sidebar: rooms
// first"); the live cards of this window (store/chats.ts requests) count too. No request per chat.
import { useLocation } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { useDeckBuilds } from '../../store/deckBuilds'

/** never sent in and never named: created for the attachments of a draft (the composer, "Ask AI about this") */
export const isUnused = (c: Pick<Chat, 'title' | 'createdAt' | 'updatedAt' | 'runState'>) => !c.title && c.createdAt === c.updatedAt && c.runState === 'idle'

/** the AI of this chat waits for my answer: the list's word for it, or a card open in this window */
export function useNeedsAnswer(chat: Pick<Chat, 'id' | 'waiting'>): boolean {
  const live = useChats((s) => Object.values(s.requests).some((r) => r.chatId === chat.id))
  return live || !!chat.waiting
}

/** the dot before the title */
export function ChatStateDot({ chat }: { chat: Pick<Chat, 'id' | 'runState' | 'waiting' | 'unseen'> }) {
  const t = useT()
  const needsAnswer = useNeedsAnswer(chat)
  const deckReady = useDeckBuilds((s) => !!s.unseen[chat.id])
  // the chat on screen is being seen (the chat page tells the server: POST /api/chats/:id/seen)
  const here = useLocation().pathname === `/c/${chat.id}`
  if (needsAnswer) return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
  if (chat.runState !== 'idle') return <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label={t(chat.runState === 'queued' ? 'chat.queued' : 'chat.running')} />
  if (deckReady) return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" role="img" aria-label={t('deck.progress.ready')} data-testid="deck-ready-dot" />
  if (chat.unseen && !here) return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" role="img" aria-label={t('sidebar.newAnswer')} data-testid="new-answer-dot" />
  return null
}

/** "답변 필요" after the title, while the AI waits for me */
export function NeedsAnswerLabel({ chat }: { chat: Pick<Chat, 'id' | 'waiting'> }) {
  const t = useT()
  if (!useNeedsAnswer(chat)) return null
  return (
    <span className="shrink-0 text-micro font-medium text-warn" data-testid="needs-answer">
      {t('chat.needsAnswer')}
    </span>
  )
}
