// A text field as tall as its text: the message boxes and the inline edit fields grow line by line, up to their CSS
// max-height (then they scroll inside), so no line is ever cut off under what follows the field. The text that stands
// in a message box's place while recording (VoiceBar.tsx VoiceHeld) grows the same way (fitLastLines).
import { useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react'

/** Sets the field's height to its text's (its borders too: the fields are border-box), at most `max` px. A field that
 * is not drawn (behind a big side panel) measures 0 and keeps its height. */
export function fitHeight(ta: HTMLTextAreaElement, max = Infinity) {
  const was = ta.style.height
  ta.style.height = 'auto'
  if (!ta.scrollHeight) return void (ta.style.height = was)
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(ta) : null
  const borders = cs ? (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) : 0
  ta.style.height = Math.min(ta.scrollHeight + borders, max) + 'px'
}

/** fitHeight whenever `deps` change (the text, the text size, …) */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, deps: DependencyList, max?: number) {
  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current, max)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** A text that stands in a field's place (a message box's text while recording: VoiceBar.tsx VoiceHeld) is as tall as
 * its text, at most its CSS max-height, as the field is (fitHeight). Taller text shows its last whole lines: the box is
 * as tall as the lines that fit (with its padding), scrolled to the end, and the top padding shows no part of the line
 * above them, so the newest words are at the bottom and no line is cut in half at the top edge. */
export function fitLastLines(el: HTMLElement) {
  el.style.height = ''
  el.style.clipPath = ''
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const lh = cs ? parseFloat(cs.lineHeight) : NaN
  if (cs && lh > 0 && el.scrollHeight > el.clientHeight + 1) {
    const pt = parseFloat(cs.paddingTop) || 0
    const pb = parseFloat(cs.paddingBottom) || 0
    const lines = Math.max(1, Math.floor((el.clientHeight - pt - pb + 0.5) / lh))
    el.style.height = lines * lh + pt + pb + 'px'
    if (pt) el.style.clipPath = `inset(${pt}px 0 0 0)`
  }
  el.scrollTop = el.scrollHeight
}

/** After a recording the field is back where its text stood (VoiceHeld, which showed the newest words): it shows the
 * end of its text too, the words that came last, once they are all in (`busy`: the last piece is on its way). */
export function useEndAfterRecording(ref: RefObject<HTMLTextAreaElement | null>, recording: boolean, busy: boolean, text: string) {
  const pending = useRef(false)
  useLayoutEffect(() => {
    if (recording) return void (pending.current = true)
    if (!pending.current) return
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
    if (!busy) pending.current = false
  }, [ref, recording, busy, text])
}
