// The focus ring is for the keyboard only (as in Slack or Notion): after a mouse click or a tap it never shows, after
// Tab (or another key that moves around the page) it does.
//
// The browser's own :focus-visible is not enough. Chrome turns it on for the element a click focused as soon as any key
// is pressed, even Shift or ⌘ alone (⌘⇧4 for a screenshot, ⌘Tab to another app), and keeps it when that element is
// clicked again; focus a script moves (a menu or dialog giving focus back to its button) can get it too. So the page
// remembers how the person last moved around, on <html data-input>:
//   - "pointer": a mouse, pen or finger was pressed last;
//   - "keyboard": a key that moves around the page (Tab, arrows, Enter, Space, Escape, Home/End, Page Up/Down) was
//     pressed last. In a text field only Tab and Escape count: there the others type, move the caret or send.
//     Keys held with ⌘, Ctrl or Alt are shortcuts, and Shift, ⌘, Ctrl, Alt or Caps Lock alone change nothing.
// index.css draws the ring (its base :focus-visible rule and the focus-visible: variant every component uses) only
// when <html> is not "pointer". Before the first press neither is set, and the browser decides as before.
//
// Both listeners are on window in the capture phase, so a handler that stops a key or a press does not hide it.

export type InputModality = 'pointer' | 'keyboard'

const MOVES = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Home', 'End', 'PageUp', 'PageDown', 'F6'])
const IN_FIELD = new Set(['Tab', 'Escape', 'F6'])

/** whether the key moves around the page (so the ring should show), for a key pressed on `target` */
export function keyMovesFocus(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>, target: EventTarget | null): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  if (!MOVES.has(e.key)) return false
  return typedIn(target) ? IN_FIELD.has(e.key) : true
}

function typedIn(t: EventTarget | null): boolean {
  const el = t as (HTMLElement & { type?: string }) | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes((el.type ?? 'text').toLowerCase())
}

/** Starts following the last kind of input on `win`'s <html> (once, from main.tsx). Returns the undo (tests). */
export function followInputModality(win: Pick<Window, 'addEventListener' | 'removeEventListener' | 'document'> = window): () => void {
  const root = win.document.documentElement
  const set = (m: InputModality) => {
    if (root.dataset.input !== m) root.dataset.input = m
  }
  const onPointer = () => set('pointer')
  const onKey = (e: KeyboardEvent) => {
    if (keyMovesFocus(e, e.target)) set('keyboard')
  }
  win.addEventListener('pointerdown', onPointer, true)
  win.addEventListener('keydown', onKey, true)
  return () => {
    win.removeEventListener('pointerdown', onPointer, true)
    win.removeEventListener('keydown', onKey, true)
  }
}
