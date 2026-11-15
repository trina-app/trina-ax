// A text field as tall as its text: the message boxes and the inline edit fields grow line by line, up to their CSS
// max-height (then they scroll inside), so no line is ever cut off under what follows the field.
import { useLayoutEffect, type DependencyList, type RefObject } from 'react'

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
