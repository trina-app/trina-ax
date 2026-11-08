// Online status on a person's picture (docs/DECISIONS.md "접속 상태"), as Slack draws it: a filled green dot while
// they are online, a hollow one while away, nothing while offline. The dot sits on the picture's lower right with a
// 2 px ring in the colour behind it (index.css `.presence-dot`: a row sets --presence-bg to its own, hover and current
// included). Only for people: the AI (@트리나) and message avatars get none.
// The picture is decorative (the name is written beside it): the words go after the name for screen readers
// (PresenceText) and as the shared tooltip on the picture for a mouse.
import clsx from 'clsx'
import type { PresenceState } from '@mycel/shared/api'
import { useT } from '../i18n'
import { usePresenceOf } from '../store/presence'
import { Avatar, type AvatarUser } from './Avatar'
import { Tooltip } from './Tooltip'

/** the dot's size on a picture of `avatar` px: 8 px up to 28 px pictures, 10 px from 32 px */
export const presenceDotSize = (avatar: number) => (avatar >= 32 ? 10 : 8)

/** The dot alone (online or away), for a caller that places it (inline before a name, a menu's mark). */
export function PresenceDot({ state, size = 8, className }: { state: Exclude<PresenceState, 'offline'>; size?: number; className?: string }) {
  return <span aria-hidden className={clsx('presence-dot block shrink-0 rounded-full', className)} data-presence-dot={state} style={{ width: size, height: size }} data-testid="presence-dot" />
}

/** A person's picture with their dot; a tooltip with the state on a computer. */
export function PresenceFace({ user, size, className }: { user: AvatarUser; size: number; className?: string }) {
  const t = useT()
  const state = usePresenceOf(user.id)
  const face = (
    <span aria-hidden className={clsx('relative inline-flex shrink-0', className)} data-testid="presence-face" data-presence={state}>
      <Avatar user={user} size={size} />
      {state !== 'offline' && <PresenceDot state={state} size={presenceDotSize(size)} className="absolute -right-px -bottom-px" />}
    </span>
  )
  return state === 'offline' ? face : <Tooltip label={t(state === 'online' ? 'presence.online' : 'presence.away')}>{face}</Tooltip>
}

/** The state in words for screen readers, after the person's name (", 접속 중"). Offline is said only with `offline`
 * (a header or a member list: in a list of rows it would only repeat). */
export function PresenceText({ userId, offline }: { userId: string; offline?: boolean }) {
  const t = useT()
  const state = usePresenceOf(userId)
  if (state === 'offline' && !offline) return null
  return <span className="sr-only" data-testid="presence-text">{`, ${t(`presence.${state}`)}`}</span>
}
