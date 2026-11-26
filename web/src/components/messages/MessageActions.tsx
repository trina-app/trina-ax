// A message's actions, one place for every surface (docs/decisions/20261126-shared-message-actions.md): the AI chat (my
// question, an answer), a room's Trina side chat, a room's timeline and thread, and a shared chat's thread (its answer on
// top and the replies). A surface says which actions a message has (`MessageAction[]`, in its order); this file draws
// them, always with the same icon for the same action (`ACTION_ICON`), the same words and the same feedback:
// - **A touch screen:** a long press on the message (`useMessagePress`) opens one sheet (`MessageActionSheet`; a phone's
//   bottom sheet with 48 px rows, a menu by the message on a tablet: components/rooms/MenuButton.tsx). A room's message
//   has its reactions on top of it. Nothing shows on a tap.
// - **A computer:** `MessageActions`, in one of two layouts: `float` (a room's or a thread's message: a small bar over the
//   message's top edge while the pointer or the keyboard is on it, like Slack's: the room's quick reactions, the
//   actions that open something (thread, Ask Trina) as icons, the rest under ⋮) and `row` (the AI chat: a row of icon
//   buttons under the message, like Claude's).
// - **Copy:** one behaviour (`useActionItems`, `ActionButtons`). A button that stays in sight turns into ✓ and says
//   "복사했어요" for a moment; from a sheet or a ⋮ menu (gone once picked) the same words come as a toast. Link copies say
//   their own words ("링크를 복사했어요"). An AI answer copies its formatting too.
import clsx from 'clsx'
import { BookmarkPlus, Copy, EllipsisVertical, Link2, MessageSquareShare, MessageSquareText, Pencil, RotateCcw, TextSelection, ThumbsDown, Trash2, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { RoomMessage } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { Tooltip } from '../Tooltip'
import { CopyButton, IconButton, useCopy } from '../ui'
import { AiMark } from '../rooms/AiFace'
import { MenuButton, useLongPress, type MenuItem } from '../rooms/MenuButton'
import { ReactionPicker } from '../rooms/Reactions'

/** Every action a message can have, wherever it shows. */
export type ActionId = 'copy' | 'copyLink' | 'selectText' | 'edit' | 'thread' | 'askTrina' | 'sendToChat' | 'regenerate' | 'suggestSkill' | 'removePreview' | 'report' | 'delete'

/** One icon per action, on every surface (Ask Trina is the AI's mark, AiMark) */
export const ACTION_ICON: Record<Exclude<ActionId, 'askTrina'>, LucideIcon> = {
  copy: Copy,
  copyLink: Link2,
  selectText: TextSelection,
  edit: Pencil,
  thread: MessageSquareText,
  sendToChat: MessageSquareShare,
  regenerate: RotateCcw,
  suggestSkill: BookmarkPlus,
  removePreview: X,
  report: ThumbsDown,
  delete: Trash2,
}

/** An action's icon: 14 px in a sheet or menu row, 13 px in the AI chat's row, 16 px on the hover bar */
export function ActionIcon({ id, size }: { id: ActionId; size: number }) {
  if (id === 'askTrina') return <AiMark place={size >= 16 ? 'bar' : 'menu'} />
  const Icon = ACTION_ICON[id]
  return <Icon size={size} aria-hidden />
}

/** What a copy puts on the clipboard, read at the moment of the copy. `html`: the formatting too (an AI answer);
 * `done`: the toast's words from a sheet or a menu (default "복사했어요"; a link: "링크를 복사했어요") */
export interface CopySource {
  text: () => string
  html?: () => string
  done?: string
}

/** One action of one message. A copy (`copy`) is copied here with the shared feedback; any other action runs `run`. */
export type MessageAction = {
  id: ActionId
  label: string
  /** test ids: `testId` on its button (the AI chat's row, the hover bar's icon), `menuTestId` on its row in the sheet or
   * the ⋮ menu (both can be on the page at once: the row stays, hidden from sight, while the sheet is open) */
  testId?: string
  menuTestId?: string
  danger?: boolean
  disabled?: boolean
} & ({ run: () => void; copy?: never } | { copy: CopySource; run?: never })

/** The actions as rows of a sheet or a ⋮ menu: the shared icon, and a copy's toast. */
export function useActionItems(actions: readonly MessageAction[]): MenuItem[] {
  const t = useT()
  const { copy } = useCopy()
  return actions.map((a) => ({
    label: a.label,
    icon: <ActionIcon id={a.id} size={14} />,
    danger: a.danger,
    disabled: a.disabled,
    testId: a.menuTestId,
    onSelect: a.copy
      ? () => {
          const src = a.copy!
          let html: string | undefined
          // a failure to format still copies the text
          try { html = src.html?.() } catch { html = undefined }
          void copy(src.text(), html).then((ok) => ok && toast({ level: 'success', text: src.done ?? t('messages.copied') }), () => {})
        }
      : a.run!,
  }))
}

/** A finger held on these is no long press of the message: a text box, a control of its own (a button, a link, an ask
 * or connect card's box), a dialog or menu over it, or a part with its own long-press menu (`data-own-menu`). */
export const PRESS_SKIP = 'textarea, input, select, button, a, [role="dialog"], [role="menu"], [data-testid="ask-card"], [data-testid="connect-card"], [data-own-menu]'
/** A room's message: its words' links and mentions keep the message's long press (their click is guarded:
 * rooms/MessageText.tsx), only a part with its own menu (a file chip, a picture) is skipped */
export const ROOM_PRESS_SKIP = '[data-own-menu]'

/** A message's long press on a touch screen (a finger, not a mouse; any width): spread `bind` on the message's box (it
 * holds the box's ref), its classes `box` on it, and give `signal` to its MessageActionSheet. `on` false: nothing (a
 * message being sent, edited, deleted, hidden). `pressedAt`: when the sheet opened (a strip's pick right after is the
 * finger lifting). `selectText`: the sheet's "Select text" (an AI chat's messages): the long press steps aside and the
 * phone's own selection works on the message, until a touch outside it. */
export function useMessagePress(on: boolean, skip: string = PRESS_SKIP) {
  const [signal, setSignal] = useState(0)
  const [selecting, setSelecting] = useState(false)
  const pressedAt = useRef(0)
  const el = useRef<HTMLElement | null>(null)
  const long = useLongPress(() => {
    pressedAt.current = Date.now()
    setSignal((n) => n + 1)
  })
  useEffect(() => {
    if (!selecting) return
    const out = (e: Event) => !el.current?.contains(e.target as Node) && setSelecting(false)
    document.addEventListener('pointerdown', out)
    return () => document.removeEventListener('pointerdown', out)
  }, [selecting])
  const ref = (node: HTMLElement | null) => { el.current = node }
  const bind = on && !selecting
    ? {
        ref,
        ...long,
        onPointerDown: (e: PointerEvent) => {
          if ((e.target as Element).closest?.(skip)) return
          long.onPointerDown(e)
        },
      }
    : { ref }
  return { signal, pressedAt, bind, selecting, selectText: () => setSelecting(true), box: on && !selecting ? PRESS_BOX : 'relative' }
}

/** The message box's classes while it has a long press: the phone's own text selection and callout stay away */
export const PRESS_BOX = 'relative pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]'

/** The one sheet a long press opens (a hidden "…" at the message's top right that `signal` opens). `title`: what it is
 * about, on a phone (the model that answered); `header`: above the rows on a touch screen (a room's reactions). */
export function MessageActionSheet({ signal, actions, title, header, testId = 'message-menu' }: { signal: number; actions: readonly MessageAction[]; title?: string; header?: (close: () => void) => ReactNode; testId?: string }) {
  const t = useT()
  const items = useActionItems(actions)
  if (!items.length && !header) return null
  return <MenuButton label={t('rooms.messageMenu')} className="absolute top-0 right-0" buttonClassName="hidden!" testId={testId} openSignal={signal} items={items} sheetTitle={title} header={header} />
}

/** the hover bar's buttons */
const BAR_BTN = 'inline-flex size-7 items-center justify-center rounded-md text-faint transition hover:bg-hover hover:text-ink'
/** The quick reactions on the hover bar, in its order. */
export const QUICK_REACTIONS: readonly string[] = ['✅', '👀', '👍']
/** on the hover bar as icons of their own (they open something); the rest go under ⋮ */
const BAR_ICONS: ReadonlySet<ActionId> = new Set(['thread', 'askTrina'])

/** A computer's actions of a message. `float`: the hover bar (`react`: the room message that takes reactions here;
 * `below`: the first message of a list, whose bar hangs under its bottom edge). `row`: icon buttons in a line, in the
 * given order (`className` on the line; `testId` for it). */
export function MessageActions(props: { layout: 'float'; actions: readonly MessageAction[]; react?: { roomId: string; m: RoomMessage } | null; below?: boolean } | { layout: 'row'; actions: readonly MessageAction[]; className?: string; testId?: string; children?: ReactNode }) {
  if (props.layout === 'row') return <ActionRow {...props} />
  return <ActionBar {...props} />
}

/** The AI chat's row: each action an icon button with its name as a tooltip; a copy turns into ✓ */
function ActionRow({ actions, className, testId, children }: { actions: readonly MessageAction[]; className?: string; testId?: string; children?: ReactNode }) {
  const t = useT()
  return (
    <span className={className} data-testid={testId}>
      {actions.map((a) =>
        a.copy ? (
          <CopyButton key={a.id} text={a.copy.text} html={a.copy.html} label={a.label} copiedLabel={t('messages.copied')} className="touch-hit" testId={a.testId} />
        ) : (
          <IconButton key={`${a.id}:${a.label}`} label={a.label} danger={a.danger} disabled={a.disabled} onClick={a.run} className="touch-hit" data-testid={a.testId} data-action={a.id}>
            <ActionIcon id={a.id} size={13} />
          </IconButton>
        ),
      )}
      {children}
    </span>
  )
}

/** The hover bar (Slack's): a small panel over the top-right edge of the message the mouse is on (or that has the
 * keyboard's focus): ✅ 👀 👍 (one click puts mine on or takes it off) and 반응 추가 where the room takes reactions, the
 * icons that open something (스레드에서 답장, 트리나에게 묻기), then ⋮ 더 보기 with the rest. It floats: nothing moves when
 * it shows; it sits over the message's top edge, never over its words (a link at a line's end stays clickable), and
 * under the first message of a list so the header above does not cut it. Never on phones or touch screens (they have
 * the long-press sheet). */
function ActionBar({ actions, react = null, below = false }: { actions: readonly MessageAction[]; react?: { roomId: string; m: RoomMessage } | null; below?: boolean }) {
  const t = useT()
  const icons = actions.filter((a) => BAR_ICONS.has(a.id) && a.run)
  const more = useActionItems(actions.filter((a) => !icons.includes(a)))
  const mine = new Set((react?.m.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji))
  return (
    <div
      role="toolbar"
      aria-label={t('rooms.messageActions')}
      className={clsx(
        'absolute right-2 flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-md transition-opacity',
        // hidden (and not in the pointer's way) until the message is hovered, has the keyboard's focus (not a click's: a
        // clicked button keeps the focus after the mouse has gone), or a menu of it is open
        'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none',
        // computers only: phones and touch screens have the long-press sheet
        'max-md:hidden pointer-coarse:hidden',
        // over the message's edge, not its words: the bar ends inside its 2 px padding, so a link at the end of the first
        // (or, below, the last) line stays under the pointer
        // the first message's bar hangs where the next message's own bar shows (over that message's top edge): it lies
        // above that one, so while it shows (the keyboard's focus, a menu open) nothing of the next message takes it
        below ? 'top-[calc(100%-2px)] z-30' : 'bottom-[calc(100%-2px)] z-20',
      )}
      data-testid="message-hover-bar"
      data-below={below ? '' : undefined}
    >
      {react &&
        QUICK_REACTIONS.map((e) => {
          const on = mine.has(e)
          const label = t(on ? 'rooms.reactRemove' : 'rooms.reactWith', { emoji: e })
          return (
            <Tooltip key={e} label={label}>
              <button type="button" aria-label={label} aria-pressed={on} onClick={() => void useRooms.getState().react(react.roomId, react.m.id, e, !on)} className={clsx(BAR_BTN, 'text-base leading-none', on && 'bg-accent-soft')} data-testid="hover-react" data-emoji={e}>
                <span aria-hidden>{e}</span>
              </button>
            </Tooltip>
          )
        })}
      {react && <ReactionPicker roomId={react.roomId} m={react.m} buttonClassName={BAR_BTN} below={below} />}
      {icons.map((a) => (
        <Tooltip key={a.id} label={a.label}>
          <button type="button" aria-label={a.label} onClick={a.run} className={BAR_BTN} data-testid={a.testId} data-action={a.id}>
            <ActionIcon id={a.id} size={16} />
          </button>
        </Tooltip>
      ))}
      {/* flex: no line box around the button (with a taller system font, Linux's, one would make the bar 1 px taller) */}
      {more.length > 0 && <MenuButton label={t('common.more')} icon={<EllipsisVertical size={16} aria-hidden />} className="flex" buttonClassName={clsx(BAR_BTN, 'max-sm:p-0')} testId="message-more" items={more} />}
    </div>
  )
}
