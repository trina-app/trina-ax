// The line under a message with replies in a thread (docs/DECISIONS.md "스레드와 반응"), one look for a room's message
// (components/rooms/RoomMessages.tsx) and an AI answer of a shared chat (components/chat/Messages.tsx; docs/decisions/
// 20261116-chat-answer-threads.md): up to 3 faces of the people who replied (the latest first), a dot for a thread I
// follow with replies I have not read (and "New replies" for screen readers: never the colour alone), "3 replies" and
// "· last reply 2:10 PM". The whole line opens the thread. Nothing at all without replies.
import type { UserRef } from '@mycel/shared/api'
import { intlTag } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { useAvatarOf } from '../store/people'
import { Avatar } from './Avatar'

/** what the line shows: the rooms' RoomThreadSummary and the chats' ChatThreadSummary have these fields */
export interface ThreadLineSummary { replyCount: number; lastReplyAt: string | null; repliers: UserRef[]; newReplies: boolean }

const timeOf = (iso: string, locale: Parameters<typeof intlTag>[0]) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))

export function ThreadLine({ summary, onOpen, testId }: { summary: ThreadLineSummary | null | undefined; onOpen: () => void; testId: string }) {
  const t = useT()
  const locale = useLocale()
  const th = summary
  if (!th || th.replyCount <= 0) return null
  return (
    <button type="button" onClick={onOpen} className="touch-hit group/thread mt-1 -ml-1 flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs hover:bg-hover" data-testid={testId} data-new={th.newReplies ? '' : undefined}>
      {th.repliers.length > 0 && (
        <span className="flex shrink-0 gap-0.5" aria-hidden>
          {th.repliers.map((u) => <ReplierFace key={u.id} user={u} />)}
        </span>
      )}
      {th.newReplies && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
      <span className="shrink-0 font-medium text-accent-text group-hover/thread:underline">{t('rooms.threadReplies', { n: th.replyCount })}</span>
      {th.newReplies && <span className="sr-only">{t('rooms.threadNew')}</span>}
      {th.lastReplyAt && <span className="truncate text-faint">· {t('rooms.threadLast', { time: timeOf(th.lastReplyAt, locale) })}</span>}
    </button>
  )
}

function ReplierFace({ user }: { user: UserRef }) {
  const u = useAvatarOf(user)
  return u ? <Avatar user={u} size={18} /> : <span className="size-[18px] rounded-full bg-hover" />
}
