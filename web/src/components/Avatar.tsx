// A person's picture: their photo when they set one, otherwise the first letter of the name on a neutral tile (the
// accent colour is for the one thing to do on a screen, not for every face).
// The photo's address carries its version (shared/src/avatar.ts avatarUrl), so the browser keeps it for good and a new
// photo is a new address. A photo that does not load falls back to the letter. `size="fill"`: the picture fills the box
// it sits in (a list row's icon box, components/list/List.tsx ListIcon: 16px on a computer, 32px on a phone), its letter
// in the list's face size (index.css --text-list-face).
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { avatarUrl } from '@mycel/shared'

export interface AvatarUser { id: string; name: string; avatarVersion?: number | null }

export function Avatar({ user, size = 24, className }: { user: AvatarUser; size?: number | 'fill'; className?: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [user.id, user.avatarVersion])
  const fill = size === 'fill'
  const style = fill ? undefined : { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.45)) }
  const box = fill ? 'size-full text-list-face' : undefined
  if (user.avatarVersion && !broken) {
    return <img src={avatarUrl(user.id, user.avatarVersion)} alt="" aria-hidden loading="lazy" decoding="async" width={fill ? undefined : size} height={fill ? undefined : size} style={style} className={clsx('shrink-0 rounded-full bg-hover object-cover', box, className)} onError={() => setBroken(true)} draggable={false} />
  }
  return (
    <span style={style} className={clsx('flex shrink-0 items-center justify-center rounded-full bg-hover font-semibold text-muted', box, className)} aria-hidden>
      {Array.from(user.name.trim())[0]?.toUpperCase() ?? '?'}
    </span>
  )
}
