// The keys of every message box (components/composer/ComposerShell.tsx), in one place so no box drifts again:
// - Enter sends with a keyboard. Shift+Enter, a word an input method is still composing (Korean, Japanese: isComposing
//   or keyCode 229) and a touch screen's Return make a new line; there the round button sends (docs/DECISIONS.md "Home
//   on phones": "Enter makes a new line there").
// - Esc stops the answer that is running, in a box that has Stop (docs/decisions/20261126-composer-shell.md): never while
//   an input method composes (Esc there cancels the composition). The box's menus and a recording take their Esc first
//   (the field asks them before this), and the event goes no further, so a panel around the box does not also close.
import type { KeyboardEvent } from 'react'

/** a word is still being composed by an input method: Enter and Esc are the input method's */
export const composing = (e: KeyboardEvent): boolean => e.nativeEvent.isComposing || e.keyCode === 229

/** a touch screen (phones, tablets): Return makes a new line */
export const touchScreen = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

/** this Enter sends (the caller then calls preventDefault): a plain Enter on a keyboard, nothing being composed */
export function enterSends(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.shiftKey || composing(e)) return false
  return !touchScreen()
}

/** this Esc stops the running answer */
export function escStops(e: KeyboardEvent): boolean {
  return e.key === 'Escape' && !composing(e) && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
}
