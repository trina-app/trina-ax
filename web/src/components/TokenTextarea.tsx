// A plain <textarea> whose tokens stand out: any caller's ranges of the text with a kind (an @mention in a room's
// message box; a #room could be one too). The text area stays the browser's own for typing (Korean and Japanese IMEs,
// the phone keyboards and their autocorrect, spell check, undo); two layers draw the same text where it has it. While it
// has text, the text area's own letters are not drawn (index.css data-token-input). The layer under it draws the tokens'
// backgrounds, the one over it the letters with the tokens in colour; what the browser draws in between stays seen: the
// caret, a selection, an IME's background (it would hide the syllable being written if the letters were under it),
// spell check, the placeholder. While an IME writes, the text area paints its own letters (browsers draw an IME's
// underline in their colour) and the front layer only the tokens, on their background: the same pixels. The layers
// copy the text area's font, padding, border widths, wrapping and colour (again when the page's theme changes), its
// width without a scroll bar, and its scroll position.
//
// Tokens act as one piece: Backspace at a token's end or Delete at its start takes all of it (a phone keyboard's
// deletion too, which comes as an edit and not as a key), the arrow keys step over one, and a caret put inside one (a
// click, a tap) goes to its nearer edge. Replacing letters of a token through a selection breaks it: the caller's ranges
// follow every edit with lib/textTokens.ts shiftRanges(ranges, edit), which drops a token an edit touched. While an IME
// is writing, the box does nothing of its own (no caret moves, no deletions).
import clsx from 'clsx'
import { forwardRef, Fragment, useCallback, useImperativeHandle, useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent, type SyntheticEvent, type TextareaHTMLAttributes } from 'react'
import { applyEdit, findEdit, snapCaret, tokenEndingAt, tokenParts, tokenStartingAt, wholeTokenEdit, type Before, type TextEdit, type TextRange } from '../lib/textTokens'

export interface TextToken extends TextRange {
  /** what it is ('person', 'ai', 'room', …), for tokenClass */
  kind: string
}

export interface TokenTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange'> {
  /** with "\n" line breaks, as the text area gives them back (a "\r\n" would put every range after it out of step) */
  value: string
  /** the ranges to stand out and to keep whole (they may not overlap) */
  tokens: readonly TextToken[]
  /** the text changed (typing, a paste, an IME, a deletion) and where: move the ranges with shiftRanges(ranges, edit) */
  onTextChange: (value: string, edit: TextEdit) => void
  /** a token's look in the layer: colour, background, radius, box-shadow. Never a padding, border, margin, size or
   * weight: those move the letters away from where the text area has them */
  tokenClass: (token: TextToken) => string
  /** the outer box's classes (its place in a flex row, …); className is the text area's own. Its background must stay
   * transparent (a layer is under it): put a background on the outer box or around it */
  containerClassName?: string
}

/** what the layer takes over from the text area (what places the letters, and their colour) */
const COPIED = [
  'box-sizing', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'font-feature-settings', 'font-variation-settings',
  'font-kerning', 'font-optical-sizing', 'letter-spacing', 'word-spacing', 'line-height', 'text-transform', 'text-indent', 'text-align', 'direction', 'tab-size',
  'white-space', 'word-break', 'overflow-wrap', 'line-break', 'hyphens', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'color',
]

const composingKey = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229

