// A person's round picture: their profile photo (Settings › Profile) when they have one, else the first letter of their
// name on a quiet round tile, as the account avatar in the sidebar. Decorative: the name is always written beside it.
import clsx from 'clsx'
import { useState } from 'react'
import { avatarUrl } from '@mycel/shared'

export interface AvatarUser {
  id: string
  name: string
  avatarVersion?: number
}

export function Avatar({ user, size = 32, className }: { user: AvatarUser; size?: number; className?: string }) {
  // a photo that cannot be loaded (removed a moment ago, offline) falls back to the letter
  const [broken, setBroken] = useState<string | null>(null)
  const src = user.avatarVersion ? avatarUrl(user.id, user.avatarVersion) : null
  const box = { width: size, height: size }
  if (src && broken !== src)
    return <img src={src} alt="" aria-hidden width={size} height={size} style={box} onError={() => setBroken(src)} className={clsx('shrink-0 rounded-full bg-hover object-cover', className)} />
  return (
    <span aria-hidden style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.42)) }} className={clsx('flex shrink-0 items-center justify-center rounded-full bg-hover leading-none font-semibold text-ink select-none', className)}>
      {Array.from(user.name.trim())[0]?.toUpperCase() ?? '?'}
    </span>
  )
}

export default Avatar
