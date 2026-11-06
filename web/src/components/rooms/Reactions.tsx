// Reactions on a room message (docs/DECISIONS.md "스레드와 반응"): the 8 fixed emoji. Under a message, one chip per emoji
// with its count (mine in the accent colour); a tap puts mine on or takes it off. Who reacted: on hover (computers) and
// on a long press (touch screens), the names the server gave (the first ROOM_REACTION_NAMES) and how many more. Adding
// one: the small smile button in a message's hover row (computers), the strip on top of the long-press sheet (phones).
// Reactions never notify, ring or count.
import clsx from 'clsx'
import { SmilePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ROOM_REACTIONS, type RoomMessage, type RoomReaction, type RoomReactionEmoji } from '@mycel/shared/api'
import { reactionWho } from '../../lib/rooms'
import { useT } from '../../i18n'
import { useNameOf } from '../../store/people'
import { useRooms } from '../../store/rooms'
import { useLongPress } from './MenuButton'

/** May this message take reactions: a message of the room for everyone, not an event line, not deleted. */
export const reactable = (m: Pick<RoomMessage, 'event' | 'deletedAt' | 'visibility'>) => !m.event && !m.deletedAt && m.visibility === 'room'

/** The 8 emoji in a row; `onPick` gets the one chosen. */
export function ReactionStrip({ onPick, mine = [], className }: { onPick: (e: RoomReactionEmoji) => void; mine?: readonly string[]; className?: string }) {
  const t = useT()
  return (
    <div role="group" aria-label={t('rooms.react')} className={clsx('flex items-center', className)} data-testid="reaction-strip">
      {ROOM_REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          aria-pressed={mine.includes(e)}
          className={clsx('flex size-9 items-center justify-center rounded-lg text-lg leading-none transition hover:bg-hover max-md:size-11 max-md:text-xl', mine.includes(e) && 'bg-accent-soft')}
          data-testid="reaction-pick"
        >
          {e}
        </button>
      ))}
    </div>
  )
}

/** The smile button of a message's hover row: the strip in a small popover (Esc or a click outside closes it). */
export function ReactionPicker({ m, roomId, className }: { m: RoomMessage; roomId: string; className?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: Event) => !box.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [open])
  const mine = (m.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji)
  return (
    <div
      ref={box}
      className={clsx('relative', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        aria-label={t('rooms.react')}
        title={t('rooms.react')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center justify-center rounded-md p-1.5 text-faint transition hover:bg-hover hover:text-ink"
        data-testid="message-react"
      >
        <SmilePlus size={16} aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-30 mb-1 rounded-xl border border-line bg-surface p-1 shadow-lg">
          <ReactionStrip
            mine={mine}
            onPick={(e) => {
              setOpen(false)
              void useRooms.getState().react(roomId, m.id, e, !mine.includes(e))
            }}
          />
        </div>
      )}
    </div>
  )
}

/** The chips under a message. */
export function ReactionChips({ roomId, m }: { roomId: string; m: RoomMessage }) {
  if (!m.reactions?.length || !reactable(m)) return null
  return (
    <div className="mt-1 mb-0.5 flex flex-wrap gap-1" data-testid="reactions">
      {m.reactions.map((r) => (
        <Chip key={r.emoji} roomId={roomId} messageId={m.id} r={r} />
      ))}
    </div>
  )
}

function Chip({ roomId, messageId, r }: { roomId: string; messageId: string; r: RoomReaction }) {
  const t = useT()
  const nameOf = useNameOf()
  const [who, setWho] = useState(false)
  const pressed = useRef(0)
  const box = useRef<HTMLSpanElement>(null)
  const long = useLongPress(() => {
    pressed.current = Date.now()
    setWho(true)
    navigator.vibrate?.(10)
  })
  useEffect(() => {
    if (!who) return
    const h = (e: Event) => !box.current?.contains(e.target as Node) && setWho(false)
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [who])
  const names = reactionWho({ count: r.count, users: r.users.map((u) => ({ name: nameOf(u) ?? u.name })) }, { sep: t('rooms.nameSep'), more: (list, n) => t('rooms.groupNamesMore', { names: list, n }) })
  return (
    <span ref={box} className="group/chip relative inline-flex" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        {...long}
        onClick={() => {
          // the finger lifting after a long press is no tap
          if (Date.now() - pressed.current < 600) return
          void useRooms.getState().react(roomId, messageId, r.emoji, !r.mine)
        }}
        aria-pressed={r.mine}
        aria-label={t(r.mine ? 'rooms.reactionMine' : 'rooms.reaction', { emoji: r.emoji, n: r.count, names })}
        className={clsx(
          'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums transition select-none [-webkit-touch-callout:none] max-md:h-7',
          r.mine ? 'border-accent/50 bg-accent-soft font-medium text-accent-text' : 'border-line text-muted hover:border-line-strong hover:text-ink',
        )}
        data-testid="reaction-chip"
        data-mine={r.mine ? '' : undefined}
      >
        <span aria-hidden className="text-sm leading-none">{r.emoji}</span>
        <span aria-hidden>{r.count}</span>
      </button>
      {/* who reacted: on hover (a mouse), or after a long press (a finger) */}
      <span
        role="tooltip"
        className={clsx(
          'pointer-events-none absolute bottom-full left-0 z-30 mb-1 w-max max-w-64 rounded-md bg-ink px-2 py-1 text-xs break-words text-surface shadow-lg',
          who ? 'block' : 'hidden pointer-fine:group-hover/chip:block',
        )}
        data-testid="reaction-who"
      >
        {r.emoji} {names}
      </span>
    </span>
  )
}
