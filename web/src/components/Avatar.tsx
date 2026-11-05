// A person's picture: their photo when they set one, otherwise the first letter of the name on the accent colour.
// The photo's address carries its version (shared/src/avatar.ts avatarUrl), so the browser keeps it for good and a new
// photo is a new address. A photo that does not load falls back to the letter.
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { avatarUrl } from '@mycel/shared'

export interface AvatarUser { id: string; name: string; avatarVersion?: number | null }

export function Avatar({ user, size = 24, className }: { user: AvatarUser; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [user.id, user.avatarVersion])
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.45)) }
  if (user.avatarVersion && !broken) {
    return <img src={avatarUrl(user.id, user.avatarVersion)} alt="" aria-hidden width={size} height={size} style={style} className={clsx('shrink-0 rounded-full bg-hover object-cover', className)} onError={() => setBroken(true)} draggable={false} />
  }
  return (
    <span style={style} className={clsx('flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-ink', className)} aria-hidden>
      {Array.from(user.name.trim())[0]?.toUpperCase() ?? '?'}
    </span>
  )
}