export const TokenTextarea = forwardRef<HTMLTextAreaElement, TokenTextareaProps>(function TokenTextarea(
  { value, tokens, onTextChange, tokenClass, containerClassName, className, style, onKeyDown, onSelect, ...rest },
  ref,
) {
  const box = useRef<HTMLTextAreaElement>(null)
  /** the tokens' backgrounds (under the text area) and the letters (over it) */
  const back = useRef<HTMLDivElement>(null)
  const front = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => box.current!, [])
  /** the text and selection right before the change the next input event brings (from beforeinput) */
  const before = useRef<(Before & { value: string }) | null>(null)
  /** the last selection seen, for a browser without beforeinput */
  const sel = useRef<Before>({ start: value.length, end: value.length })
  /** an IME is writing; where its text began */
  const composing = useRef<number | null>(null)
  /** where the caret goes once the text that took a whole token is in the box */
  const caretNext = useRef<number | null>(null)
  /** the token a Backspace or Delete selected for the browser to delete */
  const armed = useRef<TextRange | null>(null)

  /** the layers: the text area's metrics, width without its scroll bar, and scroll position */
  const sync = useCallback(() => {
    const t = box.current
    if (!t) return
    const cs = getComputedStyle(t)
    const bar = t.offsetWidth - t.clientWidth - (parseFloat(cs.getPropertyValue('border-left-width')) || 0) - (parseFloat(cs.getPropertyValue('border-right-width')) || 0)
    const side = cs.getPropertyValue('direction') === 'rtl' ? 'padding-left' : 'padding-right'
    for (const l of [back.current, front.current]) {
      if (!l) continue
      for (const p of COPIED) l.style.setProperty(p, cs.getPropertyValue(p))
      l.style.setProperty('border-style', 'solid')
      l.style.setProperty('border-color', 'transparent')
      if (bar > 0) l.style.setProperty(side, `${(parseFloat(cs.getPropertyValue(side)) || 0) + bar}px`)
      l.style.setProperty('transform', `translate(${-(t.scrollLeft || 0)}px, ${-(t.scrollTop || 0)}px)`)
    }
  }, [])
  useLayoutEffect(sync)
  // (a layout effect: the first paint already has the scroll bar's width)
  useLayoutEffect(() => {
    const t = box.current
    if (!t) return
    const scrolled = () => {
      for (const l of [back.current, front.current]) l?.style.setProperty('transform', `translate(${-(t.scrollLeft || 0)}px, ${-(t.scrollTop || 0)}px)`)
    }
    const onBefore = (e: Event) => {
      before.current = { value: t.value, start: t.selectionStart ?? t.value.length, end: t.selectionEnd ?? t.value.length, inputType: (e as InputEvent).inputType }
    }
    // (the browser's own events: React's stand-ins for these differ between browsers). While an IME writes, the text
    // area paints its own letters (the IME's underline takes their colour) and the front layer only the tokens
    // (index.css data-composing)
    const started = () => {
      composing.current = Math.min(t.selectionStart ?? t.value.length, t.selectionEnd ?? t.value.length)
      t.parentElement?.setAttribute('data-composing', '')
    }
    const ended = () => {
      composing.current = null
      t.parentElement?.removeAttribute('data-composing')
    }
    t.addEventListener('scroll', scrolled, { passive: true })
    t.addEventListener('beforeinput', onBefore)
    t.addEventListener('compositionstart', started)
    t.addEventListener('compositionend', ended)
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    resized?.observe(t)
    // the letters' colour is copied: a theme switched on the page (a class or style on <html>) copies it again
    const themed = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sync)
    themed?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => {
      t.removeEventListener('scroll', scrolled)
      t.removeEventListener('beforeinput', onBefore)
      t.removeEventListener('compositionstart', started)
      t.removeEventListener('compositionend', ended)
      resized?.disconnect()
      themed?.disconnect()
    }
  }, [sync])
  useLayoutEffect(() => {
    const c = caretNext.current
    if (c === null) return
    caretNext.current = null
    const t = box.current
    if (t && document.activeElement === t && t.value.length >= c) t.setSelectionRange(c, c)
  })

  const change = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.currentTarget.value
    const b = before.current?.value === value ? before.current : { ...sel.current, value }
    before.current = null
    const s: Before = { start: b.start, end: b.end, inputType: b.inputType }
    const edit = findEdit(value, next, s)
    const a = armed.current
    armed.current = null
    // a deletion into a token from its edge takes the whole token; while an IME writes, only when it reached into the
    // text from before it began (a phone keyboard taking back the word before the caret), never the IME's own text. A
    // keyboard that answered the Backspace we turned into "delete this token" with a deletion of its own (one letter of
    // it, or the letter before it) still takes the token
    const fromKey = a && s.start === a.start && s.end === a.end && next.length < value.length && !(edit.from === a.start && edit.removed === a.end - a.start && edit.inserted === 0)
    const whole = fromKey ? { from: a.start, removed: a.end - a.start, inserted: 0 } : composing.current === null || edit.from < composing.current ? wholeTokenEdit(tokens, edit, s) : null
    if (whole) {
      caretNext.current = whole.from
      onTextChange(applyEdit(value, whole), whole)
    } else onTextChange(next, edit)
    const t = e.currentTarget
    sel.current = { start: t.selectionStart ?? next.length, end: t.selectionEnd ?? next.length }
  }

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented || composingKey(e)) return
    const t = e.currentTarget
    const s = t.selectionStart ?? 0
    if (s !== t.selectionEnd) return
    // the whole token selected: the browser's own deletion takes it (and its undo puts it back as text)
    armed.current = null
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey) {
      const tok = e.key === 'Backspace' ? tokenEndingAt(tokens, s) : tokenStartingAt(tokens, s)
      if (tok) {
        t.setSelectionRange(tok.start, tok.end)
        armed.current = tok
      }
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const rtl = getComputedStyle(t).getPropertyValue('direction') === 'rtl'
      const backward = (e.key === 'ArrowLeft') !== rtl
      const tok = backward ? tokenEndingAt(tokens, s) : tokenStartingAt(tokens, s)
      if (tok) {
        e.preventDefault()
        const to = backward ? tok.start : tok.end
        t.setSelectionRange(to, to)
      }
    }
    sel.current = { start: t.selectionStart ?? s, end: t.selectionEnd ?? s }
  }

  const select = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget
    const s = t.selectionStart ?? 0
    if (composing.current === null && s === t.selectionEnd) {
      const to = snapCaret(tokens, s)
      if (to !== s) t.setSelectionRange(to, to)
    }
    sel.current = { start: t.selectionStart ?? s, end: t.selectionEnd ?? s }
    onSelect?.(e)
  }

  const parts = tokenParts(value, tokens)
  /** one of the two layers: the same text, the tokens marked (index.css: the back one shows only the tokens' backgrounds,
   * the front one only the letters) */
  const layer = (side: 'back' | 'front') => (
    // (never translated or selected by the page: the text area's own text is the text)
    <div aria-hidden translate="no" className="pointer-events-none absolute inset-0 overflow-hidden select-none" data-token-layer={side}>
      <div ref={side === 'back' ? back : front} data-testid={side === 'front' ? 'token-layer' : undefined}>
        {parts.map((p, i) =>
          p.token ? (
            <span key={i} className={tokenClass(p.token)} data-token={p.token.kind}>
              {p.text}
            </span>
          ) : (
            <Fragment key={i}>{p.text}</Fragment>
          ),
        )}
        {/* a text that ends with a new line has an empty last line in the text area: this keeps it in the layer */}
        {'\u200b'}
      </div>
    </div>
  )

  return (
    <div className={clsx('relative', containerClassName)} data-token-box="">
      {layer('back')}
      <textarea
        ref={box}
        {...rest}
        value={value}
        onChange={change}
        onKeyDown={keyDown}
        onSelect={select}
        data-token-input=""
        className={clsx('relative block w-full', className)}
        style={{ ...style, backgroundColor: 'transparent' }}
      />
      {layer('front')}
    </div>
  )
})
