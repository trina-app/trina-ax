// The mark of a shared project chat (docs/DECISIONS.md "Shared project chats"): one people icon, the same in the
// sidebar row, the project page's row and the chat header (there with how many see it as its tooltip). The project
// page's row also has the faces of the people who wrote in it (ChatFaces, their stack: FaceStack.tsx).
import clsx from 'clsx'
import { ShieldAlert, Users } from 'lucide-react'
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

/**
 * Who wrote in a shared chat, on its project page's row (Chat.shared.people, the most recent first; docs/DECISIONS.md
 * "Shared project chats", "The faces on the project page"): their pictures overlapping, at most 3 and then "+N"; on a
 * phone at most 2, so the title keeps its room. Each is the people directory's photo (my own also from /api/me), else
 * the letter. One person (or nobody yet: its creator): that face and the name. The pictures are decorative: the row's
 * link reads the names ("Mina, Sam 참여"), and on a computer the tooltip lists them on the faces, also while the row
 * (`focusFrom`) has keyboard focus. Without `people` (a list other than the project page's) its creator alone.
 */
export function ChatFaces({ shared, focusFrom }: { shared: NonNullable<Chat['shared']>; focusFrom?: RefObject<HTMLElement | null> }) {
  const t = useT()
  const me = useMe()
  usePeopleList()
  const byId = usePeople((s) => s.byId)
  const wrote = shared.people?.length ? shared.people : null
  const count = wrote ? Math.max(shared.peopleCount ?? 0, wrote.length) : 1
  // the name and photo as they are now (a rename shows at once, as in rooms); my photo from /api/me while the
  // directory has none for me (not read yet, or it failed)
  const people = (wrote ?? [shared.by]).map((p) => ({
    id: p.id,
    name: byId[p.id]?.name ?? p.name,
    avatarVersion: byId[p.id]?.avatarVersion ?? (p.id === me?.user.id ? me.user.avatarVersion : undefined),
  }))
  const one = people[0]!
  if (count === 1) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Avatar user={one} size={20} />
        <span className="truncate" data-testid="project-chat-by">{one.name}</span>
      </span>
    )
  }
  const names = reactionWho({ count, users: people }, { sep: t('rooms.nameSep'), more: (list, n) => t('rooms.groupNamesMore', { names: list, n }) })
  return (
    <>
      <Tooltip label={names} focusFrom={focusFrom}>
        <FaceStack people={people} count={count} hoverRing testId="project-chat" />
      </Tooltip>
      <span className="sr-only" data-testid="project-chat-people-label">{t('projects.chatPeople', { names })}</span>
    </>
  )
}
