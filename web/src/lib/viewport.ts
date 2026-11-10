// Phones: keep the composer above the on-screen keyboard. iOS Safari does not resize the layout viewport when the
// keyboard opens (interactive-widget=resizes-content only works in Chromium), so the app height follows
// visualViewport through the --app-h variable (tab 5 PWA: 입력창은 visualViewport로 키보드 위에 붙인다).
// Fixed layers (a dialog's sheet, a message's menu sheet) are placed against the layout viewport, which in iOS Safari
// keeps running under the keyboard: --kb-inset is how much of it the keyboard covers (0 where the layout viewport
// shrinks: Android, the iPhone app's WebView), and a phone's sheet ends there (components/ui.tsx Modal,
// components/rooms/MenuButton.tsx).
export function followVisualViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  // the on-screen keyboard: the visible height (zoom undone) well below the tallest seen at this width. iOS keeps the
  // layout height and shrinks the visual one; Android resizes both. Then nothing sits under the home indicator
  // (index.css: --safe-bottom is 0 while .keyboard-open).
  let tallest = 0, width = 0
  const apply = () => {
    if (window.innerWidth !== width) { width = window.innerWidth; tallest = 0 }
    tallest = Math.max(tallest, window.innerHeight, vv.height * vv.scale)
    const keyboard = tallest - vv.height * vv.scale > 150
    root.classList.toggle('keyboard-open', keyboard)
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`)
    root.style.setProperty('--kb-inset', `${keyboard ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0}px`)
    // iOS scrolls the page up when focusing a field near the bottom; keep the app pinned to the top
    if (vv.offsetTop > 0 && window.scrollY !== 0) window.scrollTo(0, 0)
  }
  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  apply()
}

/** A field that brings up a phone's keyboard while it has the focus (not a button, a checkbox or a slider). */
export function isTextField(el: Element | null): el is HTMLElement {
  if (!el) return false
  if ((el as HTMLElement).isContentEditable || el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(((el as HTMLInputElement).type || 'text').toLowerCase())
}

/** Before a sheet opens over the page on a phone (a message's long press or ⋯): the text field gives up the focus, so
 * the keyboard goes down and the sheet is in sight. Its text stays; nothing gives the focus back by itself, so the
 * keyboard does not come back until the person taps the field. */
export function dismissKeyboard() {
  const el = typeof document === 'undefined' ? null : document.activeElement
  if (isTextField(el)) el.blur?.()
}

