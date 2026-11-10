// Reactions on a room message (docs/DECISIONS.md "스레드와 반응", "Any emoji as a reaction"): any one emoji, at most
// ROOM_REACTION_EMOJI_MAX different ones on a message. Under a message, one chip per emoji with its count (mine in the
// accent colour); a tap puts mine on or takes it off. Who reacted: on hover (computers) and on a long press (touch
// screens), the names the server gave (the first ROOM_REACTION_NAMES) and how many more. Adding one: the small smile
// button in a message's hover row (computers: ✅ 👀 👍 are on the row, the strip has six more and "More emoji"), the
// strip on top of the long-press sheet (phones: six and "More emoji"). "More emoji" opens the picker (EmojiPicker.tsx).
// Reactions never notify, ring or count.
import clsx from 'clsx'
import { Plus, SmilePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RoomMessage, RoomReaction } from '@mycel/shared/api'
import { reactionWho } from '../../lib/rooms'
import { useT } from '../../i18n'
import { useNameOf } from '../../store/people'
import { useRooms } from '../../store/rooms'
import { EmojiPanel } from '../EmojiPicker'
import { useLongPress } from './MenuButton'
import { Tooltip } from '../Tooltip'

/** May this message take reactions: a message of the room for everyone, not an event line, not deleted. */
export const reactable = (m: Pick<RoomMessage, 'event' | 'deletedAt' | 'visibility'>) => !m.event && !m.deletedAt && m.visibility === 'room'

/** The phone's strip (the top of the long-press sheet): six, so it fits a 360px screen with "More emoji". */
export const STRIP_REACTIONS = ['👍', '✅', '👀', '❤️', '😂', '😭'] as const
/** The computer's strip (the hover row's smile button): the row has ✅ 👀 👍 (MessageHoverBar QUICK_REACTIONS) already. */
export const STRIP_REACTIONS_COMPUTER = ['❤️', '😂', '😭', '🙏', '🎉', '🔥'] as const

/** Emoji in a row and "More emoji" after them; `onPick` gets the one chosen, `onMore` opens the picker. */
export function ReactionStrip({ emoji = STRIP_REACTIONS, onPick, onMore, mine = [], className }: { emoji?: readonly string[]; onPick: (e: string) => void; onMore?: () => void; mine?: readonly string[]; className?: string }) {
  const t = useT()
  const cell = 'flex size-9 items-center justify-center rounded-lg leading-none transition hover:bg-hover max-md:size-11'
  return (
    <div role="group" aria-label={t('rooms.react')} className={clsx('flex items-center', className)} data-testid="reaction-strip">
      {emoji.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          aria-pressed={mine.includes(e)}
          className={clsx(cell, 'text-lg max-md:text-xl', mine.includes(e) && 'bg-accent-soft')}
          data-testid="reaction-pick"
          data-emoji={e}
        >
          {e}
        </button>
      ))}
      {onMore && (
        <Tooltip label={t('emoji.more')}>
          <button type="button" onClick={onMore} aria-label={t('emoji.more')} aria-haspopup="dialog" className={clsx(cell, 'text-faint hover:text-ink')} data-testid="reaction-more">
            <Plus size={18} aria-hidden />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/** The full picker for a message's reactions: mine marked, a pick puts it on (or takes mine off), and it closes. */
export function ReactionPanel({ roomId, m, anchor, onClose }: { roomId: string; m: RoomMessage; anchor: HTMLElement | null; onClose: () => void }) {
  const t = useT()
  const mine = (m.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji)
  return (
    // a press in the sheet (a portal) is not the message's long press, nor a right-click of it
    <div className="contents" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <EmojiPanel
        anchor={anchor}
        title={t('rooms.react')}
        selected={mine}
        onClose={onClose}
        onPick={(e) => {
          onClose()
          void useRooms.getState().react(roomId, m.id, e, !mine.includes(e))
        }}
      />
    </div>
  )
}

/** The add-reaction button of a message's hover bar: the strip in a small popover (Esc, a pick or a click outside closes
 * it; Esc gives the keyboard back to the button), and from its "More emoji" the picker by the same button. `below`: the
 * popover opens under the bar (the bar is under the first message). */
export function ReactionPicker({ m, roomId, className, buttonClassName, below = false }: { m: RoomMessage; roomId: string; className?: string; buttonClassName?: string; below?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [more, setMore] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: Event) => !box.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [open])
  const mine = (m.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji)
  // under the button when there is no room above it inside the list that scrolls (the list would cut the strip off)
  const [down, setDown] = useState(below)
  const toggle = () => {
    if (more) return setMore(false)
    if (!open) {
      const b = button.current?.getBoundingClientRect()
      const list = button.current?.closest('.overflow-y-auto')?.getBoundingClientRect()
      setDown(below || (!!b && b.top - (list?.top ?? 0) < 56))
    }
    setOpen(!open)
  }
  return (
    <div
      ref={box}
      className={clsx('relative', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
          button.current?.focus()
        }
      }}
    >
      <Tooltip label={t('rooms.react')}>
        <button
          ref={button}
          type="button"
          aria-label={t('rooms.react')}
          aria-haspopup="true"
          aria-expanded={open || more}
          onClick={toggle}
          className={clsx('inline-flex items-center justify-center rounded-md p-1.5 text-faint transition hover:bg-hover hover:text-ink', buttonClassName)}
          data-testid="message-react"
        >
          <SmilePlus size={16} aria-hidden />
        </button>
      </Tooltip>
      {open && (
        <div className={clsx('absolute right-0 z-30 rounded-xl border border-line bg-surface p-1 shadow-lg', down ? 'top-full mt-1' : 'bottom-full mb-1')}>
          <ReactionStrip
            emoji={STRIP_REACTIONS_COMPUTER}
            mine={mine}
            onPick={(e) => {
              setOpen(false)
              void useRooms.getState().react(roomId, m.id, e, !mine.includes(e))
            }}
            onMore={() => {
              setOpen(false)
              setMore(true)
            }}
          />
        </div>
      )}
      {more && <ReactionPanel roomId={roomId} m={m} anchor={button.current} onClose={() => setMore(false)} />}
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
