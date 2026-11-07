// A message's hover bar on computers (Slack's): a small floating panel over the top-right edge of the message the mouse
// is on (or that has the keyboard's focus), with ✅ 👀 👍 (one click puts mine on or takes it off), 반응 추가 (the eight
// emoji), 스레드에서 답장 (opens the thread; not on a reply, which has no thread of its own) and ⋮ 더 보기 (복사, and
// for my own message 수정 and 삭제). Every button has a tooltip (components/Tooltip.tsx) and a name. It floats: nothing
// moves when it shows; it sits under the first message of a list so the header above does not cut it. Never on phones or
// touch screens (they have the long-press sheet), on event lines or on deleted messages (RoomMessages decides).
import clsx from 'clsx'
import { EllipsisVertical, MessageSquareText } from 'lucide-react'
import type { RoomMessage, RoomReactionEmoji } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { Tooltip } from '../Tooltip'
import { MenuButton, type MenuItem } from './MenuButton'
import { ReactionPicker } from './Reactions'

/** The quick reactions on the bar, in its order. */
export const QUICK_REACTIONS: readonly RoomReactionEmoji[] = ['✅', '👀', '👍']

const BTN = 'inline-flex size-7 items-center justify-center rounded-md text-faint transition hover:bg-hover hover:text-ink'

export function MessageHoverBar({ roomId, m, below = false, reactOn, onThread, more }: { roomId: string; m: RoomMessage; below?: boolean; reactOn: boolean; onThread?: () => void; more: MenuItem[] }) {
  const t = useT()
  const mine = new Set((m.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji))
  return (
    <div
      role="toolbar"
      aria-label={t('rooms.messageActions')}
      className={clsx(
        'absolute right-2 z-20 flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-md transition-opacity',
        // hidden (and not in the pointer's way) until the message is hovered, has the keyboard's focus, or a menu of it is open
        'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none',
        // computers only: phones and touch screens have the long-press sheet
        'max-md:hidden pointer-coarse:hidden',
        below ? '-bottom-5' : '-top-5',
      )}
      data-testid="message-hover-bar"
      data-below={below ? '' : undefined}
    >
      {reactOn &&
        QUICK_REACTIONS.map((e) => {
          const on = mine.has(e)
          const label = t(on ? 'rooms.reactRemove' : 'rooms.reactWith', { emoji: e })
          return (
            <Tooltip key={e} label={label}>
              <button type="button" aria-label={label} aria-pressed={on} onClick={() => void useRooms.getState().react(roomId, m.id, e, !on)} className={clsx(BTN, 'text-base leading-none', on && 'bg-accent-soft')} data-testid="hover-react" data-emoji={e}>
                <span aria-hidden>{e}</span>
              </button>
            </Tooltip>
          )
        })}
      {reactOn && <ReactionPicker roomId={roomId} m={m} buttonClassName={clsx(BTN, 'p-0')} below={below} />}
      {onThread && (
        <Tooltip label={t('rooms.replyInThread')}>
          <button type="button" aria-label={t('rooms.replyInThread')} onClick={onThread} className={BTN} data-testid="message-thread">
            <MessageSquareText size={16} aria-hidden />
          </button>
        </Tooltip>
      )}
      {more.length > 0 && <MenuButton label={t('common.more')} icon={<EllipsisVertical size={16} aria-hidden />} buttonClassName={clsx(BTN, 'p-0 max-sm:p-0')} testId="message-more" items={more} />}
    </div>
  )
}
