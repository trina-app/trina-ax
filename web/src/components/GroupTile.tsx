// A group's mark where a list names people and groups together (Admin › Folder permissions, the Team skills page's
// editors): the people mark on a rounded square the size of a person's picture (Avatar.tsx), so people (round) and
// groups (square) tell apart at a glance. Neutral like a picture's letter tile: no first letter (it would read as a
// person), no member faces and no accent colour. Decorative: the group's name is always written beside it.
import clsx from 'clsx'
import { UsersRound } from 'lucide-react'

export function GroupTile({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
      className={clsx('flex shrink-0 items-center justify-center bg-hover text-muted', className)}
      data-testid="group-tile"
    >
      <UsersRound size={Math.round(size * 0.6)} />
    </span>
  )
}
