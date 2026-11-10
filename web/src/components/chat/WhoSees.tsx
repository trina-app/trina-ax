// The line under a chat's box that says who sees the chat (docs/DECISIONS.md "Who sees it, always"): "나만 봐요", "나와
// 관리자만 봐요" or "프로젝트 사람 N명이 볼 수 있어요" (lib/sharedChat.ts whoSees), on every project chat's box and every
// open chat's (components/chat/Composer.tsx `who`). Quiet text with a small icon: a lock while only I see it, people
// otherwise. For a shared chat (or a box whose new chat will be shared) whose members the person may change
// (Project.membersEditable) it is a button that opens the members dialog (components/ProjectMembersDialog.tsx); anything
// else has nothing to open; its tooltip says what it opens. On a phone the button takes taps from a 44 px box without
// making the line taller. The project page's 멤버 line says the same words by the same rule (whoSeesText 'project').
import { Lock, Users } from 'lucide-react'
import { useT } from '../../i18n'
import { whoSees } from '../../lib/sharedChat'

/** The words of whoSees: "나만 봐요", "나와 관리자만 봐요", or how many in the place's own words: a new chat's box ("새 채팅은
 * 프로젝트 사람 N명이 …"), an open chat ("프로젝트 사람 N명이 이 채팅을 …") or the project page's 멤버 line ("N명이 봐요"). */
export function whoSeesText(t: ReturnType<typeof useT>, shared: { audience?: number; alone?: boolean } | null, place: 'new' | 'chat' | 'project'): string {
  const who = whoSees(shared)
  if (who.kind === 'me') return t('chat.whoMe')
  if (who.kind === 'admins') return t('chat.whoMeAdmins')
  return t(place === 'new' ? 'projects.sharedNewChat' : place === 'chat' ? 'chat.sharedSeen' : 'projects.membersCount', { n: who.n })
}

export function WhoSeesLine({ shared, place, onOpen }: {
  /** a shared chat's count with its project's `alone`, or the project whose new chat will be shared; null: a chat of
   * one person */
  shared: { audience?: number; alone?: boolean } | null
  /** the box of a chat not made yet ("새 채팅은 …") or an open chat ("… 이 채팅을 …") */
  place: 'new' | 'chat'
  /** opens the members dialog: only for a shared chat whose members the person may change */
  onOpen?: () => void
}) {
  const t = useT()
  const who = whoSees(shared)
  const text = whoSeesText(t, shared, place)
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
      title={t('chat.whoOpens')}
      className="touch-hit rounded-sm underline decoration-dotted underline-offset-2 hover:text-ink hover:decoration-solid"
      data-testid="who-sees"
      data-who={who.kind}
    >
      {body}
    </button>
  )
}
