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

/** Near the bottom: a list this close to its end follows it. */
export const NEAR_BOTTOM_PX = 80

/** After a scroll event: does the list follow its newest message now? Near the bottom it does. Further up it stops only
 * when the reader moved up (`scrollTop` below `lastTop`, where the last scroll event left it): the event of the list's
 * own jump to the bottom comes a frame later, and what was added meanwhile (a room card that came right after the step
 * before it) would read as the reader having scrolled up, so the room stopped following and the card stayed below the
 * message box with only its first line in sight. A scroll at the same place or further down keeps what it was. */
export function followsAfterScroll(el: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>, was: boolean, lastTop: number): boolean {
  if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) return true
  return el.scrollTop < lastTop - 1 ? false : was
}
