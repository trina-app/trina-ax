// The text field of every message box (components/composer/ComposerShell.tsx): one font (the reading size), one height
// (it grows with its text, and with a long placeholder, to the shell's FIELD_MAX on a computer and the TC-252 share of
// the screen on a phone), one key order:
//   1. the box's own lists (`keys`: "/" skills, "#" rooms, "@" people; a room's "@전체" question and its edit);
//   2. voice input (Space held to talk, Esc throws a recording away: lib/useVoiceInput.ts);
//   3. Esc stops the running answer where the box has Stop (keys.ts escStops), except while a menu, a list or a dialog
//      is open anywhere (the + menu, the AI picker, the attach sheet) and in a box inside a dialog (the file viewer's
//      column: Esc is the viewer's). It is taken (preventDefault and stopPropagation), so the room page's and a
//      thread's own Esc, which skip a taken key, do not also close a panel; the next Esc does;
//   4. Enter sends with a keyboard; Shift+Enter, a word still composed by an input method and a touch screen's Return
//      make a new line (keys.ts enterSends).
// A plain <textarea>, or with `tokens` the room's mention field (TokenTextarea: "@" names stand out); `overlay` is drawn
// behind the text (the AI chat's "#" room tokens, chat/RoomRefMenu.tsx TokenLayer).
import clsx from 'clsx'
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { fitHeight } from '../../lib/autoGrow'
import { usePanelExpanded } from '../../lib/sidePanel'
import { useTextSize } from '../../lib/textSize'
import type { VoiceInputState } from '../../lib/useVoiceInput'
import { TokenTextarea, type TokenTextareaProps } from '../TokenTextarea'
import { enterSends, escStops } from './keys'
import { FIELD_MAX, fieldPad, phoneFieldMax, useShell } from './ComposerShell'

/** Esc is another thing's while a menu, a list or a dialog is open, or when the box is inside a dialog (as
 * lib/useVoiceInput.ts and the app frame ask) */
const POPUP = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-haspopup][aria-expanded="true"]'
const escIsElsewhere = (el: Element) => !!el.closest('[role="dialog"],[role="alertdialog"]') || !!document.querySelector(POPUP)

type TokenProps = Pick<TokenTextareaProps, 'tokens' | 'onTextChange' | 'tokenClass'> & Omit<Partial<TextareaHTMLAttributes<HTMLTextAreaElement>>, 'value' | 'defaultValue' | 'onChange'>

export interface ComposerFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string
  /** a plain field's change */
  onText?: (value: string) => void
  /** the mention field's props (rooms/useMentionMenu.tsx inputProps) */
  tokens?: TokenProps
  /** the box's own keys first: true when one took the key */
  keys?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  voice?: VoiceInputState
  onSend: () => void
  /** behind the text (its padding must be the field's: `pad`) */
  overlay?: ReactNode
  /** the text's padding where it is not the shell's (fieldPad) */
  pad?: string
  /** measured again when these change (beside the text, the placeholder, the text size) */
  grow?: unknown[]
}

export const ComposerField = forwardRef<HTMLTextAreaElement, ComposerFieldProps>(function ComposerField(
  { value, onText, tokens, keys, voice, onSend, overlay, pad, grow = [], className, placeholder, onKeyDown, ...rest },
  ref,
) {
  const shell = useShell()
  const ta = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => ta.current!, [])
  // the field grows with its text, and with a long placeholder (an empty field measures its placeholder), and again
  // when the person's text size changes. Behind a big side panel (lib/sidePanel.ts) it is not drawn and measures 0: it
  // keeps its height, and is measured again when the page shows
  const textSize = useTextSize()
  const behindPanel = usePanelExpanded()
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    fitHeight(el)
    // the text that stands in its place while recording starts at this height
    if (el.offsetHeight) shell.heldHeight.current = el.offsetHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, placeholder, textSize, behindPanel, shell.line, ...grow])

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    if (keys?.(e)) return
    if (voice?.onKeyDown(e)) return
    if (shell.stop && escStops(e) && !escIsElsewhere(e.currentTarget)) {
      e.preventDefault()
      e.stopPropagation()
      shell.stop()
      return
    }
    if (enterSends(e)) {
      e.preventDefault()
      onSend()
    }
  }
  const cls = clsx(
    'relative block w-full min-w-0 resize-none bg-transparent text-reading leading-reading text-ink outline-none placeholder:text-faint',
    FIELD_MAX,
    phoneFieldMax(shell.files),
    pad ?? fieldPad(shell.line),
    className,
  )
  return (
    <div className="relative min-w-0 flex-1">
      {overlay}
      {tokens ? (
        <TokenTextarea ref={ta} rows={1} value={value} placeholder={placeholder} {...rest} {...tokens} onKeyDown={keyDown} className={cls} />
      ) : (
        <textarea ref={ta} rows={1} value={value} placeholder={placeholder} {...rest} onChange={(e) => onText?.(e.target.value)} onKeyDown={keyDown} className={cls} />
      )}
    </div>
  )
})
