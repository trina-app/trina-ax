// The mark of a shared project chat (docs/DECISIONS.md "Shared project chats"): one people icon, the same in the
// sidebar row, the project page's row and the chat header (there with how many see it as its tooltip). No avatars, no
// list of names.
import clsx from 'clsx'
import { ShieldAlert, Users } from 'lucide-react'
import { useT } from '../../i18n'
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
