// The divider on a panel's left edge: drag it (or focus it and use the arrow keys) to resize the panel, double-click to
// reset. Used by the right-hand panel beside the chat (components/SidePanelFrame.tsx) and a thread beside its room
// (components/rooms/ThreadPanel.tsx), so both look and behave the same.
//
// It resizes its PARENT element, the panel: the panel is `relative` from md up, takes its width from the CSS variable
// `--panel-w` with its own default (`md:w-[var(--panel-w,<default>)]`) and its minimum (`md:min-w-[…]`). The column it
// shares the row with is the panel's previous sibling. Phones (< 768 px) get no divider (the panel is full screen there).
// While dragging the width is written straight to the variable once per animation frame: nothing in the panel or the
// column beside it re-renders because of it. Widths and limits: lib/panelWidth.ts.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import clsx from 'clsx'
import { clampPanel, fitPanel, keyWidth, panelLimits, readPanelFraction, settlePanel, writePanelFraction, type PanelSizing } from '../lib/panelWidth'

const DRAG_SLOP = 3

/** Call `fn` when `el` changes size. No ResizeObserver (an old browser, a test without a DOM): nothing is watched. */
function watch(el: Element, fn: () => void): ResizeObserver | undefined {
  if (typeof globalThis.ResizeObserver === 'undefined') return undefined
  const ro = new ResizeObserver(fn)
  ro.observe(el)
  return ro
}

/** `testId`, `overlayTestId`: the divider's test id and that of the cover laid over the panel while dragging. */
export function PanelDivider({ sizing, label, testId = 'panel-divider', overlayTestId = 'panel-drag-overlay' }: { sizing: PanelSizing; label: string; testId?: string; overlayTestId?: string }) {
  const handle = useRef<HTMLDivElement>(null)
  const [remembered] = useState(() => readPanelFraction(sizing))
  const fraction = useRef(remembered)
  const raf = useRef(0)
  const drag = useRef<{ x: number; moved: boolean; w: number | null } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [m, setM] = useState({ now: 0, min: sizing.min, max: sizing.min })

  const panel = useCallback(() => handle.current?.parentElement ?? null, [])
  /** The room the column beside the panel and the panel share: the column is the panel's previous sibling. */
  const avail = useCallback(() => {
    const box = panel()
    const other = box?.previousElementSibling as HTMLElement | null | undefined
    return (other?.offsetWidth ?? 0) + (box?.offsetWidth ?? 0)
  }, [panel])

  const measure = useCallback(() => {
    const box = panel()
    if (!box) return
    const { min, max } = panelLimits(avail(), sizing)
    setM((o) => (o.now === box.offsetWidth && o.min === min && o.max === max ? o : { now: box.offsetWidth, min, max }))
  }, [avail, panel, sizing])

  const apply = useCallback((px: number | null) => {
    const box = panel()
    if (!box) return
    if (px === null) box.style.removeProperty('--panel-w')
    else box.style.setProperty('--panel-w', `${px}px`)
  }, [panel])

  /** Set the width for good (null: back to the default) and remember it. */
  const commit = useCallback((px: number | null) => {
    const { width, fraction: f } = settlePanel(px, avail(), sizing)
    fraction.current = f
    writePanelFraction(f, sizing)
    apply(width)
    measure()
  }, [apply, avail, measure, sizing])

  // first paint with the remembered width, and again whenever the window or the row around the panel changes size
  // (a larger text size in Settings narrows the column without a window resize)
  const fit = useCallback(() => {
    if (drag.current) return
    const w = fitPanel(fraction.current, avail(), sizing)
    if (w !== null) apply(w)
    measure()
  }, [apply, avail, measure, sizing])
  useLayoutEffect(() => {
    fit()
    window.addEventListener('resize', fit)
    const row = panel()?.parentElement
    const ro = row ? watch(row, fit) : undefined
    return () => {
      window.removeEventListener('resize', fit)
      ro?.disconnect()
      cancelAnimationFrame(raf.current)
    }
  }, [fit, panel])
  useEffect(() => {
    const box = panel()
    const ro = box ? watch(box, measure) : undefined
    return () => ro?.disconnect()
  }, [measure, panel])

  const widthAt = (clientX: number) => clampPanel((panel()?.getBoundingClientRect().right ?? 0) - clientX, avail(), sizing)
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, moved: false, w: null }
    setDragging(true)
    e.preventDefault()
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // a click is not a drag: nothing changes until the pointer has gone 3 px
    if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_SLOP) return
    d.moved = true
    const x = e.clientX
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      d.w = widthAt(x)
      apply(d.w)
    })
  }
  /** End of a drag: pointerup commits where the pointer is; a cancel or lost capture keeps the last width shown (or
   * drops the inline width if none was applied yet). Without a real drag nothing is saved. Either way the DOM and the
   * saved width agree afterwards. */
  const endDrag = (up: PointerEvent<HTMLDivElement> | null) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    cancelAnimationFrame(raf.current)
    setDragging(false)
    if (!d.moved) return measure()
    const w = up ? widthAt(up.clientX) : d.w
    if (w === null) fit()
    else commit(w)
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    endDrag(e.type === 'pointerup' ? e : null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = keyWidth(e.key, e.shiftKey, panel()?.offsetWidth ?? m.now, m)
    if (next === null) return
    e.preventDefault()
    commit(next)
  }

  return (
    <>
      {/* a thin hit area on the panel's border line; the visible line stays the panel's own border */}
      <div
        ref={handle}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={m.now}
        aria-valuemin={m.min}
        aria-valuemax={m.max}
        tabIndex={0}
        data-testid={testId}
        data-dragging={dragging || undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onLostPointerCapture={() => endDrag(null)}
        onDoubleClick={() => commit(null)}
        onKeyDown={onKey}
        className={clsx(
          'absolute inset-y-0 -left-px z-30 hidden w-1.5 cursor-col-resize touch-none select-none md:block',
          'after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:transition-colors',
          'hover:after:bg-accent focus-visible:after:bg-accent data-[dragging]:after:bg-accent focus:outline-none',
        )}
      />
      {/* while dragging, what is in the panel (an iframe, a PDF) must not swallow the moves */}
      {dragging && <div className="absolute inset-0 z-20 cursor-col-resize" data-testid={overlayTestId} />}
    </>
  )
}
