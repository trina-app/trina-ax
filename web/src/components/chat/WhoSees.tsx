// The line under a chat's box that says who sees the chat (docs/DECISIONS.md "Who sees it, always"): "나만 봐요", "나와
// 관리자만 봐요" or "프로젝트 사람 N명이 볼 수 있어요" (lib/sharedChat.ts whoSees), on every project chat's box and every
// open chat's (components/chat/Composer.tsx `who`). Quiet text with a small icon: a lock while only I see it, people
// otherwise. For a shared chat (or a box whose new chat will be shared) whose members the person may change
// (Project.membersEditable) it is a button that opens the members dialog (components/ProjectMembersDialog.tsx); anything
// else has nothing to open. On a phone the button takes taps from a 44 px box without making the line taller.
import { Lock, Users } from 'lucide-react'
import { useT } from '../../i18n'
import { whoSees } from '../../lib/sharedChat'

export function WhoSeesLine({ shared, place, onOpen }: {
  /** the shared chat's Chat.shared, or the project whose new chat will be shared; null: a chat of one person */
  shared: { audience?: number; alone?: boolean } | null
  /** the box of a chat not made yet ("새 채팅은 …") or an open chat ("… 이 채팅을 …") */
  place: 'new' | 'chat'
  /** opens the members dialog: only for a shared chat whose members the person may change */
  onOpen?: () => void
}) {
  const t = useT()
  const who = whoSees(shared)
  const text = who.kind === 'me' ? t('chat.whoMe') : who.kind === 'admins' ? t('chat.whoMeAdmins') : t(place === 'new' ? 'projects.sharedNewChat' : 'chat.sharedSeen', { n: who.n })
  const Icon = who.kind === 'me' ? Lock : Users
  const body = (
    <>
      <Icon size={12} className="mr-1 inline-block align-[-1px]" aria-hidden />
      {text}
    </>
  )
  if (!shared || !onOpen)
    return (
      <span data-testid="who-sees" data-who={who.kind}>
        {body}
      </span>
    )
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className="touch-hit rounded-sm underline decoration-dotted underline-offset-2 hover:text-ink hover:decoration-solid"
      data-testid="who-sees"
      data-who={who.kind}
    >
      {body}
    </button>
  )
}
