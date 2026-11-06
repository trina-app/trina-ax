// What a row of the AI chats says about its chat (the sidebar and the phone's drawer, Home's latest chats on a phone):
// the AI asked something and waits for me (a warn dot, then "답변 필요" after the title: tab 5 "주의가 필요한 채팅"), an
// answer runs or waits its turn (a pulsing dot), or an intro deck finished there while I was elsewhere (a still dot until
// the chat is opened, store/deckBuilds.ts).
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { useDeckBuilds } from '../../store/deckBuilds'
import { useUnseenChats } from '../../store/unseenChats'

/** never sent in and never named: created for the attachments of a draft (the composer, "Ask AI about this") */
export const isUnused = (c: Pick<Chat, 'title' | 'createdAt' | 'updatedAt' | 'runState'>) => !c.title && c.createdAt === c.updatedAt && c.runState === 'idle'

export const useNeedsAnswer = (chatId: string) => useChats((s) => Object.values(s.requests).some((r) => r.chatId === chatId))

/** the dot before the title */
export function ChatStateDot({ chat }: { chat: Pick<Chat, 'id' | 'runState'> }) {
  const t = useT()
  const needsAnswer = useNeedsAnswer(chat.id)
  const deckReady = useDeckBuilds((s) => !!s.unseen[chat.id])
  // PROTOTYPE (desktop sidebar): an answer that finished while I was elsewhere (store/unseenChats.ts)
  const answered = useUnseenChats((s) => !!s.ids[chat.id])
  if (needsAnswer) return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
  if (chat.runState !== 'idle') return <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label={t(chat.runState === 'queued' ? 'chat.queued' : 'chat.running')} />
  if (deckReady) return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" role="img" aria-label={t('deck.progress.ready')} data-testid="deck-ready-dot" />
  if (answered) return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" role="img" aria-label={t('sidebar.newAnswer')} data-testid="new-answer-dot" />
  return null
}

/** "답변 필요" after the title, while the AI waits for me */
export function NeedsAnswerLabel({ chatId }: { chatId: string }) {
  const t = useT()
  if (!useNeedsAnswer(chatId)) return null
  return (
    <span className="shrink-0 text-micro font-medium text-warn" data-testid="needs-answer">
      {t('chat.needsAnswer')}
    </span>
  )
}
