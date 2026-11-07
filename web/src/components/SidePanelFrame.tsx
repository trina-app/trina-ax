// The box of the right-hand panel and the divider between it and the chat: drag it (or use the arrow keys) to resize,
// double-click to reset. Phones (< 768 px) get the full-screen sheet and no divider. While dragging the width is written
// straight to a CSS variable once per animation frame: nothing in the chat or the preview re-renders because of it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { useT } from '../i18n'
import { clampPanel, panelLimits, PANEL_BIG_STEP, PANEL_STEP, readPanelFraction, writePanelFraction } from '../lib/panelWidth'

export default function SidePanelFrame({ children }: { children: ReactNode }) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const fraction = useRef<number | null>(readPanelFraction())
  const raf = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [m, setM] = useState({ now: 0, min: 320, max: 320 })

  /** The room the chat column and the panel share: the chat is the box's previous sibling. */
  const avail = useCallback(() => {
    const chat = box.current?.previousElementSibling as HTMLElement | null
    return (chat?.offsetWidth ?? 0) + (box.current?.offsetWidth ?? 0)
  }, [])

  const measure = useCallback(() => {
    const el = box.current
    if (!el) return
    const { min, max } = panelLimits(avail())
    setM((o) => (o.now === el.offsetWidth && o.min === min && o.max === max ? o : { now: el.offsetWidth, min, max }))
  }, [avail])

  const apply = useCallback((px: number | null) => {
    const el = box.current
    if (!el) return
    if (px === null) el.style.removeProperty('--panel-w')
    else el.style.setProperty('--panel-w', `${px}px`)
  }, [])

  /** Set the width for good (null: back to the default) and remember it. */
  const commit = useCallback((px: number | null) => {
    const a = avail()
    const w = px === null ? null : clampPanel(px, a)
    fraction.current = w === null || !a ? null : w / a
    writePanelFraction(fraction.current)
    apply(w)
    measure()
  }, [apply, avail, measure])

  // first paint with the remembered width, and again whenever the window changes size
  useLayoutEffect(() => {
    const fit = () => {
      if (fraction.current !== null) apply(clampPanel(fraction.current * avail(), avail()))
      measure()
    }
    fit()
    window.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('resize', fit)
      cancelAnimationFrame(raf.current)
    }
  }, [apply, avail, measure])
  useEffect(() => {
    const ro = new ResizeObserver(measure)
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [measure])

  const widthAt = (clientX: number) => clampPanel((box.current?.getBoundingClientRect().right ?? 0) - clientX, avail())
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    e.preventDefault()
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const x = e.clientX
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => apply(widthAt(x)))
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    cancelAnimationFrame(raf.current)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    if (e.type === 'pointerup') commit(widthAt(e.clientX))
    else measure()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? PANEL_BIG_STEP : PANEL_STEP
    const cur = box.current?.offsetWidth ?? m.now
    let next: number | null = null
    // the panel is on the right: the divider going left makes it wider
    if (e.key === 'ArrowLeft') next = cur + step
    else if (e.key === 'ArrowRight') next = cur - step
    else if (e.key === 'Home') next = m.min
    else if (e.key === 'End') next = m.max
    if (next === null) return
    e.preventDefault()
    commit(next)
  }

  return (
    <div
      ref={box}
      data-testid="side-panel"
      className={clsx(
        'min-w-0 border-line md:relative bg-surface md:border-l',
        // phones: a full-screen sheet over everything (no edge of its own)
        'max-md:fixed max-md:inset-0 max-md:z-40 max-md:pt-[var(--safe-top)] max-md:pb-[var(--safe-bottom)]',
        'md:w-[var(--panel-w,min(46%,880px))] md:min-w-[320px]',
      )}
    >
      {children}
      {/* a thin hit area on the border line; the visible line stays the box's own border */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('preview.resize')}
        aria-valuenow={m.now}
        aria-valuemin={m.min}
        aria-valuemax={m.max}
        tabIndex={0}
        data-testid="panel-divider"
        data-dragging={dragging || undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => commit(null)}
        onKeyDown={onKey}
        className={clsx(
          'absolute inset-y-0 -left-1 z-30 hidden w-2 cursor-col-resize touch-none select-none md:block',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors',
          'hover:after:bg-accent focus-visible:after:bg-accent data-[dragging]:after:bg-accent focus:outline-none',
        )}
      />
      {/* while dragging, the preview (an iframe, a PDF) must not swallow the moves */}
      {dragging && <div className="absolute inset-0 z-20 cursor-col-resize" data-testid="panel-drag-overlay" />}
    </div>
  )
}
