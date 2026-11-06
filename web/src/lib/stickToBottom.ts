// A message list that stays at its newest message while the reader is there (pages/Room.tsx, pages/Chat.tsx). The
// list's own effects follow new messages; this follows sizes: the content growing after the text arrived (a picture,
// a diagram, code highlighting) and the list itself getting shorter. On a phone the page uses
// interactive-widget=resizes-content (index.html), so opening the keyboard shrinks the list from below with its
// scroll position unchanged and no scroll event: without this the newest messages end up behind the message box.

/** Watch both; when either changes size and `atBottom()` (the reader was at the bottom), scroll to the bottom again.
 * Returns the cleanup. No ResizeObserver (an old browser, a test without a DOM): nothing is watched. */
export function stickToBottom(scroller: HTMLElement, content: HTMLElement, atBottom: () => boolean, RO: typeof ResizeObserver | undefined = globalThis.ResizeObserver): () => void {
  if (typeof RO === 'undefined') return () => {}
  const ro = new RO(() => {
    if (atBottom()) scroller.scrollTop = scroller.scrollHeight
  })
  ro.observe(content)
  ro.observe(scroller)
  return () => ro.disconnect()
}
