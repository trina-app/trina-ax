// The mark of a shared project chat (docs/DECISIONS.md "Shared project chats"): one people icon, the same in the
// Trina list's row, the project page's row and the chat header (there with how many see it as its tooltip). In every
// chat list a shared chat someone else wrote in shows their faces in place of the icon (ChatFaces, their stack:
// FaceStack.tsx; docs/DECISIONS.md "Faces in every chat list").
import clsx from 'clsx'
import { Lock, ShieldAlert, Users } from 'lucide-react'
import type { RefObject } from 'react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { reactionWho } from '../../lib/rooms'
import { usePeople, usePeopleList } from '../../store/people'
import { useMe } from '../../store/session'
import { Avatar } from '../Avatar'
import { FaceStack } from '../FaceStack'
import { Tooltip } from '../Tooltip'

/** The icon in a list row: named "공유 채팅" for a screen reader, so the row's link says it. */
/** A chat in a team project that only its creator sees ("Only me", or one from before or brought in): a quiet lock in
 * its rows (docs/DECISIONS.md "Team project chats shared by default"). */
export function PrivateIcon({ className }: { className?: string }) {
  const t = useT()
  return <Lock size={12} role="img" aria-label={t('chat.privateLabel')} className={clsx('shrink-0 text-faint', className)} data-testid="private-icon" />
}

export function SharedIcon({ className }: { className?: string }) {
  const t = useT()
  return <Users size={14} role="img" aria-label={t('chat.sharedLabel')} className={clsx('shrink-0', className)} data-testid="shared-icon" />
}

/** The chat header's mark: the icon, and on a computer how many people see the chat as its tooltip (the line under the
 * message box says the same on every screen). */
export function SharedChatMark({ audience }: { audience: number }) {
  const t = useT()
  const label = t('chat.shared', { n: audience })
  return (
    <Tooltip label={label}>
      <span role="img" aria-label={label} className="inline-flex shrink-0 items-center rounded-md p-1 text-muted" data-testid="chat-shared">
        <Users size={15} aria-hidden />
      </span>
    </Tooltip>
  )
}

/** The chat header's mark of a chat only I see in a team project: the lock, as the shared one's people icon, with
 * "Only you see this chat" as its tooltip and name (QA TC-1068). */
export function PrivateChatMark() {
  const t = useT()
  const label = t('chat.privateLabel')
  return (
    <Tooltip label={label}>
      <span role="img" aria-label={label} className="inline-flex shrink-0 items-center rounded-md p-1 text-muted" data-testid="chat-private">
        <Lock size={15} aria-hidden />
      </span>
    </Tooltip>
  )
}

/** In place of the message box while safe operations (1A) are on: a shared chat can only be read then. */
export function SharedReadOnly() {
  const t = useT()
  return (
    <p role="status" className="flex items-start gap-2 rounded-2xl border border-line bg-subtle px-4 py-3 text-sm leading-6 break-keep text-muted" data-testid="shared-safe-ops">
      <ShieldAlert size={16} className="mt-1 shrink-0" aria-hidden />
      <span className="min-w-0">{t('chat.sharedSafeOps')}</span>
    </p>
  )
}

/** The other people who wrote in a shared chat, as its list gave them (Chat.shared.people: never me); null when nobody
 * else wrote, or the chat came without them (not from a list): its row shows the people icon then. */
export const otherWriters = (shared: Chat['shared']) => (shared?.people?.length ? shared.people : null)

/**
 * Who else wrote in a shared chat, on its list row (Chat.shared.people, the most recent first, never me;
 * docs/DECISIONS.md "Faces in every chat list"): their pictures overlapping (FaceStack, 20 px), at most 3 and then
 * "+N"; on a phone at most 2, so the title keeps its room. Each is the people directory's photo, else the letter.
 * Nothing when nobody else wrote (otherWriters: the row keeps its people icon). The pictures are decorative: the row's
 * link reads "Shared chat · Sam, Jun and 2 more" (an sr-only line), and on a computer the tooltip lists the names on
 * the faces, also while the row (`focusFrom`) has keyboard focus. No name on screen, except on a project page's row
 * (`page`) with one other writer: that face and the name on a computer. `on`: the colour behind the row (a list panel's
 * `subtle`, a page's `canvas`); `selected`: the row is the one on screen. `testId`: the stack's prefix. `where`: the
 * project the row's tag would have named (the faces take its place in the Trina list): after the names, in the tooltip
 * and the label.
 */
export function ChatFaces({ shared, focusFrom, page = false, on = 'canvas', selected, testId = 'project-chat', where }: { shared: NonNullable<Chat['shared']>; focusFrom?: RefObject<HTMLElement | null>; page?: boolean; on?: 'canvas' | 'subtle' | 'surface'; selected?: boolean; testId?: string; where?: string }) {
  const t = useT()
  const me = useMe()
  usePeopleList()
  const byId = usePeople((s) => s.byId)
  const wrote = otherWriters(shared)
  if (!wrote) return null
  const count = Math.max(shared.peopleCount ?? 0, wrote.length)
  // the name and photo as they are now (a rename shows at once, as in rooms); my photo from /api/me while the
  // directory has none for me (not read yet, or it failed)
  const people = wrote.map((p) => ({
    id: p.id,
    name: byId[p.id]?.name ?? p.name,
    avatarVersion: byId[p.id]?.avatarVersion ?? (p.id === me?.user.id ? me.user.avatarVersion : undefined),
  }))
  const names = reactionWho({ count, users: people }, { sep: t('rooms.nameSep'), more: (list, n) => t('rooms.groupNamesMore', { names: list, n }) }) + (where ? ` · ${where}` : '')
  const label = <span className="sr-only" data-testid={`${testId}-people-label`}>{t('chat.share.facesLabel', { names })}</span>
  if (page && count === 1) {
    const one = people[0]!
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Avatar user={one} size={20} />
        {/* a phone keeps the face only, so the title has the room (a name cut to "O." said nothing; QA TC-1081); the
            screen reader reads the label */}
        <span aria-hidden className="truncate max-md:hidden" data-testid={`${testId}-by`}>{one.name}</span>
        {label}
      </span>
    )
  }
  return (
    <>
      <Tooltip label={names} focusFrom={focusFrom}>
        <FaceStack people={people} count={count} hoverRing on={on} selected={selected} testId={testId} />
      </Tooltip>
      {label}
    </>
  )
}
