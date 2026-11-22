// One drawing of a Word or PowerPoint preview (components/viewers/OfficeView.tsx useRender): each drawing gets an
// element of its own inside the preview's box, and a signal that says it is no longer wanted.
//
// Why: the PowerPoint viewer adds its slides in batches of 4, and its destroy() empties the element it drew into. When a
// preview drew again while the last drawing was still on its way (the panel width settling, the bytes read again), both
// drew into one element: the old viewer was destroyed when its open() finished, after the new one had added a batch or
// two, and that emptied the shared element. Only the new viewer's later batches stayed, so the deck began at slide 5 or
// 9 (owner, 2026-11-22). With a host per drawing, a late drawing can only add to or empty its own host, which is no
// longer in the box.

/** What a drawing may hand back: undone when the preview draws again or closes. */
export type Undo = void | (() => void)

/** The preview's box: the DOM calls a drawing's start needs (a plain element; tests pass a small stand-in). */
export interface DrawBox<H> {
  textContent: string | null
  appendChild(node: H): unknown
}

export interface DrawHandlers {
  /** the drawing failed (not called after it was stopped) */
  error(message: string): void
  /** the drawing ended, drawn or failed (not called after it was stopped) */
  done(): void
}

/** Starts one drawing in `box`: what was there is removed, a new host from `makeHost` is put in, and `render` draws in
 * it. Returns `stop`: the drawing's undo runs (at once, or when a late drawing finishes), its signal is aborted, and
 * nothing it does afterwards reaches `box` or the handlers. */
export function startDraw<H>(box: DrawBox<H>, makeHost: () => H, render: (host: H, signal: AbortSignal) => Promise<Undo>, on: DrawHandlers): () => void {
  const host = makeHost()
  box.textContent = ''
  box.appendChild(host)
  const ctrl = new AbortController()
  let live = true
  let undo: (() => void) | undefined
  render(host, ctrl.signal)
    .then((u) => {
      if (typeof u !== 'function') return
      if (live) undo = u
      else u()
    })
    .catch((e: unknown) => {
      if (live) on.error(e instanceof Error ? e.message : String(e))
    })
    .finally(() => {
      if (live) on.done()
    })
  return () => {
    live = false
    ctrl.abort()
    undo?.()
    undo = undefined
  }
}
